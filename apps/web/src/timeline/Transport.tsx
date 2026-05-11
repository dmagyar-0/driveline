// T3.2 · Timeline UI (scrubber). Bottom-anchored transport bar that drives
// the T3.1 state machine through the existing `useSession` actions — all
// clamping, end-of-session auto-pause, and speed bounds live in the store
// (see `state/store.ts:170-201`).

import { useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { TimeRange } from "../state/store";
import { formatAbsolute, formatDuration, formatRelative } from "./formatTime";
import { BookmarkMarkers } from "./BookmarkMarkers";
import {
  getReadinessSnapshot,
  subscribeReadiness,
  type ReadyState,
} from "../panels/videoReadiness";
import styles from "./Transport.module.css";

// Issue #2 — hysteresis for the decode-waiting dot. Plan §3 numbers:
// don't show the dot for short waits (which happen on every tiny
// scrub), and once shown keep it visible for a brief minimum so a
// fast-flickering ready/waiting flap doesn't strobe.
const WAITING_VISIBLE_DELAY_MS = 250;
const WAITING_MIN_VISIBLE_MS = 400;
// Array (not equality) so adding states later is a one-line change.
// "stalled" is deliberately excluded — see `anyPanelWaiting` JSDoc.
const STATES_THAT_SHOW_DOT: readonly ReadyState[] = ["waiting"];

/** Returns true when at least one panel in the registry is in a
 *  state that should drive the loading affordance. "stalled" panels
 *  intentionally do NOT trigger the dot — they have their own
 *  inline error UI inside the VideoPanel. */
function anyPanelWaiting(): boolean {
  for (const r of getReadinessSnapshot().values()) {
    if (STATES_THAT_SHOW_DOT.includes(r.state)) return true;
  }
  return false;
}

/** Issue #2 — drives the "decode-waiting" dot. Subscribes to the
 *  readiness registry (coalesced to rAF) and applies plan §3
 *  hysteresis so the dot ignores sub-250 ms blips and stays visible
 *  for at least 400 ms once shown. The hook re-renders the Transport
 *  only on hysteresis transitions, never per rAF frame. */
function useDecodeWaiting(): boolean {
  const [visible, setVisible] = useState(false);
  // Refs hold the timers so unrelated parent re-renders don't tear
  // them down — the dot must persist across rerenders triggered by
  // unrelated store slices (cursorNs, loadedRanges, …).
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(false);
  const shownAtMsRef = useRef<number>(0);
  visibleRef.current = visible;

  useEffect(() => {
    const clearShow = () => {
      if (showTimerRef.current !== null) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    };
    const clearHide = () => {
      if (hideTimerRef.current !== null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const evaluate = () => {
      const wantsDot = anyPanelWaiting();
      if (wantsDot) {
        // Cancel any pending hide; we still want to be visible.
        clearHide();
        if (visibleRef.current || showTimerRef.current !== null) return;
        showTimerRef.current = setTimeout(() => {
          showTimerRef.current = null;
          shownAtMsRef.current = performance.now();
          setVisible(true);
        }, WAITING_VISIBLE_DELAY_MS);
      } else {
        clearShow();
        if (!visibleRef.current || hideTimerRef.current !== null) return;
        const elapsed = performance.now() - shownAtMsRef.current;
        const remaining = Math.max(0, WAITING_MIN_VISIBLE_MS - elapsed);
        hideTimerRef.current = setTimeout(() => {
          hideTimerRef.current = null;
          // Re-check: if a new wait started while the hide timer was
          // pending, keep the dot visible.
          if (anyPanelWaiting()) {
            shownAtMsRef.current = performance.now();
            setVisible(true);
          } else {
            setVisible(false);
          }
        }, remaining);
      }
    };

    // Initial evaluation, then subscribe to coalesced state-change
    // notifications. The registry's notify is rAF-batched, so this
    // does not fire 60 times per second.
    evaluate();
    const unsub = subscribeReadiness(evaluate);
    return () => {
      unsub();
      clearShow();
      clearHide();
    };
  }, []);

  return visible;
}

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4] as const;
const ONE_SEC_NS = 1_000_000_000n;

// Ratio → ns, clamped to `[0, 1]` before mapping across the range.
function nsFromRatio(ratio: number, range: TimeRange): bigint {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  const span = range.endNs - range.startNs;
  // Sessions above ~104 days would exceed Number.MAX_SAFE_INTEGER on
  // `span`; acceptable for MVP, the reader corpus is seconds-to-minutes.
  return range.startNs + BigInt(Math.round(r * Number(span)));
}

function percentOf(cursorNs: bigint, range: TimeRange): number {
  const span = range.endNs - range.startNs;
  if (span === 0n) return 0;
  const off = cursorNs - range.startNs;
  return (Number(off) / Number(span)) * 100;
}

export function Transport() {
  const cursorNs = useSession((s) => s.cursorNs);
  const playing = useSession((s) => s.playing);
  const speed = useSession((s) => s.speed);
  const globalRange = useSession((s) => s.globalRange);
  const loadedRanges = useSession((s) => s.loadedRanges);
  const pendingFetch = useSession((s) => s.pendingFetch);
  const decodeWaiting = useDecodeWaiting();

  const disabled = globalRange === null;
  const [mode, setMode] = useState<"relative" | "absolute">("relative");

  const trackRef = useRef<HTMLDivElement | null>(null);
  const pendingNs = useRef<bigint | null>(null);
  const rafId = useRef<number | null>(null);

  const flushPending = () => {
    if (pendingNs.current !== null) {
      useSession.getState().setCursor(pendingNs.current);
      pendingNs.current = null;
    }
    rafId.current = null;
  };

  const scheduleCommit = (ns: bigint) => {
    pendingNs.current = ns;
    if (rafId.current === null) {
      rafId.current = requestAnimationFrame(flushPending);
    }
  };

  const ratioFromEvent = (e: PointerEvent | React.PointerEvent): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return (e.clientX - rect.left) / rect.width;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !globalRange) return;
    const track = trackRef.current;
    if (!track) return;
    track.setPointerCapture(e.pointerId);
    scheduleCommit(nsFromRatio(ratioFromEvent(e), globalRange));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !globalRange) return;
    const track = trackRef.current;
    if (!track || !track.hasPointerCapture(e.pointerId)) return;
    scheduleCommit(nsFromRatio(ratioFromEvent(e), globalRange));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (track && track.hasPointerCapture(e.pointerId)) {
      track.releasePointerCapture(e.pointerId);
    }
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    flushPending();
  };

  // Cancel any in-flight rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, []);

  // Global keyboard shortcuts per `docs/06-ui-and-panels.md:156-157`.
  // ArrowLeft / ArrowRight step the cursor by ±1 s; the store's
  // setCursor clamps to [startNs, endNs].
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const store = useSession.getState();
      const range = store.globalRange;
      if (!range) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (store.playing) store.pause();
        else store.play();
      } else if (e.code === "Home") {
        e.preventDefault();
        store.setCursor(range.startNs);
      } else if (e.code === "End") {
        e.preventDefault();
        store.setCursor(range.endNs);
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        store.setCursor(store.cursorNs - ONE_SEC_NS);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        store.setCursor(store.cursorNs + ONE_SEC_NS);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPlayPause = () => {
    if (disabled) return;
    const store = useSession.getState();
    if (store.playing) store.pause();
    else store.play();
  };

  const stepBy = (deltaNs: bigint) => {
    if (disabled) return;
    const store = useSession.getState();
    if (!store.globalRange) return;
    store.setCursor(store.cursorNs + deltaNs);
  };
  const onPrev1s = () => stepBy(-ONE_SEC_NS);
  const onNext1s = () => stepBy(ONE_SEC_NS);

  const onSpeedChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    useSession.getState().setSpeed(Number(e.target.value));
  };

  const onModeToggle = () => {
    setMode((m) => (m === "relative" ? "absolute" : "relative"));
  };

  const fillPct = globalRange ? percentOf(cursorNs, globalRange) : 0;
  const isFetching = Object.values(pendingFetch).some((p) => p !== null);
  const bufferedSegments: Array<{ key: string; left: number; width: number }> =
    [];
  if (globalRange) {
    for (const [sid, ranges] of Object.entries(loadedRanges)) {
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        const left = percentOf(r.startNs, globalRange);
        const right = percentOf(r.endNs, globalRange);
        const width = Math.max(0, right - left);
        if (width <= 0) continue;
        bufferedSegments.push({
          key: `${sid}:${i}`,
          left,
          width,
        });
      }
    }
  }
  const readout = globalRange
    ? mode === "relative"
      ? `${formatRelative(cursorNs, globalRange.startNs)} / ${formatDuration(
          globalRange.endNs - globalRange.startNs,
        )}`
      : formatAbsolute(cursorNs)
    : "--:--.---";
  const startLabel = globalRange
    ? formatRelative(globalRange.startNs, globalRange.startNs)
    : "--:--.---";
  const endLabel = globalRange
    ? formatDuration(globalRange.endNs - globalRange.startNs)
    : "--:--.---";

  return (
    <div
      className={styles.bar}
      data-testid="transport"
      aria-disabled={disabled}
    >
      <div className={styles.row}>
        <div className={styles.btnGroup}>
          <button
            type="button"
            className={styles.btnT}
            data-testid="transport-prev-1s"
            aria-label="Step back 1 second"
            onClick={onPrev1s}
            disabled={disabled}
            title="Step back 1 s"
          >
            ◀◀
          </button>
          <button
            type="button"
            className={`${styles.btnT} ${styles.play}`}
            data-testid="play-pause"
            aria-label={playing ? "Pause" : "Play"}
            aria-pressed={playing}
            onClick={onPlayPause}
            disabled={disabled}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            className={styles.btnT}
            data-testid="transport-next-1s"
            aria-label="Step forward 1 second"
            onClick={onNext1s}
            disabled={disabled}
            title="Step forward 1 s"
          >
            ▶▶
          </button>
          {/* Issue #2 — decode-waiting dot. Pulses when at least one
           *  bound video panel has been "waiting" continuously for
           *  ≥ 250 ms (hysteresis-managed in `useDecodeWaiting`).
           *  Stalled panels surface their own per-panel error badge
           *  instead, so they don't trigger this. */}
          {decodeWaiting && (
            <span
              className={styles.decodeWaitingDot}
              data-testid="transport-decode-waiting"
              role="status"
              aria-label="Waiting for video decode"
              title="Waiting for video decode"
            />
          )}
        </div>
        <span className={styles.time}>{startLabel}</span>
        <div
          ref={trackRef}
          className={`${styles.track} ${disabled ? styles.disabled : ""}`}
          data-testid="scrubber"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={globalRange ? Number(globalRange.startNs) : 0}
          aria-valuemax={globalRange ? Number(globalRange.endNs) : 0}
          aria-valuenow={Number(cursorNs)}
          aria-valuetext={
            globalRange ? formatRelative(cursorNs, globalRange.startNs) : "none"
          }
          aria-disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className={styles.trackStrip}>
            {bufferedSegments.length > 0 && (
              <div
                className={styles.bufferedSegments}
                data-testid="transport-buffered"
              >
                {bufferedSegments.map((seg) => (
                  <div
                    key={seg.key}
                    className={styles.bufferedSegment}
                    style={{
                      left: `${seg.left}%`,
                      width: `${seg.width}%`,
                    }}
                  />
                ))}
              </div>
            )}
            <div
              className={styles.trackFill}
              style={{ width: `${fillPct}%` }}
            />
            <BookmarkMarkers />
            <div
              className={
                decodeWaiting
                  ? `${styles.thumb} ${styles.thumbWaiting}`
                  : styles.thumb
              }
              data-testid="scrubber-thumb"
              style={{ left: `${fillPct}%` }}
            />
            {isFetching && (
              <div
                className={styles.fetchSpinner}
                data-testid="transport-fetch-spinner"
                style={{ left: `${fillPct}%` }}
                aria-hidden
              />
            )}
          </div>
        </div>
        <span className={styles.time}>{endLabel}</span>
        <select
          id="transport-speed"
          className={styles.speed}
          data-testid="transport-speed"
          value={speed}
          onChange={onSpeedChange}
          disabled={disabled}
          aria-label="Playback speed"
        >
          {SPEED_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </div>
      <div className={styles.metaRow}>
        <span
          className={styles.readout}
          data-testid="transport-readout"
          aria-live="off"
        >
          {readout}
        </span>
        <button
          type="button"
          className={styles.modeButton}
          data-testid="transport-mode"
          onClick={onModeToggle}
          disabled={disabled}
          title="Toggle absolute / relative time readout"
        >
          {mode === "relative" ? "relative" : "absolute"}
        </button>
      </div>
    </div>
  );
}
