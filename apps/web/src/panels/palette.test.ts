import { describe, expect, it } from "vitest";
import {
  colorFor,
  colorForSource,
  dashForIndex,
  DASH_PATTERNS,
  DASH_THRESHOLD,
  PLOT_PALETTE,
  SOURCE_PALETTE,
  MAX_PLOT_SERIES,
} from "./palette";

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

  it("has a palette length matching the plot-series cap", () => {
    // The PlotPanel limits a panel to 8 channels (MAX_PLOT_SERIES) so the
    // palette is sized to give every channel its own slot at the cap.
    expect(PLOT_PALETTE).toHaveLength(MAX_PLOT_SERIES);
  });

  it("every palette colour is a 6-digit hex code", () => {
    // The chip swatch is rendered with `background: colorFor(id)` and the
    // uPlot stroke uses the same string. Both consumers need a canonical
    // CSS colour; reject anything that drifted out of `#RRGGBB`.
    for (const c of PLOT_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("colorForSource (iter3 issue #2 — source ribbons)", () => {
  it("returns a colour from the SOURCE_PALETTE", () => {
    expect(SOURCE_PALETTE).toContain(colorForSource("src-1"));
  });

  it("is deterministic for the same source id", () => {
    const id = "comma2k19_seg4.mcap";
    expect(colorForSource(id)).toBe(colorForSource(id));
  });

  it("distinguishes typical source ids across the palette", () => {
    const ids = [
      "comma2k19_seg1.mcap",
      "comma2k19_seg4.mcap",
      "comma2k19_seg7.mcap",
      "comma2k19_seg10.mcap",
      "comma2k19_chassis.mcap",
      "comma2k19_imu.mf4",
      "comma2k19_gnss.mf4",
      "comma2k19.mf4",
    ];
    const colours = new Set(ids.map(colorForSource));
    // Iter2's grey badge was indistinguishable across these. Iter3 must
    // light each up with at least a few distinct hues.
    expect(colours.size).toBeGreaterThanOrEqual(4);
  });

  it("every source palette colour is a 6-digit hex code", () => {
    for (const c of SOURCE_PALETTE) {
      expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("handles the empty source id without throwing", () => {
    expect(SOURCE_PALETTE).toContain(colorForSource(""));
  });
});

describe("dashForIndex (iter5 issue #7 — dash fallback)", () => {
  it("returns solid for every series when count is below the threshold", () => {
    for (let i = 0; i < 3; i++) {
      expect(dashForIndex(i, 3)).toEqual([]);
    }
  });

  it("cycles through DASH_PATTERNS at or above the threshold", () => {
    // At 4 traces, all four patterns appear in order.
    const count = DASH_THRESHOLD;
    expect(dashForIndex(0, count)).toEqual(DASH_PATTERNS[0]);
    expect(dashForIndex(1, count)).toEqual(DASH_PATTERNS[1]);
    expect(dashForIndex(2, count)).toEqual(DASH_PATTERNS[2]);
    expect(dashForIndex(3, count)).toEqual(DASH_PATTERNS[3]);
  });

  it("wraps past the pattern cycle so a 5th series reuses pattern 0", () => {
    expect(dashForIndex(4, 8)).toEqual(DASH_PATTERNS[0]);
    expect(dashForIndex(5, 8)).toEqual(DASH_PATTERNS[1]);
  });

  it("emits 4 distinct patterns and one of them is solid", () => {
    expect(DASH_PATTERNS).toHaveLength(4);
    expect(DASH_PATTERNS[0]).toEqual([]);
    // The non-solid patterns each have a non-zero filled length.
    for (let i = 1; i < DASH_PATTERNS.length; i++) {
      expect(DASH_PATTERNS[i].length).toBeGreaterThan(0);
    }
  });
});

describe("PLOT_PALETTE (iter5 issue #6 — Wong colourblind-safe)", () => {
  it("contains 8 unique entries", () => {
    expect(new Set(PLOT_PALETTE).size).toBe(PLOT_PALETTE.length);
  });

  it("does not include any of the iter4 'warm cluster' that collided", () => {
    // Iter4 audit called out f07a6f (coral), and the wider problem was
    // adjacent reds/pinks/oranges. We now include orange + vermillion +
    // reddish-purple but they're widely separated in hue. The specific
    // iter4 coral that the audit flagged is gone.
    expect(PLOT_PALETTE).not.toContain("#f07a6f");
  });
});
