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
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("renders a labelled close button per source and removes it on click", async () => {
    useSession.setState({
      sources: [
        {
          id: "demo.mcap",
          kind: "mcap",
          name: "demo.mcap",
          handle: 1,
          timeRange: { startNs: 0n, endNs: 10n },
          channels: [],
        },
      ],
      channels: [],
      globalRange: { startNs: 0n, endNs: 10n },
    });
    render(<SourcesDrawer />);

    const closeBtn = screen.getByTestId("source-close-demo.mcap");
    // Accessible name carries the filename so SR users know what closes.
    expect(closeBtn.getAttribute("aria-label")).toBe("Close demo.mcap");

    fireEvent.click(closeBtn);
    // `removeSource` is async (serialised behind the open/close chain);
    // wait for the slice to drain before asserting the row is gone.
    await waitFor(() => expect(useSession.getState().sources).toHaveLength(0));
    expect(screen.queryByTestId("source-row-demo.mcap")).toBeNull();
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
