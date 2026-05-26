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

  it("segmented control toggles store.timeMode between relative and absolute", () => {
    const { getByTestId } = render(<Transport />);
    const relBtn = getByTestId("transport-mode-relative") as HTMLButtonElement;
    const absBtn = getByTestId("transport-mode-absolute") as HTMLButtonElement;
    expect(useSession.getState().timeMode).toBe("relative");
    expect(relBtn.getAttribute("aria-pressed")).toBe("true");
    expect(absBtn.getAttribute("aria-pressed")).toBe("false");

    act(() => {
      fireEvent.click(absBtn);
    });
    expect(useSession.getState().timeMode).toBe("absolute");
    expect(absBtn.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      fireEvent.click(relBtn);
    });
    expect(useSession.getState().timeMode).toBe("relative");
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
    const ticks = document.querySelectorAll(
      "[data-testid='transport-segments'] span",
    );
    expect(ticks.length).toBe(2);
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
});
