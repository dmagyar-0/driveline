// Unit tests for the per-panel readiness registry (Issue #2).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetReadinessForTests,
  clearPanelReadiness,
  computeVideoReady,
  getReadinessSnapshot,
  setPanelReadiness,
  subscribeReadiness,
  type PanelReadiness,
  type VideoReadyInputs,
} from "./videoReadiness";

function snap(
  state: PanelReadiness["state"],
  overrides: Partial<PanelReadiness> = {},
): PanelReadiness {
  return {
    state,
    lastReadyMs: 0,
    waitingSinceMs: null,
    lastBlitPtsNs: null,
    ...overrides,
  };
}

describe("videoReadiness registry", () => {
  beforeEach(() => {
    __resetReadinessForTests();
    // Run the rAF coalescer synchronously so tests don't sprout
    // arbitrary `await new Promise(r => requestAnimationFrame(r))`
    // dance for every assertion.
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetReadinessForTests();
  });

  it("starts empty", () => {
    expect(getReadinessSnapshot().size).toBe(0);
  });

  it("setPanelReadiness inserts new panels and overwrites existing ones", () => {
    setPanelReadiness("p1", snap("waiting", { waitingSinceMs: 100 }));
    expect(getReadinessSnapshot().get("p1")?.state).toBe("waiting");

    setPanelReadiness(
      "p1",
      snap("ready", { lastReadyMs: 200, waitingSinceMs: null }),
    );
    expect(getReadinessSnapshot().get("p1")?.state).toBe("ready");
    expect(getReadinessSnapshot().get("p1")?.lastReadyMs).toBe(200);
    expect(getReadinessSnapshot().get("p1")?.waitingSinceMs).toBeNull();
  });

  it("clearPanelReadiness removes the entry and notifies subscribers", () => {
    const fn = vi.fn();
    const unsub = subscribeReadiness(fn);

    setPanelReadiness("p1", snap("ready"));
    expect(getReadinessSnapshot().has("p1")).toBe(true);
    fn.mockClear();

    clearPanelReadiness("p1");
    expect(getReadinessSnapshot().has("p1")).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);

    // Clearing a panel that's already gone should not notify again.
    fn.mockClear();
    clearPanelReadiness("p1");
    expect(fn).not.toHaveBeenCalled();
    unsub();
  });

  it("notifies subscribers on first insert and on state transitions only", () => {
    const fn = vi.fn();
    const unsub = subscribeReadiness(fn);

    setPanelReadiness("p1", snap("waiting", { waitingSinceMs: 100 }));
    expect(fn).toHaveBeenCalledTimes(1);
    fn.mockClear();

    // Same state, just a clock tick — must not notify.
    setPanelReadiness("p1", snap("waiting", { waitingSinceMs: 100 }));
    setPanelReadiness("p1", snap("waiting", { waitingSinceMs: 100 }));
    expect(fn).not.toHaveBeenCalled();

    // Transition → notify.
    setPanelReadiness("p1", snap("ready", { lastReadyMs: 250 }));
    expect(fn).toHaveBeenCalledTimes(1);

    // Another transition → notify.
    fn.mockClear();
    setPanelReadiness("p1", snap("stalled"));
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();
  });

  it("subscriber unsubscribe stops further notifications", () => {
    const fn = vi.fn();
    const unsub = subscribeReadiness(fn);
    setPanelReadiness("p1", snap("waiting"));
    expect(fn).toHaveBeenCalledTimes(1);

    fn.mockClear();
    unsub();
    setPanelReadiness("p1", snap("ready"));
    expect(fn).not.toHaveBeenCalled();
  });

  it("supports multiple panels independently", () => {
    setPanelReadiness("a", snap("ready", { lastBlitPtsNs: 100n }));
    setPanelReadiness("b", snap("waiting", { waitingSinceMs: 50 }));
    setPanelReadiness("c", snap("stalled"));

    const r = getReadinessSnapshot();
    expect(r.size).toBe(3);
    expect(r.get("a")?.state).toBe("ready");
    expect(r.get("a")?.lastBlitPtsNs).toBe(100n);
    expect(r.get("b")?.state).toBe("waiting");
    expect(r.get("c")?.state).toBe("stalled");
  });

  it("a panel transitioning waiting → stalled → waiting fires two state-change notifies", () => {
    const fn = vi.fn();
    const unsub = subscribeReadiness(fn);

    setPanelReadiness("p1", snap("waiting"));
    fn.mockClear();
    setPanelReadiness("p1", snap("stalled"));
    expect(fn).toHaveBeenCalledTimes(1);
    setPanelReadiness("p1", snap("waiting"));
    expect(fn).toHaveBeenCalledTimes(2);

    unsub();
  });

  it("subscriber callbacks that throw do not break the notify loop", () => {
    const bad = vi.fn().mockImplementation(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    subscribeReadiness(bad);
    subscribeReadiness(good);

    setPanelReadiness("p1", snap("waiting"));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("logs subscriber errors via console.warn so a swallowed-update regression is visible", () => {
    // The catch in `scheduleNotify` deliberately surfaces subscriber
    // throws through `console.warn` (rather than swallowing silently)
    // so a buggy subscriber that breaks readiness propagation shows up
    // in field telemetry instead of producing a silent "stuck dot" in
    // the Transport. Pin both the message and the thrown error so a
    // refactor can't quietly drop the second argument.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("boom");
    const bad = vi.fn().mockImplementation(() => {
      throw err;
    });
    subscribeReadiness(bad);

    setPanelReadiness("p1", snap("waiting"));
    expect(bad).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("videoReadiness: subscriber threw", err);
    warn.mockRestore();
  });
});

describe("computeVideoReady", () => {
  const MS = 1_000_000n; // ns per ms
  const EPS_300 = 300n * MS; // production READY_EPSILON_NS
  const EPS_100 = 100n * MS; // the old (too-tight) value
  const FRAME_LIVE_WINDOW_MS = 250;

  function inputs(over: Partial<VideoReadyInputs> = {}): VideoReadyInputs {
    return {
      lastBlitPtsNs: 0n,
      cursorNs: 0n,
      nowMs: 10_000,
      lastFrameArrivedLocalMs: 10_000,
      blitQueueLen: 0,
      epsilonNs: EPS_300,
      frameLiveWindowMs: FRAME_LIVE_WINDOW_MS,
      ...over,
    };
  }

  it("is not ready before any frame has been blitted", () => {
    expect(computeVideoReady(inputs({ lastBlitPtsNs: null }))).toBe(false);
  });

  it("tight arm: a frame within epsilon behind the cursor is ready", () => {
    // Blit 80 ms (≈ one 12 fps frame) behind the cursor.
    const cursorNs = 5_000n * MS;
    expect(
      computeVideoReady(inputs({ cursorNs, lastBlitPtsNs: cursorNs - 80n * MS })),
    ).toBe(true);
  });

  it("tight arm: a frame AHEAD of the cursor (just-scrubbed-back) is ready", () => {
    const cursorNs = 5_000n * MS;
    expect(
      computeVideoReady(inputs({ cursorNs, lastBlitPtsNs: cursorNs + 40n * MS })),
    ).toBe(true);
  });

  // The regression this guards: a HEALTHY low-frame-rate stream whose blit sits
  // ~130 ms behind the cursor (setCursor coalescing + one ~12 fps frame), with
  // the loose arms unavailable at the sampled instant (no fresh arrival, queue
  // momentarily drained). At ε=100 ms this returned false → the playback gate
  // held the cursor → 0.38× slow-motion. At ε=300 ms it is correctly ready.
  it("steady-state low-fps lag is ready at 300ms epsilon but NOT at 100ms (slow-motion regression)", () => {
    const cursorNs = 5_000n * MS;
    const lag = inputs({
      cursorNs,
      lastBlitPtsNs: cursorNs - 130n * MS, // ~1.5 frames behind at 12 fps
      lastFrameArrivedLocalMs: 10_000 - 400, // stale (> FRAME_LIVE_WINDOW_MS)
      nowMs: 10_000,
      blitQueueLen: 0, // loose arm B also unavailable this instant
    });
    expect(computeVideoReady({ ...lag, epsilonNs: EPS_300 })).toBe(true);
    expect(computeVideoReady({ ...lag, epsilonNs: EPS_100 })).toBe(false);
  });

  it("loose arm A: beyond epsilon but the decoder produced a frame recently → ready", () => {
    const cursorNs = 5_000n * MS;
    expect(
      computeVideoReady(
        inputs({
          cursorNs,
          lastBlitPtsNs: cursorNs - 500n * MS, // well beyond ε
          lastFrameArrivedLocalMs: 10_000 - 100, // within 250 ms window
          nowMs: 10_000,
          blitQueueLen: 0,
        }),
      ),
    ).toBe(true);
  });

  it("loose arm B: beyond epsilon, stale arrival, but frames queued ahead → ready", () => {
    const cursorNs = 5_000n * MS;
    expect(
      computeVideoReady(
        inputs({
          cursorNs,
          lastBlitPtsNs: cursorNs - 500n * MS,
          lastFrameArrivedLocalMs: 10_000 - 5_000, // stale
          nowMs: 10_000,
          blitQueueLen: 4,
        }),
      ),
    ).toBe(true);
  });

  it("genuine stall: far behind, stale arrival, empty queue → NOT ready (gates)", () => {
    const cursorNs = 5_000n * MS;
    expect(
      computeVideoReady(
        inputs({
          cursorNs,
          lastBlitPtsNs: cursorNs - 2_000n * MS, // 2 s behind
          lastFrameArrivedLocalMs: 10_000 - 5_000, // stale
          nowMs: 10_000,
          blitQueueLen: 0,
        }),
      ),
    ).toBe(false);
  });
});
