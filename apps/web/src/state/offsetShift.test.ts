import { describe, expect, it } from "vitest";
import {
  Float64,
  Table,
  TimeUnit,
  Timestamp,
  makeData,
  makeVector,
  tableFromIPC,
  tableToIPC,
  type DataType,
} from "apache-arrow";
import { shiftFetchWindow, shiftRangeArrowTs } from "./offsetShift";

const TS_TYPE = new Timestamp(TimeUnit.NANOSECOND, "UTC");

function ipc(
  cols: Record<string, { type: DataType; data: ArrayLike<unknown> }>,
): Uint8Array {
  const vectors: Record<string, ReturnType<typeof makeVector>> = {};
  for (const [name, { type, data }] of Object.entries(cols)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vectors[name] = makeVector(makeData({ type, data } as any));
  }
  return tableToIPC(new Table(vectors), "file");
}

function scalarIpc(ts: BigInt64Array, value: Float64Array): Uint8Array {
  return ipc({
    ts: { type: TS_TYPE, data: ts },
    value: { type: new Float64(), data: value },
  });
}

function readTs(bytes: Uint8Array): bigint[] {
  const table = tableFromIPC(bytes);
  const col = table.getChild("ts");
  if (!col) throw new Error("no ts column");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (col as any).data[0].values as BigInt64Array;
  return Array.from(raw);
}

function readValues(bytes: Uint8Array): number[] {
  const table = tableFromIPC(bytes);
  const col = table.getChild("value");
  if (!col) throw new Error("no value column");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (col as any).data[0].values as Float64Array;
  return Array.from(raw);
}

describe("shiftFetchWindow", () => {
  it("queries [start - O, end - O] so a forward-shifted source is covered", () => {
    const r = shiftFetchWindow(1_000n, 2_000n, 500n);
    expect(r.startNs).toBe(500n);
    expect(r.endNs).toBe(1_500n);
  });

  it("handles a negative offset (source clock ahead of the session)", () => {
    const r = shiftFetchWindow(1_000n, 2_000n, -300n);
    expect(r.startNs).toBe(1_300n);
    expect(r.endNs).toBe(2_300n);
  });

  it("is a pass-through for a zero offset", () => {
    const r = shiftFetchWindow(1_000n, 2_000n, 0n);
    expect(r.startNs).toBe(1_000n);
    expect(r.endNs).toBe(2_000n);
  });

  it("preserves full ns precision past Number.MAX_SAFE_INTEGER", () => {
    const start = 1_700_000_000_000_000_000n;
    const end = 1_700_000_000_000_000_500n;
    const offset = 123_456_789n;
    const r = shiftFetchWindow(start, end, offset);
    expect(r.startNs).toBe(start - offset);
    expect(r.endNs).toBe(end - offset);
  });
});

describe("shiftRangeArrowTs", () => {
  it("adds the offset to every ts value, leaving values untouched", () => {
    const bytes = scalarIpc(
      new BigInt64Array([100n, 200n, 300n]),
      new Float64Array([1.5, 2.5, 3.5]),
    );
    const out = shiftRangeArrowTs(bytes, 50n);
    expect(readTs(out)).toEqual([150n, 250n, 350n]);
    expect(readValues(out)).toEqual([1.5, 2.5, 3.5]);
  });

  it("applies a negative offset", () => {
    const bytes = scalarIpc(
      new BigInt64Array([1_000n, 2_000n]),
      new Float64Array([0, 0]),
    );
    expect(readTs(shiftRangeArrowTs(bytes, -250n))).toEqual([750n, 1_750n]);
  });

  it("is a pass-through (same reference) for a zero offset", () => {
    const bytes = scalarIpc(
      new BigInt64Array([1n]),
      new Float64Array([0]),
    );
    expect(shiftRangeArrowTs(bytes, 0n)).toBe(bytes);
  });

  it("returns empty input unchanged", () => {
    const empty = new Uint8Array(0);
    expect(shiftRangeArrowTs(empty, 99n)).toBe(empty);
  });

  it("preserves full ns precision when shifting", () => {
    const base = 1_700_000_000_000_000_000n;
    const bytes = scalarIpc(
      new BigInt64Array([base, base + 1n]),
      new Float64Array([0, 0]),
    );
    const offset = 987_654_321n;
    expect(readTs(shiftRangeArrowTs(bytes, offset))).toEqual([
      base + offset,
      base + 1n + offset,
    ]);
  });

  it("round-trips through the fetch-boundary maths (window back, ts forward)", () => {
    // Simulate the store boundary: the reader stores samples on its own clock,
    // is queried with the window shifted back by O, and the returned ts is
    // shifted forward by O. A sample stored at native ts N appears at N + O.
    const offset = 500n;
    // Caller wants [1000, 2000) on the session clock.
    const win = shiftFetchWindow(1_000n, 2_000n, offset);
    expect(win.startNs).toBe(500n);
    expect(win.endNs).toBe(1_500n);
    // Reader returns native samples inside [500, 1500).
    const readerBytes = scalarIpc(
      new BigInt64Array([600n, 900n, 1_400n]),
      new Float64Array([10, 20, 30]),
    );
    const out = shiftRangeArrowTs(readerBytes, offset);
    // Shifted forward by O — all land inside the requested [1000, 2000).
    expect(readTs(out)).toEqual([1_100n, 1_400n, 1_900n]);
  });
});
