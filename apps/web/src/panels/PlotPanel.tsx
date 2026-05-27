// T4.2 · PlotPanel — multi-series plot with channel picker.
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
// UX overhaul (issues #1–#8):
//   1. Chips compact: short label + unit + optional source badge; full
//      path lives in the tooltip; chip row never grows past 2 rows.
//   2. Source badge appears when the bound short-labels collide so users
//      can disambiguate four `speed` chips coming from four files.
//   3. Y-axes group by unit. With ≥2 unit-groups we render left + right
//      axes (uPlot scales `y` and `y2`); with ≥3, extra groups still get
//      their own scale and we surface a `Mixed units` warning chip.
//   4. Cursor-value legend strip under the plot, updated in the same
//      effect that publishes the sync snapshot (no extra hot-path work).
//   5. The add-channel button reads `Add channel · n / N max`.
//   6. Calmer palette (`palette.ts`).
//   7. Chip swatch is `colorFor(channel.id)` — same string used for the
//      uPlot stroke; the two cannot drift.
//   8. Axis grid + label colours read from `--color-fg-3` / a dedicated
//      `--color-plot-grid` for legibility on the dark surface.
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
import { ChannelChip } from "./ChannelChip";
import {
  CursorReadout,
  formatReadoutValue,
  type CursorReadoutEntry,
} from "./CursorReadout";
import { CursorGutter, type CursorGutterEntry } from "./CursorGutter";
import { SegmentBands, formatSegmentTime } from "./SegmentBands";
import {
  shortChannelLabel,
  shouldShowSourceBadges,
  sourceBadge as sourceBadgeFor,
} from "./channelLabels";
import { groupByUnit, axisLabel, type AxisGroup } from "./axisGroups";
import {
  formatRelativeTime24h,
  formatAxisTime24h,
  makeAxisValueFormatter,
} from "./plotFormat";
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
  sampleAtCursor: Array<{
    channelId: string;
    tsNs: bigint;
    value: number;
  } | null>;
  // T6.3 — per-series min/max over the most recent fetched range. Used
  // by `signalAlignment.spec.ts` to assert two sources agree on the same
  // underlying signal within one sample. Empty when no render has
  // completed yet.
  seriesStats: PlotSeriesStats[];
}

declare global {
  interface Window {
    __drivelinePlotPanels?: Record<string, PlotSyncSnapshot | undefined>;
  }
}

