// @vitest-environment jsdom
//
// ScenePanel render tests. The WebGL renderer itself can't run under jsdom
// (no `webgl2` context), so these assert the panel's *state branching*: the
// empty-state callout with no binding, the bound branch (canvas host) once a
// point-cloud channel is bound, and that a binding to a missing channel falls
// back to empty rather than rendering a dead canvas.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Channel, SourceMeta } from "../state/store";

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

import { ScenePanel } from "./ScenePanel";
import { useSession } from "../state/store";

function fakePointCloudSource(): { source: SourceMeta; channel: Channel } {
  const channel: Channel = {
    id: "src/cloud",
    nativeId: "cloud",
    sourceId: "src",
    name: "lidar_top_360fov",
    group: null,
    kind: "point_cloud",
    dtype: null,
    unit: null,
    sampleCount: 1000,
    timeRange: { startNs: 0n, endNs: 1_000_000_000n },
  };
  const source: SourceMeta = {
    id: "src",
    kind: "lidar",
    name: "src",
    handle: 0,
    timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    channels: [channel],
  };
  return { source, channel };
}

describe("ScenePanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty-state callout when no binding is set", () => {
    render(<ScenePanel panelId="scene-1" />);
    expect(screen.getByTestId("scene-empty")).toBeTruthy();
    expect(screen.queryByTestId("scene-canvas-host")).toBeNull();
  });

  it("renders the canvas host once a point-cloud channel is bound", () => {
    const { source } = fakePointCloudSource();
    useSession.setState({ sources: [source], channels: source.channels });
    useSession.getState().setSceneBinding("scene-1", "src/cloud");
    render(<ScenePanel panelId="scene-1" />);
    expect(screen.getByTestId("scene-canvas-host")).toBeTruthy();
    expect(screen.queryByTestId("scene-empty")).toBeNull();
  });

  it("falls back to empty when the bound channel id no longer resolves", () => {
    useSession.getState().setSceneBinding("scene-1", "does/not/exist");
    render(<ScenePanel panelId="scene-1" />);
    // No matching channel → treated as unbound, so the empty callout shows.
    expect(screen.getByTestId("scene-empty")).toBeTruthy();
    expect(screen.queryByTestId("scene-canvas-host")).toBeNull();
  });
});
