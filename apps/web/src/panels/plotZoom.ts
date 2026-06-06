// Mouse-wheel zoom for PlotPanel. Pure, side-effect-free helpers so the
// geometry/maths can be unit-tested without a live uPlot instance — the
// panel builds the geometry from uPlot's bbox + axis layout, then feeds it
// here. The interaction contract:
//
//   - wheel over the plot drawing area  → scale BOTH axes (x + every y);
//   - wheel over the x-axis gutter       → scale only x (the timeline);
//   - wheel over a y-axis gutter         → scale only that y-axis (so a
//     panel with several y-axes zooms just the one under the pointer).
//
// Stacked mode (each y-axis remapped into its own horizontal band) keeps the
// same shape with the band standing in for "the y under the pointer": wheel
// over a band's slice of the drawing area scales x + THAT band's y, and wheel
// over the gutter flanking a band scales only that band's y. Vertical position
// (not horizontal) picks the band, mirroring the visual stack.
//
// The x window lives in nanoseconds (`bigint`, mirroring all time state)
// so the cursor overlay / drag-to-scrub keep their precision; y windows
// are plain data-unit floats. Zoom-out that reaches the full timeline
// returns `null` so the panel stores "no x-zoom" rather than a redundant
// full-range window.

import type { PlotZoom, TimeRange } from "../state/store";

// Per-wheel-notch multiplier on the visible span. >1 zooms out, its
// reciprocal zooms in, so an in-then-out pair lands back where it started.
export const WHEEL_ZOOM_STEP = 1.15;

// Floor on the visible x-span (ns) so repeated zoom-in can never collapse
// the window to a zero-width (or inverted) range. 1 µs is far finer than
// any real sample spacing yet keeps the maths well-defined.
export const MIN_X_SPAN_NS = 1000n;

export type ZoomTarget =
  | { kind: "x" }
  | { kind: "y"; axisIdx: number }
  // `axisIdx` is set only when stacked, naming the single band to scale
  // alongside x; absent (overlay) means "x + every y-axis".
  | { kind: "both"; axisIdx?: number };

