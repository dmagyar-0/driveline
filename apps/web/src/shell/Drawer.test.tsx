// @vitest-environment jsdom
//
// Drawer host · width + splitter tests.
//
// The host wraps the active drawer in a sized container and renders the
// `DrawerResizer` splitter. The store-level clamping is covered by
// `state/store.test.ts`; this file pins the rendering + interaction
// contract: the wrapper reflects the stored width, and keyboard /
// pointer adjustments commit a clamped value back to the store.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { Drawer } from "./Drawer";
import { useSession } from "../state/store";

// The host's forwarded props are only exercised by the Layout/Channels
// drawers; for these tests we open the Sources drawer, which ignores them.
const noopProps = {
  ensurePlotPanel: () => null,
  addVideoPanel: () => {},
  addPlotPanel: () => {},
  addScenePanel: () => {},
  addMapPanel: () => {},
  addTablePanel: () => {},
  addValuePanel: () => {},
  addEnumPanel: () => {},
  resetLayout: () => {},
};

afterEach(async () => {
  cleanup();
  await useSession.getState().clear();
  useSession.getState().setActiveRailTab(null);
  useSession.getState().setDrawerWidth(220);
});

describe("Drawer host", () => {
  it("renders nothing when no rail tab is active", () => {
    useSession.getState().setActiveRailTab(null);
    const { container } = render(<Drawer {...noopProps} />);
    expect(container.firstChild).toBeNull();
  });

  it("reflects the stored drawer width on the host wrapper", () => {
    useSession.getState().setActiveRailTab("sources");
    useSession.getState().setDrawerWidth(360);
    render(<Drawer {...noopProps} />);
    const resizer = screen.getByTestId("drawer-resizer");
    const host = resizer.parentElement as HTMLElement;
    expect(host.style.width).toBe("360px");
  });

  it("exposes the splitter as a vertical separator with width bounds", () => {
    useSession.getState().setActiveRailTab("sources");
    render(<Drawer {...noopProps} />);
    const resizer = screen.getByTestId("drawer-resizer");
    expect(resizer.getAttribute("role")).toBe("separator");
    expect(resizer.getAttribute("aria-orientation")).toBe("vertical");
    expect(resizer.getAttribute("aria-valuemin")).toBe("220");
    expect(resizer.getAttribute("aria-valuemax")).toBe("560");
    expect(resizer.getAttribute("aria-valuenow")).toBe("220");
  });

  it("ArrowRight widens the drawer and commits to the store", () => {
    useSession.getState().setActiveRailTab("sources");
    render(<Drawer {...noopProps} />);
    fireEvent.keyDown(screen.getByTestId("drawer-resizer"), {
      key: "ArrowRight",
    });
    expect(useSession.getState().drawerWidth).toBe(236);
  });

  it("ArrowLeft is clamped at the minimum width", () => {
    useSession.getState().setActiveRailTab("sources");
    useSession.getState().setDrawerWidth(220);
    render(<Drawer {...noopProps} />);
    fireEvent.keyDown(screen.getByTestId("drawer-resizer"), {
      key: "ArrowLeft",
    });
    expect(useSession.getState().drawerWidth).toBe(220);
  });

  it("End jumps to the maximum width", () => {
    useSession.getState().setActiveRailTab("sources");
    render(<Drawer {...noopProps} />);
    fireEvent.keyDown(screen.getByTestId("drawer-resizer"), { key: "End" });
    expect(useSession.getState().drawerWidth).toBe(560);
  });
});
