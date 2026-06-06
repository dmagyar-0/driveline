import { describe, expect, it } from "vitest";
import {
  synthesizeSidecarText,
  synthesizeSidecarBytes,
  synthesizeSidecarBytesChecked,
  SidecarCountMismatchError,
} from "./videoTimestampBinding";

describe("synthesizeSidecarText", () => {
  it("emits one `<i>\\t<ts>\\n` line per row, frame index == row index", () => {
    const ts = new BigInt64Array([100n, 200n, 350n]);
    expect(synthesizeSidecarText(ts)).toBe("0\t100\n1\t200\n2\t350\n");
  });

  it("preserves full bigint ns precision (no Number narrowing)", () => {
    // ~1.7e18 — well past Number.MAX_SAFE_INTEGER (9.007e15). Round-tripping
    // through Number would corrupt these digits.
    const big = 1_700_000_000_123_456_789n;
    const ts = new BigInt64Array([big, big + 1n]);
    const text = synthesizeSidecarText(ts);
    expect(text).toBe(
      "0\t1700000000123456789\n1\t1700000000123456790\n",
    );
    // The exact final digits survive — proof no lossy conversion happened.
    expect(text.includes("123456789")).toBe(true);
    expect(text.includes("123456790")).toBe(true);
  });

  it("handles an empty column as empty text", () => {
    expect(synthesizeSidecarText(new BigInt64Array(0))).toBe("");
  });
});

describe("synthesizeSidecarBytes", () => {
  it("UTF-8 encodes the synthesized text", () => {
    const ts = new BigInt64Array([1n, 2n]);
    const bytes = synthesizeSidecarBytes(ts);
    expect(new TextDecoder().decode(bytes)).toBe("0\t1\n1\t2\n");
  });
});

describe("synthesizeSidecarBytesChecked", () => {
  it("returns the sidecar bytes when the row count matches the sample count", () => {
    const ts = new BigInt64Array([10n, 20n, 30n]);
    const bytes = synthesizeSidecarBytesChecked(ts, 3);
    expect(new TextDecoder().decode(bytes)).toBe("0\t10\n1\t20\n2\t30\n");
  });

  it("throws SidecarCountMismatchError when counts differ", () => {
    const ts = new BigInt64Array([10n, 20n]);
    expect(() => synthesizeSidecarBytesChecked(ts, 3)).toThrow(
      SidecarCountMismatchError,
    );
    try {
      synthesizeSidecarBytesChecked(ts, 3);
    } catch (e) {
      const err = e as SidecarCountMismatchError;
      expect(err.tabularRows).toBe(2);
      expect(err.sampleCount).toBe(3);
      // Message names both counts so the dialog surfaces an actionable error.
      expect(err.message).toContain("2");
      expect(err.message).toContain("3");
    }
  });

  it("treats a longer time column as a mismatch too", () => {
    const ts = new BigInt64Array([1n, 2n, 3n, 4n]);
    expect(() => synthesizeSidecarBytesChecked(ts, 3)).toThrow(
      SidecarCountMismatchError,
    );
  });
});
