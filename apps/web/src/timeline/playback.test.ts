// Unit tests for the T3.3 playback loop. Uses a hand-rolled fake clock
// and fake rAF scheduler so the tests run under the existing
// `environment: "node"` vitest setup. Drives the real Zustand store
// through the same fake-worker pattern as `state/store.test.ts`.

import { beforeEach, describe, expect, it } from "vitest";
import type { Remote } from "comlink";
import { useSession } from "../state/store";
import { isCursorGated, startPlaybackLoop } from "./playback";
import type { PanelReadiness } from "../panels/videoReadiness";
import type {
  DataCoreApi,
  McapSummary,
  Mf4Summary,
  Mp4SidecarSummary,
} from "../workerClient";

interface Summaries {
  mcap: McapSummary;
  mf4: Mf4Summary;
  mp4: Mp4SidecarSummary;
}

// Session spans 100 s so the drift-free test can walk 10 s of fake
// frames without hitting end-of-session; the explicit end-of-session
// test overshoots by > 100 s to exercise the clamp + auto-pause path.
const SESSION_END_NS = 100_000_000_000n;

function summaries(): Summaries {
  return {
    mcap: {
      start_ns: 0n,
      end_ns: SESSION_END_NS,
      channels: [],
    },
    mf4: {
      start_ns: 0n,
      end_ns: SESSION_END_NS,
      channels: [],
    },
    mp4: {
      start_ns: 0n,
      end_ns: SESSION_END_NS,
      channels: [],
    },
  };
}

function makeFakeWorker(): Remote<DataCoreApi> {
  let nextHandle = 1;
  const s = summaries();
  return {
    async ping() {
      return "pong";
    },
    async fetchRangeStub() {
      return new Uint8Array();
    },
    async openMcap() {
      return nextHandle++;
    },
    async closeMcap() {},
    async mcapSummary() {
      return s.mcap;
    },
    async openMf4() {
      return nextHandle++;
    },
    async closeMf4() {},
    async mf4Summary() {
      return s.mf4;
    },
    async mf4FetchRange() {
      return new Uint8Array();
    },
    async openMp4Sidecar() {
      return nextHandle++;
    },
    async closeMp4Sidecar() {},
    async mp4SidecarSummary() {
      return s.mp4;
    },
  } as unknown as Remote<DataCoreApi>;
}

interface FakeClock {
  now: () => number;
  raf: (cb: FrameRequestCallback) => number;
  caf: (id: number) => void;
  advance: (ms: number) => void;
  flush: () => number; // returns count of callbacks invoked
  pendingCount: () => number;
}

function makeFakeClock(): FakeClock {
  let nowMs = 0;
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    now: () => nowMs,
    raf(cb) {
      const id = nextId++;
      pending.set(id, cb);
      return id;
    },
    caf(id) {
      pending.delete(id);
    },
    advance(ms) {
      nowMs += ms;
    },
    flush() {
      const cbs = Array.from(pending.values());
      pending.clear();
      for (const cb of cbs) cb(nowMs);
      return cbs.length;
    },
    pendingCount: () => pending.size,
  };
}

async function loadSession(): Promise<void> {
  useSession.getState().setWorker(makeFakeWorker());
  await useSession
    .getState()
    .openFiles([new File([new Uint8Array([1])], "seed.mcap")]);
}

beforeEach(async () => {
  await useSession.getState().clear();
});

