// T3.3 · Playback loop. rAF-driven advance of `cursorNs` while
// `playing`; respects `speed`; anchored against `performance.now()` so
// drift across the session is bounded by the clock precision rather
// than accumulated frame deltas.
//
// Kept as a plain module (not a React hook) so the tick logic is
// testable under the existing `environment: "node"` vitest setup
// without jsdom or React Testing Library.
//
// The loop is a pure consumer of the T3.1 state machine — all clamp
// and end-of-session auto-pause invariants live in `state/store.ts:
// 189-201`, so the tick does nothing more than compute the next ns
// value and hand it to `setCursor`.

import type { StoreApi } from "zustand";
import type { SessionState } from "../state/store";
import { mark, measure } from "../perf";
import {
  getReadinessSnapshot as defaultGetReadinessSnapshot,
  type PanelReadiness,
} from "../panels/videoReadiness";

// Issue #2 — cursor gating signal. Mirrors the constant in
// `panels/VideoPanel.tsx`; both modules independently consult their
// own copy so neither has to import across the panels/timeline seam
// just to compare two bigints.
//
// Rationale: ε must exceed the STEADY-STATE lag between the cursor and the
// newest blitted frame, or the gate fires during healthy playback and throttles
// the cursor into slow-motion (measured: at ε=100 ms on ~12 fps nuScenes the
// cursor was gated ~62 % of ticks → 0.38× playback, even with the decoder 763 ms
// ahead and 9 frames queued). That steady-state lag = setCursor coalescing
// (~33 ms) + frame quantisation (≈ one inter-frame interval). At 30/60 fps that
// interval is ~17–33 ms so 100 ms covered it, but low-rate camera streams
// (nuScenes CAM_FRONT ≈ 12 fps → ~85 ms frames) push the lag to ~130 ms, above
// the old ε. 300 ms comfortably clears the low-rate case while still catching a
// genuine stall (whose lag grows without bound). Mirrors the constant in
// `panels/VideoPanel.tsx`; both modules keep their own copy so neither imports
// across the panels/timeline seam just to compare two bigints.
export const READY_EPSILON_NS = 300_000_000n;

/** Issue #2 — flag readable by Playwright via the `getCursorGated`
 *  dev hook. Module-scope so the rAF loop can write it without
 *  routing through React state. Mirrors the most recent `tick()`
 *  decision; consult after a tick to know if the cursor was held.
 *
 *  Caveat: only one playback loop may run against this module at a
 *  time — concurrent `startPlaybackLoop()` callers would race on this
 *  flag. Production has exactly one loop (mounted by `<App />`); unit
 *  tests in `playback.test.ts` rely on that singleton assumption to
 *  observe gate state via `isCursorGated()`. */
let cursorGated = false;
export function isCursorGated(): boolean {
  return cursorGated;
}

export interface PlaybackDeps {
  /** Wall-clock source in milliseconds. */
  now: () => number;
  /** Schedules `cb` for the next animation frame; returns a handle. */
  raf: (cb: FrameRequestCallback) => number;
  /** Cancels a previously-returned rAF handle. */
  caf: (id: number) => void;
  /** Schedules `cb` after ~`ms`; returns a numeric handle. The rAF
   *  starvation fallback (see `startPlaybackLoop`): rAF is throttled to
   *  a crawl in backgrounded/headless tabs because no display drives
   *  frames, but `setTimeout` keeps firing. Defaults to `setTimeout`
   *  (cast to a number so the handle type matches `raf`'s; Node returns
   *  a Timeout object, the browser returns a number). */
  setTimer: (cb: () => void, ms: number) => number;
  /** Cancels a previously-returned `setTimer` handle. */
  clearTimer: (handle: number) => void;
  /** Issue #2 — readiness map source. Defaults to the live registry;
   *  unit tests inject a hand-rolled Map so the gate can be exercised
   *  without spinning up a VideoPanel. */
  readiness: () => Map<string, PanelReadiness>;
  /** Issue #2 — list of bound video panel ids. Defaults to reading
   *  `videoBindings` off the store; unit tests pass a closure to
   *  drive the gate directly. */
  boundVideoPanelIds: (state: SessionState) => string[];
}

