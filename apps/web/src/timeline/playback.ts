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

export interface PlaybackDeps {
  /** Wall-clock source in milliseconds. */
  now: () => number;
  /** Schedules `cb` for the next animation frame; returns a handle. */
  raf: (cb: FrameRequestCallback) => number;
  /** Cancels a previously-returned rAF handle. */
  caf: (id: number) => void;
}

type SessionStore = Pick<
  StoreApi<SessionState>,
  "getState" | "subscribe"
>;

function defaultDeps(): PlaybackDeps {
  return {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
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
  const { now, raf, caf } = { ...defaultDeps(), ...deps };

  let rafId: number | null = null;
  let anchor: Anchor | null = null;
  // The last value the loop itself wrote via `setCursor`. The store
  // clamps, so the post-write `cursorNs` may differ (end-of-session),
  // but comparing to this pre-clamp value is enough to distinguish a
  // loop-originated change from an external scrub.
  let lastWritten: bigint | null = null;

  function capture(state: SessionState): void {
    anchor = { cursorNs: state.cursorNs, nowMs: now(), speed: state.speed };
    lastWritten = state.cursorNs;
  }

  function cancel(): void {
    if (rafId !== null) {
      caf(rafId);
      rafId = null;
    }
  }

  function tick(): void {
    rafId = null;
    const a = anchor;
    if (!a) return;
    const state = store.getState();
    if (!state.playing) return;
    const elapsedMs = now() - a.nowMs;
    const deltaNs = BigInt(Math.round(elapsedMs * 1e6 * a.speed));
    const nextNs = a.cursorNs + deltaNs;
    lastWritten = nextNs;
    state.setCursor(nextNs);
    // setCursor may have clamped and auto-paused at end-of-session; the
    // subscribe listener will have already cleared `anchor` in that
    // case, so re-check before scheduling the next frame.
    if (store.getState().playing && anchor !== null) {
      rafId = raf(tick);
    }
  }

  function schedule(): void {
    if (rafId === null) {
      rafId = raf(tick);
    }
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
    if (
      state.cursorNs !== prev.cursorNs &&
      state.cursorNs !== lastWritten
    ) {
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
