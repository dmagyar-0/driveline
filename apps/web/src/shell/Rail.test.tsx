// @vitest-environment jsdom
//
// Phase 10 · Rail a11y wiring.
//
// The rail buttons announce the rail/drawer relationship through
// aria-controls + aria-expanded so that AT can navigate between
// the toggling control and the disclosed region. The shared
// DRAWER_REGION_ID constant lives next to the Drawer host.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { Rail } from "./Rail";
import { DRAWER_REGION_ID } from "./Drawer";
import { useSession } from "../state/store";

afterEach(() => {
  cleanup();
  useSession.setState({ activeRailTab: null, railCollapsed: false });
});

describe("Rail", () => {
  it("renders five buttons with aria-controls pointing at the drawer region", () => {
    render(<Rail />);
    const sources = screen.getByTestId("rail-sources");
    expect(sources.getAttribute("aria-controls")).toBe(DRAWER_REGION_ID);
    expect(sources.getAttribute("aria-expanded")).toBe("false");
    expect(sources.getAttribute("aria-pressed")).toBe("false");
    expect(sources.getAttribute("aria-label")).toBe("Sources");
    // UX overhaul #14 — every rail item carries a visible text label
    // and a descriptive title attribute for hover tooltips.
    expect(sources.textContent).toContain("Sources");
    expect(sources.getAttribute("title")).toContain("Sources");
  });

  it("groups the five rail items so AT can announce sections", () => {
    render(<Rail />);
    const rail = screen.getByTestId("rail");
    const groups = rail.querySelectorAll('[role="group"]');
    // Three groups: data (Sources/Channels), workspace (Layout/Panel), events.
    expect(groups.length).toBe(3);
  });

  it("flips aria-expanded + aria-pressed on the active tab only", () => {
    render(<Rail />);
    fireEvent.click(screen.getByTestId("rail-channels"));
    expect(
      screen.getByTestId("rail-channels").getAttribute("aria-expanded"),
    ).toBe("true");
    expect(
      screen.getByTestId("rail-channels").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("rail-sources").getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("collapses to null render when railCollapsed is set", () => {
    useSession.setState({ railCollapsed: true });
    const { container } = render(<Rail />);
    expect(container.querySelector('[data-testid="rail"]')).toBeNull();
  });
});
