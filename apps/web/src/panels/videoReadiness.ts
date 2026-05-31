// Per-panel video decode readiness registry. Issue #2.
//
// Lives outside Zustand on purpose. The rAF blit loop in `VideoPanel`
// writes a snapshot at 60 Hz; routing those writes through the store
// would force `useSession` selectors to re-render at 60 Hz too. Keeping
// this as a plain module-scope singleton lets the playback rAF loop
// poll readiness in O(panels) per tick with zero React work, while the
// Transport's `useDecodeWaiting` subscriber coalesces hysteresis
// transitions into the React commit phase.
//
// Hot-path writes reuse a per-panel scratch object, so the `tick`
// allocation budget here is a single Map.set per panel per frame.

// "uncovered": the cursor is outside this source's time coverage, so there
// is no frame to wait for. Non-gating for playback (like "stalled"), but it
// is NOT an error — the panel shows an informational "no video at this time"
// pill rather than the red stalled/retry badge.
export type ReadyState =
  | "ready"
  | "waiting"
  | "stalled"
  | "uncovered"
  | "absent";

export interface PanelReadiness {
  state: ReadyState;
  /** `performance.now()` of the most recent tick that produced a
   *  ready signal. Useful for hysteresis math in Transport. */
  lastReadyMs: number;
  /** `performance.now()` of the tick that flipped the panel into
   *  `"waiting"`. Cleared (set to null) any time the state is not
   *  `"waiting"` so the Transport can compute "have we been waiting
   *  long enough to show the dot" without holding its own clock. */
  waitingSinceMs: number | null;
  /** Mirrors `VideoPanel.lastBlitPtsRef.current` at the tick that
   *  produced this snapshot. Exposed so the dev hook + tests can
   *  reason about the underlying signal without poking refs. */
  lastBlitPtsNs: bigint | null;
}

const registry = new Map<string, PanelReadiness>();
const listeners = new Set<() => void>();

/** Schedule a coalesced notify so 60 Hz panel writes don't fire a
 *  storm of subscriber callbacks. Falls back to setTimeout in
 *  environments without rAF (jsdom, vitest node). */
let pendingNotify = false;
function scheduleNotify(): void {
  if (pendingNotify) return;
  pendingNotify = true;
  const flush = () => {
    pendingNotify = false;
    for (const l of listeners) {
      try {
        l();
      } catch (err) {
        // Subscriber bugs shouldn't break the registry — but log so
        // a regression that swallows readiness updates is visible in
        // field telemetry instead of producing a silent "stuck dot".
        console.warn("videoReadiness: subscriber threw", err);
      }
    }
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

/** Write the latest readiness for a panel. Called by `VideoPanel`'s
 *  rAF blit loop once per frame. The registry stores its own copy of
 *  the snapshot so callers can reuse a per-panel scratch object on
 *  the hot path without colliding with state-change detection. */
export function setPanelReadiness(
  panelId: string,
  snap: PanelReadiness,
): void {
  const prev = registry.get(panelId);
  if (prev) {
    // State transition is the only thing the Transport cares about
    // (it derives hysteresis from `waitingSinceMs`); the underlying
    // numbers update every tick. We always notify on a state flip,
    // and otherwise let `scheduleNotify`'s rAF coalescing decide.
    //
    // Capture the previous state in a local *before* mutating, so the
    // detection works correctly even when `snap === prev` (which
    // happens whenever the caller — e.g. `VideoPanel`'s rAF blit loop
    // — passes its own scratch object back in). Without this, the
    // `prev.state !== snap.state` compare would always be false on
    // the second-and-later writes for a given panel.
    const prevState = prev.state;
    prev.state = snap.state;
    prev.lastReadyMs = snap.lastReadyMs;
    prev.waitingSinceMs = snap.waitingSinceMs;
    prev.lastBlitPtsNs = snap.lastBlitPtsNs;
    if (prevState !== snap.state) scheduleNotify();
    return;
  }
  // First write for this panel — copy out so subsequent caller
  // mutations don't silently rewrite the registry entry without going
  // through this function (and therefore without firing the change
  // notification).
  registry.set(panelId, {
    state: snap.state,
    lastReadyMs: snap.lastReadyMs,
    waitingSinceMs: snap.waitingSinceMs,
    lastBlitPtsNs: snap.lastBlitPtsNs,
  });
  scheduleNotify();
}

/** Read the live registry. The map reference is stable across calls;
 *  callers must treat it as read-only. */
export function getReadinessSnapshot(): Map<string, PanelReadiness> {
  return registry;
}

/** Subscribe to coalesced (rAF-batched) state-change notifications.
 *  Returns an unsubscribe function. */
export function subscribeReadiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop a panel from the registry (called from `VideoPanel`'s
 *  cleanup). Notifies subscribers so the Transport doesn't keep a
 *  stale "waiting" view of an unmounted panel. */
export function clearPanelReadiness(panelId: string): void {
  if (!registry.delete(panelId)) return;
  scheduleNotify();
}

/** Test seam: drop every panel. Not exposed in production code. */
export function __resetReadinessForTests(): void {
  registry.clear();
  listeners.clear();
  pendingNotify = false;
}
