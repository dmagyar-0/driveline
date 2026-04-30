// @vitest-environment jsdom
//
// Phase 6 · TablePanel render tests. Asserts the empty state and the
// row-per-binding render path. Doesn't drive the worker fetch — that
// surface is covered by the e2e spec under apps/e2e/tests/.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { TablePanel } from "./TablePanel";
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
      sourceId: "src-a",
      name: "speed",
      kind: "scalar",
      dtype: "f64",
      unit: "m/s",
      sampleCount: 3,
      timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    },
    {
      id: "/rpm",
      sourceId: "src-a",
      name: "rpm",
      kind: "scalar",
      dtype: "f64",
      unit: null,
      sampleCount: 3,
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

describe("TablePanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty state when nothing is bound", () => {
    seed();
    render(<TablePanel panelId="table-1" />);
    expect(screen.getByTestId("table-empty")).toBeTruthy();
  });

  it("renders one row per bound channel", () => {
    seed();
    useSession.getState().addTableChannel("table-1", "/speed");
    useSession.getState().addTableChannel("table-1", "/rpm");
    render(<TablePanel panelId="table-1" />);
    expect(screen.getByTestId("table-row-/speed")).toBeTruthy();
    expect(screen.getByTestId("table-row-/rpm")).toBeTruthy();
    // Cells render the em-dash placeholder until the worker fetch
    // completes (jsdom doesn't run wasm-pack output, so fetches reject
    // at the boundary). The component must not throw.
    expect(screen.getByTestId("table-value-/speed").textContent).toBe("—");
  });

  it("drops bindings whose channel id no longer exists", () => {
    // Seed a source so the cull effect runs — the gate on
    // `sources.length > 0` exists so a fresh hydrate (channels list
    // empty) doesn't wipe persisted bindings before the user has
    // dropped a file.
    seed();
    useSession.setState({
      tableBindings: { "table-1": ["/ghost"] },
    });
    render(<TablePanel panelId="table-1" />);
    // The cleanup effect filters the binding to []; empty state renders.
    expect(screen.getByTestId("table-empty")).toBeTruthy();
    expect(useSession.getState().tableBindings["table-1"]).toEqual([]);
  });

  it("does not clear a persisted binding before any source loads", () => {
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      tableBindings: { "table-1": ["/persisted"] },
    });
    render(<TablePanel panelId="table-1" />);
    expect(useSession.getState().tableBindings["table-1"]).toEqual([
      "/persisted",
    ]);
  });
});
