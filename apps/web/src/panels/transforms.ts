// P7 · Per-series transforms (derived channels).
//
// A transform maps one decoded `PlotSeries` to another, producing a new
// `ys` array while leaving `xs` and `rawTsNs` untouched — the time base
// is owned by the reader and the cross-panel sync snapshot binary-searches
// `rawTsNs`, so a transform that rewrote timestamps would desync the
// cursor readout. Transforms are applied in PlotPanel's fetch effect,
// before `mergeSeries`, so the existing NaN-poison protection
// (`mergeSeries` maps non-finite ys to gaps) still covers any non-finite
// value a transform emits (e.g. the first derivative sample).
//
// Pure and side-effect free so it can be unit-tested natively.

import type { PlotSeries } from "./seriesFromArrow";

export type Transform =
  | { kind: "none" }
  | { kind: "abs" }
  // d(value)/d(t) using consecutive `rawTsNs` deltas, in value-units per
  // second. The first sample has no predecessor → NaN (renders as a gap).
  | { kind: "derivative" }
  // Affine rescale, e.g. unit conversion: y' = y * mul + add.
  | { kind: "scale"; mul: number; add: number };

export const NONE: Transform = { kind: "none" };

// Stable, compact string for a transform — folded into PlotPanel's
// `seriesKey` so changing a transform rebuilds/refetches the plot, and
// used by the drawer's `<select>` value. `none` returns "" so an
// all-default panel produces the same key it did before P7 landed.
export function transformKey(t: Transform | undefined): string {
  if (!t || t.kind === "none") return "";
  if (t.kind === "scale") return `scale:${t.mul},${t.add}`;
  return t.kind;
}

// Short human label for the chip/readout. Mirrors `transformKey` but
// reads as a suffix on the channel name (e.g. "speed Δ/s").
export function transformLabel(t: Transform | undefined): string | null {
  if (!t || t.kind === "none") return null;
  switch (t.kind) {
    case "abs":
      return "|x|";
    case "derivative":
      return "d/dt";
    case "scale":
      return `×${t.mul}${t.add ? `+${t.add}` : ""}`;
  }
}

export function applyTransform(series: PlotSeries, t: Transform): PlotSeries {
  switch (t.kind) {
    case "none":
      return series;
    case "abs":
      return withYs(series, mapYs(series.ys, Math.abs));
    case "scale": {
      const { mul, add } = t;
      return withYs(
        series,
        mapYs(series.ys, (v) => v * mul + add),
      );
    }
    case "derivative":
      return withYs(series, derivative(series));
  }
}

// Clone the series with a replacement `ys`. `xs` and `rawTsNs` are shared
// by reference (read-only by contract — see seriesFromArrow), matching the
// zero-copy posture of the rest of the pipeline.
function withYs(series: PlotSeries, ys: Float64Array): PlotSeries {
  return { xs: series.xs, ys, rawTsNs: series.rawTsNs };
}

function mapYs(ys: Float64Array, fn: (v: number) => number): Float64Array {
  const out = new Float64Array(ys.length);
  for (let i = 0; i < ys.length; i++) out[i] = fn(ys[i]);
  return out;
}

function derivative(series: PlotSeries): Float64Array {
  const { ys, rawTsNs } = series;
  const n = Math.min(ys.length, rawTsNs.length);
  const out = new Float64Array(n);
  if (n > 0) out[0] = Number.NaN; // no predecessor for the first sample
  for (let i = 1; i < n; i++) {
    // Legitimate ns → seconds compute boundary: the difference of two
    // adjacent ns timestamps is far below Number.MAX_SAFE_INTEGER even at
    // epoch scale, so the BigInt subtraction → Number is lossless here.
    const dtSec = Number(rawTsNs[i] - rawTsNs[i - 1]) / 1e9;
    // A zero (or negative) dt would divide to ±Infinity/NaN; emit NaN so
    // mergeSeries renders it as a gap rather than poisoning the y-scale.
    out[i] = dtSec > 0 ? (ys[i] - ys[i - 1]) / dtSec : Number.NaN;
  }
  return out;
}