type SessionStore = Pick<StoreApi<SessionState>, "getState" | "subscribe">;

function defaultBoundVideoPanelIds(state: SessionState): string[] {
  // Walk `videoBindings` once per tick; a panel is "bound" iff its
  // entry exists and is non-null. Allocation-light: the array is at
  // most one entry per video panel (typically ≤ 4).
  const out: string[] = [];
  const b = state.videoBindings;
  for (const k in b) {
    if (b[k]) out.push(k);
  }
  return out;
}

// ~16 ms ≈ one 60 Hz frame. When rAF is starved the timer keeps the
// cursor advancing at roughly 60 Hz; when rAF is healthy it almost
// always wins the race and cancels the timer before it fires.
const FALLBACK_INTERVAL_MS = 16;

function defaultDeps(): PlaybackDeps {
  return {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
    setTimer: (cb, ms) => setTimeout(cb, ms) as unknown as number,
    clearTimer: (handle) => clearTimeout(handle),
    readiness: defaultGetReadinessSnapshot,
    boundVideoPanelIds: defaultBoundVideoPanelIds,
  };
}

interface Anchor {
  cursorNs: bigint;
  nowMs: number;
  speed: number;
}

export function startPlaybackLoop(
  store: SessionStore,
  deps?: Partial<PlaybackDeps>,
): () => void {
  const { now, raf, caf, setTimer, clearTimer, readiness, boundVideoPanelIds } =
    {
      ...defaultDeps(),
      ...deps,
    };

  // The cursor is driven from BOTH rAF and a setTimeout fallback,
  // whichever fires first (see `arm`/`disarm`). rAF keeps foreground
  // playback vsync-smooth; the timer guarantees ~60 Hz progress when
  // rAF is starved (backgrounded / headless tabs, where no display
  // drives frames). Both handles are tracked so a tick can cancel its
  // still-pending sibling and `cancel()` can clear the pair.
  let rafId: number | null = null;
  let timerId: number | null = null;
  let anchor: Anchor | null = null;
  // The last value the loop itself wrote via `advanceCursor`. The store
  // clamps, so the post-write `cursorNs` may differ (end-of-session),
  // but comparing to this pre-clamp value is enough to distinguish a
  // loop-originated change from an external scrub.
  let lastWritten: bigint | null = null;

  function capture(state: SessionState): void {
    anchor = { cursorNs: state.cursorNs, nowMs: now(), speed: state.speed };
    lastWritten = state.cursorNs;
  }

  // Arm both schedulers for the next tick. Whichever fires first runs
  // `tick`, which calls `disarm()` to cancel the loser before doing any
  // work — so the tick body runs exactly once per scheduling round.
  function arm(): void {
    if (rafId === null) rafId = raf(tick);
    if (timerId === null) timerId = setTimer(tick, FALLBACK_INTERVAL_MS);
  }

  // Cancel whichever of the rAF / timer pair is still pending.
  function disarm(): void {
    if (rafId !== null) {
      caf(rafId);
      rafId = null;
    }
    if (timerId !== null) {
      clearTimer(timerId);
      timerId = null;
    }
  }

  function cancel(): void {
    disarm();
  }

  function tick(): void {
    // Either rAF or the timer fired; cancel the still-pending sibling so
    // the tick body runs once, then re-arm both at the end. The tick is
    // absolute (computes `nextNs` from the fixed anchor + wall clock and
    // clamps), so even an extra firing could only yield a finer step,
    // never an overshoot — but cancelling avoids needless back-to-back
    // ticks.
    disarm();
    const a = anchor;
    if (!a) return;
    const state = store.getState();
    if (!state.playing) return;
    mark("tick:start");

    // Issue #2 — decode-aware gate. Hold the cursor whenever any bound
    // video panel reports "waiting" or "absent"; ignore stalled panels
    // (they have their own inline error UI and we must not deadlock on
    // them); and ignore bindings whose panel hasn't mounted yet — an
    // orphan binding from a previous layout, with no rAF loop running,
    // shouldn't gate the cursor forever. Once a panel mounts its rAF
    // tick will land an entry in the registry within one frame and the
    // gate engages naturally.
    const bound = boundVideoPanelIds(state);
    if (bound.length > 0) {
      const snaps = readiness();
      let allReady = true;
      for (let i = 0; i < bound.length; i++) {
        const r = snaps.get(bound[i]);
        // No registry entry = panel not mounted (orphan binding) →
        // ignore. Mount lifecycle: panel's first rAF tick adds the
        // entry, panel's cleanup `clearPanelReadiness` removes it.
        if (!r) continue;
        if (r.state === "waiting" || r.state === "absent") {
          allReady = false;
          break;
        }
        // "ready" → continue. "stalled"/"uncovered" → ignore for cursor
        // gating: a stalled panel has its own error UI, and an uncovered
        // panel simply has no frame at this time — neither should freeze
        // playback for the other panels (signals must keep rolling).
      }
      if (!allReady) {
        cursorGated = true;
        // Re-anchor BOTH the wall clock AND the cursor base to the live
        // store value. The anchor advances the cursor as `base + (now −
        // nowMs)·speed`, where `base` (`a.cursorNs`) is fixed across
        // ungated ticks for drift-free playback. If we only reset
        // `nowMs` here (keeping the stale `base` from play-start), the
        // next ungated tick computes `base + ~0` and snaps the cursor
        // all the way back to the play origin — the "camera jumps back
        // again and again" sawtooth that appears whenever the decoder
        // trips the gate *after* the cursor has already advanced (e.g.
        // a 4K stream under render load). Reading the live cursor as the
        // new base pins the hold at the cursor's real position so play
        // resumes forward from there. `state.cursorNs` is the most
        // recent value the loop wrote via `advanceCursor` (or an
        // external scrub the subscribe listener already re-captured).
        anchor = { cursorNs: state.cursorNs, nowMs: now(), speed: a.speed };
        lastWritten = state.cursorNs;
        mark("tick:gated");
        arm();
        return;
      }
    }
    cursorGated = false;

    const elapsedMs = now() - a.nowMs;
    const deltaNs = BigInt(Math.round(elapsedMs * 1e6 * a.speed));
    const nextNs = a.cursorNs + deltaNs;
    lastWritten = nextNs;
    // `advanceCursor` is the playback-only seam: same clamp + auto-pause
    // semantics as `setCursor`, but it does not bump `seekEpoch`. That
    // keeps the videoDecode pipeline from interpreting a 60 Hz playback
    // tick as a user scrub and tearing down the decoder on every frame.
    state.advanceCursor(nextNs);
    mark("tick:end");
    measure("tick", "tick:start", "tick:end");
    // advanceCursor may have clamped and auto-paused at end-of-session;
    // the subscribe listener will have already cleared `anchor` in that
    // case, so re-check before scheduling the next frame.
    if (store.getState().playing && anchor !== null) {
      arm();
    }
  }

  function schedule(): void {
    arm();
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.playing && !prev.playing) {
      capture(state);
      schedule();
      return;
    }
    if (!state.playing && prev.playing) {
      cancel();
      anchor = null;
      lastWritten = null;
      return;
    }
    if (!state.playing) return;

    if (state.speed !== prev.speed) {
      capture(state);
      return;
    }
    if (state.cursorNs !== prev.cursorNs && state.cursorNs !== lastWritten) {
      capture(state);
    }
  });

  // Initial sync: if the store is already playing when the loop is
  // wired up, seed the anchor and schedule immediately.
  const init = store.getState();
  if (init.playing) {
    capture(init);
    schedule();
  }

  return () => {
    unsubscribe();
    cancel();
    anchor = null;
    lastWritten = null;
  };
}
