// Align N scalar series onto a shared x-axis for uPlot (T4.2).
//
// uPlot's AlignedData is `[xs, ys1, ys2, ...]` — every y has to index
// into the same xs. Scalar channels from different sources rarely share
// every sample timestamp, so we k-way merge their xs into a union and
// emit per-series y arrays aligned to that union.
//
// Two output modes, controlled by `gapThresholdSec`:
//
// 1. `gapThresholdSec === null` (default — preserves the bug-fix
//    behavior shipped in PR #83). Missing-sample slots are filled with
//    `null`. The renderer must use `spanGaps: true` so two same-rate
//    signals on different CAN mailboxes — every-other-slot null per
//    series — don't collapse to invisible dots. The trade-off is that
//    a real channel-loss gap (broadcast stops for several seconds) is
//    indistinguishable from a normal alignment artifact: both render
//    as a horizontal hold.
//
// 2. `gapThresholdSec` finite & > 0. Per-series step-hold: missing
//    slots within the threshold of the last real sample are filled with
//    that sample's value (matching the documented step-hold behavior in
//    `docs/03-data-model.md`); slots beyond the threshold become `null`.
//    To keep the held line visible right up to the gap edge, two
//    synthetic xs are injected per detected gap — one at the held-end
//    (`lastX + threshold`) and one a tick later that flips the series to
//    `null`. The renderer pairs this with `spanGaps: false` so the
//    explicit nulls render as gaps. This makes real dropouts
//    discoverable without losing the multi-mailbox interleave fix.

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

export function mergeSeries(
  inputs: PlotSeries[],
  gapThresholdSec: number | null = null,
): AlignedSeries {
  if (inputs.length === 0) return EMPTY;

  // Default mode: union + null at non-coincident timestamps. PlotPanel
  // pairs this with `spanGaps:true` (see PlotPanel.tsx series opts).
  if (
    gapThresholdSec === null ||
    !Number.isFinite(gapThresholdSec) ||
    gapThresholdSec <= 0
  ) {
    if (inputs.length === 1) {
      return { xs: inputs[0].xs, ys: [inputs[0].ys] };
    }
    return mergeUnion(inputs);
  }

  return mergeStepHold(inputs, gapThresholdSec);
}

function mergeUnion(inputs: PlotSeries[]): AlignedSeries {
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

function mergeStepHold(
  inputs: PlotSeries[],
  threshold: number,
): AlignedSeries {
  // Sentinel offset used to place the "gap-start" marker just past the
  // held-end marker. uPlot renders consecutive x-positions in order, so
  // any strictly positive offset breaks the line; we keep it small
  // relative to the threshold so the visual break sits as close as
  // possible to `lastX + threshold`. The min floor handles
  // pathologically tiny thresholds where `threshold * 1e-6` would
  // underflow to zero.
  const epsilon = Math.max(threshold * 1e-6, 1e-9);

  // Collect candidate xs: every real sample plus, for each detected
  // intra-series gap, a "held-end" marker at `lastX + threshold` and a
  // "gap-start" marker at `lastX + threshold + epsilon`.
  const candidate: number[] = [];
  for (const inp of inputs) {
    const xs = inp.xs;
    for (let i = 0; i < xs.length; i++) {
      candidate.push(xs[i]);
      if (i > 0 && xs[i] - xs[i - 1] > threshold) {
        const heldEnd = xs[i - 1] + threshold;
        candidate.push(heldEnd);
        candidate.push(heldEnd + epsilon);
      }
    }
  }
  candidate.sort((a, b) => a - b);

  // Dedupe ascending. Float comparison is exact here because all values
  // came from input.xs (Float64) or arithmetic on those values, never
  // from user-typed thresholds.
  const xsBuf = new Float64Array(candidate.length);
  let n = 0;
  for (let i = 0; i < candidate.length; i++) {
    if (n === 0 || candidate[i] !== xsBuf[n - 1]) {
      xsBuf[n++] = candidate[i];
    }
  }
  const xs = xsBuf.subarray(0, n);

  // Per-series walk: step-hold within threshold, null beyond.
  const ys: (number | null)[][] = inputs.map((inp) => {
    const out: (number | null)[] = new Array(n).fill(null);
    const ixs = inp.xs;
    const iys = inp.ys;
    let cursor = 0;
    let hasSample = false;
    let lastX = 0;
    let lastY = 0;
    for (let i = 0; i < n; i++) {
      const ux = xs[i];
      while (cursor < ixs.length && ixs[cursor] <= ux) {
        lastX = ixs[cursor];
        lastY = iys[cursor];
        hasSample = true;
        cursor++;
      }
      if (!hasSample) {
        out[i] = null;
      } else if (ux - lastX > threshold) {
        out[i] = null;
      } else {
        out[i] = lastY;
      }
    }
    return out;
  });

  return { xs, ys };
}
