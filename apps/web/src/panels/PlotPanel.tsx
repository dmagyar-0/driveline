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
// Mouse-wheel zoom (see `plotZoom.ts`) scales the x and/or y axes
// depending on where the pointer is; a "Reset zoom" button surfaces in the
// plot's top-right while any scale is overridden.
//
// Out of scope: panning, y-axis fixed range, step-hold/linear toggle.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import {
  MAX_PLOT_Y_AXES,
  effectivePlotZoomX,
  isPlotTimeAxisSynced,
  useSession,
} from "../state/store";
import type {
  Channel,
  PlotAxisWindow,
  PlotZoom,
  TimeRange,
} from "../state/store";
import { channelLabel, effectiveUnit } from "../state/units";
import { seriesFromArrow, type PlotSeries } from "./seriesFromArrow";
import { mergeSeries } from "./mergeSeries";
import { cursorStrokeColor, cursorXPx, nsFromXPx } from "./cursorOverlay";
import { MAX_PLOT_SERIES, colorFor } from "./palette";
import { getChannelDragData, hasChannelDrag } from "./channelDrag";
import { applyTransform, transformKey, type Transform } from "./transforms";
import {
  WHEEL_ZOOM_STEP,
  isPlotZoomed,
  plotFractions,
  scaleWindowX,
  scaleWindowY,
  zoomTargetForPointer,
} from "./plotZoom";
import { bandFracTop } from "./plotAxes";
import { buildPlotOptions } from "./buildPlotOptions";
import { buildZoomGeometry, tooltipPositionStyle } from "./plotGeometry";
import { channelMap } from "./shared/channels";
import { formatValue } from "./shared/formatValue";
import { lastIndexAtOrBefore } from "./shared/cursorLookup";
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

// P3 — colour for the secondary (hover) crosshair. A muted neutral that
// reads as "preview" against the solid orange playback cursor. Inlined
// rather than a CSS-var read because it's used inside a canvas draw on the
// hover hot path (no getComputedStyle per frame).
const HOVER_CROSSHAIR_COLOR = "rgba(224, 224, 224, 0.55)";

const EMPTY_X = new Float64Array();
const EMPTY_Y = new Float64Array();
const EMPTY_DATA: uPlot.AlignedData = [EMPTY_X, EMPTY_Y];

const NONE_TRANSFORM: Transform = { kind: "none" };

// uPlot scale key for a 0-based y-axis index. Index 0 is literally "y" so
// `plotRef.current.scales.y` stays present + finite (the e2e signalAlignment
// / plot-sync specs assert on it). Extra axes get "y1", "y2", … keys.
function scaleKeyForAxis(axisIdx: number): string {
  return axisIdx === 0 ? "y" : `y${axisIdx}`;
}

