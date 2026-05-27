// @vitest-environment jsdom
//
// Phase 7+ · PanelHeader (per-tab chrome) behaviour.
//
// Exercises the public contract the FlexLayout integration relies on:
//   - all four action buttons render with a `title` AND an `aria-label`
//   - the destructive close button is visually distinct (CSS only,
//     covered indirectly by checking the button is tagged `tab-close`)
//   - clicking each button dispatches the right Action against the
//     model, or — in the settings case — wires the store
//   - the inline rename input commits on Enter and reverts on Escape
//   - double-click on the title maximises an unfocused panel and
//     enters rename on a focused panel
//
// We build a minimal stub `Model` because instantiating the real
// flexlayout-react Model under jsdom is heavy and ties the test to
// FlexLayout's internal action serialisation. The stub records which
// Action ids were dispatched; that's all we need.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { Actions } from "flexlayout-react";
import type { Action, Model } from "flexlayout-react";
import { PanelHeader } from "./PanelHeader";
import { useSession } from "../state/store";

function makeStubModel(): { model: Model; actions: Action[] } {
  const actions: Action[] = [];
  const model = {
    doAction(action: Action): void {
      actions.push(action);
    },
  } as unknown as Model;
  return { model, actions };
}

describe("PanelHeader", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
    useSession.getState().setSelectedPanelId(null);
    useSession.getState().setActiveRailTab(null);
  });

  it("renders every icon button with both title and aria-label", () => {
    const { model } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Speeds"
        kind="plot"
        isFocused={false}
      />,
    );
    // Iter5 · the pencil ("tab-rename") was dropped — rename is now a
    // subset of panel settings (double-click title to invoke), so the
    // cluster shrinks to settings / maximize / close + a destructive-
    // action divider before close.
    for (const testId of ["tab-settings", "tab-maximize", "tab-close"]) {
      const btn = screen.getByTestId(testId);
      expect(btn.getAttribute("title")).toBeTruthy();
      expect(btn.getAttribute("aria-label")).toBeTruthy();
    }
    // The pencil is gone for good.
    expect(screen.queryByTestId("tab-rename")).toBeNull();
  });

  it("close button dispatches DELETE_TAB on the panel id", () => {
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-7"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.click(screen.getByTestId("tab-close"));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe(Actions.DELETE_TAB);
    expect(actions[0]!.data?.node).toBe("plot-7");
  });

  it("maximize button toggles the parent tabset", () => {
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-42"
        name="A"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.click(screen.getByTestId("tab-maximize"));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe(Actions.MAXIMIZE_TOGGLE);
    expect(actions[0]!.data?.node).toBe("ts-42");
  });

  it("settings button flips the rail to the panel drawer and selects the panel", () => {
    const { model } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-9"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused={false}
      />,
    );
    fireEvent.click(screen.getByTestId("tab-settings"));
    expect(useSession.getState().selectedPanelId).toBe("plot-9");
    expect(useSession.getState().activeRailTab).toBe("panel");
  });

  it("double-clicking the title maximises when unfocused", () => {
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-7"
        name="A"
        kind="plot"
        isFocused={false}
      />,
    );
    fireEvent.doubleClick(screen.getByTestId("tab-name"));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe(Actions.MAXIMIZE_TOGGLE);
    expect(actions[0]!.data?.node).toBe("ts-7");
  });

  it("double-clicking the title enters rename mode when focused", () => {
    const { model } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Speeds"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.doubleClick(screen.getByTestId("tab-name"));
    expect(screen.getByTestId("tab-rename-input")).toBeTruthy();
  });

  it("rename: Enter commits the new name via RENAME_TAB", () => {
    // Iter5 · the pencil is gone; rename is invoked by double-clicking
    // the title while the panel is focused (the gesture path is the
    // only remaining entry point and is asserted here).
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Old"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.doubleClick(screen.getByTestId("tab-name"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions).toHaveLength(1);
    expect(actions[0]!.type).toBe(Actions.RENAME_TAB);
    expect(actions[0]!.data?.node).toBe("plot-1");
    expect(actions[0]!.data?.text).toBe("New name");
  });

  it("rename: Escape cancels without dispatching", () => {
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Old"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.doubleClick(screen.getByTestId("tab-name"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "scrap" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(actions).toHaveLength(0);
    // input should be gone, title visible again
    expect(screen.queryByTestId("tab-rename-input")).toBeNull();
    expect(screen.getByTestId("tab-name").textContent).toBe("Old");
  });

  it("rename: blank or whitespace-only input does not dispatch", () => {
    const { model, actions } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Old"
        kind="plot"
        isFocused
      />,
    );
    fireEvent.doubleClick(screen.getByTestId("tab-name"));
    const input = screen.getByTestId("tab-rename-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(actions).toHaveLength(0);
  });

  it("pointerdown on the header marks the panel as selected when not focused", () => {
    const { model } = makeStubModel();
    const { container } = render(
      <PanelHeader
        model={model}
        panelId="plot-5"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused={false}
      />,
    );
    expect(useSession.getState().selectedPanelId).toBeNull();
    const header = container.querySelector(
      '[data-panel-id="plot-5"]',
    ) as HTMLElement;
    fireEvent.pointerDown(header);
    expect(useSession.getState().selectedPanelId).toBe("plot-5");
  });

  it("swaps the maximize button's tooltip + aria-label when the tabset is maximized", () => {
    const { model } = makeStubModel();
    const { rerender } = render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Speeds"
        kind="plot"
        isFocused
        isMaximized={false}
      />,
    );
    const btn = screen.getByTestId("tab-maximize");
    expect(btn.getAttribute("title")).toBe("Maximize panel");
    expect(btn.getAttribute("aria-label")).toBe("Maximize panel");
    expect(btn.getAttribute("data-maximized")).toBe("false");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    rerender(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="Speeds"
        kind="plot"
        isFocused
        isMaximized
      />,
    );
    const btn2 = screen.getByTestId("tab-maximize");
    expect(btn2.getAttribute("title")).toBe("Restore panel");
    expect(btn2.getAttribute("aria-label")).toBe("Restore panel");
    expect(btn2.getAttribute("data-maximized")).toBe("true");
    expect(btn2.getAttribute("aria-pressed")).toBe("true");
  });

  it("paints the kind data attribute so CSS can pick the per-kind accent", () => {
    const { model } = makeStubModel();
    const { container } = render(
      <PanelHeader
        model={model}
        panelId="video-1"
        tabsetId="ts-1"
        name="A"
        kind="video"
        isFocused
      />,
    );
    const header = container.querySelector('[data-panel-id="video-1"]');
    expect(header?.getAttribute("data-panel-kind")).toBe("video");
  });

  // Iter5 · explicit drag affordance.
  //
  // Audit point: "no drag handle indicated, even though FlexLayout
  // panels are drag-rearrangeable; users must discover that by
  // accident." The header now stamps a 6-dot handle on the left with
  // a `title` tooltip — assert it renders and carries the discovery
  // copy. The element is aria-hidden because the drag target is the
  // whole tab button (FlexLayout-owned).
  it("renders a drag-handle affordance with a hover tooltip", () => {
    const { model } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused={false}
      />,
    );
    const handle = screen.getByTestId("tab-drag-handle");
    expect(handle).toBeTruthy();
    expect(handle.getAttribute("title")).toBe("Drag to move panel");
    expect(handle.getAttribute("aria-hidden")).toBe("true");
  });

  // Iter5 · the destructive close button gets a visible hairline
  // divider + extra spacing so it's no longer adjacent to maximize.
  // Audit point: "× close sits one pixel from □ maximize; misclick
  // risk is high." We assert the divider sits *between* maximize and
  // close so a future refactor that shuffles the cluster ordering is
  // caught at test time.
  it("places a divider between maximize and close so misclicks are mitigated", () => {
    const { model } = makeStubModel();
    render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused
      />,
    );
    const divider = screen.getByTestId("tab-action-divider");
    expect(divider).toBeTruthy();
    // The divider should be a sibling between maximize and close.
    const maximize = screen.getByTestId("tab-maximize");
    const close = screen.getByTestId("tab-close");
    // DOCUMENT_POSITION_FOLLOWING = 4. Two assertions: maximize is
    // before the divider, and the divider is before close.
    expect(
      maximize.compareDocumentPosition(divider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      divider.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // Iter5 · active vs inactive identity is no longer carried by a 1-px
  // underline alone. The wrapper now stamps `data-focused="true"` so
  // CSS can layer (a) a 2-px accent left-edge inset, (b) an 8 % accent
  // wash, and (c) a brighter title — and so AT / tests can read the
  // state without parsing hashed module class names. The audit point
  // was "active state must be unmistakable"; the data attribute is the
  // testable contract.
  it("stamps data-focused to advertise the active panel state", () => {
    const { model } = makeStubModel();
    const { container, rerender } = render(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused={false}
      />,
    );
    const header = container.querySelector('[data-panel-id="plot-1"]');
    expect(header?.getAttribute("data-focused")).toBe("false");
    rerender(
      <PanelHeader
        model={model}
        panelId="plot-1"
        tabsetId="ts-1"
        name="A"
        kind="plot"
        isFocused
      />,
    );
    expect(header?.getAttribute("data-focused")).toBe("true");
  });
});
