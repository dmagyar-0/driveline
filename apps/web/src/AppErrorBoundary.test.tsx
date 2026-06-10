// @vitest-environment jsdom
//
// Top-level error boundary tests: a child render crash must swap to the
// fallback card (naming the error, offering reload) instead of unmounting
// the tree to a blank screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { AppErrorBoundary } from "./AppErrorBoundary";

function Bomb(): ReactNode {
  throw new Error("panelKindOf exploded");
}

describe("AppErrorBoundary", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders children while nothing throws", () => {
    render(
      <AppErrorBoundary>
        <p data-testid="app-ok">instrument</p>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("app-ok")).toBeTruthy();
    expect(screen.queryByTestId("app-error-boundary")).toBeNull();
  });

  it("swaps a child render crash for the fallback card", () => {
    // React logs the caught error to console.error; silence it so the test
    // output stays readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Bomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("app-error-boundary")).toBeTruthy();
    expect(screen.getByTestId("app-error-message").textContent).toContain(
      "panelKindOf exploded",
    );
    expect(screen.getByTestId("app-error-reload")).toBeTruthy();
  });

  it("names non-Error throws in the fallback instead of rendering blank", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function StringBomb(): ReactNode {
      throw "raw string failure";
    }
    render(
      <AppErrorBoundary>
        <StringBomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId("app-error-message").textContent).toContain(
      "raw string failure",
    );
  });
});
