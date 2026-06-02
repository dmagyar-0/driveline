import { describe, expect, it } from "vitest";
import {
  applyTransform,
  transformKey,
  transformLabel,
  type Transform,
} from "./transforms";
import type { PlotSeries } from "./seriesFromArrow";

// Build a PlotSeries from ys + ns timestamps. xs is derived ns→sec the
// way seriesFromArrow does, though the transforms only touch ys/rawTsNs.
function series(ys: number[], tsNs: bigint[]): PlotSeries {
  return {
    ys: Float64Array.from(ys),
    rawTsNs: BigInt64Array.from(tsNs),
    xs: Float64Array.from(tsNs.map((t) => Number(t) / 1e9)),
  };
}

describe("applyTransform", () => {
  it("none returns the same series instance (identity)", () => {
    const s = series([1, 2, 3], [0n, 1_000_000_000n, 2_000_000_000n]);
    expect(applyTransform(s, { kind: "none" })).toBe(s);
  });

  it("abs takes the magnitude of every sample", () => {
    const s = series([-3, 0, 2.5, -1], [0n, 1n, 2n, 3n]);
    const out = applyTransform(s, { kind: "abs" });
    expect(Array.from(out.ys)).toEqual([3, 0, 2.5, 1]);
    // xs / rawTsNs untouched and shared by reference.
    expect(out.rawTsNs).toBe(s.rawTsNs);
    expect(out.xs).toBe(s.xs);
  });

  it("scale applies y' = y*mul + add (unit conversion)", () => {
    // m/s → km/h is ×3.6; also exercise a non-zero offset (C → F).
    const s = series([0, 10, 100], [0n, 1n, 2n]);
    const kmh = applyTransform(s, { kind: "scale", mul: 3.6, add: 0 });
    expect(Array.from(kmh.ys)).toEqual([0, 36, 360]);

    const c = series([0, 100], [0n, 1n]);
    const f = applyTransform(c, { kind: "scale", mul: 1.8, add: 32 });
    expect(Array.from(f.ys)).toEqual([32, 212]);
  });

  it("derivative on a known ramp yields the slope per second", () => {
    // y = 2*t (t in seconds) sampled at 1 Hz → dy/dt = 2 everywhere
    // except the first sample, which has no predecessor.
    const s = series(
      [0, 2, 4, 6],
      [0n, 1_000_000_000n, 2_000_000_000n, 3_000_000_000n],
    );
    const d = applyTransform(s, { kind: "derivative" });
    expect(Number.isNaN(d.ys[0])).toBe(true);
    expect(Array.from(d.ys.slice(1))).toEqual([2, 2, 2]);
  });

  it("derivative handles a non-uniform sample interval", () => {
    // dt of 0.5s then 2s; slope of 1 unit/sample → 2 and 0.5 units/sec.
    const s = series([0, 1, 2], [0n, 500_000_000n, 2_500_000_000n]);
    const d = applyTransform(s, { kind: "derivative" });
    expect(d.ys[1]).toBeCloseTo(2, 10);
    expect(d.ys[2]).toBeCloseTo(0.5, 10);
  });

  it("derivative emits NaN for a zero/duplicate timestamp (no poison)", () => {
    const s = series([5, 7], [1_000n, 1_000n]);
    const d = applyTransform(s, { kind: "derivative" });
    expect(Number.isNaN(d.ys[1])).toBe(true);
  });

  it("derivative of an empty series is empty", () => {
    const s = series([], []);
    expect(applyTransform(s, { kind: "derivative" }).ys.length).toBe(0);
  });
});

describe("transformKey", () => {
  it("returns '' for none/undefined so default panels keep their key", () => {
    expect(transformKey(undefined)).toBe("");
    expect(transformKey({ kind: "none" })).toBe("");
  });

  it("encodes scale parameters so a param change rebuilds the plot", () => {
    expect(transformKey({ kind: "scale", mul: 3.6, add: 0 })).toBe(
      "scale:3.6,0",
    );
    expect(transformKey({ kind: "abs" })).toBe("abs");
    expect(transformKey({ kind: "derivative" })).toBe("derivative");
  });
});

describe("transformLabel", () => {
  it("is null for none/undefined", () => {
    expect(transformLabel(undefined)).toBeNull();
    expect(transformLabel({ kind: "none" })).toBeNull();
  });

  it("describes each transform compactly", () => {
    const cases: Array<[Transform, string]> = [
      [{ kind: "abs" }, "|x|"],
      [{ kind: "derivative" }, "d/dt"],
      [{ kind: "scale", mul: 3.6, add: 0 }, "×3.6"],
      [{ kind: "scale", mul: 2, add: 5 }, "×2+5"],
    ];
    for (const [t, label] of cases) expect(transformLabel(t)).toBe(label);
  });
});
