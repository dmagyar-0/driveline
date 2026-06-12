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

import { EventsDrawer } from "./EventsDrawer";
import { useSession } from "../../state/store";
import { DEFAULT_EVENT_TAG_CONFIG } from "../../state/persist/eventTagConfig";

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
  // (the disabled-add case) doesn't see leftovers, and restore the
  // default tag taxonomy (mutated by the config-editor cases).
  useSession.setState({ globalRange: null, cursorNs: 0n });
  useSession.getState().setEventTagConfig({
    attributes: DEFAULT_EVENT_TAG_CONFIG.attributes.map((a) => ({
      ...a,
      options: [...a.options],
    })),
  });
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
    expect(items.map((el) => el.querySelector("button")?.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
      expect.stringContaining("third"),
    ]);
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

  it("expanding a row reveals tag controls; selecting a value stores it", () => {
    seedRange();
    const id = useSession.getState().addBookmark(5_000_000_000n, "x");
    render(<EventsDrawer />);
    fireEvent.click(screen.getByTestId(`bookmark-expand-${id}`));
    const select = screen.getByTestId(
      `bookmark-tag-${id}-weather`,
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Rain" } });
    expect(useSession.getState().bookmarks[0].tags).toEqual({
      weather: "Rain",
    });
    // Collapse → the value shows as a chip.
    fireEvent.click(screen.getByTestId(`bookmark-expand-${id}`));
    const chips = screen.getByTestId(`bookmark-chips-${id}`);
    expect(chips.textContent).toContain("Rain");
  });

  it("editing before/after on blur sets the range and flags data-ranged", () => {
    seedRange();
    const id = useSession.getState().addBookmark(5_000_000_000n, "x");
    render(<EventsDrawer />);
    fireEvent.click(screen.getByTestId(`bookmark-expand-${id}`));
    const before = screen.getByTestId(
      `bookmark-before-${id}`,
    ) as HTMLInputElement;
    fireEvent.change(before, { target: { value: "2" } });
    fireEvent.blur(before);
    const after = screen.getByTestId(
      `bookmark-after-${id}`,
    ) as HTMLInputElement;
    fireEvent.change(after, { target: { value: "3" } });
    fireEvent.blur(after);
    const b = useSession.getState().bookmarks[0];
    expect(b.beforeNs).toBe(2_000_000_000n);
    expect(b.afterNs).toBe(3_000_000_000n);
    expect(
      screen.getByTestId(`bookmark-row-${id}`).getAttribute("data-ranged"),
    ).toBe("true");
  });

  it("config editor adds a tag attribute", () => {
    seedRange();
    render(<EventsDrawer />);
    const before = useSession.getState().eventTagConfig.attributes.length;
    fireEvent.click(screen.getByTestId("event-tag-config-toggle"));
    fireEvent.click(screen.getByTestId("tag-attr-add"));
    expect(useSession.getState().eventTagConfig.attributes).toHaveLength(
      before + 1,
    );
  });
});

describe("EventsDrawer provenance badge", () => {
  it("shows an agent pill with confidence on agent-created events", () => {
    seedRange();
    const id = useSession.getState().addBookmark(1_000_000_000n, "cut-in", {
      origin: "agent",
      confidence: 0.82,
    });
    render(<EventsDrawer />);
    const badge = screen.getByTestId(`bookmark-origin-${id}`);
    expect(badge.textContent).toBe("agent 82%");
  });

  it("omits the pill on user-created events", () => {
    seedRange();
    const id = useSession.getState().addBookmark(1_000_000_000n, "manual");
    render(<EventsDrawer />);
    expect(screen.queryByTestId(`bookmark-origin-${id}`)).toBeNull();
  });
});

describe("EventsDrawer import / export", () => {
  it("disables Export when there are no events", () => {
    seedRange();
    render(<EventsDrawer />);
    const btn = screen.getByTestId("events-export") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("imports a JSON file (merge) and surfaces a parse error", async () => {
    seedRange();
    render(<EventsDrawer />);
    const input = screen.getByTestId("events-import-input") as HTMLInputElement;

    const good = new File(
      [JSON.stringify([{ ns: "2000000000", label: "imported" }])],
      "events.json",
      { type: "application/json" },
    );
    await act(async () => {
      fireEvent.change(input, { target: { files: [good] } });
      // file.text() resolves on a microtask; let the handler finish.
      await Promise.resolve();
    });
    expect(useSession.getState().bookmarks.map((b) => b.label)).toContain(
      "imported",
    );
    expect(screen.queryByTestId("events-import-error")).toBeNull();

    const bad = new File(["not json {"], "bad.json", {
      type: "application/json",
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [bad] } });
      await Promise.resolve();
    });
    expect(screen.getByTestId("events-import-error")).toBeTruthy();
    // The existing events survive a failed import untouched.
    expect(useSession.getState().bookmarks).toHaveLength(1);
  });
});
