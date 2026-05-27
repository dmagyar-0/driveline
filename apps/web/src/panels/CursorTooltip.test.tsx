// @vitest-environment jsdom
//
// Unit tests for the floating cursor tooltip (iter2 issue #1).
//
// The component is intentionally pure: it draws what it's told. The
// only logic worth covering directly is the flip-when-near-right-edge
// decision (`tooltipLeft`) and the "hide when no entries / null x"
// branches.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CursorTooltip, tooltipLeft } from "./CursorTooltip";
import type { CursorReadoutEntry } from "./CursorReadout";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function entry(over: Partial<CursorReadoutEntry> = {}): CursorReadoutEntry {
  return {
    channelId: over.channelId ?? "c1",
    shortLabel: over.shortLabel ?? "speed",
    value: over.value ?? "12.34",
    unit: over.unit ?? "m/s",
    sourceBadge: over.sourceBadge ?? "",
  };
}

afterEach(() => cleanup());

describe("tooltipLeft", () => {
  it("anchors to the right of the cursor when it fits", () => {
    // Cursor at x=100, container 800 wide, tooltip 240, gap 8 →
    // 100 + 8 = 108 fits (108 + 240 = 348 ≤ 800).
    expect(tooltipLeft(100, 800)).toBe(108);
  });

  it("flips to the left of the cursor when the right anchor would overflow", () => {
    // Cursor near right edge: 700 + 8 + 240 = 948 > 800 → flip.
    // Flipped: 700 - 8 - 240 = 452.
    expect(tooltipLeft(700, 800)).toBe(452);
  });

  it("clamps to 0 when flipping past the left edge", () => {
    // Tiny container — both right and flipped left would clip. The
    // helper picks max(0, …) so the tooltip stays inside the panel.
    expect(tooltipLeft(50, 100)).toBe(0);
  });

  it("respects a custom tooltip width", () => {
    // 200 + 4 + 60 = 264 ≤ 400 → fits on the right.
    expect(tooltipLeft(200, 400, 60, 4)).toBe(204);
  });
});

describe("<CursorTooltip />", () => {
  it("renders nothing when xPx is null", () => {
    const { queryByTestId } = render(
      <CursorTooltip
        xPx={null}
        containerWidthPx={400}
        timeLabel="00:01.000"
        entries={[entry()]}
      />,
    );
    expect(queryByTestId("plot-cursor-tooltip")).toBeNull();
  });

  it("renders nothing when entries is empty", () => {
    const { queryByTestId } = render(
      <CursorTooltip
        xPx={100}
        containerWidthPx={400}
        timeLabel={null}
        entries={[]}
      />,
    );
    expect(queryByTestId("plot-cursor-tooltip")).toBeNull();
  });

  it("renders one row per entry plus the time header", () => {
    const { getByTestId, queryByText } = render(
      <CursorTooltip
        xPx={100}
        containerWidthPx={400}
        timeLabel="00:30.500"
        entries={[entry({ channelId: "a" }), entry({ channelId: "b" })]}
      />,
    );
    expect(getByTestId("plot-cursor-tooltip")).toBeTruthy();
    expect(getByTestId("tooltip-row-a")).toBeTruthy();
    expect(getByTestId("tooltip-row-b")).toBeTruthy();
    expect(queryByText("00:30.500")).toBeTruthy();
  });

  it("surfaces the source badge when supplied", () => {
    const { getByTestId } = render(
      <CursorTooltip
        xPx={100}
        containerWidthPx={400}
        timeLabel={null}
        entries={[entry({ channelId: "x", sourceBadge: "mcap" })]}
      />,
    );
    expect(getByTestId("tooltip-badge-x").textContent).toBe("mcap");
  });
});
