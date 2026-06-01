// T4.2 · PlotPanel — multi-series and channel picker. T6.2 wired
// bindings into the store.
//
// Up to 8 scalar channels bound via a popover tree (`ChannelPicker`).
// Colour per channel is deterministic (`palette.colorFor`). Data for
// each binding is fetched via `useSession.fetchChannelRange`, decoded
// with `seriesFromArrow`, then k-way merged onto a shared x array so
// uPlot can render them as aligned series. The cursor overlay lives on
// a separate canvas so cursor ticks never rebuild the plot.
//
// Bindings live in the Zustand store keyed by `panelId` (T6.2) so they
// round-trip through FlexLayout serialisation and `localStorage`.
// Several plot panels can coexist, each with its own independent set of
// channels (per the manual checklist in docs/09-verification-plan.md:131).
//
// Out of scope: pan/zoom, y-axis fixed range, step-hold/linear toggle.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { useSession } from "../state/store";
import type { Channel, SourceMeta, TimeRange } from "../state/store";
import { seriesFromArrow, type PlotSeries } from "./seriesFromArrow";
import { mergeSeries } from "./mergeSeries";
import { cursorStrokeColor, cursorXPx } from "./cursorOverlay";
import { MAX_PLOT_SERIES, colorFor } from "./palette";
import { ChannelPicker } from "./ChannelPicker";
import { mark, measure } from "../perf";
import styles from "./PlotPanel.module.css";

interface PlotPanelProps {
  panelId: string;
}

// T6.1 — Cross-panel sync snapshot. Mirrors the `__drivelineVideoHud`
// pattern: an e2e spec reads it via a dev hook (`getPlotPanelSync`) to
// assert that the rendered plot agrees with the shared `cursorNs`.
export interface PlotSeriesStats {
  channelId: string;
  min: number;
  max: number;
  count: number;
}

export interface PlotSyncSnapshot {
  cursorNs: bigint;
  boundChannelIds: string[];
  lastFetchedRange: { startNs: bigint; endNs: bigint } | null;
  // One entry per bound channel, in binding order. `null` when no sample
  // in that channel has `ts <= cursorNs` yet — callers must treat this
  // as "not yet resolvable", not as a valid value.
  sampleAtCursor: Array<
    { channelId: string; tsNs: bigint; value: number } | null
  >;
  // T6.3 — per-series min/max over the most recent fetched range. Used
  // by `signalAlignment.spec.ts` to assert two sources agree on the same
  // underlying signal within one sample. Empty when no render has
  // completed yet.
  seriesStats: PlotSeriesStats[];
  // The plot's actual x-axis domain in epoch seconds, read straight from
  // uPlot after the most recent render. The x-scale is pinned to the
  // shared global timeline (not the per-series data extent), so this
  // should match `globalRange`; e2e asserts the plot doesn't silently
  // auto-fit a short signal across the full width. `null` before the
  // first render.
  xScaleSec: { min: number; max: number } | null;
}

declare global {
  interface Window {
    __drivelinePlotPanels?: Record<string, PlotSyncSnapshot | undefined>;
  }
}

