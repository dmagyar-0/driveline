// Pure-ish uPlot option assembly for PlotPanel (PANEL-04).
//
// Extracted verbatim from PlotPanel.tsx's plot-build effect so the wiring
// component holds React glue and the (large) option-tree construction stays
// in one cohesive, independently reasoned-about place. Behaviour is
// IDENTICAL: the same scales, axes, series, and `range`/`values`/`splits`
// callbacks are produced. The callbacks still read live values through the
// refs the panel passes in (the panel bakes these into uPlot once at build
// time and mutates the ref targets on cursor/zoom/mode changes — see
// PlotPanel for why each is a ref), so timing and per-frame behaviour are
// unchanged.

import uPlot from "uplot";
import type {
  Channel,
  PlotAxisWindow,
  PlotZoom,
  TimeRange,
} from "../state/store";
import { effectiveUnit } from "../state/units";
import { formatAxisTick, type TimeMode } from "../timeline/formatTime";
import {
  STACK_BAND_TICK_TARGET,
  niceBandSplits,
  stackedBandRange,
  yAxisSize,
} from "./plotAxes";

// Mirror PlotPanel's `scaleKeyForAxis`: axis 0 is literally "y" so
// `plotRef.current.scales.y` stays present + finite (the e2e signalAlignment
// / plot-sync specs assert on it). Extra axes get "y1", "y2", … keys.
function scaleKeyForAxis(axisIdx: number): string {
  return axisIdx === 0 ? "y" : `y${axisIdx}`;
}

export interface BuildPlotOptionsArgs {
  /** Plot area size in CSS pixels (the container's bounding rect). */
  width: number;
  height: number;
  /** Resolved axis foreground / grid colours (from PlotPanel.axisStyle). */
  fg: string;
  grid: string;
  /** Bound scalar channels, in binding order. */
  boundChannels: Channel[];
  /** 0-based y-axis index for a bound channel id (clamped, defaults to 0). */
  axisOf: (channelId: string) => number;
  /** uPlot scale key per bound channel (parallel to `boundChannels`). */
  seriesScaleKeys: string[];
  /** Cap on rendered y-axes (axes past this own a scale but hide the gutter). */
  maxRenderedYAxes: number;
  /** Global per-channel unit overrides (drive axis labels + series labels). */
  unitOverrides: Record<string, string>;
  /** Channel display label (PlotPanel passes `channelLabel`). */
  channelLabel: (c: Channel, overrides: Record<string, string>) => string;
  /** Deterministic per-channel series colour (PlotPanel passes `colorFor`). */
  colorFor: (channelId: string) => string;
  /** Whether stacked-bands mode is active (≥2 data-bearing axes). */
  stacking: boolean;
  /** Gap threshold: null ⇒ spanGaps:true; positive ⇒ explicit gap markers. */
  gapThresholdSec: number | null;
  /** Live refs the baked-in uPlot callbacks read on each resolve. */
  globalRangeSecRef: { current: [number, number] | null };
  timeModeRef: { current: TimeMode };
  effectiveZoomXRef: { current: TimeRange | null };
  zoomRef: { current: PlotZoom | undefined };
  /** Per-axis auto-ranged DATA extent recorded by each banded scale's `range`
   *  callback. Mutated in place (cleared by the panel before each rebuild). */
  bandDataExtentRef: { current: Map<number, PlotAxisWindow> };
}

/**
 * Assemble the `uPlot.Options` for PlotPanel's current binding/axis/zoom
 * state. Pure with respect to its arguments except that it mutates
 * `bandDataExtentRef.current` (PlotPanel relies on this side effect for the
 * wheel-zoom base — same as the inline code did). The returned options carry
 * the same `range`/`values`/`splits` callbacks the panel previously inlined.
 */
