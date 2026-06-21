import { describe, expect, it } from "vitest";
import { lastIndexAtOrBefore } from "./cursorLookup";

describe("lastIndexAtOrBefore", () => {
  describe("over bigint[]", () => {
    const rows = [0n, 10n, 20n, 30n];
    it("finds the index at-or-before the cursor", () => {
      expect(lastIndexAtOrBefore(rows, 25n)).toBe(2);
      expect(lastIndexAtOrBefore(rows, 20n)).toBe(2);
      expect(lastIndexAtOrBefore(rows, 30n)).toBe(3);
      expect(lastIndexAtOrBefore(rows, 100n)).toBe(3);
    });
    it("hits the first element exactly", () => {
      expect(lastIndexAtOrBefore(rows, 0n)).toBe(0);
    });
    it("returns -1 when the cursor precedes every element", () => {
      expect(lastIndexAtOrBefore(rows, -5n)).toBe(-1);
    });
    it("returns -1 for an empty array", () => {
      expect(lastIndexAtOrBefore([], 5n)).toBe(-1);
    });
  });

  describe("over BigInt64Array", () => {
    const rows = BigInt64Array.from([0n, 10n, 20n, 30n]);
    it("finds the index at-or-before the cursor", () => {
      expect(lastIndexAtOrBefore(rows, 25n)).toBe(2);
      expect(lastIndexAtOrBefore(rows, 9n)).toBe(0);
      expect(lastIndexAtOrBefore(rows, 30n)).toBe(3);
      expect(lastIndexAtOrBefore(rows, 1_000n)).toBe(3);
    });
    it("returns -1 when the cursor precedes every element", () => {
      expect(lastIndexAtOrBefore(rows, -1n)).toBe(-1);
    });
    it("returns -1 for an empty typed array", () => {
      expect(lastIndexAtOrBefore(new BigInt64Array(), 5n)).toBe(-1);
    });
  });

  it("handles a single-element series", () => {
    expect(lastIndexAtOrBefore([42n], 41n)).toBe(-1);
    expect(lastIndexAtOrBefore([42n], 42n)).toBe(0);
    expect(lastIndexAtOrBefore([42n], 43n)).toBe(0);
  });
});
