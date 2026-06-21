// @vitest-environment jsdom
//
// AddPanelMenu · the persistent "Add panel" control rendered in the
// drawer host footer. Covers: the trigger toggles the menu, each kind
// invokes the matching add callback and closes the menu, and Escape
// dismisses it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { AddPanelMenu } from "./AddPanelMenu";
import { setWorkspaceBridge } from "../layout/workspaceBridge";

function setup() {
  // The menu mints panels through the module-scoped workspace bridge; mock
  // it so each menu item is observed via a single `createPanel(kind)` call.
  const createPanel = vi.fn(() => "panel-1");
  const cleanupBridge = setWorkspaceBridge({
    createPanel,
    closePanel: vi.fn(() => true),
    resetLayout: vi.fn(),
  });
  render(<AddPanelMenu />);
  return { createPanel, cleanupBridge };
}

afterEach(() => {
  cleanup();
});

describe("AddPanelMenu", () => {
  it("keeps the menu closed until the trigger is clicked", () => {
    setup();
    const trigger = screen.getByTestId("drawer-add-panel");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("drawer-add-panel-menu")).toBeNull();

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("drawer-add-panel-menu")).not.toBeNull();
  });

  it("offers every panel kind and mints the matching kind", () => {
    const { createPanel } = setup();
    const cases: ReadonlyArray<[string, string]> = [
      ["add-panel-video", "video"],
      ["add-panel-plot", "plot"],
      ["add-panel-scene", "scene"],
      ["add-panel-map", "map"],
      ["add-panel-table", "table"],
      ["add-panel-value", "value"],
      ["add-panel-enum", "enum"],
    ];
    for (const [testid, kind] of cases) {
      createPanel.mockClear();
      fireEvent.click(screen.getByTestId("drawer-add-panel"));
      fireEvent.click(screen.getByTestId(testid));
      expect(createPanel).toHaveBeenCalledTimes(1);
      expect(createPanel).toHaveBeenCalledWith(kind);
      // Choosing a kind closes the menu.
      expect(screen.queryByTestId("drawer-add-panel-menu")).toBeNull();
    }
  });

  it("closes on Escape", () => {
    setup();
    fireEvent.click(screen.getByTestId("drawer-add-panel"));
    expect(screen.getByTestId("drawer-add-panel-menu")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("drawer-add-panel-menu")).toBeNull();
  });
});
