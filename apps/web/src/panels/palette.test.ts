import { describe, expect, it } from "vitest";
import { colorFor, PLOT_PALETTE, MAX_PLOT_SERIES } from "./palette";

describe("palette (P2 — cap 8 → 16)", () => {
  it("exposes 16 distinct colours matching the cap", () => {
    expect(PLOT_PALETTE).toHaveLength(16);
    expect(MAX_PLOT_SERIES).toBe(16);
    expect(new Set(PLOT_PALETTE).size).toBe(16);
  });

  it("keeps the original 8 colours stable at their indices", () => {
    // Re-colouring an existing binding on upgrade would be a silent
    // regression — the first 8 must stay byte-identical.
    expect(PLOT_PALETTE.slice(0, 8)).toEqual([
      "#3b82f6",
      "#f97316",
      "#10b981",
      "#ef4444",
      "#a855f7",
      "#eab308",
      "#14b8a6",
      "#ec4899",
    ]);
  });
});

describe("colorFor", () => {
  it("returns a colour from the palette", () => {
    expect(PLOT_PALETTE).toContain(colorFor("mcap:/vehicle/speed"));
  });

  it("is deterministic for the same id", () => {
    const id = "mf4:/vehicle/speed";
    expect(colorFor(id)).toBe(colorFor(id));
  });

  it("distinguishes typical channel ids across the palette", () => {
    const ids = [
      "mcap:/vehicle/speed",
      "mf4:/vehicle/speed",
      "mcap:/imu/accel",
      "mcap:/control/mode",
      "mf4:/engine/rpm",
      "mcap:/camera/front",
      "mf4:/brake/pressure",
      "mcap:/steering/angle",
    ];
    const colours = new Set(ids.map(colorFor));
    // Expect at least half the palette gets used across a realistic
    // spread — guards against a hash that maps everything to one slot.
    expect(colours.size).toBeGreaterThanOrEqual(4);
  });

  it("handles the empty id without throwing", () => {
    expect(PLOT_PALETTE).toContain(colorFor(""));
  });
});
