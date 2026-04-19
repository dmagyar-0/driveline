// T4.2 · PlotPanel — multi-series and channel picker (T4.3: Rust-side
// min-max decimation). T6.2 wired bindings into the store.
//
// Up to 8 scalar channels bound via a popover tree (`ChannelPicker`).
// Colour per channel is deterministic (`palette.colorFor`). Data for
// each binding is fetched via `useSession.fetchChannelRange`, decoded
// with `seriesFromArrow`, then k-way merged onto a shared x array so
// uPlot can render them as aligned series. The cursor overlay lives on
// a separate canvas so cursor ticks never rebuild the plot.
//
// Each fetch passes `maxPoints = canvas_px * 2` per
// docs/06-ui-and-panels.md:131, which triggers min-max bucket decimation
// in Rust so PlotPanel can render 1 M-sample windows under the 16 ms
// budget in docs/09-verification-plan.md:146.
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
import { cursorXPx } from "./cursorOverlay";
import { MAX_PLOT_SERIES, colorFor } from "./palette";
import { ChannelPicker } from "./ChannelPicker";
import styles from "./PlotPanel.module.css";

interface PlotPanelProps {
  panelId: string;
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

export function PlotPanel({ panelId }: PlotPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.plotBindings[panelId]);
  const setPlotBinding = useSession((s) => s.setPlotBinding);
  const addPlotChannel = useSession((s) => s.addPlotChannel);
  const removePlotChannel = useSession((s) => s.removePlotChannel);

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
  useEffect(() => {
    const filtered = boundChannelIds.filter((id) => {
      const c = channels.get(id);
      return c && c.kind === "scalar";
    });
    if (filtered.length !== boundChannelIds.length) {
      setPlotBinding(panelId, filtered);
    }
  }, [boundChannelIds, channels, panelId, setPlotBinding]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const plotMountRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  // Range used for the most recent `setData`; the cursor overlay uses
  // this so a stale cursor tick never projects onto a range we haven't
  // rendered yet.
  const lastRangeRef = useRef<TimeRange | null>(null);

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

  // (Re)build uPlot whenever the set of bound channels changes. We key
  // off the joined id string so the effect reruns only on meaningful
  // changes, not on every `boundChannels` reference churn.
  const seriesKey = boundChannelIds.join("|");
  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales: { x: { time: true }, y: { auto: true } },
      series: [
        {},
        ...boundChannels.map((c) => ({
          label: labelFor(c),
          stroke: colorFor(c.id),
          width: 1,
          spanGaps: false,
        })),
      ],
      axes: [{}, {}],
      cursor: { show: false },
      legend: { show: boundChannels.length > 0 },
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
      return;
    }

    // `canvas_px_width * 2` per docs/06-ui-and-panels.md:131. Floor at
    // 256 so a not-yet-laid-out container still triggers decimation
    // rather than pulling the full range over Comlink.
    const containerWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const maxPoints = Math.max(256, Math.round(containerWidth) * 2);

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
              maxPoints,
            ),
          ),
        );
        if (aborted) return;
        const decoded: PlotSeries[] = batches.map((b) => seriesFromArrow(b));
        const merged = mergeSeries(decoded);
        plot.setData([merged.xs, ...merged.ys] as uPlot.AlignedData);
        lastRangeRef.current = globalRange;
      } catch (err) {
        if (!aborted) console.error("PlotPanel fetch failed", err);
      }
    })();

    return () => {
      aborted = true;
    };
  }, [boundChannels, globalRange]);

  // Cursor overlay redraw on every cursor tick.
  useEffect(() => {
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

    ctx.strokeStyle = "#f97316";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + x + 0.5, top);
    ctx.lineTo(left + x + 0.5, top + height);
    ctx.stroke();
  }, [cursorNs, globalRange, seriesKey]);

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
