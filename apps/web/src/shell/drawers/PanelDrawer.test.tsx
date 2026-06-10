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
import { MAX_PLOT_SERIES } from "../../panels/palette";

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
            nativeId: "chan-a",
            sourceId: "src-a",
            name: "alpha",
            kind: "scalar",
            dtype: "f64",
            unit: null,
            sampleCount: 3,
            timeRange: { startNs: 0n, endNs: 1_000_000_000n },
          },
          {
            id: "chan-b",
            nativeId: "chan-b",
            sourceId: "src-a",
            name: "beta",
            kind: "scalar",
            dtype: "f64",
            unit: null,
            sampleCount: 3,
            timeRange: { startNs: 0n, endNs: 1_000_000_000n },
          },
          {
            id: "video-stream",
            nativeId: "video-stream",
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
        nativeId: "chan-a",
        sourceId: "src-a",
        name: "alpha",
        kind: "scalar",
        dtype: "f64",
        unit: null,
        sampleCount: 3,
        timeRange: { startNs: 0n, endNs: 1_000_000_000n },
      },
      {
        id: "chan-b",
        nativeId: "chan-b",
        sourceId: "src-a",
        name: "beta",
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

  it("stores undefined from setSelectedPanelId as null and stays on the empty state", () => {
    // Regression: the `setSelectedPanelId` dev hook is driven from untyped
    // JS (page.evaluate), so `undefined` can arrive where the types say
    // `string | null`. It used to land in the store verbatim, slip past the
    // drawer's `=== null` guard, and crash `panelKindOf` — unmounting the
    // whole app. The action now coerces non-strings to null.
    useSession.getState().setSelectedPanelId(undefined);
    render(<PanelDrawer />);
    expect(useSession.getState().selectedPanelId).toBeNull();
    expect(screen.getByTestId("panel-drawer-empty")).toBeTruthy();
  });

  it("renders the empty state even if the store itself holds undefined", () => {
    // Defence in depth: bypass the (now hardened) action and corrupt the
    // state directly. The drawer must treat any non-string id as "nothing
    // selected" rather than crash.
    useSession.setState({ selectedPanelId: undefined });
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
      `1 / ${MAX_PLOT_SERIES}`,
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

  it("plot zoom: ± zooms the time axis and Reset clears the override", () => {
    useSession.setState({
      globalRange: { startNs: 0n, endNs: 1_000_000_000n },
    });
    useSession.getState().setSelectedPanelId("plot-1");
    useSession.getState().addPlotChannel("plot-1", "chan-a");
    render(<PanelDrawer />);

    // Nothing zoomed yet → Reset disabled.
    const reset = screen.getByTestId(
      "panel-plot-zoom-reset",
    ) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);

    // Zoom in on the time axis. plot-1 is synced by default, so the window
    // lands in the SHARED store and Reset enables.
    fireEvent.click(screen.getByTestId("panel-plot-zoom-in"));
    expect(useSession.getState().sharedPlotZoomX).toBeTruthy();
    expect(
      (screen.getByTestId("panel-plot-zoom-reset") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    // Reset clears the shared window (and any per-panel override).
    fireEvent.click(screen.getByTestId("panel-plot-zoom-reset"));
    expect(useSession.getState().sharedPlotZoomX).toBeNull();
  });

  it("plot sync-time-axis toggle flips the per-panel flag (default on)", () => {
    useSession.getState().setSelectedPanelId("plot-1");
    useSession.getState().addPlotChannel("plot-1", "chan-a");
    render(<PanelDrawer />);

    const toggle = screen.getByTestId(
      "panel-plot-sync-toggle",
    ) as HTMLButtonElement;
    // Default: synced on.
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    // Turning it off persists `syncTimeAxis: false` on the panel.
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(
      useSession.getState().plotPanelSettings["plot-1"]?.syncTimeAxis,
    ).toBe(false);

    // Turning it back on stores it as a deletion (default posture).
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      "syncTimeAxis" in (useSession.getState().plotPanelSettings["plot-1"] ?? {}),
    ).toBe(false);
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

  describe("scene channel-kind filter", () => {
    // The seed() source carries only a scalar + a video channel, so a fresh
    // scene panel has nothing point-cloud-shaped to bind. Append a vector
    // channel (the kind a point cloud arrives as) to exercise the happy path.
    function addVectorChannel(): void {
      const st = useSession.getState();
      const vector = {
        id: "cloud-a",
        nativeId: "cloud-a",
        sourceId: "src-a",
        name: "lidar points",
        group: null,
        kind: "vector" as const,
        dtype: "f64",
        unit: null,
        sampleCount: 10,
        timeRange: { startNs: 0n, endNs: 1_000_000_000n },
      };
      useSession.setState({
        sources: st.sources.map((src) =>
          src.id === "src-a"
            ? { ...src, channels: [...src.channels, vector] }
            : src,
        ),
        channels: [...st.channels, vector],
      });
    }

    it("disables the add button when no vector channels are loaded", () => {
      useSession.getState().setSelectedPanelId("scene-1");
      render(<PanelDrawer />);
      expect(
        screen
          .getByTestId("panel-scene-add-channel")
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(screen.getByTestId("panel-scene-detect").textContent).toMatch(
        /No point-cloud channels detected/,
      );
    });

    it("enables the add button and reports the detected count", () => {
      addVectorChannel();
      useSession.getState().setSelectedPanelId("scene-1");
      render(<PanelDrawer />);
      const add = screen.getByTestId("panel-scene-add-channel");
      expect(add.getAttribute("aria-disabled")).toBeNull();
      expect(screen.getByTestId("panel-scene-detect").textContent).toContain(
        "1 compatible channel ",
      );
    });

    it("offers only vector channels in the scene picker", () => {
      addVectorChannel();
      useSession.getState().setSelectedPanelId("scene-1");
      render(<PanelDrawer />);
      fireEvent.click(screen.getByTestId("panel-scene-add-channel"));
      // The vector channel is offered; the scalar `chan-a` is filtered out.
      expect(screen.getByTestId("pick-cloud-a")).toBeTruthy();
      expect(screen.queryByTestId("pick-chan-a")).toBeNull();
    });

    it("binds the picked vector channel through the picker", () => {
      addVectorChannel();
      useSession.getState().setSelectedPanelId("scene-1");
      render(<PanelDrawer />);
      fireEvent.click(screen.getByTestId("panel-scene-add-channel"));
      fireEvent.click(screen.getByTestId("pick-cloud-a"));
      expect(useSession.getState().sceneBindings["scene-1"]).toBe("cloud-a");
    });
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

  it("binds the map by picking lat then lon one at a time", () => {
    // Regression: the two pickers are filled one at a time, but the store's
    // MapBinding needs both axes. Picking lat alone used to be discarded
    // (written straight back as null), so the map could never be bound from
    // the drawer — the user just saw nothing happen on click.
    useSession.getState().setSelectedPanelId("map-1");
    // clear() is a no-op without a worker (jsdom), so reset the binding
    // explicitly for a hermetic start.
    useSession.getState().setMapBinding("map-1", null);
    render(<PanelDrawer />);

    // Pick latitude.
    fireEvent.click(screen.getByTestId("panel-map-pick-lat"));
    fireEvent.click(screen.getByTestId("pick-chan-a"));
    // Half-pick: the drawer reflects lat immediately, but nothing is
    // committed until lon lands.
    expect(screen.getByTestId("panel-map-remove-lat")).toBeTruthy();
    expect(useSession.getState().mapBindings["map-1"] ?? null).toBeNull();

    // Pick longitude → the complete pair commits.
    fireEvent.click(screen.getByTestId("panel-map-pick-lon"));
    fireEvent.click(screen.getByTestId("pick-chan-b"));
    expect(useSession.getState().mapBindings["map-1"]).toEqual({
      latChannelId: "chan-a",
      lonChannelId: "chan-b",
    });
  });

  it("binds the map when lon is picked before lat", () => {
    // Order independence: the half-pick is held whichever axis is chosen
    // first.
    useSession.getState().setSelectedPanelId("map-1");
    useSession.getState().setMapBinding("map-1", null);
    render(<PanelDrawer />);

    fireEvent.click(screen.getByTestId("panel-map-pick-lon"));
    fireEvent.click(screen.getByTestId("pick-chan-b"));
    expect(screen.getByTestId("panel-map-remove-lon")).toBeTruthy();
    expect(useSession.getState().mapBindings["map-1"] ?? null).toBeNull();

    fireEvent.click(screen.getByTestId("panel-map-pick-lat"));
    fireEvent.click(screen.getByTestId("pick-chan-a"));
    expect(useSession.getState().mapBindings["map-1"]).toEqual({
      latChannelId: "chan-a",
      lonChannelId: "chan-b",
    });
  });

  it("renders the table body and remove fires removeTableChannel", () => {
    useSession.getState().setSelectedPanelId("table-1");
    useSession.getState().addTableChannel("table-1", "chan-a");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("TABLE");
    expect(screen.getByTestId("panel-table-count").textContent).toBe(
      `1 / ${MAX_PLOT_SERIES}`,
    );
    fireEvent.click(screen.getByTestId("panel-table-remove-chan-a"));
    expect(useSession.getState().tableBindings["table-1"]).toEqual([]);
  });

  it("renders the enum body and remove fires removeEnumChannel", () => {
    useSession.getState().setSelectedPanelId("enum-1");
    useSession.getState().addEnumChannel("enum-1", "chan-a");
    render(<PanelDrawer />);
    expect(screen.getByTestId("drawer-panel-kind").textContent).toBe("ENUM");
    expect(screen.getByTestId("panel-enum-count").textContent).toBe(
      `1 / ${MAX_PLOT_SERIES}`,
    );
    fireEvent.click(screen.getByTestId("panel-enum-remove-chan-a"));
    expect(useSession.getState().enumBindings["enum-1"]).toEqual([]);
  });

  it("falls back to UnknownKind for an unrecognised id prefix", () => {
    useSession.getState().setSelectedPanelId("widget-orphan");
    render(<PanelDrawer />);
    expect(screen.getByTestId("panel-drawer-unknown")).toBeTruthy();
  });

  describe("plot gap-threshold (Phase 8)", () => {
    it("plot body renders the gap-threshold section with default off state", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      render(<PanelDrawer />);
      expect(screen.getByTestId("panel-plot-gap-section")).toBeTruthy();
      const toggle = screen.getByTestId("panel-plot-gap-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      // Input row is hidden until the toggle is on.
      expect(screen.queryByTestId("panel-plot-gap-input-row")).toBeNull();
    });

    it("toggling on writes a positive default and exposes the input", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      render(<PanelDrawer />);
      const toggle = screen.getByTestId("panel-plot-gap-toggle");
      fireEvent.click(toggle);
      // Default seed when toggled on without a prior draft is 1 sec.
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.gapThresholdSec,
      ).toBe(1);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(screen.getByTestId("panel-plot-gap-input-row")).toBeTruthy();
    });

    it("toggling off clears the per-panel threshold to null", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      useSession.getState().setPlotGapThreshold("plot-1", 2.5);
      render(<PanelDrawer />);
      const toggle = screen.getByTestId("panel-plot-gap-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(toggle);
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.gapThresholdSec,
      ).toBeNull();
    });

    it("blurring a valid number commits to the store", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      useSession.getState().setPlotGapThreshold("plot-1", 1);
      render(<PanelDrawer />);
      const input = screen.getByTestId(
        "panel-plot-gap-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "0.75" } });
      fireEvent.blur(input);
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.gapThresholdSec,
      ).toBe(0.75);
    });

    it("pressing Enter commits the draft and blurs the input", () => {
      // Power users edit by typing then hitting Enter rather than
      // tabbing out. The Enter handler must commit-and-blur (not just
      // commit), otherwise the still-focused input swallows shortcuts
      // like space-to-play.
      useSession.getState().setSelectedPanelId("plot-1");
      useSession.getState().setPlotGapThreshold("plot-1", 1);
      render(<PanelDrawer />);
      const input = screen.getByTestId(
        "panel-plot-gap-input",
      ) as HTMLInputElement;
      input.focus();
      expect(document.activeElement).toBe(input);
      fireEvent.change(input, { target: { value: "0.4" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.gapThresholdSec,
      ).toBe(0.4);
      expect(document.activeElement).not.toBe(input);
    });

    it("blurring an invalid number reverts the draft without flipping the mode", () => {
      // The user might transiently type a non-positive or empty value
      // mid-edit; that shouldn't cascade into "off" state.
      useSession.getState().setSelectedPanelId("plot-1");
      useSession.getState().setPlotGapThreshold("plot-1", 2);
      render(<PanelDrawer />);
      const input = screen.getByTestId(
        "panel-plot-gap-input",
      ) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "-3" } });
      fireEvent.blur(input);
      // Store stays at 2; draft reverts back.
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.gapThresholdSec,
      ).toBe(2);
    });
  });

  describe("plot stack-axes", () => {
    it("renders the stack toggle off by default", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      render(<PanelDrawer />);
      expect(screen.getByTestId("panel-plot-stack-section")).toBeTruthy();
      const toggle = screen.getByTestId("panel-plot-stack-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });

    it("toggling on sets stackAxes and reflects aria-checked", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      render(<PanelDrawer />);
      const toggle = screen.getByTestId("panel-plot-stack-toggle");
      fireEvent.click(toggle);
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.stackAxes,
      ).toBe(true);
      expect(toggle.getAttribute("aria-checked")).toBe("true");
    });

    it("toggling off clears the flag", () => {
      useSession.getState().setSelectedPanelId("plot-1");
      useSession.getState().setPlotStackAxes("plot-1", true);
      render(<PanelDrawer />);
      const toggle = screen.getByTestId("panel-plot-stack-toggle");
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      fireEvent.click(toggle);
      expect(
        useSession.getState().plotPanelSettings["plot-1"]?.stackAxes ?? false,
      ).toBe(false);
    });
  });
});
