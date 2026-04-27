// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cursorStrokeColor, cursorXPx } from "./cursorOverlay";

const range = { startNs: 0n, endNs: 1_000_000_000n }; // 1 s

describe("cursorXPx", () => {
  it("returns null for non-positive width", () => {
    expect(cursorXPx(500_000_000n, range, 0)).toBeNull();
    expect(cursorXPx(500_000_000n, range, -10)).toBeNull();
  });

  it("returns null for a degenerate range", () => {
    expect(cursorXPx(0n, { startNs: 10n, endNs: 10n }, 100)).toBeNull();
    expect(cursorXPx(0n, { startNs: 20n, endNs: 10n }, 100)).toBeNull();
  });

  it("returns null when the cursor is outside the range", () => {
    expect(cursorXPx(-1n, range, 1000)).toBeNull();
    expect(cursorXPx(range.endNs + 1n, range, 1000)).toBeNull();
  });

  it("projects the midpoint to half the width", () => {
    expect(cursorXPx(500_000_000n, range, 1000)).toBeCloseTo(500, 6);
  });

  it("projects the endpoints to 0 and the full width", () => {
    expect(cursorXPx(0n, range, 1000)).toBeCloseTo(0, 6);
    expect(cursorXPx(range.endNs, range, 1000)).toBeCloseTo(1000, 6);
  });

  it("keeps sub-pixel accuracy for epoch-scale ns ranges", () => {
    // 2024-01-01T00:00:00Z → ~1.704e18 ns. Midpoint across 1 second still
    // projects to half width even though neither endpoint fits in a
    // JS safe integer.
    const epoch = 1_704_067_200_000_000_000n;
    const wide = { startNs: epoch, endNs: epoch + 1_000_000_000n };
    expect(cursorXPx(epoch + 500_000_000n, wide, 800)).toBeCloseTo(400, 3);
  });
});

describe("cursorStrokeColor", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--color-accent-orange");
  });

  it("reads --color-accent-orange from :root at call time", () => {
    document.documentElement.style.setProperty(
      "--color-accent-orange",
      "#abcdef",
    );
    expect(cursorStrokeColor()).toBe("#abcdef");
  });

  it("falls back to the literal hex when the var is unset", () => {
    // No `--color-accent-orange` declared; jsdom returns "" from the
    // computed style and the helper short-circuits to the fallback.
    expect(cursorStrokeColor()).toBe("#f97316");
  });
});
