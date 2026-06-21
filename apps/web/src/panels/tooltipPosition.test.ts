// @vitest-environment jsdom
//
// Unit test for the PlotPanel hover-tooltip placement. Regression cover for
// the "values go out of bounds" bug: the tooltip was anchored at
// `left: pointerX + 12` with no edge handling, so hovering near the right
// edge rendered the per-series value readout entirely outside the panel.
// `tooltipPositionStyle` flips the box to the far side of the pointer before
// it would overflow, anchoring by `right`/`bottom` so it grows inward.

import { describe, expect, it, vi } from "vitest";

// uPlot calls `matchMedia()` at module load (the PlotPanel import below pulls
// it in). jsdom doesn't ship one, so stub it before the import chain
// resolves. Mirrors yAxisSize.test.ts / PlotPanel.test.tsx.
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

import { tooltipPositionStyle } from "./plotGeometry";

describe("tooltipPositionStyle", () => {
  const AREA = { areaW: 800, areaH: 600 };

  it("anchors by left/top when there is room (pointer top-left)", () => {
    const s = tooltipPositionStyle({ leftPx: 50, topPx: 40, ...AREA });
    expect(s).toEqual({ left: "62px", top: "52px" });
    expect(s.right).toBeUndefined();
    expect(s.bottom).toBeUndefined();
  });

  it("flips to right anchoring near the right edge so it stays inside", () => {
    const s = tooltipPositionStyle({ leftPx: 780, topPx: 40, ...AREA });
    // right = areaW - leftPx + offset = 800 - 780 + 12
    expect(s.right).toBe("32px");
    expect(s.left).toBeUndefined();
    // The box's right edge lands at areaW - 32 = 768px ≤ areaW: no overflow.
    expect(AREA.areaW - 32).toBeLessThanOrEqual(AREA.areaW);
  });

  it("flips to bottom anchoring in the lower half", () => {
    const s = tooltipPositionStyle({ leftPx: 50, topPx: 560, ...AREA });
    expect(s.bottom).toBe("52px"); // areaH - topPx + offset = 600 - 560 + 12
    expect(s.top).toBeUndefined();
    expect(s.left).toBe("62px");
  });

  it("does not flip off the left edge on a panel narrower than the tooltip", () => {
    // 250px panel < tooltip max-width: hovering at the left must still anchor
    // by `left` (pointer is before the midpoint) rather than flip the box off
    // the left edge.
    const s = tooltipPositionStyle({
      leftPx: 20,
      topPx: 20,
      areaW: 250,
      areaH: 200,
    });
    expect(s.left).toBe("32px");
    expect(s.right).toBeUndefined();
  });

  it("flips toward the side with more room on a narrow panel (pointer right)", () => {
    const s = tooltipPositionStyle({
      leftPx: 230,
      topPx: 20,
      areaW: 250,
      areaH: 200,
    });
    expect(s.right).toBe("32px"); // 250 - 230 + 12
    expect(s.left).toBeUndefined();
  });
});
