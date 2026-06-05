// @vitest-environment jsdom
//
// ChannelPicker kind-filter tests. The picker defaults to scalar-only (so
// PlotPanel and the Table/Value/Scene/Map drawers keep their behaviour) but
// accepts an explicit `kinds` set — EnumPanel's drawer passes
// `["scalar", "enum"]` so genuine enum channels can be bound.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { ChannelPicker } from "./ChannelPicker";
import { useSession, type SourceMeta } from "../state/store";

const SOURCE: SourceMeta = {
  id: "src-a",
  kind: "mcap",
  name: "a.mcap",
  handle: 1,
  timeRange: { startNs: 0n, endNs: 1_000_000_000n },
  channels: [
    {
      id: "/speed",
      nativeId: "/speed",
      sourceId: "src-a",
      name: "speed",
      kind: "scalar",
      dtype: "f64",
      unit: "m/s",
      sampleCount: 5,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
    {
      id: "/gear",
      nativeId: "/gear",
      sourceId: "src-a",
      name: "gear",
      kind: "enum",
      dtype: "i32",
      unit: null,
      sampleCount: 5,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
  ],
};

const anchor = {
  top: 10,
  bottom: 20,
  left: 10,
  right: 40,
  width: 30,
  height: 10,
  x: 10,
  y: 10,
  toJSON: () => ({}),
} as DOMRect;

describe("ChannelPicker · kind filter", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("offers only scalar channels by default", () => {
    render(
      <ChannelPicker
        sources={[SOURCE]}
        selectedIds={[]}
        maxSelected={4}
        anchorRect={anchor}
        onToggle={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId("pick-/speed")).toBeTruthy();
    expect(screen.queryByTestId("pick-/gear")).toBeNull();
  });

  it("offers enum channels when kinds includes enum", () => {
    render(
      <ChannelPicker
        sources={[SOURCE]}
        selectedIds={[]}
        maxSelected={4}
        anchorRect={anchor}
        onToggle={() => {}}
        onClose={() => {}}
        kinds={["scalar", "enum"]}
      />,
    );
    expect(screen.getByTestId("pick-/speed")).toBeTruthy();
    expect(screen.getByTestId("pick-/gear")).toBeTruthy();
  });

  it("shows a kind-specific empty message when nothing matches", () => {
    const noScalar: SourceMeta = {
      ...SOURCE,
      channels: [SOURCE.channels[1]], // enum only
    };
    render(
      <ChannelPicker
        sources={[noScalar]}
        selectedIds={[]}
        maxSelected={4}
        anchorRect={anchor}
        onToggle={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No scalar channels loaded/)).toBeTruthy();
  });
});