// Read a scale's currently-resolved [min, max] (the visible window) as the
// base for the first wheel notch on an axis that has no override yet.
function readResolvedScale(
  plot: uPlot,
  key: string,
): { min: number; max: number } | null {
  const sc = plot.scales[key];
  if (
    sc &&
    sc.min != null &&
    sc.max != null &&
    Number.isFinite(sc.min) &&
    Number.isFinite(sc.max)
  ) {
    return { min: sc.min, max: sc.max };
  }
  return null;
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
  // Wheel-zoom windows for this panel (x/y scale overrides). Subscribed so
  // the panel re-applies them to uPlot and toggles the "Reset zoom" button
  // when they change. Absent (undefined) ⇒ no zoom. The per-panel `x` is
  // only the source of truth when this panel is NOT synced — see
  // `effectiveZoomX` below — but `zoom.y` is always per-panel.
  const zoom = useSession((s) => s.plotZoom[panelId]);
  // Whether this plot's time axis follows the shared (synced) window. Synced
  // is the default; the user opts out per-panel from the drawer.
  const syncTimeAxis = useSession((s) => isPlotTimeAxisSynced(s, panelId));
  // The time window this plot actually displays: the shared window when
  // synced, else this panel's own x-zoom. `null` ⇒ fit the full range. The
  // scale callback, the wheel base, and the reset-button check all read it,
  // so a synced panel tracks `sharedPlotZoomX` and an unsynced one its own.
  const effectiveZoomX = useSession((s) => effectivePlotZoomX(s, panelId));

  const boundChannelIds = useMemo(() => storedBindings ?? [], [storedBindings]);

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
    () =>
      boundChannelIds
        .map((id) => channels.get(id))
        .filter((c): c is Channel => !!c),
    [boundChannelIds, channels],
  );

  // Resolve the active transform for a bound channel id (defaulting to
  // pass-through). A small helper so the fetch effect, seriesKey, and the
  // tooltip all agree on the same transform per series.
  const transformFor = useCallback(
    (channelId: string): Transform => transforms?.[channelId] ?? NONE_TRANSFORM,
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

  // The distinct y-axes that actually carry a bound channel, ascending.
  // `usedAxisCount` drives the "Stack" toggle's visibility (offered only
  // with ≥2 axes) and gates the band remap; the index list is the set of
  // axes a "scale both" wheel over the plot area zooms.
  const usedAxisIndices = useMemo(() => {
    const used = new Set<number>();
    for (const c of boundChannels) used.add(axisOf(c.id));
    return [...used].sort((a, b) => a - b);
  }, [boundChannels, axisOf]);
  const usedAxisCount = usedAxisIndices.length;
  // Stacking is only meaningful (and only remaps the y-scales) with ≥2
  // data-bearing axes; the wheel handler skips y-zoom while it's on,
  // since each band already owns its axis's vertical slice.
  const stacking = stackAxes && usedAxisCount >= 2;
  const usedAxisIndicesRef = useRef(usedAxisIndices);
  usedAxisIndicesRef.current = usedAxisIndices;
  const stackingRef = useRef(stacking);
  stackingRef.current = stacking;

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
        ? [Number(globalRange.startNs) / 1e9, Number(globalRange.endNs) / 1e9]
        : null,
    [globalRange],
  );
  // uPlot's x-range callback runs synchronously inside `setData`, well
  // after this render commits, so it must read the latest value through
  // a ref rather than the closed-over `globalRangeSec`.
  const globalRangeSecRef = useRef<[number, number] | null>(globalRangeSec);
  globalRangeSecRef.current = globalRangeSec;
  // The full timeline in ns (the x-zoom base + clamp bound) and the live
  // zoom windows, read through refs so the scale `range` callbacks (baked
  // in at build time) and the native wheel handler (attached once) always
  // see current values without a rebuild / re-bind.
  const globalRangeRef = useRef<TimeRange | null>(globalRange);
  globalRangeRef.current = globalRange;
  const zoomRef = useRef<PlotZoom | undefined>(zoom);
  zoomRef.current = zoom;
  // The visible x-window (shared-or-own, resolved by `effectivePlotZoomX`),
  // read by the x-scale `range` callback through a ref so a synced panel
  // picks up `sharedPlotZoomX` changes without a rebuild — same posture as
  // `zoomRef` for the y-axes.
  const effectiveZoomXRef = useRef<TimeRange | null>(effectiveZoomX);
  effectiveZoomXRef.current = effectiveZoomX;
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
  const decodedRef = useRef<{ channelId: string; series: PlotSeries }[]>([]);
  // Per-axis auto-ranged DATA extent recorded by each banded scale's `range`
  // callback (keyed by 0-based axis index). The wheel handler needs this as
  // the base for the first per-band zoom notch: while stacked, the resolved
  // `plot.scales[key]` holds the EXPANDED band range (≈3.6× the data), not the
  // data extent, so `readResolvedScale` would zoom against the wrong span.
  const bandDataExtentRef = useRef<Map<number, PlotAxisWindow>>(new Map());

  // seriesStats are O(total samples) to compute — extract them once when
  // decoded data changes and cache in a ref. publishSync reads the cached
  // value; the cursor tick never recomputes min/max/mean.
  const seriesStatsRef = useRef<PlotSeriesStats[]>([]);

  // Recompute seriesStats from a decoded array. Called every time
  // decodedRef.current is assigned (fetch effect + empty-data path).
  const recomputeSeriesStats = useCallback(
    (decoded: { channelId: string; series: PlotSeries }[]): void => {
      seriesStatsRef.current = decoded.map(({ channelId, series }) => {
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
      });
    },
    [],
  );

  const publishSync = useCallback(() => {
    const store = (window.__drivelinePlotPanels ??= {});
    const decoded = decodedRef.current;
    // Read current cursorNs directly from the store so this callback does
    // not need cursorNs in its dep list — keeping it stable across cursor
    // ticks. The overlay effect that calls publishSync re-runs per tick so
    // getState() is always fresh.
    const cursorNs = useSession.getState().cursorNs;
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
    // seriesStats are pre-computed when data changes (see recomputeSeriesStats),
    // not here — this path is on the cursor/hover hot path at ~60 Hz.
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
      seriesStats: seriesStatsRef.current,
      xScaleSec,
      yScale,
    };
  }, [boundChannelIds, panelId]);

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
  //
  // Memoised so the four `.map().join()` passes don't run on every render
  // (e.g. cursor ticks); the key only changes when its actual inputs change.
  const seriesKey = useMemo(
    () =>
      `${boundChannelIds.join("|")}::g=${
        gapThresholdSec ?? "off"
      }::a=${boundChannels.map((c) => axisOf(c.id)).join(",")}::u=${boundChannels
        .map((c) => effectiveUnit(c, unitOverrides) ?? "")
        .join(",")}::t=${boundChannelIds
        .map((id) => transformKey(transformFor(id)))
        .join(",")}::s=${stackAxes ? "1" : "0"}`,
    [
      boundChannelIds,
      boundChannels,
      gapThresholdSec,
      axisOf,
      unitOverrides,
      transformFor,
      stackAxes,
    ],
  );
  useEffect(() => {
    const mount = plotMountRef.current;
    const container = containerRef.current;
    if (!mount || !container) return;

    const rect = container.getBoundingClientRect();
    const { fg, grid } = axisStyle();
    // Assemble the uPlot option tree (x/y scales, axes, series + their
    // baked-in `range`/`values`/`splits` callbacks) in `buildPlotOptions`
    // (PANEL-04). The factory is given the same live refs the inline code
    // closed over, so the built callbacks read current zoom/mode/range
    // values without a rebuild — behaviour is identical to the previous
    // inline assembly. The factory also mutates `bandDataExtentRef` (the
    // wheel-zoom base) exactly as the inline code did.
    const opts = buildPlotOptions({
      width: rect.width,
      height: rect.height,
      fg,
      grid,
      boundChannels,
      axisOf,
      seriesScaleKeys,
      maxRenderedYAxes: MAX_RENDERED_Y_AXES,
      unitOverrides,
      channelLabel,
      colorFor,
      stacking,
      gapThresholdSec,
      globalRangeSecRef,
      timeModeRef,
      effectiveZoomXRef,
      zoomRef,
      bandDataExtentRef,
    });
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
    seriesStatsRef.current = [];
    // Drop band data extents from the previous axis layout; the new scales'
    // `range` callbacks repopulate this on the first `setData`.
    bandDataExtentRef.current.clear();

    return () => {
      plot.destroy();
      if (plotRef.current === plot) plotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesKey]);

  // Apply wheel/side-menu zoom changes to the live plot. The scale `range`
  // callbacks above read `zoomRef`, so re-resolving every scale via
  // `setData(plot.data)` (resetScales defaults true) re-fits to the current
  // zoom — or back to global/auto on reset — without a rebuild or refetch.
  // A layout effect run synchronously (uPlot itself batches the actual
  // canvas repaint through its own rAF, so a wheel burst still paints ≤1×
  // per frame) so the rescale lands in the same commit as the React state
  // change — no one-frame lag while wheeling. On mount `plotRef` is still
  // null (the build effect runs after layout effects), so the first run is a
  // no-op and the build/fetch path owns the initial draw.
  //
  // Mirror publishSync through a ref so the zoom layout-effect can call
  // the latest version without adding it to the effect's dep list.
  const publishSyncRef = useRef(publishSync);
  publishSyncRef.current = publishSync;
  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    mark(`plot:zoom:${panelId}`);
    // `setData` alone defers its scale resolution to a microtask; `batch`
    // runs uPlot's commit synchronously, so the re-resolved scales are
    // readable immediately for the republish below.
    plot.batch(() => {
      plot.setData(plot.data);
    });
    // Re-publish so the sync snapshot's resolved `xScaleSec` / `yScale`
    // reflect the post-rescale scales (the cursor-overlay effect's publish
    // ran before this one, when the scales were still pre-zoom).
    publishSyncRef.current();
    // `effectiveZoomX` is in the deps so a synced panel re-resolves its
    // x-scale when `sharedPlotZoomX` changes (another plot zoomed); `zoom`
    // covers this panel's own y (and own x while unsynced).
  }, [zoom, effectiveZoomX, panelId]);

  // Mouse-wheel zoom. A native, non-passive listener so it can
  // `preventDefault()` the page scroll (React's synthetic onWheel is
  // passive and can't). Attached once; reads geometry from the live uPlot
  // and the rest through render-synced refs / `getState`, then writes the
  // computed window(s) to the store — the layout effect above applies them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      const plot = plotRef.current;
      const bound = globalRangeRef.current;
      if (!plot || !bound) return;
      const geom = buildZoomGeometry(
        plot,
        stackingRef.current,
        usedAxisIndicesRef.current,
      );
      if (!geom) return;
      const rect = container.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const target = zoomTargetForPointer(geom, px, py);
      if (target === null) return;
      // Over an interactive region: take over the wheel from page scroll.
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1 / WHEEL_ZOOM_STEP : WHEEL_ZOOM_STEP;
      const { fracX, fracTop } = plotFractions(geom, px, py);
      const st = useSession.getState();
      const z = st.plotZoom[panelId];
      if (target.kind === "x" || target.kind === "both") {
        // Zoom from whatever this panel currently shows (shared window when
        // synced, else its own), then route the result back the same way:
        // `applyPlotZoomX` writes the shared window for a synced panel —
        // moving every synced plot — or this panel's own x otherwise.
        const base = effectiveZoomXRef.current ?? bound;
        st.applyPlotZoomX(panelId, scaleWindowX(base, fracX, factor, bound));
      }
      // Y-zoom. Overlay: scale every targeted axis (one gutter axis, or all
      // used axes for a "both") across the full plot height. Stacked: scale
      // just the band under the pointer, anchored at the pointer's position
      // WITHIN that band and based on the band's own data extent — the
      // resolved scale holds the expanded band range, so we read the recorded
      // data extent (bandDataExtentRef) instead.
      if (target.kind === "y" || target.kind === "both") {
        if (stackingRef.current) {
          const axisIdx = target.axisIdx;
          const order = usedAxisIndicesRef.current;
          const slot = axisIdx == null ? -1 : order.indexOf(axisIdx);
          if (axisIdx != null && slot >= 0) {
            const base =
              z?.y?.[axisIdx] ?? bandDataExtentRef.current.get(axisIdx);
            if (base) {
              const fracBand = bandFracTop(fracTop, slot, order.length);
              st.setPlotZoomY(
                panelId,
                axisIdx,
                scaleWindowY(base, fracBand, factor),
              );
            }
          }
        } else {
          const axes =
            target.kind === "y" ? [target.axisIdx] : usedAxisIndicesRef.current;
          for (const axisIdx of axes) {
            const key = scaleKeyForAxis(axisIdx);
            const base = z?.y?.[axisIdx] ?? readResolvedScale(plot, key);
            if (!base) continue;
            st.setPlotZoomY(
              panelId,
              axisIdx,
              scaleWindowY(base, fracTop, factor),
            );
          }
        }
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [panelId]);

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
      recomputeSeriesStats([]);
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
        recomputeSeriesStats(decodedRef.current);
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
    // fetch. One binary search per bound channel; seriesStats are
    // pre-computed on data change (not recomputed here).
    publishSync();

    const overlay = overlayRef.current;
    const plot = plotRef.current;
    if (!overlay || !plot) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    // Project the cursor/hover over the VISIBLE x-window: when x is zoomed
    // the drawing area spans the effective window (the shared one when this
    // panel is synced, else its own — a sub-range of the fetched global
    // range), so a cursor outside that window resolves to `null` and draws
    // nothing (correctly off-screen). Unzoomed it's the full fetched range.
    const range = effectiveZoomX ?? lastRangeRef.current ?? globalRange;
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
    // `effectiveZoomX` is a dep so the cursor/crosshair reproject after a
    // wheel zoom — including when ANOTHER synced plot drives the shared
    // window — which changes the visible range without touching cursorNs.
  }, [cursorNs, hoverNs, globalRange, seriesKey, publishSync, effectiveZoomX]);

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
  //
  // The Map is mutated in-place (stable ref) rather than allocated fresh
  // each tick — safe because valueAtCursor is consumed only inline in this
  // component's render, never passed as a prop to a memoized child or used
  // in a dep array. React re-renders due to cursorNs changing regardless,
  // so chip text always reflects the current value.
  const valueAtCursorRef = useRef<Map<string, number>>(new Map());
  void dataEpoch;
  const valueAtCursor = valueAtCursorRef.current;
  valueAtCursor.clear();
  for (const { channelId, series } of decodedRef.current) {
    const idx = lastIndexAtOrBefore(series.rawTsNs, cursorNs);
    if (idx >= 0) valueAtCursor.set(channelId, series.ys[idx]);
  }

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
      // Map over the VISIBLE window so a drag-scrub while zoomed lands on
      // the instant under the pointer (not on the full fetched range). Uses
      // the effective window (shared when synced, else this panel's own).
      const range =
        effectiveZoomXRef.current ?? lastRangeRef.current ?? globalRange;
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
            <span
              key={c.id}
              className={styles.chip}
              data-testid={`chip-${c.id}`}
            >
              <span
                className={styles.chipSwatch}
                style={{ background: colorFor(c.id) }}
                aria-hidden
              />
              <span className={styles.chipLabel}>
                {channelLabel(c, unitOverrides)}
              </span>
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
        {(effectiveZoomX !== null || isPlotZoomed(zoom)) && (
          <button
            type="button"
            className={styles.resetZoom}
            // Sits above the (pointer-events:none) overlay; stop the
            // pointerdown so a click here doesn't also start a drag-scrub
            // on the plot area beneath it.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              useSession.getState().clearPlotZoom(panelId);
            }}
            data-testid="plot-reset-zoom"
            title={
              syncTimeAxis
                ? "Reset zoom to fit (time axis is synced across plots)"
                : "Reset zoom to fit"
            }
          >
            Reset zoom
          </button>
        )}
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
                <span className={styles.tooltipLabel}>
                  {channelLabel(c, unitOverrides)}
                </span>
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
