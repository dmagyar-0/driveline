// @vitest-environment jsdom
//
// Phase 6 · ScenePanel render tests.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.hoisted(() => {
  const g = globalThis as unknown as { ResizeObserver: unknown };
  g.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

import { ScenePanel } from "./ScenePanel";
import { useSession } from "../state/store";

describe("ScenePanel", () => {
  afterEach(async () => {
    cleanup();
    await useSession.getState().clear();
  });

  it("renders the empty-state callout when no binding is set", () => {
    render(<ScenePanel panelId="scene-1" />);
    expect(screen.getByTestId("scene-empty")).toBeTruthy();
    expect(screen.queryByTestId("scene-bound-channel")).toBeNull();
  });

  it("shows the bound channel id when one is set", () => {
    useSession.getState().setSceneBinding("scene-1", "/cloud/front");
    render(<ScenePanel panelId="scene-1" />);
    const bound = screen.getByTestId("scene-bound-channel");
    expect(bound.textContent).toContain("/cloud/front");
  });
});
