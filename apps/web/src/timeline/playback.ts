// Playback loop. rAF-driven advance of `cursorNs` while `playing`;
// anchored against `performance.now()` so drift is bounded by clock
// precision rather than accumulated frame deltas.
//
// Plain module (not a React hook) so the tick logic is testable
// under the `environment: "node"` vitest setup without jsdom.
//
// Pure consumer of the state machine — clamp + end-of-session
// auto-pause invariants live in `state/store.ts`.

import type { StoreApi } from "zustand";
import type { SessionState } from "../state/store";
import { mark, measure } from "../perf";
import {
  getReadinessSnapshot as defaultGetReadinessSnapshot,
  type PanelReadiness,
} from "../panels/videoReadiness";

// Cursor gating signal. Mirrors the constant in `panels/VideoPanel.tsx`;
// both consult their own copy so neither has to import across the
// panels/timeline seam to compare two bigints.
//
// ε = 100 ms (~3 frames at 30 fps) keeps the gate from flapping when
// a single rAF tick lands between decode + blit.
export const READY_EPSILON_NS = 100_000_000n;

/** Flag readable by Playwright via `getCursorGated`. Module-scope so
 *  the rAF loop can write it without routing through React state.
 *
 *  Singleton: only one playback loop may run against this module at
 *  a time — concurrent callers would race. Production mounts exactly
 *  one loop from `<App />`. */
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
  /** Readiness map source. Defaults to the live registry; unit tests
   *  inject a Map so the gate can be exercised without a VideoPanel. */
  readiness: () => Map<string, PanelReadiness>;
  /** Bound video panel ids. Defaults to reading `videoBindings` off
   *  the store; unit tests pass a closure to drive the gate directly. */
  boundVideoPanelIds: (state: SessionState) => string[];
}

type SessionStore = Pick<
  StoreApi<SessionState>,
  "getState" | "subscribe"
>;

function defaultBoundVideoPanelIds(state: SessionState): string[] {
  // A panel is "bound" iff its entry exists and is non-null.
  const out: string[] = [];
  const b = state.videoBindings;
  for (const k in b) {
    if (b[k]) out.push(k);
  }
  return out;
}

function defaultDeps(): PlaybackDeps {
  return {
    now: () => performance.now(),
    raf: (cb) => requestAnimationFrame(cb),
    caf: (id) => cancelAnimationFrame(id),
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
  const { now, raf, caf, readiness, boundVideoPanelIds } = {
    ...defaultDeps(),
    ...deps,
  };

  let rafId: number | null = null;
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
    mark("tick:start");

    // Decode-aware gate. Hold the cursor whenever any bound video
    // panel is "waiting" or "absent"; ignore stalled panels (they
    // have their own inline error UI and we must not deadlock on
    // them); ignore bindings whose panel hasn't mounted yet (orphan
    // bindings from a previous layout would gate forever).
    const bound = boundVideoPanelIds(state);
    if (bound.length > 0) {
      const snaps = readiness();
      let allReady = true;
      for (let i = 0; i < bound.length; i++) {
        const r = snaps.get(bound[i]);
        // No registry entry = panel not mounted (orphan binding) →
        // ignore. The panel's first rAF tick adds the entry on mount.
        if (!r) continue;
        if (r.state === "waiting" || r.state === "absent") {
          allReady = false;
          break;
        }
        // "stalled" → ignore for cursor gating.
      }
      if (!allReady) {
        cursorGated = true;
        anchor = { ...a, nowMs: now() };
        mark("tick:gated");
        rafId = raf(tick);
        return;
      }
    }
    cursorGated = false;

    const elapsedMs = now() - a.nowMs;
    const deltaNs = BigInt(Math.round(elapsedMs * 1e6 * a.speed));
    const nextNs = a.cursorNs + deltaNs;
    lastWritten = nextNs;
    // `advanceCursor` is the playback-only seam: same clamp +
    // auto-pause as `setCursor`, but does NOT bump `seekEpoch`. That
    // prevents the videoDecode pipeline from treating a 60 Hz tick as
    // a user scrub and tearing down the decoder every frame.
    state.advanceCursor(nextNs);
    mark("tick:end");
    measure("tick", "tick:start", "tick:end");
    // advanceCursor may have auto-paused at end-of-session; the
    // subscribe listener clears `anchor` in that case, so re-check
    // before scheduling.
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

  // If the store is already playing at wire-up, seed the anchor and
  // schedule immediately.
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
