// @vitest-environment jsdom
//
// iter5 issues #1 + #2 · TopBar contract tests.
//
// Locks in the new behaviour:
//   #1 — the previously empty top-bar centre now shows a session title
//        (hint, single-file name, or "N sources" + duration).
//   #2 — the status chip has four colour-coded states with a `data-status`
//        attribute the tests use as a stable selector; only `ready`
//        auto-hides; failure states surface an inline "Details" toggle.
//
// We seed the store directly via `useSession.setState` to skip the
// worker boot path — the TopBar reads `sources`, `globalRange`, and
// `lastOpenErrors` via single-key selectors, which is exactly what the
// tests need to drive.

import { afterEach, describe, expect, it } from "vitest";
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

import { TopBar } from "./TopBar";
import { useSession } from "../state/store";
import type { SourceMeta } from "../state/store";

afterEach(() => {
  cleanup();
  useSession.setState({
    sources: [],
    globalRange: null,
    lastOpenErrors: [],
  });
});

function mkSource(overrides: Partial<SourceMeta>): SourceMeta {
  return {
    id: "s",
    kind: "mcap",
    name: "x.mcap",
    handle: 0,
    timeRange: { startNs: 0n, endNs: 1_000_000_000n },
    channels: [],
    ...overrides,
  };
}

describe("TopBar — iter5 #1 session title", () => {
  it("renders the empty-state hint when no sources are loaded", () => {
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    const hint = screen.getByTestId("topbar-session-hint");
    expect(hint.textContent).toMatch(/Drop a recording to begin/i);
    expect(screen.queryByTestId("topbar-session-primary")).toBeNull();
  });

  it("renders the file name + duration for a single source", () => {
    useSession.setState({
      sources: [
        mkSource({
          id: "a",
          name: "comma2k19_seg10.mcap",
          timeRange: { startNs: 0n, endNs: 510_000_000_000n }, // 8m 30s
        }),
      ],
      globalRange: { startNs: 0n, endNs: 510_000_000_000n },
    });
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    expect(screen.getByTestId("topbar-session-primary").textContent).toBe(
      "comma2k19_seg10.mcap",
    );
    expect(screen.getByTestId("topbar-session-duration").textContent).toBe(
      "08:30",
    );
  });

  it("renders 'N sources' + duration when multiple sources are loaded", () => {
    useSession.setState({
      sources: [
        mkSource({ id: "a", name: "a.mcap" }),
        mkSource({ id: "b", name: "b.mcap" }),
        mkSource({ id: "c", name: "c.mp4", kind: "mp4+sidecar" }),
      ],
      globalRange: { startNs: 0n, endNs: 3_661_000_000_000n }, // 1h 01m 01s
    });
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    expect(screen.getByTestId("topbar-session-primary").textContent).toBe(
      "3 sources",
    );
    expect(screen.getByTestId("topbar-session-duration").textContent).toBe(
      "01:01:01",
    );
  });
});

describe("TopBar — iter5 #2 failure-mode status chip", () => {
  it("is in the `loading` state while ready === false", () => {
    render(<TopBar ready={false} onOpenSourcesDrawer={() => {}} />);
    const chip = screen.getByTestId("status-chip");
    expect(chip.getAttribute("data-status")).toBe("loading");
    expect(chip.textContent).toMatch(/Initialising/);
  });

  it("settles to the `ready` state when ready === true and no errors are pending", () => {
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    const chip = screen.getByTestId("status-chip");
    expect(chip.getAttribute("data-status")).toBe("ready");
    expect(chip.textContent).toMatch(/Ready/);
    // No details toggle in the ready state.
    expect(screen.queryByTestId("status-details-toggle")).toBeNull();
  });

  it("renders `degraded` when at least one source loaded but errors exist", () => {
    useSession.setState({
      sources: [mkSource({ id: "a", name: "a.mcap" })],
      lastOpenErrors: [{ name: "broken.mcap", reason: "EOF" }],
    });
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    const chip = screen.getByTestId("status-chip");
    expect(chip.getAttribute("data-status")).toBe("degraded");
    expect(chip.textContent).toMatch(/Degraded/);
    // Details toggle exists in the failure states.
    expect(screen.getByTestId("status-details-toggle")).toBeTruthy();
  });

  it("renders `error` when no sources loaded but errors are pending", () => {
    useSession.setState({
      sources: [],
      lastOpenErrors: [
        { name: "broken.mcap", reason: "EOF" },
        { name: "weird.bin", reason: "unknown extension" },
      ],
    });
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    const chip = screen.getByTestId("status-chip");
    expect(chip.getAttribute("data-status")).toBe("error");
    expect(chip.textContent).toMatch(/Error/);
  });

  it("toggles the details flyout when the inline Details button is clicked", () => {
    useSession.setState({
      sources: [],
      lastOpenErrors: [{ name: "broken.mcap", reason: "EOF parse failure" }],
    });
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    expect(screen.queryByTestId("status-details")).toBeNull();
    const toggle = screen.getByTestId("status-details-toggle");
    act(() => {
      fireEvent.click(toggle);
    });
    const details = screen.getByTestId("status-details");
    expect(details.textContent).toContain("broken.mcap");
    expect(details.textContent).toContain("EOF parse failure");
    // Toggle off.
    act(() => {
      fireEvent.click(toggle);
    });
    expect(screen.queryByTestId("status-details")).toBeNull();
  });

  it("keeps the hidden worker-status sentinel mounted (e2e contract)", () => {
    render(<TopBar ready onOpenSourcesDrawer={() => {}} />);
    const sentinel = screen.getByTestId("worker-status");
    expect(sentinel.textContent).toBe("workers ready");
  });
});
