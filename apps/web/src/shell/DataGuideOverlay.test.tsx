// @vitest-environment jsdom
//
// The data-guide overlay is opt-in chrome (no store reads). These tests
// cover the bits that matter: it lists the formats, switches to the agents
// tab, surfaces the non-obvious examples, and dismisses via Escape, the
// scrim and the Close button.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { DataGuideOverlay } from "./DataGuideOverlay";

afterEach(cleanup);

describe("DataGuideOverlay", () => {
  it("lists readable formats on the default tab", () => {
    render(<DataGuideOverlay onClose={() => {}} />);
    const body = screen.getByTestId("data-guide-overlay");
    expect(within(body).getByText("MCAP")).toBeTruthy();
    expect(within(body).getByText(/MF4/)).toBeTruthy();
    expect(within(body).getByText(/timestamps sidecar/)).toBeTruthy();
    // The non-obvious sidecar line example is shown verbatim.
    expect(body.textContent).toContain("1532671467005757531");
  });

  it("switches to the agents tab and shows the API surface", () => {
    render(<DataGuideOverlay onClose={() => {}} />);
    fireEvent.click(screen.getByTestId("data-guide-tab-agents"));
    const body = screen.getByTestId("data-guide-overlay");
    expect(body.textContent).toContain("window.__drivelineAgent.getSkill()");
    expect(body.textContent).toContain("Bring Your Own Key");
    expect(body.textContent).toContain("addDataSource");
  });

  it("closes on Escape, scrim click and the Close button", () => {
    const onClose = vi.fn();
    const { rerender } = render(<DataGuideOverlay onClose={onClose} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<DataGuideOverlay onClose={onClose} />);
    fireEvent.click(screen.getByTestId("data-guide-overlay"));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByTestId("data-guide-close"));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
