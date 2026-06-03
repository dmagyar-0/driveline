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

import {
  type CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { MAX_PLOT_Y_AXES, useSession } from "../state/store";
import type { Channel, SourceMeta, TimeRange } from "../state/store";
import { channelLabel, effectiveUnit } from "../state/units";
import { seriesFromArrow, type PlotSeries } from "./seriesFromArrow";
import { mergeSeries } from "./mergeSeries";
import { cursorStrokeColor, cursorXPx, nsFromXPx } from "./cursorOverlay";
import { MAX_PLOT_SERIES, colorFor } from "./palette";
import { getChannelDragData, hasChannelDrag } from "./channelDrag";
import { applyTransform, transformKey, type Transform } from "./transforms";
import { ChannelPicker } from "./ChannelPicker";
import { mark, measure } from "../perf";
import { formatAxisTick } from "../timeline/formatTime";
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
  // P4 — arithmetic mean over the finite samples in the fetched range.
  // `NaN` when no finite sample exists (mirrors min/max). The drawer's
  // per-series stats block reads this; existing fields are unchanged so
  // the T6.3 signalAlignment assertions still hold.
  mean: number;
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
  // The plot's resolved y-axis domain, read straight from uPlot after
  // the most recent render. A series whose samples decode to NaN/±Inf
  // would poison uPlot's shared auto-range to `[NaN, NaN]` and blank
  // every series; `mergeSeries` maps non-finite values to gaps so this
  // stays finite. e2e asserts `Number.isFinite(yScale.{min,max})` to
  // catch a regression of that blanking bug. `null` before the first
  // render or when no series carries a finite sample.
  yScale: { min: number; max: number } | null;
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

// Compact value formatting for the live readout in each chip. Mirrors
// TablePanel.formatValue so the two surfaces agree on how a sample reads.
function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}

// P3 — colour for the secondary (hover) crosshair. A muted neutral that
// reads as "preview" against the solid orange playback cursor. Inlined
// rather than a CSS-var read because it's used inside a canvas draw on the
// hover hot path (no getComputedStyle per frame).
const HOVER_CROSSHAIR_COLOR = "rgba(224, 224, 224, 0.55)";

// P3 — hover tooltip placement. The box is nudged off the pointer by
// `TOOLTIP_OFFSET_PX`; `TOOLTIP_MAX_WIDTH_PX` mirrors `.tooltip`'s
// `max-width: 16rem` in PlotPanel.module.css (16rem ≈ 256px at the 16px
// root). Both feed `tooltipPositionStyle`, which flips the tooltip to the
// far side of the pointer before it would spill past the plot area — without
// it, hovering near the right edge renders the value readout entirely
// outside the panel.
const TOOLTIP_OFFSET_PX = 12;
const TOOLTIP_MAX_WIDTH_PX = 256;

const EMPTY_X = new Float64Array();
const EMPTY_Y = new Float64Array();
const EMPTY_DATA: uPlot.AlignedData = [EMPTY_X, EMPTY_Y];

function channelMap(sources: SourceMeta[]): Map<string, Channel> {
  const m = new Map<string, Channel>();
  for (const s of sources) for (const c of s.channels) m.set(c.id, c);
  return m;
}

const NONE_TRANSFORM: Transform = { kind: "none" };

// uPlot scale key for a 0-based y-axis index. Index 0 is literally "y" so
// `plotRef.current.scales.y` stays present + finite (the e2e signalAlignment
// / plot-sync specs assert on it). Extra axes get "y1", "y2", … keys.
function scaleKeyForAxis(axisIdx: number): string {
  return axisIdx === 0 ? "y" : `y${axisIdx}`;
}

// Cap on how many distinct axes a panel renders. Mirrors MAX_PLOT_Y_AXES
// (the store clamps axis assignments to it) so an out-of-range index can
// never ask for a gutter we don't lay out.
const MAX_RENDERED_Y_AXES = MAX_PLOT_Y_AXES;

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

// uPlot reserves a fixed ~50px gutter for the y-axis. Wide tick labels —
// six-figure signal values, long decimals, or a leading minus sign —
// overflow it and get clipped at the panel's left edge, so the axis shows
// "00000" instead of "100000". Size the gutter to the widest formatted
// tick instead. This is the canonical uPlot dynamic-axis recipe: measure
// the longest label in the axis's own (pxRatio-scaled) font and add room
// for the tick mark and gap. Converges in a single layout cycle because
// the tick values depend only on the y-scale, not on the gutter width.
//
// `values` is `null` on uPlot's first sizing pass (before any ticks are
// computed), so fall back to the default minimum then.
export const Y_AXIS_MIN_SIZE = 50;
export function yAxisSize(
  self: uPlot,
  values: string[] | null,
  axisIdx: number,
): number {
  const axis = self.axes[axisIdx];
  const tickSize =
    axis.ticks && typeof axis.ticks.size === "number" ? axis.ticks.size : 0;
  const gap = typeof axis.gap === "number" ? axis.gap : 0;
  let size = tickSize + gap;
  const longest = (values ?? []).reduce(
    (acc, v) => (v.length > acc.length ? v : acc),
    "",
  );
  if (longest !== "") {
    // After init uPlot stores `font` as `[cssFont, pxSize, cssSize]`; the
    // first entry already includes the devicePixelRatio multiplier, so
    // `measureText` returns device pixels — divide back to CSS pixels.
    const font = (axis.font as unknown as [string] | undefined)?.[0];
    if (font) self.ctx.font = font;
    const dpr = window.devicePixelRatio || 1;
    size += self.ctx.measureText(longest).width / dpr;
  }
  return Math.ceil(Math.max(size, Y_AXIS_MIN_SIZE));
}

