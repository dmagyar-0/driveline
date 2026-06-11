// @vitest-environment jsdom
//
// TablePanel render tests. Asserts the empty state, the bound-channel
// header columns, and stale-binding cleanup. The virtualised body and the
// cursor-row highlight ride on the worker fetch, which jsdom can't run
// (no wasm-pack output), so the merge/scroll behaviour is covered by
// `tableModel.test.ts` plus the e2e spec.

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
      nativeId: "/speed",
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
      nativeId: "/rpm",
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

  it("renders a header column per bound channel", () => {
    seed();
    useSession.getState().addTableChannel("table-1", "/speed");
    useSession.getState().addTableChannel("table-1", "/rpm");
    render(<TablePanel panelId="table-1" />);
    expect(screen.getByTestId("table-panel")).toBeTruthy();
    expect(screen.getByTestId("table-col-/speed")).toBeTruthy();
    expect(screen.getByTestId("table-col-/rpm")).toBeTruthy();
  });

  it("drops bindings whose channel id no longer exists", () => {
    seed();
    useSession.setState({
      tableBindings: { "table-1": ["/ghost"] },
    });
    render(<TablePanel panelId="table-1" />);
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
