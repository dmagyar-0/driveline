import { describe, expect, it } from "vitest";
import { mergeSeries } from "./mergeSeries";
import type { PlotSeries } from "./seriesFromArrow";

function mk(xs: number[], ys: number[]): PlotSeries {
  return { xs: new Float64Array(xs), ys: new Float64Array(ys) };
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
});
