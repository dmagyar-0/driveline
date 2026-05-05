import { describe, expect, it } from "vitest";
import { mergeSeries } from "./mergeSeries";
import type { PlotSeries } from "./seriesFromArrow";

function mk(xs: number[], ys: number[]): PlotSeries {
  // `rawTsNs` is only used by the T6.1 cross-panel sync snapshot; these
  // merge unit tests work in seconds and don't exercise that field.
  // Build a parallel BigInt64 view from `xs` so the shape is complete.
  const rawTsNs = new BigInt64Array(xs.length);
  for (let i = 0; i < xs.length; i++) rawTsNs[i] = BigInt(Math.round(xs[i]));
  return {
    xs: new Float64Array(xs),
    ys: new Float64Array(ys),
    rawTsNs,
  };
}

describe("mergeSeries", () => {
  it("returns empty for no inputs", () => {
    const out = mergeSeries([]);
    expect(out.xs.length).toBe(0);
    expect(out.ys).toEqual([]);
  });

  it("passes the single-series case through without copying", () => {
    const s = mk([1, 2, 3], [10, 20, 30]);
    const out = mergeSeries([s]);
    expect(out.xs).toBe(s.xs);
    expect(out.ys.length).toBe(1);
    expect(out.ys[0]).toBe(s.ys);
  });

  it("coalesces identical timestamps across two series", () => {
    const a = mk([1, 2, 3], [10, 20, 30]);
    const b = mk([1, 2, 3], [100, 200, 300]);
    const out = mergeSeries([a, b]);
    expect(Array.from(out.xs)).toEqual([1, 2, 3]);
    expect(out.ys[0]).toEqual([10, 20, 30]);
    expect(out.ys[1]).toEqual([100, 200, 300]);
  });

  it("fills nulls for missing samples in either series", () => {
    const a = mk([1, 3], [10, 30]);
    const b = mk([2, 3], [200, 300]);
    const out = mergeSeries([a, b]);
    expect(Array.from(out.xs)).toEqual([1, 2, 3]);
    expect(out.ys[0]).toEqual([10, null, 30]);
    expect(out.ys[1]).toEqual([null, 200, 300]);
  });

  it("handles completely disjoint series", () => {
    const a = mk([1, 2], [10, 20]);
    const b = mk([3, 4], [300, 400]);
    const out = mergeSeries([a, b]);
    expect(Array.from(out.xs)).toEqual([1, 2, 3, 4]);
    expect(out.ys[0]).toEqual([10, 20, null, null]);
    expect(out.ys[1]).toEqual([null, null, 300, 400]);
  });

  it("tolerates an empty series alongside a populated one", () => {
    const a = mk([], []);
    const b = mk([1, 2], [100, 200]);
    const out = mergeSeries([a, b]);
    expect(Array.from(out.xs)).toEqual([1, 2]);
    expect(out.ys[0]).toEqual([null, null]);
    expect(out.ys[1]).toEqual([100, 200]);
  });

  it("merges three series with partial overlap into a single union", () => {
    // k = 3 exercises the k-way merge cursor loop that k = 2 can
    // collapse to a single interleave. Union timestamps are
    // [1, 2, 3, 4, 5]; each series supplies the values it owns and
    // gets `null` everywhere else.
    const a = mk([1, 3, 5], [10, 30, 50]);
    const b = mk([2, 3, 4], [200, 300, 400]);
    const c = mk([5], [5000]);
    const out = mergeSeries([a, b, c]);
    expect(Array.from(out.xs)).toEqual([1, 2, 3, 4, 5]);
    expect(out.ys[0]).toEqual([10, null, 30, null, 50]);
    expect(out.ys[1]).toEqual([null, 200, 300, 400, null]);
    expect(out.ys[2]).toEqual([null, null, null, null, 5000]);
  });
});