// Vertical gap reserved at the top and bottom of each band when axes are
// stacked, as a fraction of the band height. Keeps adjacent signals from
// touching so the lanes read as distinct.
export const STACK_BAND_GAP = 0.08;

// Stacked-axes layout. When the user stacks a panel's y-axes, each axis in
// use gets remapped so its samples occupy a horizontal band instead of the
// full plot height — letting several signals of different magnitudes be read
// at once without overlapping. uPlot maps a scale's [min, max] across the
// full height (min → bottom, max → top), so returning a span *wider* than
// the data compresses the data into a slice of that height; offsetting the
// span then slides the slice to the target band.
//
// `slot` is the band's 0-based position FROM THE TOP (slot 0 = topmost),
// `count` the number of stacked bands. Falls back to a unit span when the
// data extent is missing or degenerate (flat / non-finite) so the returned
// range is always finite and can't blank the plot.
export function stackedBandRange(
  dataMin: number,
  dataMax: number,
  slot: number,
  count: number,
): [number, number] {
  const n = Math.max(1, Math.floor(count));
  const s = Math.min(Math.max(0, Math.floor(slot)), n - 1);
  let lo = Number.isFinite(dataMin) ? dataMin : 0;
  let hi = Number.isFinite(dataMax) ? dataMax : 1;
  if (!(hi > lo)) {
    // Flat or inverted extent: synthesize a span around the value so the
    // line sits centred in its band rather than dividing by zero.
    const mid = Number.isFinite((lo + hi) / 2) ? (lo + hi) / 2 : 0;
    const half = Math.max(Math.abs(mid) * 0.05, 0.5);
    lo = mid - half;
    hi = mid + half;
  }
  const bandFrac = 1 / n;
  const gap = STACK_BAND_GAP * bandFrac;
  // Normalised band edges measured from the BOTTOM (uPlot's 0..1 y space);
  // slot 0 is the topmost band, so it claims the highest normalised range.
  const normHi = 1 - s * bandFrac - gap;
  const normLo = 1 - (s + 1) * bandFrac + gap;
  const innerFrac = normHi - normLo; // bandFrac * (1 - 2 * STACK_BAND_GAP)
  const fullSpan = (hi - lo) / innerFrac;
  const scaleMin = lo - normLo * fullSpan;
  return [scaleMin, scaleMin + fullSpan];
}

// Tick/grid filter for a stacked band. Keeps only the split values inside the
// band's data extent `[lo, hi]` (replacing the rest with `null`, which uPlot
// hides), so a banded axis doesn't paint ticks across the empty space its
// expanded scale spans. A `null` extent (degenerate or not-yet-resolved data)
// or a filter that would blank the axis entirely falls back to the original
// splits so a band never loses every label.
export function bandTickFilter(
  splits: number[],
  extent: [number, number] | null,
): (number | null)[] {
  if (!extent) return splits;
  const [lo, hi] = extent;
  const kept = splits.map((v) => (v >= lo && v <= hi ? v : null));
  return kept.some((v) => v !== null) ? kept : splits;
}

// Position the hover tooltip beside the pointer, flipping to the opposite
// side before it would overflow the plot area. Anchoring by `right`/`bottom`
// (instead of `left`/`top`) when flipped makes the box grow away from the
// near edge so it can never render outside the panel — the fix for the
// value readout spilling past the right edge when hovering near it.
//
// `leftPx`/`topPx` are pointer coordinates relative to the plot area;
// `areaW`/`areaH` are that area's size. Horizontal flips only when a
// max-width tooltip wouldn't fit on the right AND the pointer is past the
// midpoint, so a panel narrower than the tooltip still lands the box on the
// side with more room rather than off the left edge. The tooltip's height is
// content-driven (one row per channel), so vertical flips by whichever half
// has more room.
export function tooltipPositionStyle(t: {
  leftPx: number;
  topPx: number;
  areaW: number;
  areaH: number;
}): CSSProperties {
  const flipX =
    t.leftPx + TOOLTIP_OFFSET_PX + TOOLTIP_MAX_WIDTH_PX > t.areaW &&
    t.leftPx > t.areaW / 2;
  const flipY = t.topPx > t.areaH / 2;
  return {
    ...(flipX
      ? { right: `${t.areaW - t.leftPx + TOOLTIP_OFFSET_PX}px` }
      : { left: `${t.leftPx + TOOLTIP_OFFSET_PX}px` }),
    ...(flipY
      ? { bottom: `${t.areaH - t.topPx + TOOLTIP_OFFSET_PX}px` }
      : { top: `${t.topPx + TOOLTIP_OFFSET_PX}px` }),
  };
}

