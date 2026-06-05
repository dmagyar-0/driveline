// @vitest-environment jsdom
//
// Phase 6 · EnumPanel render tests. The canvas paint path is exercised
// only minimally under jsdom (no real 2d context); the e2e spec covers
// the full fixture-driven render.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  const g = globalThis as unknown as { ResizeObserver: unknown };
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { EnumPanel, segmentsFor } from "./EnumPanel";
import type { PlotSeries } from "./seriesFromArrow";
import { useSession, type SourceMeta } from "../state/store";

const SOURCE: SourceMeta = {
  id: "src-a",
  kind: "mcap",
  name: "a.mcap",
  handle: 1,
  timeRange: { startNs: 0n, endNs: 1_000_000_000n },
  channels: [
    {
      id: "/state/gear",
      nativeId: "/state/gear",
      sourceId: "src-a",
      name: "gear",
      kind: "scalar",
      dtype: "f64",
      unit: null,
      sampleCount: 5,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
    {
      id: "/state/mode",
      nativeId: "/state/mode",
      sourceId: "src-a",
      name: "mode",
      kind: "scalar",
      dtype: "f64",
      unit: null,
      sampleCount: 5,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
    {
      id: "/state/drive_mode",
      nativeId: "/state/drive_mode",
      sourceId: "src-a",
      name: "drive_mode",
      kind: "enum",
      dtype: "i32",
      unit: null,
      sampleCount: 5,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
  ],
};

function seed(): void {
  useSession.setState({
    sources: [SOURCE],
    channels: SOURCE.channels,
    globalRange: SOURCE.timeRange,
  });
}

describe("EnumPanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty state when nothing is bound", () => {
    seed();
    render(<EnumPanel panelId="enum-1" />);
    expect(screen.getByTestId("enum-empty")).toBeTruthy();
  });

  it("shows the channel name when bound", () => {
    seed();
    useSession.getState().setEnumBinding("enum-1", ["/state/gear"]);
    render(<EnumPanel panelId="enum-1" />);
    expect(screen.getByTestId("enum-channel-name").textContent).toBe("gear");
  });

  it("renders one lane per bound channel", () => {
    seed();
    useSession
      .getState()
      .setEnumBinding("enum-1", ["/state/gear", "/state/mode"]);
    render(<EnumPanel panelId="enum-1" />);
    const lanes = screen.getAllByTestId("enum-lane");
    expect(lanes).toHaveLength(2);
    expect(
      screen.getAllByTestId("enum-channel-name").map((n) => n.textContent),
    ).toEqual(["gear", "mode"]);
  });

  it("clears the binding when the bound channel disappears", () => {
    // Seed a source so the cull effect runs — the gate on
    // `sources.length > 0` exists so a fresh hydrate (channels list
    // empty) doesn't wipe persisted bindings before the user has
    // dropped a file.
    seed();
    useSession.setState({
      enumBindings: { "enum-1": ["/ghost"] },
    });
    render(<EnumPanel panelId="enum-1" />);
    // The cleanup effect drops the orphaned binding; empty state renders.
    expect(screen.getByTestId("enum-empty")).toBeTruthy();
    expect(useSession.getState().enumBindings["enum-1"]).toEqual([]);
  });

  it("does not clear a persisted binding before any source loads", () => {
    // Pre-fix this would wipe the binding on hydrate; with the
    // `sources.length > 0` gate it survives until the user actually
    // drops a file (at which point the cull above fires).
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      enumBindings: { "enum-1": ["/persisted"] },
    });
    render(<EnumPanel panelId="enum-1" />);
    expect(useSession.getState().enumBindings["enum-1"]).toEqual([
      "/persisted",
    ]);
  });

  it("admits an enum-kind channel binding and renders its lane", () => {
    seed();
    useSession.getState().setEnumBinding("enum-1", ["/state/drive_mode"]);
    render(<EnumPanel panelId="enum-1" />);
    // The cull effect keeps enum-kind bindings (not only scalar).
    expect(useSession.getState().enumBindings["enum-1"]).toEqual([
      "/state/drive_mode",
    ]);
    expect(screen.getByTestId("enum-channel-name").textContent).toBe(
      "drive_mode",
    );
  });
});

// `series` factory: build a minimal PlotSeries from parallel ys/ts arrays.
function series(ys: number[], tsNs: bigint[]): PlotSeries {
  return {
    kind: "scalar",
    xs: new Float64Array(ys.length),
    ys: new Float64Array(ys),
    rawTsNs: BigInt64Array.from(tsNs),
  };
}

describe("EnumPanel · segmentsFor", () => {
  it("coalesces consecutive equal values into one segment", () => {
    const segs = segmentsFor(series([1, 1, 1, 2, 2], [0n, 1n, 2n, 3n, 4n]), 5n);
    expect(segs.map((s) => s.value)).toEqual([1, 2]);
    expect(segs[0]).toMatchObject({ startNs: 0n, endNs: 3n });
    expect(segs[1]).toMatchObject({ startNs: 3n, endNs: 5n });
  });

  it("coalesces a run of NaN into a single gap segment (value === null)", () => {
    const segs = segmentsFor(
      series([NaN, NaN, NaN, NaN], [0n, 1n, 2n, 3n]),
      4n,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].value).toBeNull();
    // No `colorFor("NaN")` — gaps get the neutral gap colour.
    expect(segs[0].color).not.toBe("NaN");
  });

  it("separates a NaN gap from surrounding finite states", () => {
    const segs = segmentsFor(series([1, NaN, NaN, 2], [0n, 1n, 2n, 3n]), 4n);
    expect(segs.map((s) => s.value)).toEqual([1, null, 2]);
  });

  it("treats Infinity as a gap too", () => {
    const segs = segmentsFor(series([Infinity, -Infinity], [0n, 1n]), 2n);
    expect(segs).toHaveLength(1);
    expect(segs[0].value).toBeNull();
  });
});
