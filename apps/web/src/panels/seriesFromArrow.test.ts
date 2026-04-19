import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { seriesFromArrow } from "./seriesFromArrow";

const fixturePath = resolve(
  __dirname,
  "../../../../test-fixtures/arrow_scalar.ipc",
);

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
