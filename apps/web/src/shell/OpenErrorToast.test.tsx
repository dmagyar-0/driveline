// @vitest-environment jsdom
//
// The toast surfaces `lastOpenErrors` in the main UI so an all-invalid
// drop batch (which the closed-by-default Sources drawer would hide)
// gives visible feedback. These tests drive the store directly and
// assert the toast appears, summarises, links to the drawer, dismisses,
// and auto-clears.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { OpenErrorToast, OPEN_ERROR_TOAST_MS } from "./OpenErrorToast";
import { useSession } from "../state/store";

beforeEach(() => {
  vi.useFakeTimers();
  useSession.setState({ lastOpenErrors: [], activeRailTab: null });
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  useSession.setState({ lastOpenErrors: [], activeRailTab: null });
});

describe("OpenErrorToast", () => {
  it("renders nothing when there are no open errors", () => {
    render(<OpenErrorToast />);
    expect(screen.queryByTestId("open-error-toast")).toBeNull();
  });

  it("surfaces a single-file error with its reason", () => {
    render(<OpenErrorToast />);
    act(() => {
      useSession.setState({
        lastOpenErrors: [
          { name: "clip.mp4", reason: "missing .mp4.timestamps sidecar" },
        ],
      });
    });
    const toast = screen.getByTestId("open-error-toast");
    expect(toast).toBeTruthy();
    expect(
      screen.getByTestId("open-error-toast-summary").textContent,
    ).toContain("clip.mp4");
    expect(toast.textContent).toContain("missing .mp4.timestamps sidecar");
  });

  it("summarises a multi-file batch with a count", () => {
    render(<OpenErrorToast />);
    act(() => {
      useSession.setState({
        lastOpenErrors: [
          { name: "a.xyz", reason: "unknown extension" },
          { name: "b.mp4", reason: "missing sidecar" },
        ],
      });
    });
    expect(
      screen.getByTestId("open-error-toast-summary").textContent,
    ).toContain("2 files");
    expect(screen.getByTestId("open-error-toast").textContent).toContain(
      "+1 more",
    );
  });

  it("opens the Sources drawer via View details and hides the toast", () => {
    render(<OpenErrorToast />);
    act(() => {
      useSession.setState({
        lastOpenErrors: [{ name: "a.xyz", reason: "unknown extension" }],
      });
    });
    fireEvent.click(screen.getByTestId("open-error-toast-details"));
    // Drawer is opened, but the errors remain for the drawer detail view.
    expect(useSession.getState().activeRailTab).toBe("sources");
    expect(useSession.getState().lastOpenErrors.length).toBe(1);
    expect(screen.queryByTestId("open-error-toast")).toBeNull();
  });

  it("dismisses and clears the errors on the close button", () => {
    render(<OpenErrorToast />);
    act(() => {
      useSession.setState({
        lastOpenErrors: [{ name: "a.xyz", reason: "unknown extension" }],
      });
    });
    fireEvent.click(screen.getByTestId("open-error-toast-dismiss"));
    expect(screen.queryByTestId("open-error-toast")).toBeNull();
    expect(useSession.getState().lastOpenErrors.length).toBe(0);
  });

  it("auto-clears the errors after the timeout", () => {
    render(<OpenErrorToast />);
    act(() => {
      useSession.setState({
        lastOpenErrors: [{ name: "a.xyz", reason: "unknown extension" }],
      });
    });
    expect(screen.getByTestId("open-error-toast")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(OPEN_ERROR_TOAST_MS + 1);
    });
    expect(useSession.getState().lastOpenErrors.length).toBe(0);
    expect(screen.queryByTestId("open-error-toast")).toBeNull();
  });
});
