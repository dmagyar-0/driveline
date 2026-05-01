// @vitest-environment jsdom
//
// SourcesDrawer · drop-error section tests.
//
// `lastOpenErrors` is populated by `openFiles` when a dropped file
// fails the bucket step (unknown extension, sidecar without partner,
// etc.). The drawer surfaces those errors with a dismiss button so
// they don't silently disappear. The store-level behaviour is covered
// by `state/store.test.ts`; this file pins the rendering contract.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SourcesDrawer } from "./SourcesDrawer";
import { useSession } from "../../state/store";

afterEach(async () => {
  cleanup();
  await useSession.getState().clear();
});

describe("SourcesDrawer", () => {
  it("hides the drop-errors section when lastOpenErrors is empty", () => {
    render(<SourcesDrawer />);
    expect(screen.queryByTestId("sources-errors")).toBeNull();
  });

  it("renders one row per error when lastOpenErrors has entries", () => {
    useSession.setState({
      lastOpenErrors: [
        { name: "notes.txt", reason: "unknown extension" },
        { name: "stray.mp4.timestamps", reason: "no matching .mp4 in drop" },
      ],
    });
    render(<SourcesDrawer />);
    expect(screen.getByTestId("sources-errors")).toBeTruthy();
    expect(screen.getByText("notes.txt")).toBeTruthy();
    expect(screen.getByText("unknown extension")).toBeTruthy();
    expect(screen.getByText("stray.mp4.timestamps")).toBeTruthy();
    expect(screen.getByText("no matching .mp4 in drop")).toBeTruthy();
  });

  it("dismiss button clears lastOpenErrors via dismissOpenErrors", () => {
    useSession.setState({
      lastOpenErrors: [{ name: "notes.txt", reason: "unknown extension" }],
    });
    render(<SourcesDrawer />);
    fireEvent.click(screen.getByTestId("sources-errors-dismiss"));
    expect(useSession.getState().lastOpenErrors).toEqual([]);
    // Section disappears after the slice clears.
    expect(screen.queryByTestId("sources-errors")).toBeNull();
  });
});