export function buildPlotOptions(args: BuildPlotOptionsArgs): uPlot.Options {
  const {
    width,
    height,
    fg,
    grid,
    boundChannels,
    axisOf,
    seriesScaleKeys,
    maxRenderedYAxes,
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
  } = args;

  // X-axis carries the time-tick formatter so its labels track the
  // Transport's relative/absolute mode and use the same `formatTime`
  // helpers. Reads mode + relative origin through refs (see PlotPanel) so a
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
  const bandCount = dataAxisOrder.length;
  // Data extent per banded scale, recorded by the `range` callback and read
  // by each axis's tick/grid `filter` so an axis only labels (and grids) its
  // own band — without this, the expanded scale paints ticks all through the
  // empty space outside the band. Persists across redraws within this plot;
  // a rebuild gets a fresh map.
  const bandExtent = new Map<string, [number, number] | null>();
  // Every y-scale carries a `range` callback (resolved synchronously inside
  // `setData`, so the e2e/plot-sync specs can read `scales.y` straight off).
  // Priority per axis:
  //   - Overlay: an explicit wheel/side-menu zoom window wins; else uPlot's
  //     default auto-range (`rangeNum(d,d,0.1,true)` ≡ the built-in
  //     `snapNumY`), so an unzoomed, unstacked axis looks exactly as before.
  //   - Stacked: the band remaps its DATA extent into its vertical slice; a
  //     per-band zoom window narrows that extent (so the band shows a zoomed
  //     slice of its signal) while keeping the same slot. Either way the
  //     extent is recorded for the wheel base (bandDataExtentRef) and the
  //     ticks (bandExtent → niceBandSplits) so the grid tracks the zoom.
  const yScales: uPlot.Scales = {};
  for (const axisIdx of axisOrder) {
    const key = scaleKeyForAxis(axisIdx);
    const isBandedAxis = stacking && dataAxisOrder.includes(axisIdx);
    const slot = isBandedAxis ? dataAxisOrder.indexOf(axisIdx) : 0;
    yScales[key] = {
      auto: true,
      range: (_u, dMin, dMax) => {
        const z = zoomRef.current?.y?.[axisIdx];
        if (isBandedAxis) {
          const dataLo = Number.isFinite(dMin) ? dMin : 0;
          const dataHi = Number.isFinite(dMax) ? dMax : 1;
          bandDataExtentRef.current.set(axisIdx, {
            min: dataLo,
            max: dataHi,
          });
          const lo = z && z.max > z.min ? z.min : dataLo;
          const hi = z && z.max > z.min ? z.max : dataHi;
          bandExtent.set(key, hi > lo ? [lo, hi] : null);
          return stackedBandRange(lo, hi, slot, bandCount);
        }
        if (z) return [z.min, z.max];
        if (!Number.isFinite(dMin) || !Number.isFinite(dMax)) {
          return [null, null];
        }
        return uPlot.rangeNum(dMin, dMax, 0.1, true);
      },
    };
  }

  const yAxes: uPlot.Axis[] = axisOrder.map((axisIdx, idx) => {
    const onLeft = idx === 0;
    const rendered = idx < maxRenderedYAxes;
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
      // band paints its own grid (confined to its band by the splits below)
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
      // Generate this band's ticks from its own data extent (recorded by the
      // `range` callback above) rather than letting uPlot derive them from
      // the expanded scale — see niceBandSplits. The values stay inside the
      // band, so the grid is evenly spaced and confined to the band, and
      // every band lands the same density regardless of magnitude.
      axis.splits = () =>
        niceBandSplits(bandExtent.get(key) ?? null, STACK_BAND_TICK_TARGET);
      // Format the ticks ourselves too. uPlot's default formatter derives its
      // decimal places from the *expanded* scale's increment, which would
      // round a finer band tick (e.g. a 0.5 step) to the wrong precision; our
      // splits are already clean numbers, so render them verbatim.
      axis.values = (_self, splits) => splits.map((v) => String(v));
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
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    scales: {
      x: {
        time: true,
        // Pin the x-domain to the shared global timeline. Returning an
        // explicit range here disables uPlot's auto-fit-to-data (and
        // its range padding), so a short signal no longer stretches to
        // fill the panel — it occupies only its real slice of absolute
        // time. Falls back to the data extent only before any source
        // has set a global range.
        //
        // A wheel/side-menu x-zoom narrows the domain to its window
        // (converted ns → epoch seconds, the same precision the global
        // range uses), taking precedence over the global pin. The window
        // is the shared one when this panel is synced, else its own —
        // resolved by `effectivePlotZoomX` and read through a ref.
        range: (_u, dataMin, dataMax) => {
          const zx = effectiveZoomXRef.current;
          if (zx) {
            const lo = Number(zx.startNs) / 1e9;
            const hi = Number(zx.endNs) / 1e9;
            if (hi > lo) return [lo, hi];
          }
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
  return opts;
}