// Largest index `i` with `tsNs[i] <= cursorNs`, or -1 if none.
function lastIndexAtOrBefore(
  tsNs: BigInt64Array,
  cursorNs: bigint,
): number {
  let lo = 0;
  let hi = tsNs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tsNs[mid] <= cursorNs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

const EMPTY_X = new Float64Array();
const EMPTY_Y = new Float64Array();
const EMPTY_DATA: uPlot.AlignedData = [EMPTY_X, EMPTY_Y];

function labelFor(c: Channel): string {
  return c.unit ? `${c.name} (${c.unit})` : c.name;
}

function channelMap(sources: SourceMeta[]): Map<string, Channel> {
  const m = new Map<string, Channel>();
  for (const s of sources) for (const c of s.channels) m.set(c.id, c);
  return m;
}

// uPlot's defaults paint axis labels/ticks/grid in black, which is
// invisible on the dark panel background. Resolve the relevant tokens
// from `tokens.css` once and cache — the design system has no runtime
// theme switch at v1, so re-reading on every plot rebuild (one per
// binding-set change) is wasted `getComputedStyle` work. Mirrors
// `cursorStrokeColor` in cursorOverlay.
let axisStyleCache: { fg: string; grid: string } | null = null;
function axisStyle(): { fg: string; grid: string } {
  if (axisStyleCache !== null) return axisStyleCache;
  const fallback = { fg: "#e0e0e0", grid: "#2a2a2a" };
  if (typeof document === "undefined") {
    axisStyleCache = fallback;
    return axisStyleCache;
  }
  const cs = getComputedStyle(document.documentElement);
  const fg = cs.getPropertyValue("--color-fg-2").trim();
  const grid = cs.getPropertyValue("--color-border-subtle").trim();
  axisStyleCache = {
    fg: fg || fallback.fg,
    grid: grid || fallback.grid,
  };
  return axisStyleCache;
}

export function PlotPanel({ panelId }: PlotPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.plotBindings[panelId]);
  const setPlotBinding = useSession((s) => s.setPlotBinding);
  const addPlotChannel = useSession((s) => s.addPlotChannel);
  const removePlotChannel = useSession((s) => s.removePlotChannel);
  // Gap threshold mode comes from per-panel settings (Phase 8). `null`
  // is the default and pairs with `spanGaps:true`; a positive number
  // pairs with `spanGaps:false` and explicit gap markers in mergeSeries.
  const gapThresholdSec = useSession(
    (s) => s.plotPanelSettings[panelId]?.gapThresholdSec ?? null,
  );

  const boundChannelIds = useMemo(
    () => storedBindings ?? [],
    [storedBindings],
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);

  const channels = useMemo(() => channelMap(sources), [sources]);
  const boundChannels = useMemo(
    () => boundChannelIds.map((id) => channels.get(id)).filter((c): c is Channel => !!c),
    [boundChannelIds, channels],
  );

  // Drop bindings that no longer map to a live scalar channel. Defence in
  // depth against stale ids left in the persisted layout (e.g. the user
  // saved a session, reloaded, then dropped a different file).
  //
  // Skip the cull until at least one source has been loaded — on first
  // hydrate the channels list is empty, which would otherwise wipe every
  // persisted binding before the user has had a chance to drop a file.
  useEffect(() => {
    if (sources.length === 0) return;
    const filtered = boundChannelIds.filter((id) => {
      const c = channels.get(id);
      return c && c.kind === "scalar";
    });
    if (filtered.length !== boundChannelIds.length) {
      setPlotBinding(panelId, filtered);
    }
  }, [boundChannelIds, channels, panelId, setPlotBinding, sources.length]);

  // The shared global timeline in epoch seconds. The plot's x-scale is
  // pinned to this (not the per-series data extent) so a signal that
  // only covers part of the timeline lands in its true absolute-time
  // position, leaving the uncovered span blank — and the cursor overlay,
  // which already projects `cursorNs` over the global range, lines up.
  const globalRangeSec = useMemo<[number, number] | null>(
    () =>
      globalRange
        ? [
            Number(globalRange.startNs) / 1e9,
            Number(globalRange.endNs) / 1e9,
          ]
        : null,
    [globalRange],
  );
  // uPlot's x-range callback runs synchronously inside `setData`, well
  // after this render commits, so it must read the latest value through
  // a ref rather than the closed-over `globalRangeSec`.
  const globalRangeSecRef = useRef<[number, number] | null>(globalRangeSec);
  globalRangeSecRef.current = globalRangeSec;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotMountRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Range used for the most recent `setData`; the cursor overlay uses
  // this so a stale cursor tick never projects onto a range we haven't
  // rendered yet.
  const lastRangeRef = useRef<TimeRange | null>(null);
  // Per-channel decoded series, retained so the T6.1 sync snapshot can
  // binary-search raw ns timestamps. Parallel to `lastRangeRef`: both
  // are updated in lockstep after a successful fetch and cleared when
  // the binding set changes.
  const decodedRef = useRef<
    { channelId: string; series: PlotSeries }[]
  >([]);

  const publishSync = useCallback(() => {
    const store =
      (window.__drivelinePlotPanels ??= {});
    const decoded = decodedRef.current;
    const sampleAtCursor: PlotSyncSnapshot["sampleAtCursor"] = decoded.map(
      ({ channelId, series }) => {
        const idx = lastIndexAtOrBefore(series.rawTsNs, cursorNs);
        if (idx < 0) return null;
        return {
          channelId,
          tsNs: series.rawTsNs[idx],
          value: series.ys[idx],
        };
      },
    );
    const range = lastRangeRef.current;
    const seriesStats: PlotSeriesStats[] = decoded.map(
      ({ channelId, series }) => {
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < series.ys.length; i++) {
          const v = series.ys[i];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        return {
          channelId,
          min: Number.isFinite(min) ? min : NaN,
          max: Number.isFinite(max) ? max : NaN,
          count: series.ys.length,
        };
      },
    );
    const xScale = plotRef.current?.scales?.x;
    const xScaleSec =
      xScale && xScale.min != null && xScale.max != null
        ? { min: xScale.min, max: xScale.max }
        : null;
    store[panelId] = {
      cursorNs,
      boundChannelIds,
      lastFetchedRange: range
        ? { startNs: range.startNs, endNs: range.endNs }
        : null,
      sampleAtCursor,
      seriesStats,
      xScaleSec,
    };
  }, [boundChannelIds, cursorNs, panelId]);

  const resizePlotToContainer = useCallback(() => {
    const plot = plotRef.current;
    const c = containerRef.current;
    if (!plot || !c) return;
    const r = c.getBoundingClientRect();
    plot.setSize({
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height)),
    });
  }, []);

  const sizeOverlayToContainer = useCallback(() => {
    const overlay = overlayRef.current;
    const c = containerRef.current;
    if (!overlay || !c) return;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.round(r.width * dpr));
    overlay.height = Math.max(1, Math.round(r.height * dpr));
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  }, []);

  // Keep a ResizeObserver alive for the plot area. The plot itself is
  // rebuilt in the effect below whenever the series set changes, since
  // uPlot has no public API for adding/removing series in-place.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => {
      resizePlotToContainer();
      sizeOverlayToContainer();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [resizePlotToContainer, sizeOverlayToContainer]);

  // (Re)build uPlot whenever the set of bound channels OR the
  // gap-threshold mode changes. The threshold flips `spanGaps` (which
  // is a per-series option that uPlot bakes into its draw plan), so
  // mode changes need a fresh plot instance.
  const seriesKey = `${boundChannelIds.join("|")}::g=${
    gapThresholdSec ?? "off"
  }`;
  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const { fg, grid } = axisStyle();
    const axisOpts: uPlot.Axis = {
      stroke: fg,
      ticks: { stroke: grid },
      grid: { stroke: grid },
    };
    // Default mode: `mergeSeries` emits `null` at every union timestamp
    // where *this* series has no sample. With two same-rate signals on
    // different CAN mailboxes (e.g. /vehicle/speed and
    // /vehicle/steering_angle in comma2k19) every other slot is null
    // per series, so `spanGaps:false` collapsed each trace to invisible
    // 1-pixel dots. Spanning gives each series the step-hold rendering
    // 03-data-model.md promises — at the cost of hiding real
    // channel-loss gaps as longer horizontal holds.
    //
    // Gap-threshold mode: `mergeSeries` already step-holds within the
    // threshold and emits explicit `null`s at gap markers, so the
    // renderer must NOT span — `spanGaps:false` lets those nulls draw
    // as actual gaps without losing the multi-mailbox interleave fix.
    const spanGaps = gapThresholdSec === null;
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: {
        x: {
          time: true,
          // Pin the x-domain to the shared global timeline. Returning an
          // explicit range here disables uPlot's auto-fit-to-data (and
          // its range padding), so a short signal no longer stretches to
          // fill the panel — it occupies only its real slice of absolute
          // time. Falls back to the data extent only before any source
          // has set a global range.
          range: (_u, dataMin, dataMax) => {
            const r = globalRangeSecRef.current;
            if (r && r[1] > r[0]) return r;
            return [dataMin, dataMax];
          },
        },
        y: { auto: true },
      },
      series: [
        {},
        ...boundChannels.map((c) => ({
          label: labelFor(c),
          stroke: colorFor(c.id),
          width: 1,
          spanGaps,
        })),
      ],
      axes: [axisOpts, axisOpts],
      cursor: { show: false },
      // The control bar's chips (colour swatch + label + remove) already
      // act as this plot's legend, and the cursor is disabled so uPlot's
      // built-in legend would only ever show static series names. Keeping
      // it on rendered a redundant table *below* the canvas, which (since
      // the canvas is sized to the full container height) overflowed the
      // panel and forced a scrollbar. Disable it and let the chips own the
      // legend role.
      legend: { show: false },
    };
    const plot = new uPlot(opts, EMPTY_DATA, mount);
    plotRef.current = plot;
    sizeOverlayToContainer();
    // Clear stale overlay pixels from the previous plot geometry.
    const overlay = overlayRef.current;
    const ctx = overlay?.getContext("2d");
    if (overlay && ctx) {
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
    // New series set means any previous data is no longer valid.
    lastRangeRef.current = null;
    // Clear decoded series so a post-rebuild cursor tick doesn't publish
    // stale samples keyed by the previous binding set.
    decodedRef.current = [];

    return () => {
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey]);

  // Fetch & render on binding or range change.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (boundChannels.length === 0 || !globalRange) {
      plot.setData(EMPTY_DATA);
      lastRangeRef.current = null;
      decodedRef.current = [];
      publishSync();
      return;
    }

    let aborted = false;
    void (async () => {
      try {
        const store = useSession.getState();
        const batches = await Promise.all(
          boundChannels.map((c) =>
            store.fetchChannelRange(
              c.id,
              globalRange.startNs,
              globalRange.endNs,
              false,
            ),
          ),
        );
        if (aborted) return;
        const decoded: PlotSeries[] = batches.map((b) => seriesFromArrow(b));
        const merged = mergeSeries(decoded, gapThresholdSec);
        const renderStart = `plot:render:${panelId}:start`;
        const renderEnd = `plot:render:${panelId}:end`;
        mark(renderStart);
        plot.setData([merged.xs, ...merged.ys] as uPlot.AlignedData);
        mark(renderEnd);
        measure(`plot:render:${panelId}`, renderStart, renderEnd);
        lastRangeRef.current = globalRange;
        decodedRef.current = boundChannels.map((c, i) => ({
          channelId: c.id,
          series: decoded[i],
        }));
        publishSync();
      } catch (err) {
        if (!aborted) console.error("PlotPanel fetch failed", err);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [boundChannels, globalRange, gapThresholdSec, publishSync]);

  // Cursor overlay redraw on every cursor tick.
  useEffect(() => {
    // Re-publish the T6.1 sync snapshot every cursor tick so e2e
    // assertions see the latest `sampleAtCursor` without waiting on a
    // fetch. Cheap: one binary search per bound channel.
    publishSync();

    const overlay = overlayRef.current;
    const plot = plotRef.current;
    if (!overlay || !plot) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    const range = lastRangeRef.current ?? globalRange;
    if (!range) return;
    const bbox = plot.bbox;
    // uPlot's bbox is in device pixels; convert to CSS pixels for the
    // standard 2D context.
    const left = bbox.left / dpr;
    const top = bbox.top / dpr;
    const width = bbox.width / dpr;
    const height = bbox.height / dpr;

    const x = cursorXPx(cursorNs, range, width);
    if (x === null) return;

    ctx.strokeStyle = cursorStrokeColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + x + 0.5, top);
    ctx.lineTo(left + x + 0.5, top + height);
    ctx.stroke();
  }, [cursorNs, globalRange, seriesKey, publishSync]);

  // Drop this panel's sync snapshot on unmount so stale ids don't leak
  // into a test after a panel is closed.
  useEffect(() => {
    return () => {
      const store = window.__drivelinePlotPanels;
      if (store) delete store[panelId];
    };
  }, [panelId]);

  const atCap = boundChannelIds.length >= MAX_PLOT_SERIES;
  const hasAnyScalar = useMemo(
    () => sources.some((s) => s.channels.some((c) => c.kind === "scalar")),
    [sources],
  );

  const togglePicker = () => {
    if (!pickerOpen) {
      const rect = addBtnRef.current?.getBoundingClientRect() ?? null;
      setAnchorRect(rect);
      setPickerOpen(true);
    } else {
      setPickerOpen(false);
    }
  };

  const onToggle = (id: string) => {
    if (boundChannelIds.includes(id)) {
      removePlotChannel(panelId, id);
    } else {
      addPlotChannel(panelId, id);
    }
  };

  const onRemove = (id: string) => {
    removePlotChannel(panelId, id);
  };

  return (
    <section className={styles.panel} data-testid="plot-panel">
      <div className={styles.controls}>
        <div className={styles.chips} data-testid="plot-chips">
          {boundChannels.map((c) => (
            <span key={c.id} className={styles.chip} data-testid={`chip-${c.id}`}>
              <span
                className={styles.chipSwatch}
                style={{ background: colorFor(c.id) }}
                aria-hidden
              />
              <span className={styles.chipLabel}>{labelFor(c)}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`remove ${c.name}`}
                onClick={() => onRemove(c.id)}
                data-testid={`remove-${c.id}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <button
          ref={addBtnRef}
          type="button"
          className={styles.addBtn}
          onClick={togglePicker}
          disabled={!hasAnyScalar || atCap}
          aria-expanded={pickerOpen}
          data-testid="plot-add-channel"
        >
          + Add channel{" "}
          <span className={styles.countBadge}>
            {boundChannelIds.length} / {MAX_PLOT_SERIES}
          </span>
        </button>
      </div>
      {pickerOpen && (
        <ChannelPicker
          sources={sources}
          selectedIds={boundChannelIds}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={anchorRect}
          onToggle={onToggle}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <div ref={containerRef} className={styles.plotArea}>
        <div ref={plotMountRef} className={styles.plotMount} />
        <canvas ref={overlayRef} className={styles.overlay} />
        {boundChannels.length === 0 && (
          <div className={styles.empty} data-testid="plot-empty">
            {hasAnyScalar
              ? "Pick one or more channels to plot."
              : "Drop an MCAP or MF4 file to load scalar channels."}
          </div>
        )}
      </div>
    </section>
  );
}
