// @vitest-environment jsdom
//
// Phase 5 · PanelDrawer component tests.
//
// Verifies the empty state, plot-kind body, and video-kind body render
// from the store. The picker popover and decoder polling are smoke-
// tested; the deeper end-to-end click + persistence path lives in
// `apps/e2e/tests/panelDrawer.spec.ts`.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { PanelDrawer } from "./PanelDrawer";
import { useSession } from "../../state/store";

function seed(): void {
  useSession.setState({
    sources: [
      {
        id: "src-a",
        kind: "mcap",
        name: "a.mcap",
        handle: 1,
        timeRange: { startNs: 0n, endNs: 1_000_000_000n },
        channels: [
          {
            id: "chan-a",
            sourceId: "src-a",
            name: "alpha",
            kind: "scalar",
            dtype: "f64",
            unit: null,
            sampleCount: 3,
            timeRange: { startNs: 0n, endNs: 1_000_000_000n },
          },
          {
            id: "video-stream",
            sourceId: "src-a",
            name: "front cam",
            kind: "video",
            dtype: null,
            unit: null,
            sampleCount: 30,
            timeRange: { startNs: 0n, endNs: 1_000_000_000n },
          },
        ],
      },
    ],
    channels: [
      {
        id: "chan-a",
        sourceId: "src-a",
        name: "alpha",
        kind: "scalar",
        dtype: "f64",
        unit: null,
        sampleCount: 3,
        timeRange: { startNs: 0n, endNs: 1_000_000_000n },
      },
    ],
    layoutJson: {
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 50,
            children: [
              { type: "tab", id: "plot-1", name: "Speed", component: "plot" },
              { type: "tab", id: "video-1", name: "Front cam", component: "video" },
            ],
          },
        ],
      },
    },
  });
}

describe("PanelDrawer", () => {
  beforeEach(() => {
    seed();
  });

  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
    useSession.getState().setLayoutJson(null);
    useSession.getState().setSelectedPanelId(null);
  });

  it("renders the empty state when no panel is selected", () => {
    render(<PanelDrawer />);
    expect(screen.getByTestId("panel-drawer-empty")).toBeTruthy();
    expect(screen.queryByTestId("drawer-panel-name")).toBeNull();
  });

  it("renders the plot body for a selected plot panel", () => {
    useSession.getState().setSelectedPanelId("plot-1");
    useSession.getState().addPlotChannel("plot-1", "chan-a");
    render(<PanelDrawer />);
    const name = screen.getByTestId("drawer-panel-name");
    expect(name.textContent).toBe("Speed");
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("PLOT");
    expect(screen.getByTestId("panel-plot-count").textContent).toBe(
      "1 / 8",
    );
    expect(screen.getByTestId("panel-plot-remove-chan-a")).toBeTruthy();
  });

  it("removePlotChannel fires when × is clicked", () => {
    useSession.getState().setSelectedPanelId("plot-1");
    useSession.getState().addPlotChannel("plot-1", "chan-a");
    render(<PanelDrawer />);
    fireEvent.click(screen.getByTestId("panel-plot-remove-chan-a"));
    expect(useSession.getState().plotBindings["plot-1"]).toEqual([]);
  });

  it("renders the video body with HUD toggle reading store state", () => {
    useSession.getState().setSelectedPanelId("video-1");
    useSession.getState().setVideoBinding("video-1", "video-stream");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("VIDEO");
    const toggle = screen.getByTestId("panel-drawer-hud-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(useSession.getState().videoHudOn["video-1"]).toBe(true);
    expect(
      screen
        .getByTestId("panel-drawer-hud-toggle")
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("video body shows the bound channel and clears it via ×", () => {
    useSession.getState().setSelectedPanelId("video-1");
    useSession.getState().setVideoBinding("video-1", "video-stream");
    render(<PanelDrawer />);
    fireEvent.click(screen.getByTestId("panel-video-remove-video-stream"));
    expect(useSession.getState().videoBindings["video-1"]).toBeNull();
  });

  it("step-hold placeholder is rendered as aria-disabled", () => {
    useSession.getState().setSelectedPanelId("video-1");
    render(<PanelDrawer />);
    const sh = screen.getByTestId("panel-drawer-step-hold");
    expect(sh.getAttribute("aria-disabled")).toBe("true");
  });

  it("falls back to the panel id as a label when the layout has no name", () => {
    useSession.getState().setSelectedPanelId("plot-orphan");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-name").textContent).toBe(
      "plot-orphan",
    );
  });

  it("renders the scene body with a forward-compat callout", () => {
    useSession.getState().setSelectedPanelId("scene-1");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("SCENE");
    expect(screen.getByTestId("panel-scene-status")).toBeTruthy();
    expect(screen.getByTestId("panel-scene-add-channel")).toBeTruthy();
  });

  it("scene binding persists through setSceneBinding", () => {
    useSession.getState().setSelectedPanelId("scene-1");
    useSession.getState().setSceneBinding("scene-1", "chan-a");
    render(<PanelDrawer />);
    expect(screen.getByTestId("panel-scene-remove-chan-a")).toBeTruthy();
    fireEvent.click(screen.getByTestId("panel-scene-remove-chan-a"));
    expect(useSession.getState().sceneBindings["scene-1"]).toBeNull();
  });

  it("renders the map body with two pickers", () => {
    useSession.getState().setSelectedPanelId("map-1");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("MAP");
    expect(screen.getByTestId("panel-map-pick-lat")).toBeTruthy();
    expect(screen.getByTestId("panel-map-pick-lon")).toBeTruthy();
  });

  it("map removes both axes when either × is clicked", () => {
    useSession.getState().setSelectedPanelId("map-1");
    useSession.getState().setMapBinding("map-1", {
      latChannelId: "chan-a",
      lonChannelId: "chan-a",
    });
    render(<PanelDrawer />);
    fireEvent.click(screen.getByTestId("panel-map-remove-lat"));
    expect(useSession.getState().mapBindings["map-1"]).toBeNull();
  });

  it("renders the table body and remove fires removeTableChannel", () => {
    useSession.getState().setSelectedPanelId("table-1");
    useSession.getState().addTableChannel("table-1", "chan-a");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("TABLE");
    expect(screen.getByTestId("panel-table-count").textContent).toBe(
      "1 / 8",
    );
    fireEvent.click(screen.getByTestId("panel-table-remove-chan-a"));
    expect(useSession.getState().tableBindings["table-1"]).toEqual([]);
  });

  it("renders the enum body with the bound channel and clears via ×", () => {
    useSession.getState().setSelectedPanelId("enum-1");
    useSession.getState().setEnumBinding("enum-1", "chan-a");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("ENUM");
    fireEvent.click(screen.getByTestId("panel-enum-remove-chan-a"));
    expect(useSession.getState().enumBindings["enum-1"]).toBeNull();
  });

  it("falls back to UnknownKind for an unrecognised id prefix", () => {
    useSession.getState().setSelectedPanelId("widget-orphan");
    render(<PanelDrawer />);
    expect(screen.getByTestId("panel-drawer-unknown")).toBeTruthy();
  });
});
