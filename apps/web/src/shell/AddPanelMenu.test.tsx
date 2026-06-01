// @vitest-environment jsdom
//
// AddPanelMenu · the persistent "Add panel" control rendered in the
// drawer host footer. Covers: the trigger toggles the menu, each kind
// invokes the matching add callback and closes the menu, and Escape
// dismisses it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AddPanelMenu } from "./AddPanelMenu";

function setup() {
  const handlers = {
    addVideoPanel: vi.fn(),
    addPlotPanel: vi.fn(),
    addScenePanel: vi.fn(),
    addMapPanel: vi.fn(),
    addTablePanel: vi.fn(),
    addEnumPanel: vi.fn(),
  };
  render(<AddPanelMenu {...handlers} />);
  return handlers;
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

  it("offers every panel kind and invokes the matching callback", () => {
    const handlers = setup();
    const cases: ReadonlyArray<[string, keyof typeof handlers]> = [
      ["add-panel-video", "addVideoPanel"],
      ["add-panel-plot", "addPlotPanel"],
      ["add-panel-scene", "addScenePanel"],
      ["add-panel-map", "addMapPanel"],
      ["add-panel-table", "addTablePanel"],
      ["add-panel-enum", "addEnumPanel"],
    ];
    for (const [testid, fnName] of cases) {
      fireEvent.click(screen.getByTestId("drawer-add-panel"));
      fireEvent.click(screen.getByTestId(testid));
      expect(handlers[fnName]).toHaveBeenCalledTimes(1);
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
