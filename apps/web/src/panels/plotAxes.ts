// Pure y-axis layout helpers for PlotPanel.
//
// Extracted from PlotPanel.tsx (which was ~1900 lines of component + helpers)
// so the wiring component holds React glue and these stay independently
// testable. Behaviour is unchanged — these are the same functions the
// `yAxisSize.test.ts` / `stackedBandRange.test.ts` suites already cover.

import type uPlot from "uplot";

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

// Map a pointer's whole-plot vertical fraction (0 = top, 1 = bottom) to the
// fraction WITHIN stacked band `slot` of `count` (0 = band top = the band's
// max value, 1 = band bottom = its min). Mirrors `stackedBandRange`'s band
// edges (inset by `STACK_BAND_GAP`) so that when a band is wheel-zoomed the
// value under the pointer stays fixed, exactly like the unstacked y-zoom.
// Pointing into the inter-band gap clamps to the nearer band edge; a
// degenerate band (zero inner height) maps to its centre.
export function bandFracTop(
  fracTop: number,
  slot: number,
  count: number,
): number {
  const n = Math.max(1, Math.floor(count));
  const s = Math.min(Math.max(0, Math.floor(slot)), n - 1);
  const bandFrac = 1 / n;
  const gap = STACK_BAND_GAP * bandFrac;
  // The band's data region as top-down pixel fractions: top edge (max value)
  // at `s*bandFrac + gap`, bottom edge (min value) `gap` short of the next
  // band — the complement of stackedBandRange's bottom-up `normLo`/`normHi`.
  const topPix = s * bandFrac + gap;
  const inner = bandFrac - 2 * gap;
  if (!(inner > 0)) return 0.5;
  const f = (fracTop - topPix) / inner;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

// How many gridlines to aim for inside each stacked band. The "nice" step
// search in `niceBandSplits` lands on a round increment near `span / TARGET`,
// so the realised count is usually this ±1. Kept small because a band is only
// a slice of the plot height — a denser grid crowds once several bands stack.
export const STACK_BAND_TICK_TARGET = 4;

// Tick/grid values for a stacked band.
//
// Left to itself, uPlot picks the tick increment from the *expanded* banded
// scale (≈3.6× the data height — see stackedBandRange) and we'd hide the ticks
// that land outside the band. But "nice" on the expanded scale isn't nice on
// the visible slice: each band keeps a different, oddly-spaced subset and the
// empty margin above/below the data differs per band, so the stacked grid reads
// as irregular and misaligned.
//
// Instead we synthesise the ticks ourselves, straight from the band's own data
// extent `[lo, hi]`: snap `span / target` onto the 1·2·5·10 ladder for round
// labels, then walk that step across the extent. Every band then gets an
// evenly-spaced grid at the same density regardless of its magnitude, and
// because the values stay inside `[lo, hi]`, uPlot maps them into the band and
// never paints the expanded scale's empty margins. A `null` extent (degenerate
// or not-yet-resolved data) yields no ticks — the band's flat line needs none.
export function niceBandSplits(
  extent: [number, number] | null,
  target: number,
): number[] {
  if (!extent) return [];
  const [lo, hi] = extent;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [];
  const n = Math.max(1, Math.floor(target));
  const rawStep = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const norm = rawStep / mag; // normalised into [1, 10)
  const niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = niceNorm * mag;
  // Decimal places the step implies, used to scrub float drift from the
  // accumulator so a 0.1 step renders "31.3" rather than "31.299999999999997".
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  // Tolerance (in step units) so a value sitting essentially on a tick — modulo
  // float error — isn't skipped at the low end or dropped at the high end.
  const eps = 1e-6;
  const first = Math.ceil(lo / step - eps) * step;
  const ticks: number[] = [];
  for (let i = 0; ; i++) {
    const v = first + i * step;
    if (v > hi + step * eps) break;
    ticks.push(Number(v.toFixed(decimals)));
  }
  return ticks;
}
