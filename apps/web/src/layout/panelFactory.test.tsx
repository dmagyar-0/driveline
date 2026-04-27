// @vitest-environment jsdom
//
// Phase 7 · panelFactory click-to-select wrapper.
//
// The factory wraps every panel body in a `<div>` whose `onPointerDown`
// updates `selectedPanelId` in the store. This test exercises the
// wrapper directly with a stub TabNode. We use the SCENE panel for the
// real-component cases because it doesn't pull in uPlot or trigger a
// worker fetch under jsdom — the wrapper logic is component-agnostic
// (every kind goes through the same outer `<div>`).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// uPlot is pulled in transitively by `panelFactory` → `PlotPanel`.
// uPlot calls `matchMedia()` at module load, so the shim must run
// before the import chain resolves. ResizeObserver is also missing
// from jsdom and is touched by every panel that uses it.
vi.hoisted(() => {
  const g = globalThis as unknown as {
    matchMedia: (q: string) => MediaQueryList;
    ResizeObserver: unknown;
  };
  g.matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import type { TabNode } from "flexlayout-react";
import { panelFactory } from "./panelFactory";
import { useSession } from "../state/store";
import { PANEL_COMPONENT_SCENE } from "./defaultLayout";

function makeTabNode(id: string, component: string): TabNode {
  return {
    getId: () => id,
    getComponent: () => component,
    getName: () => id,
  } as unknown as TabNode;
}

describe("panelFactory click-to-select wrapper", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
    useSession.getState().setSelectedPanelId(null);
  });

  it("emits a panel-body wrapper with a deterministic test id", () => {
    const node = makeTabNode("scene-xyz", PANEL_COMPONENT_SCENE);
    render(<>{panelFactory(node)}</>);
    expect(screen.getByTestId("panel-body-scene-xyz")).toBeTruthy();
  });

  it("setSelectedPanelId fires on pointerdown anywhere in the body", () => {
    const node = makeTabNode("scene-abc", PANEL_COMPONENT_SCENE);
    render(<>{panelFactory(node)}</>);
    expect(useSession.getState().selectedPanelId).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("panel-body-scene-abc"));
    expect(useSession.getState().selectedPanelId).toBe("scene-abc");
  });

  it("falls back to the unknown-panel placeholder when component is unrecognised", () => {
    const node = makeTabNode("widget-orphan", "widget");
    render(<>{panelFactory(node)}</>);
    expect(screen.getByTestId("unknown-panel")).toBeTruthy();
    // The wrapper is still present so click-to-select works on stale ids.
    expect(screen.getByTestId("panel-body-widget-orphan")).toBeTruthy();
  });
});
