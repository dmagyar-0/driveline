// @vitest-environment jsdom
//
// Phase 8 · EventsDrawer component tests.
//
// Empty state, populated rows sorted by ns, click-to-seek dispatches
// `setCursor`, double-click-to-rename round-trip, hover-revealed × ↔
// `removeBookmark`, and the disabled-add posture when `globalRange ===
// null`. The full reload-survives + transport-marker path lives in
// `apps/e2e/tests/bookmarks.spec.ts`.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { EventsDrawer } from "./EventsDrawer";
import { useSession } from "../../state/store";

function seedRange(): void {
  useSession.setState({
    globalRange: { startNs: 0n, endNs: 10_000_000_000n },
    cursorNs: 5_000_000_000n,
  });
}

afterEach(async () => {
  cleanup();
  for (const b of [...useSession.getState().bookmarks]) {
    useSession.getState().removeBookmark(b.id);
  }
  // Reset session state so a later test that wants no globalRange
  // (the disabled-add case) doesn't see leftovers.
  useSession.setState({ globalRange: null, cursorNs: 0n });
});

describe("EventsDrawer", () => {
  it("renders the empty state when there are no bookmarks", () => {
    seedRange();
    render(<EventsDrawer />);
    expect(screen.getByTestId("bookmarks-empty")).toBeTruthy();
    expect(screen.getByTestId("bookmarks-count-pill").textContent).toBe("0");
  });

  it("renders rows sorted by ns ascending", () => {
    seedRange();
    useSession.getState().addBookmark(7_000_000_000n, "third");
    useSession.getState().addBookmark(1_000_000_000n, "first");
    useSession.getState().addBookmark(3_000_000_000n, "second");
    render(<EventsDrawer />);
    const items = screen.getAllByTestId(/^bookmark-row-/);
    expect(items.map((el) => el.querySelector("button")?.textContent)).toEqual(
      [
        expect.stringContaining("first"),
        expect.stringContaining("second"),
        expect.stringContaining("third"),
      ],
    );
  });

  it("click on a row dispatches setCursor", () => {
    seedRange();
    const id = useSession.getState().addBookmark(2_500_000_000n, "x");
    render(<EventsDrawer />);
    expect(useSession.getState().cursorNs).toBe(5_000_000_000n);
    fireEvent.click(screen.getByTestId(`bookmark-seek-${id}`));
    expect(useSession.getState().cursorNs).toBe(2_500_000_000n);
  });

  it("double-click on label swaps in an input; Enter commits the rename", () => {
    seedRange();
    const id = useSession.getState().addBookmark(1_000_000_000n, "old");
    render(<EventsDrawer />);
    const label = screen.getByText("old");
    fireEvent.doubleClick(label);
    const input = screen.getByTestId(
      `bookmark-rename-input-${id}`,
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSession.getState().bookmarks[0].label).toBe("new");
  });

  it("Escape during rename cancels without mutating the slice", () => {
    seedRange();
    const id = useSession.getState().addBookmark(1_000_000_000n, "keep");
    render(<EventsDrawer />);
    fireEvent.doubleClick(screen.getByText("keep"));
    const input = screen.getByTestId(
      `bookmark-rename-input-${id}`,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useSession.getState().bookmarks[0].label).toBe("keep");
  });

  it("× button removes the bookmark", () => {
    seedRange();
    const id = useSession.getState().addBookmark(1_000_000_000n, "doomed");
    render(<EventsDrawer />);
    fireEvent.click(screen.getByTestId(`bookmark-remove-${id}`));
    expect(useSession.getState().bookmarks).toHaveLength(0);
  });

  it("disables the add button when globalRange is null", () => {
    // Explicitly no seed.
    render(<EventsDrawer />);
    const btn = screen.getByTestId("bookmark-add-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  });

  it("flags out-of-range bookmarks via data-out-of-range", () => {
    seedRange(); // range is [0, 10s]
    const id = useSession.getState().addBookmark(20_000_000_000n, "future");
    render(<EventsDrawer />);
    const row = screen.getByTestId(`bookmark-row-${id}`);
    expect(row.getAttribute("data-out-of-range")).toBe("true");
  });

  it("explains the out-of-range state via title and aria-label", () => {
    seedRange();
    const id = useSession.getState().addBookmark(20_000_000_000n, "future");
    render(<EventsDrawer />);
    const seek = screen.getByTestId(`bookmark-seek-${id}`);
    expect(seek.getAttribute("title")).toBe(
      "Outside the current session's range",
    );
    expect(seek.getAttribute("aria-label")).toBe(
      "Out of range — Seek to future",
    );
  });

  it("uses the bookmark label as title for in-range rows", () => {
    seedRange();
    const id = useSession.getState().addBookmark(5_000_000_000n, "midpoint");
    render(<EventsDrawer />);
    const seek = screen.getByTestId(`bookmark-seek-${id}`);
    expect(seek.getAttribute("title")).toBe("midpoint");
    expect(seek.getAttribute("aria-label")).toBe("Seek to midpoint");
  });
});
