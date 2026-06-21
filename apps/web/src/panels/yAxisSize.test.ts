// @vitest-environment jsdom
//
// Unit test for the PlotPanel y-axis gutter sizing. Regression cover for
// the "y-axis truncates large numbers" bug: uPlot's fixed ~50px gutter
// clipped wide tick labels (e.g. "100000", "-123.456") at the panel edge.
// `yAxisSize` grows the gutter to fit the widest formatted tick.

import { describe, expect, it, vi } from "vitest";

// uPlot calls `matchMedia()` at module load (the PlotPanel import below
// pulls it in). jsdom doesn't ship one, so stub it before the import
// chain resolves. `vi.hoisted` lifts this ahead of the ESM import hoist —
// mirrors PlotPanel.test.tsx.
vi.hoisted(() => {
  (
    globalThis as unknown as { matchMedia: (q: string) => MediaQueryList }
  ).matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

import { Y_AXIS_MIN_SIZE, yAxisSize } from "./plotAxes";
import type uPlot from "uplot";

// A stand-in for the uPlot instance: a canvas-2d-ish ctx whose
// `measureText` width is proportional to the string length (10px/char),
// plus the axis metadata `yAxisSize` reads. Mirrors uPlot's post-init
// `font` shape `[cssFont, pxSize, cssSize]`.
function makeSelf(charPx = 10): uPlot {
  const ctx = {
    font: "",
    measureText: (s: string) => ({ width: s.length * charPx }),
  } as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    axes: [
      {},
      {
        ticks: { size: 10 },
        gap: 5,
        font: ["12px sans-serif", 12, 12],
      },
    ],
  } as unknown as uPlot;
}

describe("yAxisSize", () => {
  it("returns the minimum gutter on the first (null values) pass", () => {
    expect(yAxisSize(makeSelf(), null, 1)).toBe(Y_AXIS_MIN_SIZE);
  });

  it("returns the minimum gutter for short labels that already fit", () => {
    // "1", "2", "3" → widest is 1 char * 10px = 10px, well under the floor.
    expect(yAxisSize(makeSelf(), ["1", "2", "3"], 1)).toBe(Y_AXIS_MIN_SIZE);
  });

  it("grows the gutter to fit a wide label so it isn't truncated", () => {
    // "100000" → 6 chars * 10px = 60px text + 10px tick + 5px gap = 75px.
    const size = yAxisSize(makeSelf(), ["0", "50000", "100000"], 1);
    expect(size).toBe(75);
    expect(size).toBeGreaterThan(Y_AXIS_MIN_SIZE);
  });

  it("accounts for a leading minus sign and decimals", () => {
    // "-123.456" → 8 chars * 10px = 80px + 10 + 5 = 95px.
    expect(yAxisSize(makeSelf(), ["-123.456", "0", "123.456"], 1)).toBe(95);
  });

  it("scales measured device pixels back to CSS pixels by devicePixelRatio", () => {
    const prev = window.devicePixelRatio;
    // A HiDPI display: uPlot's font is pre-scaled by dpr, so measureText
    // reports device pixels and yAxisSize must divide them back down.
    window.devicePixelRatio = 2;
    try {
      // 6 chars * 10px = 60 device px / 2 = 30 CSS px + 15 → under floor.
      expect(yAxisSize(makeSelf(), ["100000"], 1)).toBe(Y_AXIS_MIN_SIZE);
      // 12 chars * 10px = 120 device px / 2 = 60 + 15 = 75 CSS px.
      expect(yAxisSize(makeSelf(), ["123456789012"], 1)).toBe(75);
    } finally {
      window.devicePixelRatio = prev;
    }
  });
});
