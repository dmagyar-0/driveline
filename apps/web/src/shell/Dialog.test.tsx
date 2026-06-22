// @vitest-environment jsdom
//
// Shared modal `Dialog` primitive (SHELL-02). Pins the consolidated
// mechanics that were previously copy-pasted across ~6 dialogs: the
// `role="dialog"` / `aria-modal` envelope, Escape-to-close (with the
// `escapeEnabled` lock for in-flight runs), optional scrim-click-to-close,
// initial focus, focus restoration on unmount, and the NEW Tab focus-trap.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { Dialog } from "./Dialog";

afterEach(cleanup);

describe("Dialog", () => {
  it("renders the modal envelope with the accessible name", () => {
    render(
      <Dialog onClose={() => {}} ariaLabel="Test dialog" data-testid="d">
        <div>
          <button type="button">First</button>
        </div>
      </Dialog>,
    );
    const scrim = screen.getByTestId("d");
    expect(scrim.getAttribute("role")).toBe("dialog");
    expect(scrim.getAttribute("aria-modal")).toBe("true");
    expect(scrim.getAttribute("aria-label")).toBe("Test dialog");
  });

  it("closes on Escape, and not when escapeEnabled is false", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog onClose={onClose} ariaLabel="x" data-testid="d">
        <button type="button">First</button>
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <Dialog
        onClose={onClose}
        ariaLabel="x"
        data-testid="d"
        escapeEnabled={false}
      >
        <button type="button">First</button>
      </Dialog>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    // Still 1 — the suspended binding must not fire.
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on a scrim click only when closeOnScrimClick is set", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dialog onClose={onClose} ariaLabel="x" data-testid="d">
        <button type="button">First</button>
      </Dialog>,
    );
    fireEvent.click(screen.getByTestId("d"));
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <Dialog onClose={onClose} ariaLabel="x" data-testid="d" closeOnScrimClick>
        <button type="button">First</button>
      </Dialog>,
    );
    fireEvent.click(screen.getByTestId("d"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves initial focus to the first focusable element", () => {
    render(
      <Dialog onClose={() => {}} ariaLabel="x">
        <button type="button">First</button>
        <button type="button">Second</button>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "First" }),
    );
  });

  it("traps Tab and Shift+Tab within the dialog", () => {
    render(
      <Dialog onClose={() => {}} ariaLabel="x" data-testid="d">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Dialog>,
    );
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    const scrim = screen.getByTestId("d");

    // Tab from the last focusable wraps to the first.
    last.focus();
    fireEvent.keyDown(scrim, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    // Shift+Tab from the first focusable wraps to the last.
    first.focus();
    fireEvent.keyDown(scrim, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("restores focus to the previously-focused element on unmount", () => {
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const { unmount } = render(
      <Dialog onClose={() => {}} ariaLabel="x">
        <button type="button">Inside</button>
      </Dialog>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Inside" }),
    );

    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
