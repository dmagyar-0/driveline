// @vitest-environment jsdom
//
// T6.3 · Transport integration test.
//
// Mounts the real `<Transport />` under jsdom and exercises the three
// behaviours that aren't already covered by the rAF-level
// `playback.test.ts` or by the end-to-end `transport.spec.ts`:
//
//   - keyboard shortcuts (Space / Home / End) drive the store through
//     the window-level listener in `Transport.tsx:106-139`;
//   - clicking the play/pause button + changing the speed select
//     routes through the store's `play()` / `pause()` / `setSpeed()`
//     actions;
//   - a scrubber pointer-down on the track schedules a cursor commit
//     (flushed on the next rAF).
//
// The unit-level complement to `apps/e2e/tests/transport.spec.ts` —
// that one exercises the browser's real pointer capture and CSS
// layout, this one exercises the React event wiring.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Transport } from "./Transport";
import { useSession } from "../state/store";

// React 19 RTL requires this flag so `act(...)` wrappers don't log
// "environment not configured" noise.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function seedSession(): void {
  // Seed a 10 s session so Home/End land on distinct values and the
  // cursor ratio math is exercisable.
  useSession.setState({
    sources: [],
    channels: [],
    globalRange: { startNs: 1_000_000_000n, endNs: 11_000_000_000n },
    cursorNs: 1_000_000_000n,
    playing: false,
    speed: 1,
    timeMode: "relative",
    layoutJson: null,
    videoBindings: {},
    plotBindings: {},
  });
}