describe("playback loop (T3.3)", () => {
  it("does not schedule a frame while paused", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);
    expect(clock.pendingCount()).toBe(0);
    clock.advance(100);
    expect(clock.pendingCount()).toBe(0);
    stop();
  });

  it("schedules and advances cursorNs when play() is called", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    expect(useSession.getState().playing).toBe(true);
    expect(clock.pendingCount()).toBe(1);

    clock.advance(16);
    clock.flush();
    // 16 ms at 1× = 16 000 000 ns.
    expect(useSession.getState().cursorNs).toBe(16_000_000n);
    // The tick should have scheduled the next frame.
    expect(clock.pendingCount()).toBe(1);

    stop();
  });

  it("is drift-free across 10 s of simulated play at 1×", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    // 625 frames × 16 ms = 10 000 ms of wall-clock. Anchored math
    // computes `nextNs` from the single `anchor.nowMs` each frame, so
    // the final cursor must be *exactly* 10 s regardless of how many
    // frames were flushed — no rounding accumulation.
    for (let i = 0; i < 625; i++) {
      clock.advance(16);
      clock.flush();
    }
    expect(useSession.getState().cursorNs).toBe(10_000_000_000n);
    expect(useSession.getState().playing).toBe(true);
    stop();
  });

  it("stays exact even under irregular frame intervals", async () => {
    // Simulate rAF jitter: frames arrive at uneven gaps. Because the
    // loop anchors against `performance.now()` rather than accumulating
    // per-frame deltas, the total advance after N frames equals the
    // elapsed wall-clock × 1e6 × speed regardless of frame cadence.
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    const gaps = [7, 21, 16, 33, 12, 18, 14, 22, 15, 17]; // sum = 175
    let totalMs = 0;
    for (const g of gaps) {
      clock.advance(g);
      clock.flush();
      totalMs += g;
    }
    expect(useSession.getState().cursorNs).toBe(BigInt(totalMs) * 1_000_000n);
    stop();
  });

  it("respects speed: 2× doubles the advance", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().setSpeed(2);
    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    // 100 ms × 1e6 × 2 = 200 000 000 ns.
    expect(useSession.getState().cursorNs).toBe(200_000_000n);
    stop();
  });

  it("respects speed: 0.25× quarters the advance", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().setSpeed(0.25);
    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    // 100 ms × 1e6 × 0.25 = 25 000 000 ns.
    expect(useSession.getState().cursorNs).toBe(25_000_000n);
    stop();
  });

  it("re-anchors on mid-playback speed change without losing position", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(100_000_000n);

    // Switch to 2×. Cursor must not jump.
    useSession.getState().setSpeed(2);
    expect(useSession.getState().cursorNs).toBe(100_000_000n);

    // Next 50 ms at 2× = 100_000_000 ns of additional advance.
    clock.advance(50);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(200_000_000n);
    stop();
  });

  it("re-anchors on external setCursor during play", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(100_000_000n);

    // Simulate a scrub mid-play.
    useSession.getState().setCursor(500_000_000n);
    expect(useSession.getState().cursorNs).toBe(500_000_000n);
    // Still playing — the store only auto-pauses at endNs.
    expect(useSession.getState().playing).toBe(true);

    // Next 50 ms should advance from the new anchor, not from the old
    // position.
    clock.advance(50);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(550_000_000n);
    stop();
  });

  it("stops scheduling once play reaches end-of-session", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    // Overshoot the 100 s session span. setCursor clamps to endNs and
    // flips playing=false; the loop must observe the flip and stop
    // scheduling further frames.
    clock.advance(100_001);
    clock.flush();
    const s = useSession.getState();
    expect(s.cursorNs).toBe(SESSION_END_NS);
    expect(s.playing).toBe(false);
    expect(clock.pendingCount()).toBe(0);
    stop();
  });

  it("cancels the scheduled frame when pause() is called", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    expect(clock.pendingCount()).toBe(1);
    useSession.getState().pause();
    expect(clock.pendingCount()).toBe(0);

    // Any further fake time should not move the cursor.
    const before = useSession.getState().cursorNs;
    clock.advance(500);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(before);
    stop();
  });

  it("stop() cancels the pending frame and stops subscribing", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);

    useSession.getState().play();
    expect(clock.pendingCount()).toBe(1);
    stop();
    expect(clock.pendingCount()).toBe(0);

    // Subsequent store changes should not re-engage the loop.
    useSession.getState().pause();
    useSession.getState().play();
    expect(clock.pendingCount()).toBe(0);
  });

  it("picks up a session that is already playing at wire-up time", async () => {
    await loadSession();
    useSession.getState().play();
    expect(useSession.getState().playing).toBe(true);

    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, clock);
    // Loop was started after `play()` — it must seed an anchor and
    // schedule a frame immediately.
    expect(clock.pendingCount()).toBe(1);

    clock.advance(50);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(50_000_000n);
    stop();
  });
});