export function PlotPanel({ panelId }: PlotPanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  // Shared relative/absolute toggle (owned by the store, driven by the
  // Transport's mode button). The x-axis tick formatter reads this so the
  // plot's time labels match the scrubber readout's mode and format.
  const timeMode = useSession((s) => s.timeMode);
  const storedBindings = useSession((s) => s.plotBindings[panelId]);
  const setPlotBinding = useSession((s) => s.setPlotBinding);
  const addPlotChannel = useSession((s) => s.addPlotChannel);
  const removePlotChannel = useSession((s) => s.removePlotChannel);
  const setPlotStackAxes = useSession((s) => s.setPlotStackAxes);
  // Gap threshold mode comes from per-panel settings (Phase 8). `null`
  // is the default and pairs with `spanGaps:true`; a positive number
  // pairs with `spanGaps:false` and explicit gap markers in mergeSeries.
  const gapThresholdSec = useSession(
    (s) => s.plotPanelSettings[panelId]?.gapThresholdSec ?? null,
  );
  // Per-channel y-axis assignment, keyed by channel id (0-based). Units no
  // longer drive grouping; the user assigns axes explicitly in the panel
  // settings. Absent entries default to axis 0 (the shared scale).
  const axisAssignments = useSession(
    (s) => s.plotPanelSettings[panelId]?.axisAssignments,
  );
  // When on, the in-use y-axes are remapped into stacked vertical bands
  // (see `stackedBandRange`) so signals on different axes don't overlap.
  // Only has a visible effect when ≥2 axes carry data.
  const stackAxes = useSession(
    (s) => s.plotPanelSettings[panelId]?.stackAxes ?? false,
  );
  // Global per-channel unit overrides. Drives the chip/series labels and
  // the axis-label "all signals share a unit" check below.
  const unitOverrides = useSession((s) => s.unitOverrides);
  // P7 — per-series transforms, keyed by channel id. A stable JSON-ish
  // string folded into `seriesKey` so editing a transform refetches.
  const transforms = useSession(
    (s) => s.plotPanelSettings[panelId]?.transforms,
  );
  // P3 — shared cross-panel hover crosshair. Read here so this panel
  // redraws its overlay when ANY plot is hovered (Grafana shared
  // crosshair). The hover *write* path is rAF-coalesced below.
  const hoverNs = useSession((s) => s.hoverNs);

  const boundChannelIds = useMemo(
    () => storedBindings ?? [],
    [storedBindings],
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  // True while a channel is dragged over this plot's area — drives the
  // drop-target highlight. Distinct from the scrub pointer path: native
  // drag events never fire pointermove, so the cursor hot path is untouched.
  const [dragOver, setDragOver] = useState(false);

  // Bumped after each successful fetch so the chips' value-at-cursor
  // readout recomputes when fresh data lands (the binary search reads a
  // ref, which React can't subscribe to on its own). Mirrors
  // TablePanel's `renderTick`.
  const [dataEpoch, setDataEpoch] = useState(0);

  const channels = useMemo(() => channelMap(sources), [sources]);
  const boundChannels = useMemo(
    () => boundChannelIds.map((id) => channels.get(id)).filter((c): c is Channel => !!c),
    [boundChannelIds, channels],
  );

  // Resolve the active transform for a bound channel id (defaulting to
  // pass-through). A small helper so the fetch effect, seriesKey, and the
  // tooltip all agree on the same transform per series.
  const transformFor = useCallback(
    (channelId: string): Transform =>
      transforms?.[channelId] ?? NONE_TRANSFORM,
    [transforms],
  );

  // Resolve a bound channel's 0-based y-axis index from the panel's
  // explicit assignments, clamped to the renderable range. Absent ⇒ 0.
  const axisOf = useCallback(
    (channelId: string): number => {
      const raw = axisAssignments?.[channelId] ?? 0;
      if (!Number.isInteger(raw) || raw < 0) return 0;
      return Math.min(raw, MAX_RENDERED_Y_AXES - 1);
    },
    [axisAssignments],
  );

  // Map each bound channel to its uPlot scale key from the explicit axis
  // assignment. Axis 0 is scale "y" (rendered LEFT); higher indices get
  // "y1", "y2", … and render on the RIGHT.
  const seriesScaleKeys = useMemo(
    () => boundChannels.map((c) => scaleKeyForAxis(axisOf(c.id))),
    [boundChannels, axisOf],
  );

  // How many distinct y-axes actually carry a bound channel. Drives the
  // "Stack" toggle's visibility (offered only with ≥2 axes) and gates the
  // band remap in the build effect — stacking a single axis is a no-op.
  const usedAxisCount = useMemo(() => {
    const used = new Set<number>();
    for (const c of boundChannels) used.add(axisOf(c.id));
    return used.size;
  }, [boundChannels, axisOf]);

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
  // uPlot bakes the axis `values` callback in at build time, but the mode
  // can flip without a rebuild — so the callback reads the live value
  // through a ref rather than the closed-over `timeMode`. The effect below
  // redraws the plot when the mode changes so labels repaint immediately.
  const timeModeRef = useRef(timeMode);
  timeModeRef.current = timeMode;

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
        // P4 — accumulate mean over finite samples only, so a NaN gap
        // (e.g. the first derivative sample) doesn't poison the average.
        let sum = 0;
        let finiteCount = 0;
        for (let i = 0; i < series.ys.length; i++) {
          const v = series.ys[i];
          if (!Number.isFinite(v)) continue;
          if (v < min) min = v;
          if (v > max) max = v;
          sum += v;
          finiteCount++;
        }
        return {
          channelId,
          min: Number.isFinite(min) ? min : NaN,
          max: Number.isFinite(max) ? max : NaN,
          mean: finiteCount > 0 ? sum / finiteCount : NaN,
          count: series.ys.length,
        };
      },
    );
    const xScale = plotRef.current?.scales?.x;
    const xScaleSec =
      xScale && xScale.min != null && xScale.max != null
        ? { min: xScale.min, max: xScale.max }
        : null;
    // Report the raw resolved min/max (including a NaN poison) so callers
    // can assert finiteness rather than have it masked into a `null`.
    const yScaleObj = plotRef.current?.scales?.y;
    const yScale =
      yScaleObj && yScaleObj.min != null && yScaleObj.max != null
        ? { min: yScaleObj.min, max: yScaleObj.max }
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
      yScale,
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

  // (Re)build uPlot whenever `seriesKey` changes. It folds in every input
  // that changes the plot's *structure* or *data*: the binding set, the
  // gap-threshold mode (flips per-series `spanGaps`, baked into the draw
  // plan), the per-channel y-axis assignment (different scales/axes), the
  // effective units (drive the axis labels), and each channel's transform
  // (P7 — different decoded ys ⇒ refetch). uPlot has no public API for
  // mutating scales/series in place, so each of these needs a fresh plot.
  const seriesKey = `${boundChannelIds.join("|")}::g=${
    gapThresholdSec ?? "off"
  }::a=${boundChannels.map((c) => axisOf(c.id)).join(",")}::u=${boundChannels
    .map((c) => effectiveUnit(c, unitOverrides) ?? "")
    .join(",")}::t=${boundChannelIds
    .map((id) => transformKey(transformFor(id)))
    .join(",")}::s=${stackAxes ? "1" : "0"}`;
  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const { fg, grid } = axisStyle();
    // X-axis carries the time-tick formatter so its labels track the
    // Transport's relative/absolute mode and use the same `formatTime`
    // helpers. Reads mode + relative origin through refs (see above) so a
    // mode toggle repaints via `redraw()` without rebuilding the plot.
    const xAxisOpts: uPlot.Axis = {
      stroke: fg,
      ticks: { stroke: grid },
      grid: { stroke: grid },
      values: (_u, splits) => {
        const startSec = globalRangeSecRef.current?.[0] ?? 0;
        return splits.map((s) =>
          formatAxisTick(s, startSec, timeModeRef.current),
        );
      },
      // Reserve more horizontal room per tick in absolute mode: the
      // `YYYY-MM-DD HH:MM:SS.mmm` label is ~3× wider than a relative
      // `MM:SS.mmm`, so the default spacing packs in enough ticks to
      // overlap. A wider minimum makes uPlot pick a coarser increment.
      space: (_u, _axisIdx, _min, _max, _dim) =>
        timeModeRef.current === "absolute" ? 180 : 70,
    };
    // Build the y-axis groups from the explicit per-channel assignments.
    // Each distinct axis index in use gets its own auto-ranged scale so a
    // 0-1 signal and a 0-10000 signal stay individually readable, and so
    // one series' NaN gaps can never poison another axis's range. Axis 0
    // is always scale "y", rendered LEFT (the e2e plot-sync specs read
    // `scales.y`); higher indices render on the RIGHT (`side:1`).
    //
    // The y-axis grows its gutter to fit the widest tick (see yAxisSize)
    // so large-magnitude signals aren't truncated at the panel edge.
    //
    // Axis label: only show a unit when EVERY signal on that axis shares
    // the same (effective) unit. Mixed-unit or unitless axes stay unlabelled.
    const usedAxes = new Set<number>();
    for (const c of boundChannels) usedAxes.add(axisOf(c.id));
    // Always keep axis 0 present so `scales.y` stays defined even with
    // zero bound channels.
    usedAxes.add(0);
    const axisOrder = [...usedAxes].sort((a, b) => a - b);
    const groupOrder = axisOrder.map(scaleKeyForAxis);

    const sharedUnitFor = (axisIdx: number): string | undefined => {
      let shared: string | null | undefined;
      for (const c of boundChannels) {
        if (axisOf(c.id) !== axisIdx) continue;
        const u = effectiveUnit(c, unitOverrides);
        if (shared === undefined) shared = u;
        else if (shared !== u) return undefined;
      }
      // `shared` is undefined (no signals) or null (all unitless) ⇒ no label.
      return shared ? shared : undefined;
    };

    // Default: each axis auto-ranges to its own data and draws across the
    // full plot height (axes overlay). Stacked: each axis that carries data
    // is remapped into its own horizontal band, lowest index on top, so the
    // signals don't overlap. `dataAxisOrder` excludes the always-present
    // axis 0 when nothing sits on it, so an empty forced axis never reserves
    // a band. Stacking is a no-op below two data-bearing axes.
    const dataAxisOrder = [
      ...new Set(boundChannels.map((c) => axisOf(c.id))),
    ].sort((a, b) => a - b);
    const stacking = stackAxes && dataAxisOrder.length >= 2;
    const bandCount = dataAxisOrder.length;
    // Data extent per banded scale, recorded by the `range` callback and read
    // by each axis's tick/grid `filter` so an axis only labels (and grids) its
    // own band — without this, the expanded scale paints ticks all through the
    // empty space outside the band. Persists across redraws within this plot;
    // a rebuild gets a fresh map.
    const bandExtent = new Map<string, [number, number] | null>();
    const yScales: uPlot.Scales = {};
    for (const key of groupOrder) yScales[key] = { auto: true };
    if (stacking) {
      dataAxisOrder.forEach((axisIdx, slot) => {
        const key = scaleKeyForAxis(axisIdx);
        yScales[key] = {
          // uPlot passes the data extent for this scale; record it for the
          // band filter, then remap it into the band. (Like the x-scale
          // `range` below, this runs synchronously inside `setData`, so the
          // resolved scale is readable immediately.)
          range: (_u, dMin, dMax) => {
            const lo = Number.isFinite(dMin) ? dMin : 0;
            const hi = Number.isFinite(dMax) ? dMax : 1;
            bandExtent.set(key, hi > lo ? [lo, hi] : null);
            return stackedBandRange(dMin, dMax, slot, bandCount);
          },
        };
      });
    }

    const yAxes: uPlot.Axis[] = axisOrder.map((axisIdx, idx) => {
      const onLeft = idx === 0;
      const rendered = idx < MAX_RENDERED_Y_AXES;
      const key = scaleKeyForAxis(axisIdx);
      const isBanded = stacking && dataAxisOrder.includes(axisIdx);
      const axis: uPlot.Axis = {
        scale: key,
        side: onLeft ? 3 : 1, // uPlot sides: 3 = left, 1 = right
        stroke: fg,
        ticks: { stroke: grid },
        // Overlaid: only the primary (left) axis paints the horizontal grid;
        // extra axes would overpaint it with their own (misaligned) lines.
        // Stacked: each banded axis owns a disjoint vertical slice, so every
        // band paints its own grid (confined to its band by the filter below)
        // and the empty forced axis paints none.
        grid: stacking
          ? isBanded
            ? { stroke: grid }
            : { show: false }
          : onLeft
            ? { stroke: grid }
            : { show: false },
        size: yAxisSize,
        label: sharedUnitFor(axisIdx),
        // Axes past the render cap still own a scale (data stays ranged)
        // but hide their axis so the gutters don't stack up.
        show: rendered,
      };
      if (isBanded) {
        // Drop ticks/gridlines that fall in the expanded scale's empty space
        // outside this band's data extent.
        axis.filter = (_self, splits) =>
          bandTickFilter(splits, bandExtent.get(key) ?? null);
      }
      return axis;
    });
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
        ...yScales,
      },
      series: [
        {},
        ...boundChannels.map((c, i) => ({
          label: channelLabel(c, unitOverrides),
          stroke: colorFor(c.id),
          width: 1,
          spanGaps,
          // P1 — pin each series to its unit-group scale.
          scale: seriesScaleKeys[i],
        })),
      ],
      axes: [xAxisOpts, ...yAxes],
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

  // Repaint axis labels when the relative/absolute mode flips. The plot
  // instance and its data are untouched — only the tick formatter's output
  // changes — so a `redraw` is enough; rebuilding would force a refetch.
  // Skip the mount run: the build effect already drew with the current
  // mode (the `values` closure reads `timeModeRef`), and redrawing a
  // freshly-built plot whose axes haven't been laid out yet throws.
  const prevTimeModeRef = useRef(timeMode);
  useEffect(() => {
    if (prevTimeModeRef.current === timeMode) return;
    prevTimeModeRef.current = timeMode;
    // `redraw(rebuildPaths=false, recalcAxes=true)`: skip the series-path
    // rebuild (data is unchanged) but force `recalcAxes` so uPlot re-runs
    // the x-axis `values` formatter and repaints the tick labels in the
    // new mode. A bare `redraw()` re-sets the x-scale to the same min/max,
    // which uPlot short-circuits — leaving the cached labels stale.
    plotRef.current?.redraw(false, true);
  }, [timeMode]);

  // Fetch & render on binding or range change.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    if (boundChannels.length === 0 || !globalRange) {
      plot.setData(EMPTY_DATA);
      lastRangeRef.current = null;
      decodedRef.current = [];
      setDataEpoch((n) => n + 1);
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
        // P7 — apply each channel's transform to its decoded series before
        // alignment. The transform produces a fresh `ys` and leaves
        // `rawTsNs`/`xs` intact, so the cursor/tooltip binary search and the
        // x-axis are unaffected. `mergeSeries` still maps any non-finite
        // value a transform emits (e.g. the first derivative sample) to a
        // gap, so the shared y-scale stays finite.
        const decoded: PlotSeries[] = batches.map((b, i) =>
          applyTransform(seriesFromArrow(b), transformFor(boundChannels[i].id)),
        );
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
        setDataEpoch((n) => n + 1);
        publishSync();
      } catch (err) {
        if (!aborted) console.error("PlotPanel fetch failed", err);
      }
    })();

    return () => {
      aborted = true;
    };
    // `transformFor` is included so editing a channel's transform refetches
    // and re-renders the derived series (it changes identity with
    // `transforms`). `seriesKey` is included so any structural rebuild (a
    // y-axis reassignment or a unit-label change creates a fresh, empty
    // uPlot instance) re-pushes data into the new plot rather than leaving
    // it blank until the next cursor tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    boundChannels,
    globalRange,
    gapThresholdSec,
    transformFor,
    publishSync,
    seriesKey,
  ]);

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

    // P3 — secondary shared-crosshair at the hovered timestamp, drawn on
    // EVERY plot (Grafana pattern): hovering one plot shows the crosshair
    // on all so a user can read the same instant across panels without
    // moving the playback cursor. A muted dashed line distinguishes it
    // from the solid playback cursor. Drawn first so the solid cursor
    // paints over it when they coincide.
    if (hoverNs !== null) {
      const hx = cursorXPx(hoverNs, range, width);
      if (hx !== null) {
        ctx.save();
        ctx.strokeStyle = HOVER_CROSSHAIR_COLOR;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(left + hx + 0.5, top);
        ctx.lineTo(left + hx + 0.5, top + height);
        ctx.stroke();
        ctx.restore();
      }
    }

    const x = cursorXPx(cursorNs, range, width);
    if (x === null) return;

    ctx.strokeStyle = cursorStrokeColor();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left + x + 0.5, top);
    ctx.lineTo(left + x + 0.5, top + height);
    ctx.stroke();
  }, [cursorNs, hoverNs, globalRange, seriesKey, publishSync]);

  // Drop this panel's sync snapshot on unmount so stale ids don't leak
  // into a test after a panel is closed.
  useEffect(() => {
    return () => {
      const store = window.__drivelinePlotPanels;
      if (store) delete store[panelId];
    };
  }, [panelId]);

  // Value-at-cursor per bound channel, for the live readout in each chip.
  // One binary search per channel against the retained raw timestamps —
  // cheap enough to run every render (cursor scrub re-renders this panel
  // anyway). `dataEpoch` is a hidden dependency: it bumps when a fetch
  // swaps `decodedRef`, so the readout refreshes when new data lands.
  void dataEpoch;
  const valueAtCursor = useMemo(() => {
    const m = new Map<string, number>();
    for (const { channelId, series } of decodedRef.current) {
      const idx = lastIndexAtOrBefore(series.rawTsNs, cursorNs);
      if (idx >= 0) m.set(channelId, series.ys[idx]);
    }
    return m;
  }, [cursorNs, dataEpoch]);

  // Drag-to-scrub on the plot. Mirrors the Transport scrubber: pointer
  // capture so a drag that leaves the panel keeps tracking, and a single
  // rAF-coalesced commit per frame so a fast drag never floods the cursor
  // hot path with `setCursor` calls.
  const pendingScrubNs = useRef<bigint | null>(null);
  const scrubRafId = useRef<number | null>(null);

  const flushScrub = useCallback(() => {
    if (pendingScrubNs.current !== null) {
      useSession.getState().setCursor(pendingScrubNs.current);
      pendingScrubNs.current = null;
    }
    scrubRafId.current = null;
  }, []);

  const scheduleScrub = useCallback(
    (ns: bigint) => {
      pendingScrubNs.current = ns;
      if (scrubRafId.current === null) {
        scrubRafId.current = requestAnimationFrame(flushScrub);
      }
    },
    [flushScrub],
  );

  // Map a pointer event to an absolute timestamp using uPlot's drawing
  // bbox (in device pixels) so the commit lands where the overlay tick
  // would draw it — i.e. inside the plotting area, not the axis gutter.
  const nsFromPointer = useCallback(
    (clientX: number): bigint | null => {
      const plot = plotRef.current;
      const container = containerRef.current;
      const range = lastRangeRef.current ?? globalRange;
      if (!plot || !container || !range) return null;
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const leftPx = plot.bbox.left / dpr;
      const widthPx = plot.bbox.width / dpr;
      return nsFromXPx(clientX - rect.left - leftPx, range, widthPx);
    },
    [globalRange],
  );

  const onScrubPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!globalRange) return;
    const ns = nsFromPointer(e.clientX);
    if (ns === null) return;
    // Scrub-start: drop the hover crosshair/tooltip — the solid playback
    // cursor takes over, and a stale hover line would double up on it.
    clearHover();
    containerRef.current?.setPointerCapture(e.pointerId);
    scheduleScrub(ns);
  };

  const onScrubPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;
    // Drag in progress (pointer captured): feed the scrub hot path only.
    if (container.hasPointerCapture(e.pointerId)) {
      const ns = nsFromPointer(e.clientX);
      if (ns !== null) scheduleScrub(ns);
      return;
    }
    // No capture → plain hover. Publish the hovered ns (shared crosshair)
    // and position the tooltip relative to the panel.
    if (!globalRange) return;
    const ns = nsFromPointer(e.clientX);
    if (ns === null) {
      clearHover();
      return;
    }
    const rect = container.getBoundingClientRect();
    scheduleHover(
      ns,
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
    );
  };

  const onScrubPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (container?.hasPointerCapture(e.pointerId)) {
      container.releasePointerCapture(e.pointerId);
    }
    if (scrubRafId.current !== null) {
      cancelAnimationFrame(scrubRafId.current);
      scrubRafId.current = null;
    }
    flushScrub();
  };

  // Cancel any in-flight scrub commit on unmount.
  useEffect(() => {
    return () => {
      if (scrubRafId.current !== null) {
        cancelAnimationFrame(scrubRafId.current);
        scrubRafId.current = null;
      }
    };
  }, []);

  // P3 — hover (distinct from drag-to-scrub). When the pointer moves over
  // the plot WITHOUT capture (no drag in progress), publish the hovered
  // ns to the store so every plot draws the shared crosshair, and position
  // a local floating tooltip. This is a hot path: coalesce to ≤1 store
  // write per rAF (mirrors the scrub pattern) and emit a perf mark so the
  // budget spec can watch it. Hover NEVER calls `setCursor`/seeks.
  const [tooltip, setTooltip] = useState<{
    leftPx: number;
    topPx: number;
    ns: bigint;
    // Plot-area size at hover time, so the tooltip can flip away from an
    // edge it would otherwise overflow (see `tooltipPositionStyle`).
    areaW: number;
    areaH: number;
  } | null>(null);
  const pendingHover = useRef<{
    ns: bigint;
    leftPx: number;
    topPx: number;
    areaW: number;
    areaH: number;
  } | null>(null);
  const hoverRafId = useRef<number | null>(null);

  const flushHover = useCallback(() => {
    hoverRafId.current = null;
    const p = pendingHover.current;
    pendingHover.current = null;
    if (p === null) return;
    mark(`plot:hover:${panelId}`);
    useSession.getState().setHoverNs(p.ns);
    setTooltip({
      leftPx: p.leftPx,
      topPx: p.topPx,
      ns: p.ns,
      areaW: p.areaW,
      areaH: p.areaH,
    });
  }, [panelId]);

  const scheduleHover = useCallback(
    (
      ns: bigint,
      leftPx: number,
      topPx: number,
      areaW: number,
      areaH: number,
    ) => {
      pendingHover.current = { ns, leftPx, topPx, areaW, areaH };
      if (hoverRafId.current === null) {
        hoverRafId.current = requestAnimationFrame(flushHover);
      }
    },
    [flushHover],
  );

  const clearHover = useCallback(() => {
    if (hoverRafId.current !== null) {
      cancelAnimationFrame(hoverRafId.current);
      hoverRafId.current = null;
    }
    pendingHover.current = null;
    setTooltip(null);
    useSession.getState().setHoverNs(null);
  }, []);

  // Clear the shared hover on unmount so a closed panel doesn't leave a
  // stale crosshair on the others.
  useEffect(() => clearHover, [clearHover]);

  // Per-series value at the hovered timestamp, for the floating tooltip.
  // One binary search per channel against retained raw timestamps — same
  // cheap pattern as `valueAtCursor`. `dataEpoch` is a hidden dep so the
  // readout refreshes when a fetch swaps `decodedRef`.
  const tooltipNs = tooltip?.ns ?? null;
  const valueAtHover = useMemo(() => {
    const m = new Map<string, number>();
    if (tooltipNs === null) return m;
    for (const { channelId, series } of decodedRef.current) {
      const idx = lastIndexAtOrBefore(series.rawTsNs, tooltipNs);
      if (idx >= 0) m.set(channelId, series.ys[idx]);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tooltipNs, dataEpoch]);

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

  // --- Drag-and-drop: accept a channel dragged from the Channels drawer. ---
  // `addPlotChannel` already dedupes and enforces MAX_PLOT_SERIES, so the
  // drop handler only has to gate on channel kind (plots render scalars).
  const onChannelDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasChannelDrag(e.dataTransfer)) return;
    // At capacity there's nowhere to put it: refuse the drop (no
    // preventDefault ⇒ the browser won't fire `drop`) and show "no-drop".
    if (atCap) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    // preventDefault marks this element as a valid drop target.
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dragOver) setDragOver(true);
  };

  const onChannelDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // dragleave also fires when crossing into child nodes (plot mount,
    // overlay canvas, tooltip); only clear when the pointer truly exits.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  };

  const onChannelDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!hasChannelDrag(e.dataTransfer)) return;
    e.preventDefault();
    setDragOver(false);
    const id = getChannelDragData(e.dataTransfer);
    if (id === null) return;
    const channel = channels.get(id);
    if (!channel || channel.kind !== "scalar") return;
    addPlotChannel(panelId, id);
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
              <span className={styles.chipLabel}>{channelLabel(c, unitOverrides)}</span>
              <span
                className={styles.chipValue}
                data-testid={`chip-value-${c.id}`}
              >
                {valueAtCursor.has(c.id)
                  ? formatValue(valueAtCursor.get(c.id)!)
                  : "—"}
              </span>
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
        {usedAxisCount >= 2 && (
          <button
            type="button"
            className={`${styles.stackBtn} ${
              stackAxes ? styles.stackBtnOn : ""
            }`}
            aria-pressed={stackAxes}
            onClick={() => setPlotStackAxes(panelId, !stackAxes)}
            data-testid="plot-stack-axes"
            title={
              stackAxes
                ? "Unstack axes — overlay all signals across the full height"
                : "Stack axes — give each y-axis its own vertical band"
            }
          >
            Stack
          </button>
        )}
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
      <div
        ref={containerRef}
        className={`${styles.plotArea} ${
          globalRange ? styles.scrubbable : ""
        } ${dragOver ? styles.dragOver : ""}`}
        role="slider"
        tabIndex={globalRange ? 0 : -1}
        aria-label="Scrub cursor on plot"
        aria-valuemin={globalRange ? Number(globalRange.startNs) : 0}
        aria-valuemax={globalRange ? Number(globalRange.endNs) : 0}
        aria-valuenow={Number(cursorNs)}
        aria-disabled={!globalRange}
        onPointerDown={onScrubPointerDown}
        onPointerMove={onScrubPointerMove}
        onPointerUp={onScrubPointerUp}
        onPointerCancel={onScrubPointerUp}
        onPointerLeave={clearHover}
        onDragOver={onChannelDragOver}
        onDragLeave={onChannelDragLeave}
        onDrop={onChannelDrop}
      >
        <div ref={plotMountRef} className={styles.plotMount} />
        <canvas ref={overlayRef} className={styles.overlay} />
        {dragOver && (
          <div
            className={styles.dropHint}
            data-testid="plot-drop-hint"
            aria-hidden
          >
            Release to add channel
          </div>
        )}
        {tooltip !== null && boundChannels.length > 0 && (
          <div
            className={styles.tooltip}
            data-testid="plot-hover-tooltip"
            // Layout-driven dynamic position only (allowed inline style):
            // beside the pointer, flipped to the far side before it would
            // overflow the plot area (see `tooltipPositionStyle`).
            // `pointer-events:none` (in CSS) keeps it from stealing the hover.
            style={tooltipPositionStyle(tooltip)}
          >
            {boundChannels.map((c) => (
              <div key={c.id} className={styles.tooltipRow}>
                <span
                  className={styles.tooltipSwatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden
                />
                <span className={styles.tooltipLabel}>{channelLabel(c, unitOverrides)}</span>
                <span className={styles.tooltipValue}>
                  {valueAtHover.has(c.id)
                    ? formatValue(valueAtHover.get(c.id)!)
                    : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
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