// Largest index `i` with `tsNs[i] <= cursorNs`, or -1 if none.
function lastIndexAtOrBefore(tsNs: BigInt64Array, cursorNs: bigint): number {
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
let axisStyleCache: {
  fg: string;
  grid: string;
  ticks: string;
} | null = null;
function axisStyle(): { fg: string; grid: string; ticks: string } {
  if (axisStyleCache !== null) return axisStyleCache;
  // Tuned for legibility on `--color-bg-3` (#151515):
  //   - axis labels: `--color-fg-3` (#bbbbbb) ≈ 9.4:1 — well above 4.5.
  //   - grid lines: `#2f2f2f` ≈ 1.4:1 — visible but unobtrusive,
  //     replaces the v1 `--color-border-subtle` (#2a2a2a) which sat
  //     too close to the panel surface to register at a glance.
  //   - tick marks: same as grid.
  const fallback = { fg: "#bbbbbb", grid: "#2f2f2f", ticks: "#2f2f2f" };
  if (typeof document === "undefined") {
    axisStyleCache = fallback;
    return axisStyleCache;
  }
  const cs = getComputedStyle(document.documentElement);
  const fg = cs.getPropertyValue("--color-fg-3").trim();
  // Allow a panel-local override token if anyone introduces one; fall
  // back to the hand-picked `#2f2f2f` rather than the default border
  // colour, which is too dark on the deepest panel surface.
  const grid = cs.getPropertyValue("--color-plot-grid").trim() || fallback.grid;
  axisStyleCache = {
    fg: fg || fallback.fg,
    grid,
    ticks: grid,
  };
  return axisStyleCache;
}

// Above this many chips we collapse into "N channels" with a popover.
// Picked so the chip row never exceeds two rows at typical panel widths.
const CHIP_COLLAPSE_THRESHOLD = 6;

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

  const boundChannelIds = useMemo(() => storedBindings ?? [], [storedBindings]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  // When the chip count exceeds CHIP_COLLAPSE_THRESHOLD we hide the chip
  // row and surface a "N channels" pill that opens a popover. Collapsed
  // is the default at the threshold; the user can pin it open.
  const [chipsCollapsed, setChipsCollapsed] = useState(true);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);

  const channels = useMemo(() => channelMap(sources), [sources]);
  const boundChannels = useMemo(
    () =>
      boundChannelIds
        .map((id) => channels.get(id))
        .filter((c): c is Channel => !!c),
    [boundChannelIds, channels],
  );

  // Pre-compute the source-disambiguation badges so chips and the
  // cursor readout agree on what's shown.
  const badges = useMemo(() => {
    const show = shouldShowSourceBadges(boundChannels);
    const m = new Map<string, string>();
    for (const c of boundChannels) {
      m.set(c.id, show ? sourceBadgeFor(c, sources) : "");
    }
    return m;
  }, [boundChannels, sources]);

  // Group by unit for multi-axis rendering (issue #3). Calculated once
  // per binding-set change; downstream consumers (uPlot opts builder,
  // axis warning chip) read this.
  const axisGroups: AxisGroup[] = useMemo(
    () => groupByUnit(boundChannels),
    [boundChannels],
  );
  const hasMixedUnits = axisGroups.length >= 3;

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
  const decodedRef = useRef<{ channelId: string; series: PlotSeries }[]>([]);

  // Cursor-readout entries. Recomputed in the same effect that publishes
  // the sync snapshot — no extra binary searches on the hot path.
  const [readoutEntries, setReadoutEntries] = useState<CursorReadoutEntry[]>(
    [],
  );

  // Iter3 issue #1 — cursor gutter entries. Replaces the iter2 floating
  // tooltip; the gutter never overlaps the data, so we no longer need
  // the tooltip pixel-X state or the panel-width flip decision. Both
  // are computed in the same hot-path effect as `readoutEntries`.
  const [gutterEntries, setGutterEntries] = useState<CursorGutterEntry[]>([]);

  // Iter2 issue #4 — segment-band geometry. We rebuild bands when
  // `sources` change (a new file is dropped or one is closed); the
  // band's pixel rect comes from the plot's bbox tracked in the cursor
  // overlay effect. Decoupling these means scrubbing the cursor doesn't
  // recompute band geometry on every tick.
  const [bbox, setBbox] = useState<{
    leftPx: number;
    topPx: number;
    widthPx: number;
    heightPx: number;
  } | null>(null);

  const publishSync = useCallback(() => {
    const t0 = `plot:cursor:${panelId}:start`;
    const t1 = `plot:cursor:${panelId}:end`;
    mark(t0);
    const store = (window.__drivelinePlotPanels ??= {});
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
    store[panelId] = {
      cursorNs,
      boundChannelIds,
      lastFetchedRange: range
        ? { startNs: range.startNs, endNs: range.endNs }
        : null,
      sampleAtCursor,
      seriesStats,
    };

    // Build the cursor-readout entries piggybacking on the same loop:
    // one entry per bound channel in binding order, value picked from
    // the binary search above. `null` value renders as `—`.
    const byIdx = new Map<string, (typeof sampleAtCursor)[number]>();
    for (let i = 0; i < decoded.length; i++) {
      byIdx.set(decoded[i].channelId, sampleAtCursor[i]);
    }
    const entries: CursorReadoutEntry[] = boundChannels.map((c) => {
      const s = byIdx.get(c.id) ?? null;
      const valueStr =
        s && Number.isFinite(s.value) ? formatReadoutValue(s.value) : null;
      return {
        channelId: c.id,
        shortLabel: shortChannelLabel(c),
        value: valueStr,
        unit: c.unit,
        sourceBadge: badges.get(c.id) ?? "",
        sourceId: c.sourceId,
      };
    });
    setReadoutEntries(entries);

    // Iter3 issue #1 — gutter entries carry the raw numeric value so
    // the gutter can format it with the unit-aware fixed-decimal
    // helper (issue #3). The readout strip below the plot continues to
    // use `formatReadoutValue` for backwards compatibility with the
    // T6.3 spec — both surfaces show the same number to the same
    // precision the user expects from their unit.
    const gutter: CursorGutterEntry[] = boundChannels.map((c) => {
      const s = byIdx.get(c.id) ?? null;
      return {
        channelId: c.id,
        shortLabel: shortChannelLabel(c),
        value:
          s && Number.isFinite(s.value) ? formatReadoutValue(s.value) : null,
        unit: c.unit,
        sourceBadge: badges.get(c.id) ?? "",
        sourceId: c.sourceId,
        rawValue: s && Number.isFinite(s.value) ? s.value : null,
      };
    });
    setGutterEntries(gutter);
    mark(t1);
    // Cheap one-shot mark; do not measure on every cursor tick (would
    // pollute the perf timeline). Caller can `performance.measure`
    // between the marks when investigating regressions.
  }, [boundChannelIds, boundChannels, badges, cursorNs, panelId]);

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
  //
  // Axis grouping is also baked in here: each unit-group gets its own
  // uPlot scale (`y`, `y2`, …) so heterogeneous channels are not
  // compared on the same vertical axis.
  const axisGroupKey = axisGroups
    .map(
      (g) => `${g.scaleKey}:${g.unit}:${g.channels.map((c) => c.id).join(",")}`,
    )
    .join("|");
  const seriesKey = `${boundChannelIds.join("|")}::g=${
    gapThresholdSec ?? "off"
  }::axes=${axisGroupKey}`;
  // Build a quick lookup from channel-id → scale key for the series opts.
  const scaleByChannelId = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of axisGroups) {
      for (const c of g.channels) m.set(c.id, g.scaleKey);
    }
    return m;
  }, [axisGroups]);

  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const { fg, grid, ticks } = axisStyle();
    // Iter2 issue #3 — when a y-axis is tinted (its group has a
    // homogeneous palette colour) we use that tint for the axis label,
    // ticks, and a slightly stronger grid colour so the user can tell
    // at a glance which trace owns which side. The bottom x-axis stays
    // neutral; tinting it would suggest the time axis belongs to one
    // series. Pass `tint` only for tinted Y axes.
    //
    // Iter3 issue #4 — for Y axes we install a custom `values`
    // formatter that prints uniform decimals across the tick ladder.
    // uPlot's default trims trailing zeros which produces ladders like
    // `33, 33.4, 33.6, 33.8` — the lone `33` reads as missing a decimal.
    //
    // Iter3 issue #5 — when there are two y-axis groups, the left and
    // right gridlines are tinted to match their owning axis. Tints are
    // dialled way down (alpha ~0.12) so the canvas stays readable —
    // the goal is "which group does this gridline belong to", not
    // "shout the axis colour".
    //
    // Iter3 issue #6 — the bottom (time) axis uses a strict 24h
    // `HH:MM:SS` formatter; uPlot's default mixes `6:08am` and 24h
    // depending on the tick magnitude.
    const mkAxis = (
      side: 0 | 1 | 2 | 3,
      scale: string,
      label?: string,
      tint?: string,
      gridTint?: string,
    ): uPlot.Axis => {
      const stroke = tint ?? fg;
      const tickStroke = tint ?? ticks;
      const isTimeAxis = scale === "x";
      const gridStroke = gridTint ?? grid;
      const axisOpts: uPlot.Axis = {
        scale,
        side,
        stroke,
        ticks: { stroke: tickStroke, size: 4 },
        grid: { stroke: gridStroke, width: 1 },
        ...(label ? { label } : {}),
      };
      // Force 24h on the time axis; otherwise the Y-axis formatter so
      // the tick ladder reads cleanly even when the range zooms in.
      if (isTimeAxis) {
        axisOpts.values = (_self, splits) => splits.map(formatAxisTime24h);
      } else {
        axisOpts.values = makeAxisValueFormatter() as uPlot.Axis.Values;
      }
      return axisOpts;
    };

    // Per-side gridline tint (iter3 issue #5). Use the group's
    // `axisColor` at low opacity so the gridlines associate without
    // overpowering the canvas. We only tint when there are ≥2 groups;
    // a single-axis plot keeps the neutral grid (tinting one side
    // doesn't differentiate anything in that case).
    const tintedGrid = (hex: string): string => {
      // Convert `#rrggbb` → `rgba(r,g,b,0.12)`. Defensive: if the input
      // isn't a 6-digit hex, fall back to the default grid colour.
      if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return grid;
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, 0.18)`;
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

    // Per-scale config: every group gets a `scales` entry. Only the
    // first two groups get a visible axis (left + right); the rest
    // still scale independently but their gridlines are suppressed so
    // the canvas doesn't become unreadable.
    const scales: uPlot.Options["scales"] = { x: { time: true } };
    const axesOpts: uPlot.Axis[] = [mkAxis(2, "x")]; // bottom x-axis
    for (let i = 0; i < axisGroups.length; i++) {
      const g = axisGroups[i];
      (scales as Record<string, uPlot.Scale>)[g.scaleKey] = { auto: true };
      // Only tint the axis when there are ≥2 unit groups; with a single
      // axis the tint would just colour the chrome to match every
      // series, adding noise instead of signal. Pass `undefined` to
      // mkAxis so single-axis plots retain the neutral fg colour.
      const tint = axisGroups.length >= 2 ? g.axisColor : undefined;
      // Iter3 issue #5 — gridline tint per side. Only applied when
      // there are two visible Y axes (left + right); otherwise we'd
      // tint both lines the same colour, which doesn't differentiate.
      const gridTint =
        axisGroups.length >= 2 && tint ? tintedGrid(tint) : undefined;
      if (i === 0) {
        axesOpts.push(mkAxis(3, g.scaleKey, axisLabel(g), tint, gridTint));
      } else if (i === 1) {
        axesOpts.push(mkAxis(1, g.scaleKey, axisLabel(g), tint, gridTint));
      }
      // i >= 2: scale exists but no visible axis — see Mixed-units warning
    }

    const opts: uPlot.Options = {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      scales,
      series: [
        {},
        ...boundChannels.map((c) => ({
          label: c.name,
          stroke: colorFor(c.id),
          width: 1.25,
          spanGaps,
          scale: scaleByChannelId.get(c.id) ?? "y",
        })),
      ],
      axes: axesOpts,
      cursor: { show: false },
      // The header chips + the under-plot readout strip already list
      // every bound series with its value — uPlot's built-in legend
      // would duplicate that and steal vertical space from the canvas.
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
  }, [boundChannels, globalRange, gapThresholdSec, publishSync, panelId]);

  // Cursor overlay redraw on every cursor tick.
  useEffect(() => {
    // Re-publish the T6.1 sync snapshot every cursor tick so e2e
    // assertions see the latest `sampleAtCursor` without waiting on a
    // fetch. Cheap: one binary search per bound channel.
    publishSync();

    const overlay = overlayRef.current;
    const plot = plotRef.current;
    const containerEl = containerRef.current;
    if (!overlay || !plot || !containerEl) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Iter2 — track the plot canvas's CSS-pixel bbox inside the
    // `.plotArea` container so the segment-band overlay and the cursor
    // tooltip can position themselves over the same drawn area uPlot
    // uses for series. This is the only place we read `plot.bbox`, so
    // both consumers stay in lockstep with the canvas geometry.
    const pbbox = plot.bbox;
    const left = pbbox.left / dpr;
    const top = pbbox.top / dpr;
    const width = pbbox.width / dpr;
    const height = pbbox.height / dpr;
    setBbox((prev) =>
      prev &&
      prev.leftPx === left &&
      prev.topPx === top &&
      prev.widthPx === width &&
      prev.heightPx === height
        ? prev
        : { leftPx: left, topPx: top, widthPx: width, heightPx: height },
    );
    // Issue #5 — hide the cursor line in an empty plot. A stray orange
    // vertical bar over an unbound canvas reads as noise, not a
    // playhead. With no bound series the overlay clears to empty and
    // returns; once the user picks a channel the next cursor tick
    // redraws normally.
    if (boundChannels.length === 0) return;

    const range = lastRangeRef.current ?? globalRange;
    if (!range) return;

    const x = cursorXPx(cursorNs, range, width);
    if (x === null) return;

    ctx.strokeStyle = cursorStrokeColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + x + 0.5, top);
    ctx.lineTo(left + x + 0.5, top + height);
    ctx.stroke();
  }, [boundChannels.length, cursorNs, globalRange, seriesKey, publishSync]);

  // Drop this panel's sync snapshot on unmount so stale ids don't leak
  // into a test after a panel is closed.
  useEffect(() => {
    return () => {
      const store = window.__drivelinePlotPanels;
      if (store) delete store[panelId];
    };
  }, [panelId]);

  // Iter2 issue #4 — derive segment-band geometries from the loaded
  // sources. Each source is a "segment"; we sort by start time and
  // produce one band per source. With ≤1 source we render nothing
  // (no boundaries to indicate). When source list is empty after a
  // load, log a single warning so we have a breadcrumb if the
  // metadata path ever drops — the audit explicitly asked for the
  // graceful skip.
  const segmentBandsList = useMemo(() => {
    if (!globalRange || sources.length <= 1) return [];
    const spanNs = globalRange.endNs - globalRange.startNs;
    if (spanNs <= 0n) return [];
    const ordered = [...sources].sort((a, b) => {
      const d = a.timeRange.startNs - b.timeRange.startNs;
      return d === 0n ? 0 : d < 0n ? -1 : 1;
    });
    const originNs = globalRange.startNs;
    return ordered.map((s, i) => {
      const startOff = s.timeRange.startNs - originNs;
      const endOff = s.timeRange.endNs - originNs;
      const leftFrac = Number(startOff) / Number(spanNs);
      const widthFrac = Number(endOff - startOff) / Number(spanNs);
      // Iter3 issue #7 — segment tooltips were "S1" with an
      // unexplained one-line title. Reword as a multi-line hover so
      // the user gets the name, the 24h start time, and the duration
      // (relative ms-precise stamp for the start; HH:MM:SS for the
      // span). Browsers render `title` line breaks as separators.
      const startRel = formatSegmentTime(s.timeRange.startNs, originNs);
      const endRel = formatSegmentTime(s.timeRange.endNs, originNs);
      const startWall = formatRelativeTime24h(s.timeRange.startNs, originNs);
      return {
        id: `${s.id}:${i}`,
        label: `S${i + 1}`,
        leftFrac,
        widthFrac,
        title: `Segment ${i + 1}: ${s.name}\nStart: ${startWall} (${startRel})\nEnd: ${endRel}`,
      };
    });
  }, [sources, globalRange]);

  // One-shot warning when the audit's "no segment metadata available"
  // path fires. Sources always carry `timeRange` today, so this is
  // defensive — should never log on the supported readers.
  const segmentWarnedRef = useRef(false);
  useEffect(() => {
    if (sources.length > 1 && !globalRange && !segmentWarnedRef.current) {
      segmentWarnedRef.current = true;
      // eslint-disable-next-line no-console
      console.warn(
        "PlotPanel: segment metadata unavailable — skipping segment bands.",
      );
    }
  }, [sources, globalRange]);

  // Iter3 issue #6 — gutter time header. Always 24h `HH:MM:SS`, never
  // 12h. Relative to the session origin so segment correlations are
  // obvious (a 1.5-hour mark inside seg #2 reads as `01:30:00`).
  const gutterTimeLabel = useMemo(() => {
    if (!globalRange) return null;
    return formatRelativeTime24h(cursorNs, globalRange.startNs);
  }, [cursorNs, globalRange]);

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

  // Collapse rule (issue #1): when many channels are bound, the chip
  // row becomes a single "N channels" pill that expands on click.
  // Disabled when at-or-below the threshold so a 3-chip panel is never
  // hidden behind a click.
  const collapseEligible = boundChannelIds.length >= CHIP_COLLAPSE_THRESHOLD;
  const showChipsExpanded = !collapseEligible || !chipsCollapsed;

  return (
    <section className={styles.panel} data-testid="plot-panel">
      <div className={styles.controls}>
        {collapseEligible && (
          // Issue #6 — the standalone `"N channels"` count duplicated
          // what the Add-channel button's `n / N max` badge already
          // says. The collapse pill now just toggles visibility; the
          // Add-channel button stays the single source of truth for
          // the binding count.
          <button
            type="button"
            className={styles.collapseBtn}
            onClick={() => setChipsCollapsed((v) => !v)}
            aria-expanded={!chipsCollapsed}
            data-testid="plot-chips-collapse"
          >
            {chipsCollapsed ? "Show chips" : "Hide chips"}
          </button>
        )}
        {showChipsExpanded && (
          <div className={styles.chips} data-testid="plot-chips">
            {boundChannels.map((c) => (
              <ChannelChip
                key={c.id}
                channel={c}
                sourceBadge={badges.get(c.id) ?? ""}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
        {hasMixedUnits && (
          <span
            className={styles.warningChip}
            title={`Channels span ${axisGroups.length} unit groups. Only the first two are shown on visible axes; the rest scale independently against their own group.`}
            data-testid="plot-mixed-units-warning"
          >
            Mixed units · {axisGroups.length}
          </span>
        )}
        <button
          ref={addBtnRef}
          type="button"
          className={styles.addBtn}
          onClick={togglePicker}
          disabled={!hasAnyScalar || atCap}
          aria-expanded={pickerOpen}
          title={`Up to ${MAX_PLOT_SERIES} channels per panel`}
          data-testid="plot-add-channel"
        >
          Add channel
          <span className={styles.countBadge}>
            {boundChannelIds.length} / {MAX_PLOT_SERIES} max
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
      <div className={styles.plotArea}>
        {/* Iter3 issue #1 — `.plotCanvasWrap` is the resize target the
            ResizeObserver tracks; the gutter beside it is fixed-width
            so the plot canvas owns the remaining flex space. The plot
            no longer reflows when cursor values change. */}
        <div ref={containerRef} className={styles.plotCanvasWrap}>
          <div ref={plotMountRef} className={styles.plotMount} />
          {/* Iter2 issue #4 — segment bands sit between the canvas and
              the cursor overlay so the cursor line stays visible over the
              band tint. Rendered only when geometry is known + ≥2
              sources. */}
          {bbox &&
            boundChannels.length > 0 &&
            segmentBandsList.length > 1 && (
              <SegmentBands
                bands={segmentBandsList}
                bboxLeftPx={bbox.leftPx}
                bboxTopPx={bbox.topPx}
                bboxWidthPx={bbox.widthPx}
                bboxHeightPx={bbox.heightPx}
              />
            )}
          <canvas ref={overlayRef} className={styles.overlay} />
          {boundChannels.length === 0 && (
            <div className={styles.empty} data-testid="plot-empty">
              {hasAnyScalar
                ? "Pick one or more channels to plot."
                : "Drop an MCAP or MF4 file to load scalar channels."}
            </div>
          )}
        </div>
        {/* Iter3 issue #1 — right-side cursor-value gutter. Replaces
            the iter2 floating tooltip. The gutter is rendered only
            when there is at least one bound channel so the empty
            state has the full panel width. */}
        {boundChannels.length > 0 && (
          <CursorGutter timeLabel={gutterTimeLabel} entries={gutterEntries} />
        )}
      </div>
      <CursorReadout entries={readoutEntries} />
    </section>
  );
}
