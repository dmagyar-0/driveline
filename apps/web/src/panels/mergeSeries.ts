// Align N scalar series onto a shared x-axis for uPlot (T4.2).
//
// uPlot's AlignedData is `[xs, ys1, ys2, ...]` — every y has to index
// into the same xs. Scalar channels from different sources rarely share
// every sample timestamp, so we k-way merge their xs into a union and
// emit per-series y arrays aligned to that union, filling the gaps with
// `null` so uPlot's default step-hold draws a flat segment across them.
//
// The common case in T4.2 is two same-name channels from MCAP + MF4 that
// share identical ts (docs/09-verification-plan.md:44-45); the merge
// degenerates to a single interleave. The single-series case is a plain
// pass-through so T4.1 perf doesn't regress.

import type { PlotSeries } from "./seriesFromArrow";

export type YSeries = Float64Array | (number | null)[];

export interface AlignedSeries {
  xs: Float64Array;
  ys: YSeries[];
}

const EMPTY: AlignedSeries = {
  xs: new Float64Array(),
  ys: [],
};

export function mergeSeries(inputs: PlotSeries[]): AlignedSeries {
  if (inputs.length === 0) return EMPTY;
  if (inputs.length === 1) {
    return { xs: inputs[0].xs, ys: [inputs[0].ys] };
  }

  // k-way merge with one cursor per input. xs are already sorted
  // non-decreasing (asserted in seriesFromArrow.test.ts).
  const k = inputs.length;
  const cursors = new Int32Array(k);
  let total = 0;
  for (let i = 0; i < k; i++) total += inputs[i].xs.length;

  // Upper bound: strict union can be shorter when xs coincide; resize
  // at the end rather than scan twice.
  const outXs = new Float64Array(total);
  const outYs: (number | null)[][] = [];
  for (let i = 0; i < k; i++) outYs.push(new Array(total).fill(null));

  let outN = 0;
  while (true) {
    let minX = Number.POSITIVE_INFINITY;
    let any = false;
    for (let i = 0; i < k; i++) {
      const c = cursors[i];
      if (c < inputs[i].xs.length) {
        const x = inputs[i].xs[c];
        if (x < minX) minX = x;
        any = true;
      }
    }
    if (!any) break;

    outXs[outN] = minX;
    for (let i = 0; i < k; i++) {
      const c = cursors[i];
      if (c < inputs[i].xs.length && inputs[i].xs[c] === minX) {
        outYs[i][outN] = inputs[i].ys[c];
        cursors[i] = c + 1;
      }
    }
    outN++;
  }

  return {
    xs: outXs.subarray(0, outN),
    ys: outYs.map((y) => y.slice(0, outN)),
  };
}
