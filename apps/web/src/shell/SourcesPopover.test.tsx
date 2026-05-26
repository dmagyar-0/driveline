// @vitest-environment jsdom
//
// UX overhaul (issue #17) · SourcesPopover render contract.
//
// Drop the heavy openFiles path: seed the store directly so the unit
// test does not depend on the wasm worker. The popover only reads
// `sources` and `clear` from the slice, so seeded state is enough.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { SourcesPopover } from "./SourcesPopover";
import { useSession } from "../state/store";

afterEach(async () => {
  cleanup();
  useSession.setState({ sources: [] });
});

function seedTwoSources() {
  useSession.setState({
    sources: [
      {
        id: "a",
        kind: "mcap",
        name: "short.mcap",
        handle: 0,
        timeRange: { startNs: 0n, endNs: 5_000_000_000n },
        channels: [],
      },
      {
        id: "b",
        kind: "mp4+sidecar",
        name: "drive.mp4",
        handle: 1,
        timeRange: { startNs: 0n, endNs: 10_000_000_000n },
        channels: [],
      },
    ],
  });
}

describe("SourcesPopover", () => {
  it("renders the empty-state copy when no sources are loaded", () => {
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.getByText(/No sources loaded/i)).toBeTruthy();
    // Clear-all button is hidden when the list is empty.
    expect(screen.queryByTestId("sources-popover-clear")).toBeNull();
  });

  it("renders one row per source with name and kind badge", () => {
    seedTwoSources();
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.getByTestId("sources-popover-row-a")).toBeTruthy();
    expect(screen.getByTestId("sources-popover-row-b")).toBeTruthy();
    expect(screen.getByText("short.mcap")).toBeTruthy();
    expect(screen.getByText("drive.mp4")).toBeTruthy();
    expect(screen.getByText("MCAP")).toBeTruthy();
    expect(screen.getByText("MP4")).toBeTruthy();
  });

  it("renders nothing when open is false", () => {
    seedTwoSources();
    const { container } = render(
      <SourcesPopover
        open={false}
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(
      container.querySelector('[data-testid="sources-popover"]'),
    ).toBeNull();
  });

  it("Open Sources panel fires onOpenDrawer then onClose", () => {
    seedTwoSources();
    const onOpenDrawer = vi.fn();
    const onClose = vi.fn();
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={onClose}
        onOpenDrawer={onOpenDrawer}
      />,
    );
    fireEvent.click(screen.getByTestId("sources-popover-open-drawer"));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
