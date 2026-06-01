import { describe, expect, it } from "vitest";
import {
  buildTableModel,
  lastRowAtOrBefore,
  type TableColumnInput,
} from "./tableModel";
import type { PlotSeries } from "./seriesFromArrow";

function series(tsNs: bigint[], ys: number[]): PlotSeries {
  return {
    xs: new Float64Array(tsNs.map((t) => Number(t) / 1e6)),
    ys: new Float64Array(ys),
    rawTsNs: BigInt64Array.from(tsNs),
  };
}

function col(
  channelId: string,
  tsNs: bigint[],
  ys: number[],
): TableColumnInput {
  return { channelId, name: channelId, unit: null, series: series(tsNs, ys) };
}

describe("buildTableModel", () => {
  it("returns an empty model for no inputs", () => {
    const m = buildTableModel([]);
    expect(m.rowTsNs).toEqual([]);
    expect(m.columns).toEqual([]);
    expect(m.truncated).toBe(false);
  });

  it("unions timestamps and sample-and-holds across channels", () => {
    const m = buildTableModel([
      col("a", [0n, 2n], [10, 12]),
      col("b", [1n, 2n], [20, 22]),
    ]);
    expect(m.rowTsNs).toEqual([0n, 1n, 2n]);

    const a = m.columns[0];
    const b = m.columns[1];
    // a: exact@0, carried@1, exact@2
    expect(a.values).toEqual([10, 10, 12]);
    expect(a.exact).toEqual([true, false, true]);
    // b: no sample at-or-before 0 → null; exact@1; exact@2
    expect(b.values).toEqual([null, 20, 22]);
    expect(b.exact).toEqual([false, true, true]);
  });

  it("collapses duplicate timestamps to the last sample", () => {
    const m = buildTableModel([col("a", [0n, 0n, 1n], [1, 2, 3])]);
    expect(m.rowTsNs).toEqual([0n, 1n]);
    expect(m.columns[0].values).toEqual([2, 3]);
    expect(m.columns[0].exact).toEqual([true, true]);
  });
});

describe("lastRowAtOrBefore", () => {
  const rows = [0n, 10n, 20n, 30n];
  it("finds the row at-or-before the cursor", () => {
    expect(lastRowAtOrBefore(rows, 25n)).toBe(2);
    expect(lastRowAtOrBefore(rows, 20n)).toBe(2);
    expect(lastRowAtOrBefore(rows, 30n)).toBe(3);
    expect(lastRowAtOrBefore(rows, 100n)).toBe(3);
  });
  it("returns -1 when the cursor precedes every row", () => {
    expect(lastRowAtOrBefore(rows, -5n)).toBe(-1);
  });
  it("returns -1 for an empty model", () => {
    expect(lastRowAtOrBefore([], 5n)).toBe(-1);
  });
});