// Issue #2 — decode-aware cursor gating tests. Drives the loop with a
// hand-rolled readiness map + bound panel list so the gate predicate
// can be exercised without spinning up a `<VideoPanel>`.
describe("playback loop gating (Issue #2)", () => {
  function readinessMap(
    entries: Array<[string, PanelReadiness["state"]]>,
  ): Map<string, PanelReadiness> {
    const m = new Map<string, PanelReadiness>();
    for (const [id, state] of entries) {
      m.set(id, {
        state,
        lastReadyMs: 0,
        waitingSinceMs: state === "waiting" ? 0 : null,
        lastBlitPtsNs: state === "ready" ? 0n : null,
      });
    }
    return m;
  }

  it("does not advance the cursor while the only bound panel is waiting", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const ready = readinessMap([["video-1", "waiting"]]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["video-1"],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    // 100 ms of fake wall-clock with the panel "waiting" must NOT
    // advance the cursor.
    expect(useSession.getState().cursorNs).toBe(0n);
    expect(isCursorGated()).toBe(true);
    // The loop must keep scheduling so it can re-check on the next
    // rAF — otherwise a "waiting" panel would freeze playback even
    // after it caught up.
    expect(clock.pendingCount()).toBe(1);
    stop();
  });

  it("flips ready: next tick advances by exactly one frame, not by the entire wait", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const ready = readinessMap([["video-1", "waiting"]]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["video-1"],
    });

    useSession.getState().play();
    // Sit through a long wait while the panel reports "waiting".
    clock.advance(1000);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(0n);

    // Decoder catches up. Next 16 ms tick must advance by ~16 ms only,
    // NOT by 1016 ms (the anchor must have been re-based on every
    // gated tick).
    ready.set("video-1", {
      state: "ready",
      lastReadyMs: 0,
      waitingSinceMs: null,
      lastBlitPtsNs: 0n,
    });
    clock.advance(16);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(16_000_000n);
    expect(isCursorGated()).toBe(false);
    stop();
  });

  it("skips the gate when no video panel is bound", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => new Map(),
      boundVideoPanelIds: () => [],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    // No bound panels → predicate skipped → cursor advances normally.
    expect(useSession.getState().cursorNs).toBe(100_000_000n);
    expect(isCursorGated()).toBe(false);
    stop();
  });

  it("ignores stalled panels for gating (cursor proceeds)", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const ready = readinessMap([["video-broken", "stalled"]]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["video-broken"],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    // The single bound panel is stalled → gate ignores it → cursor
    // advances at wall clock rate.
    expect(useSession.getState().cursorNs).toBe(100_000_000n);
    expect(isCursorGated()).toBe(false);
    stop();
  });

  it("multi-panel: one waiting holds the cursor; the rest don't matter", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const ready = readinessMap([
      ["healthy", "ready"],
      ["slow", "waiting"],
    ]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["healthy", "slow"],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(0n);
    expect(isCursorGated()).toBe(true);
    stop();
  });

  it("multi-panel: one stalled + one ready advances at the ready panel's pace", async () => {
    await loadSession();
    const clock = makeFakeClock();
    const ready = readinessMap([
      ["healthy", "ready"],
      ["broken", "stalled"],
    ]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["healthy", "broken"],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(100_000_000n);
    expect(isCursorGated()).toBe(false);
    stop();
  });

  it("orphan binding without a registry entry does not gate the cursor", async () => {
    await loadSession();
    const clock = makeFakeClock();
    // Empty registry but the binding exists — typically a stale
    // videoBindings entry left over from a previous layout where the
    // panel has been removed. Gating on these would freeze playback
    // forever for users whose binding map drifted from their layout.
    // Once a real panel mounts, its first rAF tick puts it in the
    // registry and gating engages naturally.
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => new Map(),
      boundVideoPanelIds: () => ["video-1"],
    });

    useSession.getState().play();
    clock.advance(100);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(100_000_000n);
    expect(isCursorGated()).toBe(false);
    stop();
  });

  it("explicit absent state in the registry gates the cursor", async () => {
    await loadSession();
    const clock = makeFakeClock();
    // Distinct from the orphan case: the panel HAS published a
    // snapshot, but it's still in the initial "absent" state (no
    // frame has landed). This must gate; the panel's own
    // STALLED_TIMEOUT_MS escalation bounds the grace.
    const ready = readinessMap([["video-1", "absent"]]);
    const stop = startPlaybackLoop(useSession, {
      ...clock,
      readiness: () => ready,
      boundVideoPanelIds: () => ["video-1"],
    });

    useSession.getState().play();
    clock.advance(50);
    clock.flush();
    expect(useSession.getState().cursorNs).toBe(0n);
    expect(isCursorGated()).toBe(true);
    stop();
  });
});
