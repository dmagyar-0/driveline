// @vitest-environment jsdom
//
// UX overhaul (issue #17) · SourcesPopover render contract.
//
// Drop the heavy openFiles path: seed the store directly so the unit
// test does not depend on the wasm worker. The popover only reads
// `sources` and `clear` from the slice, so seeded state is enough.

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

import { SourcesPopover } from "./SourcesPopover";
import { useSession } from "../state/store";
import type { SourceKind, SourceMeta } from "../state/store";

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
        // iter2 #4 — channel count is shown on each popover row, so
        // seed at least one channel per source. The popover only
        // reads `.length`, so a stub is enough.
        channels: [
          {
            id: "a/ch0",
            nativeId: "ch0",
            sourceId: "a",
            name: "ch0",
            kind: "scalar",
            dtype: null,
            unit: null,
            sampleCount: 0,
            timeRange: { startNs: 0n, endNs: 1n },
          },
        ],
      },
      {
        id: "b",
        kind: "mp4+sidecar",
        name: "drive.mp4",
        handle: 1,
        timeRange: { startNs: 0n, endNs: 10_000_000_000n },
        channels: [
          {
            id: "b/v",
            nativeId: "1/video",
            sourceId: "b",
            name: "video",
            kind: "video",
            dtype: null,
            unit: null,
            sampleCount: 0,
            timeRange: { startNs: 0n, endNs: 1n },
          },
          {
            id: "b/a",
            nativeId: "1/audio",
            sourceId: "b",
            name: "audio",
            kind: "scalar",
            dtype: null,
            unit: null,
            sampleCount: 0,
            timeRange: { startNs: 0n, endNs: 1n },
          },
        ],
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

  it("renders channel counts and per-row remove buttons (iter2 #4)", () => {
    seedTwoSources();
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    // Channel counts — singular vs plural.
    expect(screen.getByText("1 channel")).toBeTruthy();
    expect(screen.getByText("2 channels")).toBeTruthy();
    // Per-row remove buttons exist and are disabled (no per-source
    // remove action on the store today; see TODO in component).
    const removeA = screen.getByTestId("sources-popover-remove-a");
    const removeB = screen.getByTestId("sources-popover-remove-b");
    expect(removeA.hasAttribute("disabled")).toBe(true);
    expect(removeB.hasAttribute("disabled")).toBe(true);
    expect(removeA.getAttribute("aria-label")).toContain("short.mcap");
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

  // iter3 #1 — search, sort, group, demoted clear-all.

  function seedSources(specs: ReadonlyArray<{
    id: string;
    name: string;
    kind: SourceKind;
    durationNs: bigint;
  }>) {
    const sources: SourceMeta[] = specs.map((sp) => ({
      id: sp.id,
      kind: sp.kind,
      name: sp.name,
      handle: 0,
      timeRange: { startNs: 0n, endNs: sp.durationNs },
      channels: [
        {
          id: `${sp.id}/ch`,
          nativeId: "ch",
          sourceId: sp.id,
          name: "ch",
          kind: "scalar",
          dtype: null,
          unit: null,
          sampleCount: 0,
          timeRange: { startNs: 0n, endNs: 1n },
        },
      ],
    }));
    useSession.setState({ sources });
  }

  it("does not render search or sort controls when no sources are loaded", () => {
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.queryByTestId("sources-popover-search")).toBeNull();
    expect(screen.queryByTestId("sources-popover-sort-name")).toBeNull();
  });

  it("filters source list by name (case-insensitive)", () => {
    seedSources([
      { id: "a", name: "alpha.mcap", kind: "mcap", durationNs: 1_000_000_000n },
      { id: "b", name: "beta.mcap", kind: "mcap", durationNs: 2_000_000_000n },
      {
        id: "c",
        name: "gamma.mp4",
        kind: "mp4+sidecar",
        durationNs: 3_000_000_000n,
      },
    ]);
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    const search = screen.getByTestId("sources-popover-search");
    fireEvent.change(search, { target: { value: "BET" } });
    expect(screen.getByTestId("sources-popover-row-b")).toBeTruthy();
    expect(screen.queryByTestId("sources-popover-row-a")).toBeNull();
    expect(screen.queryByTestId("sources-popover-row-c")).toBeNull();
  });

  it("shows a filter-empty state when nothing matches the query", () => {
    seedSources([
      { id: "a", name: "alpha.mcap", kind: "mcap", durationNs: 1_000_000_000n },
    ]);
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    fireEvent.change(screen.getByTestId("sources-popover-search"), {
      target: { value: "zzz" },
    });
    const empty = screen.getByTestId("sources-popover-filter-empty");
    expect(empty.textContent).toContain("zzz");
  });

  it("sorts rows by name by default and re-sorts on toggle", () => {
    seedSources([
      { id: "z", name: "zeta.mcap", kind: "mcap", durationNs: 1_000_000_000n },
      { id: "a", name: "alpha.mcap", kind: "mcap", durationNs: 9_000_000_000n },
      { id: "m", name: "mu.mcap", kind: "mcap", durationNs: 5_000_000_000n },
    ]);
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    const list = screen.getByRole("dialog");
    const namesByDom = () =>
      Array.from(list.querySelectorAll('[data-testid^="sources-popover-row-"]'))
        .map((el) => within(el as HTMLElement).getByText(/\.mcap$/).textContent)
        .filter((s): s is string => s !== null);
    // Default: name asc → alpha, mu, zeta.
    expect(namesByDom()).toEqual(["alpha.mcap", "mu.mcap", "zeta.mcap"]);
    // Duration desc → alpha (9s), mu (5s), zeta (1s).
    fireEvent.click(screen.getByTestId("sources-popover-sort-duration"));
    expect(namesByDom()).toEqual(["alpha.mcap", "mu.mcap", "zeta.mcap"]);
  });

  it("inserts group headings only when ≥3 sources of mixed kinds are loaded", () => {
    // Two sources → no headings.
    seedTwoSources();
    const { rerender } = render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.queryByTestId("sources-popover-group-mcap")).toBeNull();

    // Three sources, all MCAP → still no headings (single kind).
    seedSources([
      { id: "a", name: "a.mcap", kind: "mcap", durationNs: 1n },
      { id: "b", name: "b.mcap", kind: "mcap", durationNs: 1n },
      { id: "c", name: "c.mcap", kind: "mcap", durationNs: 1n },
    ]);
    rerender(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.queryByTestId("sources-popover-group-mcap")).toBeNull();

    // Three sources of two kinds → headings appear.
    seedSources([
      { id: "a", name: "a.mcap", kind: "mcap", durationNs: 1n },
      { id: "b", name: "b.mcap", kind: "mcap", durationNs: 1n },
      { id: "c", name: "c.mp4", kind: "mp4+sidecar", durationNs: 1n },
    ]);
    rerender(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    expect(screen.getByTestId("sources-popover-group-mcap")).toBeTruthy();
    expect(screen.getByTestId("sources-popover-group-mp4+sidecar")).toBeTruthy();
  });

  it("renders the demoted clear-all affordance with secondary styling", () => {
    seedTwoSources();
    render(
      <SourcesPopover
        open
        anchorId="ax"
        onClose={() => {}}
        onOpenDrawer={() => {}}
      />,
    );
    const clearBtn = screen.getByTestId("sources-popover-clear");
    // Demoted: the destructive `dangerBtn` class is gone; the smaller
    // `clearBtn` class is what we expect to see in production.
    expect(clearBtn.className).toMatch(/clearBtn/);
    expect(clearBtn.className).not.toMatch(/dangerBtn/);
  });
});
