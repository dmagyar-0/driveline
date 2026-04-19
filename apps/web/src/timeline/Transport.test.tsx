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
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

  it("mode button toggles between relative and absolute readout", () => {
    const { getByTestId } = render(<Transport />);
    const mode = getByTestId("transport-mode") as HTMLButtonElement;
    expect(mode.textContent).toBe("relative");

    act(() => {
      fireEvent.click(mode);
    });
    expect(mode.textContent).toBe("absolute");
  });
});
