// @vitest-environment jsdom
//
// Phase 8 · BookmarkMarkers component tests.
//
// Markers render at the right `left: %` for their `ns`, clicking a
// marker calls `setCursor` and stops propagation so the parent track
// does not also receive the pointerdown, and out-of-range bookmarks
// clamp to [0, 100]% with a `data-out-of-range` attribute. The
// integration with `Transport.tsx` is covered in
// `apps/e2e/tests/bookmarks.spec.ts`.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { BookmarkMarkers } from "./BookmarkMarkers";
import { useSession } from "../state/store";

function seedRange(): void {
  useSession.setState({
    globalRange: { startNs: 0n, endNs: 10_000_000_000n },
    cursorNs: 0n,
  });
}

afterEach(() => {
  cleanup();
  for (const b of [...useSession.getState().bookmarks]) {
    useSession.getState().removeBookmark(b.id);
  }
  useSession.setState({ globalRange: null, cursorNs: 0n });
});

describe("BookmarkMarkers", () => {
  it("renders nothing when globalRange is null", () => {
    const { container } = render(<BookmarkMarkers />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there are no bookmarks", () => {
    seedRange();
    const { container } = render(<BookmarkMarkers />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one marker per bookmark at the correct left%", () => {
    seedRange();
    const id1 = useSession.getState().addBookmark(2_500_000_000n, "a"); // 25%
    const id2 = useSession.getState().addBookmark(7_500_000_000n, "b"); // 75%
    render(<BookmarkMarkers />);
    const m1 = screen.getByTestId(`bookmark-marker-${id1}`) as HTMLDivElement;
    const m2 = screen.getByTestId(`bookmark-marker-${id2}`) as HTMLDivElement;
    expect(m1.style.left).toBe("25%");
    expect(m2.style.left).toBe("75%");
  });

  it("clicking a marker dispatches setCursor with the bookmark ns", () => {
    seedRange();
    const id = useSession.getState().addBookmark(4_000_000_000n, "x");
    render(<BookmarkMarkers />);
    expect(useSession.getState().cursorNs).toBe(0n);
    fireEvent.pointerDown(screen.getByTestId(`bookmark-marker-${id}`));
    expect(useSession.getState().cursorNs).toBe(4_000_000_000n);
  });

  it("clicking a marker stops propagation to the parent track", () => {
    seedRange();
    const id = useSession.getState().addBookmark(4_000_000_000n, "x");
    let parentSeen = false;
    const Wrapper = () => (
      <div onPointerDown={() => (parentSeen = true)}>
        <BookmarkMarkers />
      </div>
    );
    render(<Wrapper />);
    fireEvent.pointerDown(screen.getByTestId(`bookmark-marker-${id}`));
    expect(parentSeen).toBe(false);
  });

  it("clamps out-of-range bookmarks and flags them via data-out-of-range", () => {
    seedRange();
    const before = useSession.getState().addBookmark(-1_000n, "before"); // 0%
    const after = useSession.getState().addBookmark(20_000_000_000n, "after"); // 100%
    render(<BookmarkMarkers />);
    const mBefore = screen.getByTestId(
      `bookmark-marker-${before}`,
    ) as HTMLDivElement;
    const mAfter = screen.getByTestId(
      `bookmark-marker-${after}`,
    ) as HTMLDivElement;
    expect(mBefore.style.left).toBe("0%");
    expect(mAfter.style.left).toBe("100%");
    expect(mBefore.getAttribute("data-out-of-range")).toBe("true");
    expect(mAfter.getAttribute("data-out-of-range")).toBe("true");
  });

  it("renders a band spanning [ns-before, ns+after] for a ranged event", () => {
    seedRange(); // range is [0, 10s]
    const id = useSession.getState().addBookmark(5_000_000_000n, "ranged"); // 50%
    useSession.getState().setBookmarkRange(id, 1_000_000_000n, 2_000_000_000n); // 4s..7s → 40%..70%
    render(<BookmarkMarkers />);
    const band = screen.getByTestId(`bookmark-band-${id}`) as HTMLDivElement;
    expect(band.style.left).toBe("40%");
    expect(band.style.width).toBe("30%");
    // The center line stays at the anchor.
    expect(
      (screen.getByTestId(`bookmark-marker-${id}`) as HTMLDivElement).style
        .left,
    ).toBe("50%");
  });

  it("renders no band for a point event", () => {
    seedRange();
    const id = useSession.getState().addBookmark(5_000_000_000n, "point");
    render(<BookmarkMarkers />);
    expect(screen.queryByTestId(`bookmark-band-${id}`)).toBeNull();
  });

  it("renders nothing when globalRange has zero span", () => {
    useSession.setState({
      globalRange: { startNs: 1_000n, endNs: 1_000n },
      cursorNs: 1_000n,
    });
    useSession.getState().addBookmark(1_000n, "edge");
    const { container } = render(<BookmarkMarkers />);
    expect(container.firstChild).toBeNull();
  });
});
