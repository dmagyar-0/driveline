import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Table,
  TimeUnit,
  Timestamp,
  makeData,
  makeVector,
  tableToIPC,
  type DataType,
} from "apache-arrow";
import {
  SeriesDecodeError,
  decodeSeries,
  seriesFromArrow,
  seriesFromArrowOrThrow,
} from "./seriesFromArrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_scalar.ipc",
);

const TS_TYPE = new Timestamp(TimeUnit.NANOSECOND, "UTC");

// Build a single-batch Arrow IPC file with the given columns. Mirrors the
// schemas the Rust core emits (see crates/data-core/src/mcap.rs) so the
// decoder is exercised against the real wire shape, not a stub.
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

function enumIpc(ts: BigInt64Array, code: Int32Array): Uint8Array {
  return ipc({
    ts: { type: TS_TYPE, data: ts },
    code: { type: new Int32(), data: code },
  });
}

describe("seriesFromArrow", () => {
  it("decodes the T1.4 scalar fixture into seconds-since-epoch / values", () => {
    const bytes = readFileSync(fixturePath);
    const { xs, ys } = seriesFromArrow(new Uint8Array(bytes));
    expect(xs.length).toBe(3);
    expect(ys.length).toBe(3);
    // Fixture: ts = [1e9, 1.01e9, 1.02e9] ns → [1, 1.01, 1.02] s.
    expect(xs[0]).toBeCloseTo(1.0, 9);
    expect(xs[1]).toBeCloseTo(1.01, 9);
    expect(xs[2]).toBeCloseTo(1.02, 9);
    expect(ys[0]).toBeCloseTo(1.0);
    expect(ys[1]).toBeCloseTo(2.0);
    expect(ys[2]).toBeCloseTo(3.0);
  });

  it("exposes the raw ns timestamps as BigInt64 for T6.1 sync lookup", () => {
    const bytes = readFileSync(fixturePath);
    const { rawTsNs } = seriesFromArrow(new Uint8Array(bytes));
    expect(rawTsNs).toBeInstanceOf(BigInt64Array);
    expect(rawTsNs.length).toBe(3);
    expect(rawTsNs[0]).toBe(1_000_000_000n);
    expect(rawTsNs[1]).toBe(1_010_000_000n);
    expect(rawTsNs[2]).toBe(1_020_000_000n);
  });

  it("returns monotonically non-decreasing xs", () => {
    const bytes = readFileSync(fixturePath);
    const { xs } = seriesFromArrow(new Uint8Array(bytes));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    }
  });

  it("copies ys so the returned buffer does not alias Arrow storage", () => {
    const bytes = readFileSync(fixturePath);
    const a = seriesFromArrow(new Uint8Array(bytes));
    const b = seriesFromArrow(new Uint8Array(bytes));
    a.ys[0] = 999;
    expect(b.ys[0]).not.toBe(999);
  });
});

describe("decodeSeries — result contract", () => {
  it("tags a healthy scalar batch as ok/scalar", () => {
    const res = decodeSeries(
      scalarIpc(new BigInt64Array([1_000_000_000n]), new Float64Array([4.5])),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.kind).toBe("scalar");
    expect(Array.from(res.ys)).toEqual([4.5]);
    expect(res.rawTsNs[0]).toBe(1_000_000_000n);
  });

  it("returns an ok-but-empty series for a zero-row batch", () => {
    const res = decodeSeries(
      scalarIpc(new BigInt64Array([]), new Float64Array([])),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.ys.length).toBe(0);
  });

  it("flags a Float32 value column as a value-dtype mismatch (no silent blank)", () => {
    const bytes = ipc({
      ts: { type: TS_TYPE, data: new BigInt64Array([1n, 2n]) },
      value: { type: new Float32(), data: new Float32Array([1, 2]) },
    });
    const res = decodeSeries(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.reason).toBe("value-dtype");
    expect(res.message).toMatch(/Float64/);
  });

  it("flags a vector (FixedSizeList) channel as unsupported, not garbage", () => {
    const inner = new Field("item", new Float64(), false);
    const fslType = new FixedSizeList(2, inner);
    const child = makeData({
      type: new Float64(),
      data: new Float64Array([1, 2, 3, 4]),
    });
    const value = makeVector(makeData({ type: fslType, length: 2, child }));
    const ts = makeVector(
      makeData({ type: TS_TYPE, data: new BigInt64Array([1n, 2n]) }),
    );
    const bytes = tableToIPC(new Table({ ts, value }), "file");
    const res = decodeSeries(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.reason).toBe("unsupported-vector");
  });

  it("reports missing-value when neither value nor code is present", () => {
    const ts = makeVector(
      makeData({ type: TS_TYPE, data: new BigInt64Array([1n]) }),
    );
    const res = decodeSeries(tableToIPC(new Table({ ts }), "file"));
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.reason).toBe("missing-value");
  });

  it("reports a malformed IPC buffer as a decode error rather than throwing", () => {
    // ARROW1 magic followed by junk: `tableFromIPC` throws on this; the
    // decoder should catch and tag it `decode`, never propagate.
    const malformed = new Uint8Array([
      0x41, 0x52, 0x52, 0x4f, 0x57, 0x31, 0xff, 0xff, 0xff, 0xff,
    ]);
    const res = decodeSeries(malformed);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.reason).toBe("decode");
  });
});

describe("decodeSeries — enum (code) channels", () => {
  it("decodes an Int32 `code` column, tagged kind=enum, widened to Float64", () => {
    const res = decodeSeries(
      enumIpc(
        new BigInt64Array([1_000_000_000n, 1_010_000_000n, 1_020_000_000n]),
        new Int32Array([0, 2, 5]),
      ),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.kind).toBe("enum");
    expect(Array.from(res.ys)).toEqual([0, 2, 5]);
    expect(res.xs[1]).toBeCloseTo(1.01, 9);
    expect(res.rawTsNs[2]).toBe(1_020_000_000n);
  });

  it("rejects a non-Int32 code column", () => {
    const bytes = ipc({
      ts: { type: TS_TYPE, data: new BigInt64Array([1n]) },
      code: { type: new Float64(), data: new Float64Array([1]) },
    });
    const res = decodeSeries(bytes);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected error");
    expect(res.reason).toBe("value-dtype");
  });
});

describe("seriesFromArrowOrThrow", () => {
  it("throws a typed SeriesDecodeError on mismatch", () => {
    const bytes = ipc({
      ts: { type: TS_TYPE, data: new BigInt64Array([1n]) },
      value: { type: new Float32(), data: new Float32Array([1]) },
    });
    let caught: unknown;
    try {
      seriesFromArrowOrThrow(bytes);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SeriesDecodeError);
    expect((caught as SeriesDecodeError).reason).toBe("value-dtype");
  });

  it("returns the bare series on success", () => {
    const s = seriesFromArrowOrThrow(
      enumIpc(new BigInt64Array([5n]), new Int32Array([9])),
    );
    expect(Array.from(s.ys)).toEqual([9]);
    expect(s.kind).toBe("enum");
  });
});

describe("seriesFromArrow (legacy) stays blank-on-failure", () => {
  it("returns an empty series for a mismatched batch instead of throwing", () => {
    const bytes = ipc({
      ts: { type: TS_TYPE, data: new BigInt64Array([1n]) },
      value: { type: new Float32(), data: new Float32Array([1]) },
    });
    const s = seriesFromArrow(bytes);
    expect(s.ys.length).toBe(0);
    expect(s.xs.length).toBe(0);
  });
});