describe("Transport", () => {
  beforeEach(() => {
    // jsdom returns zero for getBoundingClientRect; give the scrubber
    // track a real width so ratio math doesn't collapse to zero.
    const proto = Element.prototype as unknown as {
      getBoundingClientRect: () => DOMRect;
    };
    proto.getBoundingClientRect = (): DOMRect =>
      ({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: 20,
        width: 1000,
        height: 20,
        toJSON: () => ({}),
      }) as DOMRect;

    // Polyfill the pointer-capture API jsdom is missing.
    const proto2 = Element.prototype as unknown as {
      setPointerCapture: (id: number) => void;
      releasePointerCapture: (id: number) => void;
      hasPointerCapture: (id: number) => boolean;
    };
    const captures = new Set<number>();
    proto2.setPointerCapture = (id: number) => {
      captures.add(id);
    };
    proto2.releasePointerCapture = (id: number) => {
      captures.delete(id);
    };
    proto2.hasPointerCapture = (id: number) => captures.has(id);

    // Force rAF to run synchronously so `scheduleCommit` flushes
    // before the test asserts.
    vi.stubGlobal(
      "requestAnimationFrame",
      (cb: FrameRequestCallback): number => {
        cb(performance.now());
        return 1;
      },
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});

    seedSession();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("Space toggles play/pause", () => {
    render(<Transport />);
    expect(useSession.getState().playing).toBe(false);

    act(() => {
      fireEvent.keyDown(window, { code: "Space" });
    });
    expect(useSession.getState().playing).toBe(true);

    act(() => {
      fireEvent.keyDown(window, { code: "Space" });
    });
    expect(useSession.getState().playing).toBe(false);
  });

  it("Home/End snap the cursor to range bounds", () => {
    render(<Transport />);

    act(() => {
      fireEvent.keyDown(window, { code: "End" });
    });
    // `End` lands at endNs which also triggers the auto-pause clamp.
    expect(useSession.getState().cursorNs).toBe(11_000_000_000n);
    expect(useSession.getState().playing).toBe(false);

    act(() => {
      fireEvent.keyDown(window, { code: "Home" });
    });
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
  });

  it("ignores keyboard shortcuts when focus is inside an input", () => {
    render(
      <div>
        <input data-testid="sink" />
        <Transport />
      </div>,
    );

    const input = document.querySelector(
      "input[data-testid='sink']",
    ) as HTMLInputElement;
    input.focus();

    act(() => {
      fireEvent.keyDown(input, { code: "Space" });
    });
    expect(useSession.getState().playing).toBe(false);
  });

  it("play button toggles the store and speed select updates speed", () => {
    const { getByTestId } = render(<Transport />);

    act(() => {
      fireEvent.click(getByTestId("play-pause"));
    });
    expect(useSession.getState().playing).toBe(true);

    act(() => {
      fireEvent.click(getByTestId("play-pause"));
    });
    expect(useSession.getState().playing).toBe(false);

    act(() => {
      fireEvent.change(getByTestId("transport-speed"), {
        target: { value: "2" },
      });
    });
    expect(useSession.getState().speed).toBe(2);
  });

  it("clicking at 50 % of the track commits cursor to mid-range", () => {
    const { getByTestId } = render(<Transport />);
    const track = getByTestId("scrubber");

    act(() => {
      fireEvent.pointerDown(track, {
        pointerId: 1,
        clientX: 500, // 50 % of a 1000 px wide track
      });
    });
    act(() => {
      fireEvent.pointerUp(track, { pointerId: 1, clientX: 500 });
    });

    // Mid-range of [1e9, 11e9] is 6e9.
    expect(useSession.getState().cursorNs).toBe(6_000_000_000n);
  });

  it("mode chip toggles store.timeMode between relative and absolute", () => {
    // Iteration 2 (issue #5) — the relative/absolute toggle is demoted
    // to a single chip that flips state. The chip's visible label and
    // `aria-pressed` reflect the *current* mode; clicking flips.
    const { getByTestId } = render(<Transport />);
    const chip = getByTestId("transport-mode-toggle") as HTMLButtonElement;
    expect(useSession.getState().timeMode).toBe("relative");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toBe("REL");

    act(() => {
      fireEvent.click(chip);
    });
    expect(useSession.getState().timeMode).toBe("absolute");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(chip.textContent).toBe("ABS");

    act(() => {
      fireEvent.click(chip);
    });
    expect(useSession.getState().timeMode).toBe("relative");
    expect(chip.textContent).toBe("REL");
  });

  it("renders segment count badge when multiple sources are loaded", () => {
    useSession.setState({
      sources: [
        {
          id: "a",
          kind: "mcap",
          name: "a.mcap",
          handle: 0,
          timeRange: { startNs: 1_000_000_000n, endNs: 3_000_000_000n },
          channels: [],
        },
        {
          id: "b",
          kind: "mcap",
          name: "b.mcap",
          handle: 1,
          timeRange: { startNs: 6_000_000_000n, endNs: 11_000_000_000n },
          channels: [],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    const { getByTestId } = render(<Transport />);
    expect(getByTestId("transport-segment-count").textContent).toBe(
      "2 segments",
    );
    // Iteration 2 (issue #4) — the leading boundary tick is
    // suppressed so it doesn't collide with the track's left
    // border-radius. With 2 sources we render 1 boundary; with N
    // sources we render N-1.
    const ticks = document.querySelectorAll(
      "[data-testid='transport-segments'] span",
    );
    expect(ticks.length).toBe(1);
    // The segment bands themselves are still rendered for every
    // source — that's how the user sees the structure of the
    // session at a glance.
    const bands = document.querySelectorAll(
      "[data-testid='transport-segment-bands'] > div",
    );
    expect(bands.length).toBe(2);
    // Per-segment label row should also have one label per source.
    const labels = document.querySelectorAll(
      "[data-testid='transport-segment-labels'] > span",
    );
    expect(labels.length).toBe(2);
    // Iter5 (issue #2) — labels are now structured (S-pill + name)
    // not bare text. The pill carries the index identifier.
    expect(labels[0].textContent).toContain("S1");
    expect(labels[0].textContent).toContain("a.mcap");
    expect(labels[1].textContent).toContain("S2");
    expect(labels[1].textContent).toContain("b.mcap");
  });

  it("prev-1s steps cursor by 1 s and clamps at startNs", () => {
    useSession.setState({ cursorNs: 1_500_000_000n });
    const { getByTestId } = render(<Transport />);

    act(() => {
      fireEvent.click(getByTestId("transport-prev-1s"));
    });
    // Mid-step would be 0.5e9, but setCursor clamps at startNs (1e9).
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);

    act(() => {
      fireEvent.click(getByTestId("transport-prev-1s"));
    });
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
  });

  it("next-1s clamps at endNs and auto-pauses", () => {
    useSession.setState({ cursorNs: 10_500_000_000n, playing: true });
    const { getByTestId } = render(<Transport />);

    act(() => {
      fireEvent.click(getByTestId("transport-next-1s"));
    });
    expect(useSession.getState().cursorNs).toBe(11_000_000_000n);
    expect(useSession.getState().playing).toBe(false);
  });

  it("ArrowLeft / ArrowRight step ±1 s and respect input focus", () => {
    const { getByTestId } = render(
      <div>
        <input data-testid="sink" />
        <Transport />
      </div>,
    );

    // Body-focused: ArrowRight advances cursor by 1 s.
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
    act(() => {
      fireEvent.keyDown(window, { code: "ArrowRight" });
    });
    expect(useSession.getState().cursorNs).toBe(2_000_000_000n);

    act(() => {
      fireEvent.keyDown(window, { code: "ArrowLeft" });
    });
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);

    // Input-focused: arrow keys are ignored by the transport handler.
    const input = getByTestId("sink") as HTMLInputElement;
    input.focus();
    act(() => {
      fireEvent.keyDown(input, { code: "ArrowRight" });
    });
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
  });

  it("speed pill renders all 5 options", () => {
    const { getByTestId } = render(<Transport />);
    const select = getByTestId("transport-speed") as HTMLSelectElement;
    expect(select.options.length).toBe(5);
    const values = Array.from(select.options).map((o) => Number(o.value));
    expect(values).toEqual([0.25, 0.5, 1, 2, 4]);
  });

  // Iteration 2 — VLC-style J/K/L keys (issue #6). K = play/pause,
  // J = step back 1 s, L = step forward 1 s. These complement the
  // arrow-key + Space bindings rather than replacing them.
  it("K toggles play, J/L step ±1 s (VLC-style)", () => {
    render(<Transport />);
    expect(useSession.getState().playing).toBe(false);

    act(() => {
      fireEvent.keyDown(window, { code: "KeyK" });
    });
    expect(useSession.getState().playing).toBe(true);

    act(() => {
      fireEvent.keyDown(window, { code: "KeyK" });
    });
    expect(useSession.getState().playing).toBe(false);

    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
    act(() => {
      fireEvent.keyDown(window, { code: "KeyL" });
    });
    expect(useSession.getState().cursorNs).toBe(2_000_000_000n);

    act(() => {
      fireEvent.keyDown(window, { code: "KeyJ" });
    });
    expect(useSession.getState().cursorNs).toBe(1_000_000_000n);
  });

  // Iteration 2 (issue #6) — `?` toggles the shortcuts overlay.
  it("`?` toggles the shortcuts overlay", () => {
    render(<Transport />);
    expect(
      document.querySelector("[data-testid='transport-shortcuts-overlay']"),
    ).toBeNull();

    act(() => {
      // jsdom dispatches `keydown` with `key: "?"` directly; we
      // pass both shape variants the production code accepts.
      fireEvent.keyDown(window, { key: "?", code: "Slash", shiftKey: true });
    });
    expect(
      document.querySelector("[data-testid='transport-shortcuts-overlay']"),
    ).not.toBeNull();

    act(() => {
      fireEvent.keyDown(window, { key: "?", code: "Slash", shiftKey: true });
    });
    expect(
      document.querySelector("[data-testid='transport-shortcuts-overlay']"),
    ).toBeNull();
  });

  // Iteration 2 (issue #6) — clicking the `?` button opens the overlay.
  it("? button opens and the close button hides the shortcuts overlay", () => {
    const { getByTestId } = render(<Transport />);

    act(() => {
      fireEvent.click(getByTestId("transport-shortcuts-toggle"));
    });
    expect(getByTestId("transport-shortcuts-overlay")).toBeTruthy();

    act(() => {
      fireEvent.click(getByTestId("transport-shortcuts-close"));
    });
    expect(
      document.querySelector("[data-testid='transport-shortcuts-overlay']"),
    ).toBeNull();
  });

  // Iteration 2 (issue #2) — hover tooltip appears on pointer-enter and
  // disappears on pointer-leave; in production we throttle the
  // intermediate updates to rAF, and the test polyfill above runs rAF
  // synchronously so we can read the resulting label. Iter3 added the
  // alternate-convention sub-line, so we assert containment, not
  // strict equality.
  it("hover tooltip appears on track enter and disappears on leave", () => {
    const { getByTestId } = render(<Transport />);
    const track = getByTestId("scrubber");

    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 500 });
    });
    const tip = document.querySelector(
      "[data-testid='transport-hover-tooltip']",
    );
    expect(tip).not.toBeNull();
    // Mid-range of [1e9, 11e9] is 6e9 = 5 s elapsed → "00:05.000".
    expect(tip?.textContent).toContain("00:05.000");

    act(() => {
      fireEvent.pointerLeave(track, { pointerId: 1 });
    });
    expect(
      document.querySelector("[data-testid='transport-hover-tooltip']"),
    ).toBeNull();
  });

  // Iteration 3 (issues #1 + #3) — the playhead badge now owns BOTH
  // the current time AND the session total, rendered as `current /
  // total`. The redundant second number stacked on the badge (iter2)
  // is gone; the controls row no longer carries a duplicate total.
  it("playhead badge shows `current / total` and the controls row carries no duplicate", () => {
    useSession.setState({ cursorNs: 6_000_000_000n });
    const { getByTestId, queryByTestId } = render(<Transport />);
    const badge = getByTestId("transport-playhead-badge");
    expect(badge.textContent).toContain("00:05.000");
    // Total is right of the cursor time inside the same badge.
    const total = getByTestId("transport-playhead-total");
    expect(total.textContent).toBe("00:10.000");
    // The old secondary "Total" block in the controls row is gone.
    expect(queryByTestId("transport-readout-block")).toBeNull();
    expect(queryByTestId("transport-readout")).toBeNull();
    // The badge no longer carries the alternate-convention sub-line;
    // hovering the track is where users surface that now.
    expect(badge.querySelector("[class*='playheadBadgeSub']")).toBeNull();
  });

  // Iteration 5 (issue #4) — the hover tooltip is now a single-line
  // scout: just the time. Sub-line and inline segment-name (iter3/4)
  // are gone; the cursor badge owns the rich readout. The hover chip
  // only shows boundary labels when the pointer is near a segment
  // tick (separate test below).
  it("hover tooltip is a single-line time scout", () => {
    useSession.setState({ cursorNs: 6_000_000_000n });
    const { getByTestId } = render(<Transport />);
    const track = getByTestId("scrubber");

    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 500 });
    });

    const tip = document.querySelector(
      "[data-testid='transport-hover-tooltip']",
    );
    expect(tip).not.toBeNull();
    // Only the canonical relative format (iter3 issue #1) — no
    // wall-clock alt convention sub-line in iter5.
    expect(tip?.textContent).toBe("00:05.000");
    expect(tip?.querySelectorAll("span").length).toBe(1);
  });

  // Iteration 3 (issue #4) — REL/ABS and `?` live in their own meta
  // cluster, separated from the speed pill by a divider so the three
  // controls no longer cluster awkwardly.
  it("meta cluster groups mode toggle + shortcuts; speed lives in its own pill", () => {
    const { getByTestId } = render(<Transport />);
    const meta = getByTestId("transport-meta-cluster");
    expect(meta).toBeTruthy();
    // Mode toggle and shortcuts button are children of the meta
    // cluster, not of the speed column.
    expect(meta.contains(getByTestId("transport-mode-toggle"))).toBe(true);
    expect(meta.contains(getByTestId("transport-shortcuts-toggle"))).toBe(true);
    // Iter4 (issue #4) — speed pill moved INTO the primary
    // transport-cluster (next to the play group), no longer in the
    // utility/meta cluster on the right.
    expect(meta.contains(getByTestId("transport-speed"))).toBe(false);
  });

  // Iteration 4 (issue #4) — play group + speed pill are siblings
  // inside the same primary cluster so the user reads "this is how
  // I drive playback" in one glance.
  it("playback buttons and speed pill share the primary transport cluster", () => {
    const { getByTestId } = render(<Transport />);
    const cluster = getByTestId("transport-cluster");
    expect(cluster).toBeTruthy();
    expect(cluster.contains(getByTestId("play-pause"))).toBe(true);
    expect(cluster.contains(getByTestId("transport-prev-1s"))).toBe(true);
    expect(cluster.contains(getByTestId("transport-next-1s"))).toBe(true);
    expect(cluster.contains(getByTestId("transport-speed"))).toBe(true);
    // …and explicitly NOT the demoted utility controls.
    expect(cluster.contains(getByTestId("transport-mode-toggle"))).toBe(false);
    expect(cluster.contains(getByTestId("transport-shortcuts-toggle"))).toBe(
      false,
    );
  });

  // Iteration 4 (issue #3) — date stamp sublabel inside the cursor
  // badge only renders when timeMode is "absolute". In "relative"
  // mode the badge is a single-line readout so the transport bar
  // never shows competing time formats simultaneously.
  it("date sublabel appears only in absolute mode", () => {
    const { queryByTestId, getByTestId } = render(<Transport />);
    expect(queryByTestId("transport-playhead-date")).toBeNull();

    act(() => {
      fireEvent.click(getByTestId("transport-mode-toggle"));
    });
    const date = getByTestId("transport-playhead-date");
    expect(date).toBeTruthy();
    // YYYY-MM-DD shape; the absolute formatter prints the
    // session-start day, which under our fixture seed is 1970-01-01.
    expect(date.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    act(() => {
      fireEvent.click(getByTestId("transport-mode-toggle"));
    });
    expect(queryByTestId("transport-playhead-date")).toBeNull();
  });

  // Iteration 5 (issue #4) — hover chip is terse. The iter3/4
  // inline segment-name line is gone; instead, hovering NEAR a
  // segment boundary (within ~0.4 % of track width) flips the chip
  // to "Segment N start" / "Segment N end" so the boundary ticks
  // are self-explanatory. Anywhere else (deep inside a segment),
  // it's just the time.
  it("hover chip shows boundary labels near segment ticks", () => {
    useSession.setState({
      sources: [
        {
          id: "a",
          kind: "mcap",
          name: "drive_1.mcap",
          handle: 0,
          timeRange: { startNs: 1_000_000_000n, endNs: 5_000_000_000n },
          channels: [],
        },
        {
          id: "b",
          kind: "mcap",
          name: "drive_2.mcap",
          handle: 1,
          timeRange: { startNs: 6_000_000_000n, endNs: 11_000_000_000n },
          channels: [],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
    const { getByTestId } = render(<Transport />);
    const track = getByTestId("scrubber");

    // Segment B starts at ns = 6e9, range = [1e9, 11e9] → 50 % of track.
    // Hover EXACTLY on the boundary (500/1000 = 50 %).
    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 500 });
    });
    const tip = document.querySelector(
      "[data-testid='transport-hover-tooltip']",
    );
    expect(tip?.textContent).toBe("Segment 2 start");

    // Segment A ends at ns = 5e9 → 40 % of track → 400/1000.
    act(() => {
      fireEvent.pointerLeave(track, { pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 400 });
    });
    expect(
      document.querySelector("[data-testid='transport-hover-tooltip']")
        ?.textContent,
    ).toBe("Segment 1 end");

    // Deep inside Segment A (10 % of track, far from any boundary)
    // → fall back to the canonical time readout.
    act(() => {
      fireEvent.pointerLeave(track, { pointerId: 1 });
    });
    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 100 });
    });
    const tipTime = document.querySelector(
      "[data-testid='transport-hover-tooltip']",
    );
    // 10 % of [1e9, 11e9] → 2e9 ns → 1 s elapsed → 00:01.000.
    expect(tipTime?.textContent).toBe("00:01.000");
  });

  // Iteration 5 (issue #4) — single-source sessions never trigger
  // boundary snapping; the chip always shows the time.
  it("hover chip always shows time in single-source sessions", () => {
    const { getByTestId } = render(<Transport />);
    const track = getByTestId("scrubber");

    act(() => {
      fireEvent.pointerEnter(track, { pointerId: 1, clientX: 500 });
    });
    const tip = document.querySelector(
      "[data-testid='transport-hover-tooltip']",
    );
    expect(tip?.textContent).toBe("00:05.000");
  });
});
