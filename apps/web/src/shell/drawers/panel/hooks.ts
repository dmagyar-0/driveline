// Generic drawer hooks shared by the Panel drawer bodies.
//
// Two recurring shapes lived inline (and duplicated) in the former
// `PanelDrawer.tsx`:
//   - poll a `window.__driveline*` snapshot that React can't subscribe to,
//     diff by identity, and clean up the interval (`usePlotSyncSnapshot`,
//     `useDecoderCodec`);
//   - a controlled text/number draft synced to a store value, committed on
//     blur/Enter, re-seeded when the store changes out from under us
//     (`PlotChannelUnitInput`, `PlotGapThresholdControl`).
// Both are extracted here so the cadence (and the bug-prone re-seed/cleanup
// logic) lives in one place.

import { useEffect, useRef, useState } from "react";

/** Snapshot poll cadence. The drawer reflects rAF-published `window`
 *  snapshots (codec, plot sync) that React can't subscribe to; re-reading
 *  every 250 ms is cheap and well off the cursor/video hot path. */
export const SNAPSHOT_POLL_MS = 250;

/**
 * Poll a value that lives outside React state (e.g. a `window.__driveline*`
 * snapshot) on a fixed interval, returning a fresh reference only when the
 * read result's identity changes. `read` is called immediately on mount and
 * whenever a dependency in `deps` changes (so a cursor scrub can refresh the
 * "current" column without waiting for the next tick), then every
 * `intervalMs`.
 */
export function usePolledSnapshot<T>(
  read: () => T,
  deps: readonly unknown[],
  intervalMs: number = SNAPSHOT_POLL_MS,
): T {
  const readRef = useRef(read);
  readRef.current = read;
  const [snap, setSnap] = useState<T>(() => read());
  useEffect(() => {
    const tick = () => {
      const next = readRef.current();
      setSnap((prev) => (prev === next ? prev : next));
    };
    tick();
    const id = window.setInterval(tick, intervalMs);
    return () => window.clearInterval(id);
    // `read` is held in a ref so callers can pass an inline closure without
    // resetting the interval every render; `deps` lets the caller force a
    // re-read (e.g. on cursor change). intervalMs is effectively constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
  return snap;
}

/**
 * Controlled draft bound to a store value. Holds a local string draft so a
 * partially-typed value (e.g. "0.") doesn't churn the store on every
 * keystroke, re-seeds when the store value changes out from under us (reset,
 * restored layout), and commits via `commit` on blur/Enter. `format`
 * renders the store value into the draft; `parse` turns the draft into the
 * comparable value used for the re-seed guard and is passed to `commit`.
 */
export function useDraftField<T>(opts: {
  storeValue: T;
  format: (v: T) => string;
  commit: (draft: string) => void;
}): {
  draft: string;
  setDraft: (next: string) => void;
  commit: () => void;
  /** Re-seed the draft from an arbitrary string (e.g. after a reset). */
  reseed: (next: string) => void;
} {
  const { storeValue, format, commit } = opts;
  const [draft, setDraft] = useState<string>(() => format(storeValue));
  // Track the store value we last seeded from so an EXTERNAL change re-seeds
  // the draft, but the user's in-flight keystrokes don't get clobbered.
  const lastSeenRef = useRef<T>(storeValue);
  useEffect(() => {
    if (lastSeenRef.current !== storeValue) {
      lastSeenRef.current = storeValue;
      setDraft(format(storeValue));
    }
    // `format` is a stable inline closure over constant deps in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeValue]);

  return {
    draft,
    setDraft,
    commit: () => commit(draft),
    reseed: setDraft,
  };
}