describe("mergeSeries · gap-threshold mode (Phase 8)", () => {
  it("treats null / NaN / non-positive thresholds as 'off'", () => {
    // Sanity: the gap-threshold path is opt-in. A null / NaN / 0 / -5
    // threshold must produce identical output to the default-mode call.
    const a = mk([1, 3], [10, 30]);
    const b = mk([2, 3], [200, 300]);
    const baseline = mergeSeries([a, b]);
    for (const t of [null, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const out = mergeSeries([a, b], t as number | null);
      expect(Array.from(out.xs)).toEqual(Array.from(baseline.xs));
      expect(out.ys.map((y) => Array.from(y))).toEqual(
        baseline.ys.map((y) => Array.from(y)),
      );
    }
  });

  it("step-holds within the threshold for a single series", () => {
    // Single input, no other series to provide intermediate union xs.
    // The gap-marker injection must produce a held-end + null pair so
    // uPlot draws a line up to lastX+threshold, then a gap.
    const a = mk([0, 1, 2, 100], [10, 11, 12, 13]);
    const out = mergeSeries([a], 5);
    // Real samples are preserved verbatim at their xs.
    const xs = Array.from(out.xs);
    expect(xs).toContain(0);
    expect(xs).toContain(1);
    expect(xs).toContain(2);
    expect(xs).toContain(100);
    // Gap markers: held-end at 2+5 = 7, gap-start just after.
    expect(xs).toContain(7);
    // Held-end carries the last real value (12).
    const heldIdx = xs.indexOf(7);
    expect(out.ys[0][heldIdx]).toBe(12);
    // The very next position is a null (gap-start marker, lastX+threshold+ε).
    expect(out.ys[0][heldIdx + 1]).toBeNull();
    // The post-gap real sample at 100 is the actual value, not a step-hold.
    const postIdx = xs.indexOf(100);
    expect(out.ys[0][postIdx]).toBe(13);
  });

  it("step-holds across non-coincident timestamps (multi-mailbox case)", () => {
    // Same-rate signals on different CAN mailboxes — the bug PR #83
    // fixed. With a threshold above the inter-sample dx, the per-series
    // step-hold must fill the alignment artifacts so the rendered line
    // doesn't collapse to dots, AND no nulls appear in the output for
    // small gaps.
    const a = mk([0, 0.1, 0.2, 0.3], [10, 11, 12, 13]);
    const b = mk([0.05, 0.15, 0.25], [200, 201, 202]);
    const out = mergeSeries([a, b], 1);
    const xs = Array.from(out.xs);
    // Union of all real samples — no gap markers because no dx > 1.
    expect(xs).toEqual([0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]);
    // Series A: step-held everywhere it lacks a sample, no nulls.
    expect(out.ys[0]).toEqual([10, 10, 11, 11, 12, 12, 13]);
    // Series B: leading null until first sample, then step-held.
    expect(out.ys[1]).toEqual([null, 200, 200, 201, 201, 202, 202]);
  });

  it("emits null at union timestamps that fall beyond the threshold", () => {
    // Series A has a real gap; series B has samples inside that gap.
    // At B's sample positions, A must read as null (genuinely no
    // signal), not step-held — that's the whole point of the threshold.
    const a = mk([0, 1, 2, 100], [10, 11, 12, 13]);
    const b = mk([50, 51], [500, 501]);
    const out = mergeSeries([a, b], 5);
    const xs = Array.from(out.xs);
    const idxA = xs.indexOf(50);
    const idxB = xs.indexOf(51);
    expect(out.ys[0][idxA]).toBeNull();
    expect(out.ys[0][idxB]).toBeNull();
    // Series B is real at its own positions.
    expect(out.ys[1][idxA]).toBe(500);
    expect(out.ys[1][idxB]).toBe(501);
  });

  it("returns leading null for samples that arrive after the union start", () => {
    // Series B's first sample is at t=10, but series A starts at t=0.
    // Union slots before t=10 must read as null for B (no value yet),
    // not step-held to a future value.
    const a = mk([0, 1, 2, 10], [10, 11, 12, 100]);
    const b = mk([10, 11], [200, 201]);
    const out = mergeSeries([a, b], 5);
    const xs = Array.from(out.xs);
    for (let i = 0; i < xs.length && xs[i] < 10; i++) {
      expect(out.ys[1][i]).toBeNull();
    }
  });

  it("preserves real-sample positions exactly across the held-end marker", () => {
    // Edge case: when a real sample lands at exactly lastX+threshold,
    // the held-end marker should not duplicate the position. Verify
    // dedupe by checking xs is strictly ascending.
    const a = mk([0, 5, 10, 30], [10, 15, 20, 30]);
    const out = mergeSeries([a], 10);
    const xs = Array.from(out.xs);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
  });

  it("yields all-null for an empty series alongside a populated one", () => {
    // The step-hold walk seeds `hasSample = false` and only flips it
    // once the input cursor advances past a real sample. An empty
    // series must therefore read as null at every union slot — not
    // leak the populated series' values via a shared array reference
    // and not crash on the unread `lastY`.
    const a = mk([], []);
    const b = mk([0, 1, 2], [10, 11, 12]);
    const out = mergeSeries([a, b], 5);
    expect(Array.from(out.xs)).toEqual([0, 1, 2]);
    expect(out.ys[0]).toEqual([null, null, null]);
    expect(out.ys[1]).toEqual([10, 11, 12]);
  });

  it("interleaves gap markers from multiple series in ascending order", () => {
    // Each series has its own intra-series gap. The k-way merger has to
    // emit each gap's (held-end, gap-start) pair in correct global order,
    // even when one series' gap markers fall between another series'
    // real samples. Output xs must be strictly ascending.
    const a = mk([0, 100], [10, 20]);   // gap: held-end 1, gap-start 1+ε
    const b = mk([2, 50], [200, 250]);  // gap: held-end 3, gap-start 3+ε
    const out = mergeSeries([a, b], 1);
    const xs = Array.from(out.xs);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    }
    // Both held-end markers are present.
    expect(xs).toContain(1);
    expect(xs).toContain(3);
    // a's held-end at x=1 carries a's last value (10); b is null there
    // (b hasn't started yet, since b's first sample is at 2).
    const idx1 = xs.indexOf(1);
    expect(out.ys[0][idx1]).toBe(10);
    expect(out.ys[1][idx1]).toBeNull();
    // b's held-end at x=3 carries b's last value (200); a is null there
    // (a's gap of 100 from x=0 already exceeds threshold 1).
    const idx3 = xs.indexOf(3);
    expect(out.ys[0][idx3]).toBeNull();
    expect(out.ys[1][idx3]).toBe(200);
  });
});
