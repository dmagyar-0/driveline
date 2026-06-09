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

// uPlot's shared y-scale auto-range seeds its min/max from the first
// non-null sample and combines every series on the scale via
// `Math.min`/`Math.max` (see `accScale`/`getMinMax` in uplot's source).
// Its null test is `v != null`, which lets `NaN` through — so a single
// non-finite value (a `NaN` from an unparseable sample, or ±Infinity)
// poisons the scale to `[NaN, NaN]` and blanks *every* series, not just
// the offending one. Mapping non-finite values to `null` makes uPlot
// treat them as gaps (skipped by the range scan) instead of poison.
function finiteOrNull(ys: Float64Array): YSeries {
  let hasNonFinite = false;
  for (let i = 0; i < ys.length; i++) {
    if (!Number.isFinite(ys[i])) {
      hasNonFinite = true;
      break;
    }
  }
  // Common case — every sample is finite: hand uPlot the zero-copy array.
  if (!hasNonFinite) return ys;
  const out: (number | null)[] = new Array(ys.length);
  for (let i = 0; i < ys.length; i++) {
    const v = ys[i];
    out[i] = Number.isFinite(v) ? v : null;
  }
  return out;
}

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
      return { xs: inputs[0].xs, ys: [finiteOrNull(inputs[0].ys)] };
    }
    return mergeUnion(inputs);
  }

  return mergeStepHold(inputs, gapThresholdSec);
}

function mergeUnion(inputs: PlotSeries[]): AlignedSeries {
  // k-way merge with one cursor per input. xs are already sorted
  // non-decreasing (asserted in seriesFromArrow.test.ts).
  const k = inputs.length;

  // Pass 1: count the exact union length (outN) by running the k-way
  // merge without materialising values. This is a cheap index-only scan
  // that lets us allocate outXs and each outYs array at the exact right
  // size, avoiding both the over-allocated upper-bound arrays and the
  // trailing .slice() copy that the single-pass approach needed.
  let total = 0;
  for (let i = 0; i < k; i++) total += inputs[i].xs.length;

  const cursors = new Int32Array(k);
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
    for (let i = 0; i < k; i++) {
      if (cursors[i] < inputs[i].xs.length && inputs[i].xs[cursors[i]] === minX) {
        cursors[i]++;
      }
    }
    outN++;
  }

  // Pass 2: allocate exactly-sized output arrays and fill them.
  // outN is now exact — no trailing slice needed.
  const outXs = new Float64Array(outN);
  const outYs: (number | null)[][] = [];
  for (let i = 0; i < k; i++) outYs.push(new Array(outN).fill(null));

  cursors.fill(0);
  let n = 0;
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

    outXs[n] = minX;
    for (let i = 0; i < k; i++) {
      const c = cursors[i];
      if (c < inputs[i].xs.length && inputs[i].xs[c] === minX) {
        const v = inputs[i].ys[c];
        outYs[i][n] = Number.isFinite(v) ? v : null;
        cursors[i] = c + 1;
      }
    }
    n++;
  }

  return {
    xs: outXs,
    ys: outYs,
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
  const k = inputs.length;

  // Output xs is the union of (real samples ∪ per-series gap markers).
  // Pre-count both so we can allocate the output Float64Array once.
  // Worst case (every interval > threshold) adds 2 × samples.
  let upper = 0;
  for (let i = 0; i < k; i++) {
    const xs = inputs[i].xs;
    upper += xs.length;
    for (let j = 1; j < xs.length; j++) {
      if (xs[j] - xs[j - 1] > threshold) upper += 2;
    }
  }

  // Per-input cursor over the augmented sequence (real samples + gap
  // markers). `markerPhase` encodes which of the two pending markers
  // we'll emit next, ahead of advancing past the gap:
  //   0 = none queued — `nextX` reads `xs[cursorIdx]`
  //   1 = held-end marker (`lastX + threshold`) is next
  //   2 = gap-start marker (`lastX + threshold + ε`) is next
  // Markers are queued lazily on cursor advance: once we consume real
  // sample `xs[c]`, peek `xs[c+1]` and queue a pair iff the dx exceeds
  // threshold, so the next `nextX` returns the held-end marker before
  // the post-gap real sample.
  const cursorIdx = new Int32Array(k);
  const markerPhase = new Uint8Array(k);
  const marker1 = new Float64Array(k);
  const marker2 = new Float64Array(k);

  // Returns NaN when input i is exhausted; callers guard with NaN check.
  const nextX = (i: number): number => {
    const ph = markerPhase[i];
    if (ph === 1) return marker1[i];
    if (ph === 2) return marker2[i];
    const idx = cursorIdx[i];
    const ixs = inputs[i].xs;
    return idx < ixs.length ? ixs[idx] : Number.NaN;
  };

  const consume = (i: number): void => {
    const ph = markerPhase[i];
    if (ph === 1) { markerPhase[i] = 2; return; }
    if (ph === 2) { markerPhase[i] = 0; return; }
    const ixs = inputs[i].xs;
    const idx = cursorIdx[i];
    const next = idx + 1;
    cursorIdx[i] = next;
    if (next < ixs.length && ixs[next] - ixs[idx] > threshold) {
      const m1 = ixs[idx] + threshold;
      marker1[i] = m1;
      marker2[i] = m1 + epsilon;
      markerPhase[i] = 1;
    }
  };

  // k-way merge with inline dedupe. Total cost O((N+G)·k), one
  // allocation for xsBuf — same shape as `mergeUnion` but with the
  // augmented per-input streams.
  //
  // Dedupe via `===` is bit-exact on Float64 (NaN is excluded by the
  // guard above): two values that *should* compare equal always do,
  // because IEEE-754 arithmetic on identical operands is deterministic.
  // The only loss is values "morally" equal but reached via different
  // arithmetic paths — those just leave a sub-ε extra entry in xs,
  // visually indistinguishable from the held-end marker.
  const xsBuf = new Float64Array(upper);
  let n = 0;
  while (true) {
    let minX = Number.POSITIVE_INFINITY;
    let any = false;
    for (let i = 0; i < k; i++) {
      const x = nextX(i);
      if (!Number.isNaN(x)) {
        any = true;
        if (x < minX) minX = x;
      }
    }
    if (!any) break;
    if (n === 0 || xsBuf[n - 1] !== minX) {
      xsBuf[n++] = minX;
    }
    for (let i = 0; i < k; i++) {
      if (nextX(i) === minX) consume(i);
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
        // A non-finite held value would poison uPlot's shared y-scale
        // (see `finiteOrNull`); a `NaN` sample means "no value", so it
        // reads as a gap rather than a step-held poison.
        out[i] = Number.isFinite(lastY) ? lastY : null;
      }
    }
    return out;
  });

  return { xs, ys };
}
