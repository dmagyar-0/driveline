// @vitest-environment jsdom
//
// Unit tests for the right-side cursor-value gutter (iter3 issue #1).
//
// The component is pure-presentational — the parent feeds it gutter
// entries pre-computed in the same effect that publishes the sync
// snapshot. The tests assert the rendered surface includes:
//   - a row per entry with the source-coloured ribbon (iter3 issue #2);
//   - the 24h time header (iter3 issue #6);
//   - decimal-aligned values formatted per-unit (iter3 issue #3);
//   - the em-dash placeholder when the raw value is null.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { CursorGutter, type CursorGutterEntry } from "./CursorGutter";
import { colorFor, colorForSource } from "./palette";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function entry(over: Partial<CursorGutterEntry> = {}): CursorGutterEntry {
  return {
    channelId: over.channelId ?? "c1",
    shortLabel: over.shortLabel ?? "speed",
    value: "value" in over ? (over.value as string | null) : "12.34",
    rawValue: "rawValue" in over ? (over.rawValue as number | null) : 12.34,
    unit: over.unit ?? "m/s",
    sourceBadge: over.sourceBadge ?? "",
    sourceId: over.sourceId ?? "src-a",
  };
}

afterEach(() => cleanup());

describe("<CursorGutter />", () => {
  it("renders nothing when entries is empty", () => {
    const { queryByTestId } = render(
      <CursorGutter timeLabel="00:01:23" entries={[]} />,
    );
    expect(queryByTestId("plot-cursor-gutter")).toBeNull();
  });

  it("renders one row per entry plus the time header", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel="00:30:05"
        entries={[entry({ channelId: "a" }), entry({ channelId: "b" })]}
      />,
    );
    expect(getByTestId("plot-cursor-gutter")).toBeTruthy();
    expect(getByTestId("plot-cursor-gutter-time").textContent).toBe("00:30:05");
    expect(getByTestId("gutter-row-a")).toBeTruthy();
    expect(getByTestId("gutter-row-b")).toBeTruthy();
  });

  it("renders the per-source ribbon coloured by sourceId (iter3 issue #2)", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel={null}
        entries={[entry({ channelId: "x", sourceId: "comma2k19_seg4.mcap" })]}
      />,
    );
    const ribbon = getByTestId("gutter-ribbon-x") as HTMLElement;
    // jsdom normalises hex colours to `rgb(...)` when read back from
    // `style.background`. Convert the palette hex to the same form
    // before comparing rather than asserting on `getAttribute`.
    const expectedHex = colorForSource("comma2k19_seg4.mcap");
    const r = parseInt(expectedHex.slice(1, 3), 16);
    const g = parseInt(expectedHex.slice(3, 5), 16);
    const b = parseInt(expectedHex.slice(5, 7), 16);
    expect(ribbon.style.background).toBe(`rgb(${r}, ${g}, ${b})`);
  });

  it("formats values using the unit-aware fixed-decimal helper", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel={null}
        entries={[
          entry({ channelId: "v", rawValue: 30.6, unit: "m/s" }),
          entry({ channelId: "a", rawValue: 7.3, unit: "m/s" }),
          entry({ channelId: "d", rawValue: 90, unit: "deg" }),
        ]}
      />,
    );
    // m/s → 2 dp, columns line up by decimal point.
    expect(getByTestId("gutter-value-v").textContent).toContain("30.60");
    expect(getByTestId("gutter-value-a").textContent).toContain("7.30");
    // deg → 1 dp.
    expect(getByTestId("gutter-value-d").textContent).toContain("90.0");
  });

  it("renders em-dash when the raw value is null", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel={null}
        entries={[entry({ channelId: "z", rawValue: null, value: null })]}
      />,
    );
    expect(getByTestId("gutter-value-z").textContent).toBe("—");
  });

  it("surfaces the source badge when supplied", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel={null}
        entries={[entry({ channelId: "x", sourceBadge: "seg4" })]}
      />,
    );
    expect(getByTestId("gutter-badge-x").textContent).toBe("seg4");
  });

  it("renders a per-channel value swatch tinted to the line colour (iter4 #6)", () => {
    const { getByTestId } = render(
      <CursorGutter
        timeLabel={null}
        entries={[entry({ channelId: "chan-42" })]}
      />,
    );
    const swatch = getByTestId("gutter-value-swatch-chan-42") as HTMLElement;
    // The value swatch must match the channel's line stroke colour
    // (the same `colorFor` used by the uPlot series stroke) so the
    // user can trace colour → number → label in one saccade.
    const expectedHex = colorFor("chan-42");
    const r = parseInt(expectedHex.slice(1, 3), 16);
    const g = parseInt(expectedHex.slice(3, 5), 16);
    const b = parseInt(expectedHex.slice(5, 7), 16);
    expect(swatch.style.background).toBe(`rgb(${r}, ${g}, ${b})`);
  });
});
