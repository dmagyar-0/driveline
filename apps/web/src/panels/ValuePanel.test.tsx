// @vitest-environment jsdom
//
// ValuePanel render tests. Asserts the empty state and the row-per-
// binding render path. Doesn't drive the worker fetch — that surface is
// covered by the e2e spec under apps/e2e/tests/.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ValuePanel } from "./ValuePanel";
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

describe("ValuePanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty state when nothing is bound", () => {
    seed();
    render(<ValuePanel panelId="value-1" />);
    expect(screen.getByTestId("value-empty")).toBeTruthy();
  });

  it("renders one row per bound channel", () => {
    seed();
    useSession.getState().addValueChannel("value-1", "/speed");
    useSession.getState().addValueChannel("value-1", "/rpm");
    render(<ValuePanel panelId="value-1" />);
    expect(screen.getByTestId("value-row-/speed")).toBeTruthy();
    expect(screen.getByTestId("value-row-/rpm")).toBeTruthy();
    // Cells render the em-dash placeholder until the worker fetch
    // completes (jsdom doesn't run wasm-pack output, so fetches reject
    // at the boundary). The component must not throw.
    expect(screen.getByTestId("value-value-/speed").textContent).toBe("—");
  });

  it("does not render a per-row timestamp column", () => {
    seed();
    useSession.getState().addValueChannel("value-1", "/speed");
    render(<ValuePanel panelId="value-1" />);
    // Only Channel + Value column headers — the ts column is gone.
    expect(screen.queryByText("ts (s)")).toBeNull();
  });

  it("drops bindings whose channel id no longer exists", () => {
    seed();
    useSession.setState({
      valueBindings: { "value-1": ["/ghost"] },
    });
    render(<ValuePanel panelId="value-1" />);
    expect(screen.getByTestId("value-empty")).toBeTruthy();
    expect(useSession.getState().valueBindings["value-1"]).toEqual([]);
  });

  it("does not clear a persisted binding before any source loads", () => {
    useSession.setState({
      sources: [],
      channels: [],
      globalRange: null,
      valueBindings: { "value-1": ["/persisted"] },
    });
    render(<ValuePanel panelId="value-1" />);
    expect(useSession.getState().valueBindings["value-1"]).toEqual([
      "/persisted",
    ]);
  });
});
