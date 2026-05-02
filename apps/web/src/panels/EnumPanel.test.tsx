// @vitest-environment jsdom
//
// Phase 6 · EnumPanel render tests. The canvas paint path is exercised
// only minimally under jsdom (no real 2d context); the e2e spec covers
// the full fixture-driven render.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  const g = globalThis as unknown as { ResizeObserver: unknown };
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { EnumPanel } from "./EnumPanel";
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
    useSession.getState().setEnumBinding("enum-1", "/state/gear");
    render(<EnumPanel panelId="enum-1" />);
    expect(screen.getByTestId("enum-channel-name").textContent).toBe(
      "gear",
    );
  });

  it("clears the binding when the bound channel disappears", () => {
    // Seed a source so the cull effect runs — the gate on
    // `sources.length > 0` exists so a fresh hydrate (channels list
    // empty) doesn't wipe persisted bindings before the user has
    // dropped a file.
    seed();
    useSession.setState({
      enumBindings: { "enum-1": "/ghost" },
    });
    render(<EnumPanel panelId="enum-1" />);
    // The cleanup effect drops the orphaned binding; empty state renders.
    expect(screen.getByTestId("enum-empty")).toBeTruthy();
    expect(useSession.getState().enumBindings["enum-1"]).toBeNull();
  });

  it("does not clear a persisted binding before any source loads", () => {
    // Pre-fix this would wipe the binding on hydrate; with the
    // `sources.length > 0` gate it survives until the user actually
    // drops a file (at which point the cull above fires).
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      enumBindings: { "enum-1": "/persisted" },
    });
    render(<EnumPanel panelId="enum-1" />);
    expect(useSession.getState().enumBindings["enum-1"]).toBe("/persisted");
  });
});