// A gutter / plot-area rectangle in CSS pixels (container-relative),
// tagged with what wheeling over it should scale.
export interface ZoomHitRect {
  target: ZoomTarget;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface ZoomGeometry {
  // The plot drawing area (uPlot's bbox) in CSS pixels.
  plot: { left: number; top: number; width: number; height: number };
  // Tagged hit rects. Overlay: one per rendered axis gutter (the x-axis +
  // each shown y-axis); the drawing area falls through to a "both" default.
  // Stacked: the x-gutter(s) plus, per band, two gutter flanks ("y") and a
  // drawing-area slice ("both") — together these tile the whole drawing area.
  axes: ZoomHitRect[];
}

// True when a panel has any active scale override (x window or ≥1 y
// window). Drives the in-plot "Reset zoom" button and the drawer control.
export function isPlotZoomed(zoom: PlotZoom | undefined): boolean {
  if (!zoom) return false;
  return zoom.x !== null || Object.keys(zoom.y).length > 0;
}

// Map a uPlot scale key to its 0-based y-axis index: "x" → null,
// "y" → 0, "y2" → 2. Inverse of PlotPanel's `scaleKeyForAxis`.
export function axisIdxFromScaleKey(key: string): number | null {
  if (key === "x") return null;
  if (key === "y") return 0;
  if (key.startsWith("y")) {
    const n = Number.parseInt(key.slice(1), 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }
  return null;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// Hit-test a pointer (CSS px, container-relative) against the plot geometry.
// Tagged rects are checked first so a stacked band's drawing-area slice (which
// overlaps the plot bbox) wins; the plot bbox is the overlay fallback, where no
// rect covers the drawing area and wheeling there scales both axes. Over a
// gutter scales just that axis. Returns null when outside every region.
export function zoomTargetForPointer(
  geom: ZoomGeometry,
  px: number,
  py: number,
): ZoomTarget | null {
  for (const r of geom.axes) {
    if (px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1) return r.target;
  }
  const p = geom.plot;
  if (
    px >= p.left &&
    px <= p.left + p.width &&
    py >= p.top &&
    py <= p.top + p.height
  ) {
    return { kind: "both" };
  }
  return null;
}

// Pointer position as a fraction across the plot drawing area, clamped to
// [0,1]. `fracX` runs left→right; `fracTop` runs top→bottom (so 0 is the
// top edge, which on a y-axis corresponds to the scale's max value).
export function plotFractions(
  geom: ZoomGeometry,
  px: number,
  py: number,
): { fracX: number; fracTop: number } {
  const p = geom.plot;
  return {
    fracX: p.width > 0 ? clamp01((px - p.left) / p.width) : 0.5,
    fracTop: p.height > 0 ? clamp01((py - p.top) / p.height) : 0.5,
  };
}

// Scale the visible x-window around `frac` by `factor`, keeping the instant
// under the pointer fixed, then clamp to `bound` (the full timeline).
// Returns null when the result would cover the whole timeline — i.e. fully
// zoomed out — so the caller stores "no x-zoom".
export function scaleWindowX(
  base: TimeRange,
  frac: number,
  factor: number,
  bound: TimeRange,
): TimeRange | null {
  const spanNs = base.endNs - base.startNs;
  if (spanNs <= 0n) return null;
  // The window spans seconds-to-hours of ns (< 2^53), so Number(spanNs) is
  // exact; only the *fraction* maths needs floats. Subtracting in BigInt
  // first then rounding to whole ns keeps the result on the ns grid.
  const spanF = Number(spanNs);
  const newSpanF = spanF * factor;
  const anchorNs = base.startNs + BigInt(Math.round(frac * spanF));
  let startNs = anchorNs - BigInt(Math.round(frac * newSpanF));
  let endNs = anchorNs + BigInt(Math.round((1 - frac) * newSpanF));

  // Zoomed out far enough to show the whole timeline ⇒ no zoom.
  if (startNs <= bound.startNs && endNs >= bound.endNs) return null;

  if (startNs < bound.startNs) startNs = bound.startNs;
  if (endNs > bound.endNs) endNs = bound.endNs;

  // Enforce the minimum span so zoom-in can't collapse the window.
  if (endNs - startNs < MIN_X_SPAN_NS) {
    const mid = startNs + (endNs - startNs) / 2n;
    startNs = mid - MIN_X_SPAN_NS / 2n;
    endNs = startNs + MIN_X_SPAN_NS;
    if (startNs < bound.startNs) {
      startNs = bound.startNs;
      endNs = bound.startNs + MIN_X_SPAN_NS;
    }
    if (endNs > bound.endNs) {
      endNs = bound.endNs;
      startNs = bound.endNs - MIN_X_SPAN_NS;
    }
  }
  return { startNs, endNs };
}

// Scale a y-window around `fracTop` (0 = top = max value) by `factor`,
// keeping the value under the pointer fixed. No global clamp — y has no
// fixed bound; "Reset zoom" returns the axis to auto-fit. A degenerate
// (flat / non-finite) base is widened to a unit span first so the result
// is always finite.
export function scaleWindowY(
  base: { min: number; max: number },
  fracTop: number,
  factor: number,
): { min: number; max: number } {
  let min = base.min;
  let max = base.max;
  if (!(max > min)) {
    const mid = Number.isFinite((min + max) / 2) ? (min + max) / 2 : 0;
    const half = Math.max(Math.abs(mid) * 0.05, 0.5);
    min = mid - half;
    max = mid + half;
  }
  const span = max - min;
  // uPlot maps min→bottom, max→top, so the value at `fracTop` is measured
  // down from the max.
  const anchor = max - fracTop * span;
  const newSpan = span * factor;
  return {
    min: anchor - (1 - fracTop) * newSpan,
    max: anchor + fracTop * newSpan,
  };
}
