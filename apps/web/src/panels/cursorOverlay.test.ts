// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetCursorStrokeColorCache,
  cursorStrokeColor,
  cursorXPx,
  nsFromXPx,
} from "./cursorOverlay";

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

describe("nsFromXPx", () => {
  it("returns null for non-positive width", () => {
    expect(nsFromXPx(50, range, 0)).toBeNull();
    expect(nsFromXPx(50, range, -10)).toBeNull();
  });

  it("returns null for a degenerate range", () => {
    expect(nsFromXPx(50, { startNs: 10n, endNs: 10n }, 100)).toBeNull();
    expect(nsFromXPx(50, { startNs: 20n, endNs: 10n }, 100)).toBeNull();
  });

  it("maps the midpoint pixel to the midpoint timestamp", () => {
    expect(nsFromXPx(500, range, 1000)).toBe(500_000_000n);
  });

  it("clamps out-of-bounds pixels to the range endpoints", () => {
    expect(nsFromXPx(-40, range, 1000)).toBe(range.startNs);
    expect(nsFromXPx(1400, range, 1000)).toBe(range.endNs);
  });

  it("round-trips with cursorXPx at the midpoint", () => {
    const ns = nsFromXPx(400, range, 800);
    expect(ns).not.toBeNull();
    expect(cursorXPx(ns!, range, 800)).toBeCloseTo(400, 6);
  });

  it("keeps precision for epoch-scale ns ranges", () => {
    const epoch = 1_704_067_200_000_000_000n;
    const wide = { startNs: epoch, endNs: epoch + 1_000_000_000n };
    expect(nsFromXPx(400, wide, 800)).toBe(epoch + 500_000_000n);
  });
});

describe("cursorStrokeColor", () => {
  afterEach(() => {
    document.documentElement.style.removeProperty("--color-accent-orange");
    __resetCursorStrokeColorCache();
  });

  it("reads --color-accent-orange from :root at first call", () => {
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

  it("caches the resolved colour across calls", () => {
    document.documentElement.style.setProperty(
      "--color-accent-orange",
      "#111111",
    );
    expect(cursorStrokeColor()).toBe("#111111");
    document.documentElement.style.setProperty(
      "--color-accent-orange",
      "#222222",
    );
    // Cached — subsequent token mutations are ignored until the cache
    // is reset (only test code does that; production has no theme
    // switch at v1).
    expect(cursorStrokeColor()).toBe("#111111");
  });
});
