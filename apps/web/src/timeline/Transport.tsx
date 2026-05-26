// T3.2 · Timeline UI (scrubber). Bottom-anchored transport bar that drives
// the T3.1 state machine through the existing `useSession` actions — all
// clamping, end-of-session auto-pause, and speed bounds live in the store
// (see `state/store.ts:170-201`).
//
// UX overhaul (Agent B, issues #6-9):
//
//   #6 — Segmented relative/absolute control wired to a single
//        `state.timeMode`. PlotPanel + every other readout consume the
//        same flag so the entire app shows one convention.
//   #7 — Per-source segment ticks rendered on the scrubber strip so the
//        viewer can see "segment 4 / 7 / 10 starts here" on multi-source
//        comma2k19 sessions. Source ranges already live in
//        `session.sources` — no new ingest path.
//   #8 — Promoted readout: large mono `HH:MM:SS.mmm / total`, with
//        labelled SPEED + TIME mode controls.
//   #9 — Real scrubber: 8 px track that grows to 10 px on hover, real
//        12-14 px grab handle. A `transport:scrub` perf mark bounds the
//        pointer-move work so the existing perfBudgets spec catches a
//        regression past one RAF.

import { useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { TimeRange } from "../state/store";
import {
  formatAbsolute,
  formatAbsoluteClock,
  formatDate,
  formatDuration,
  formatRelative,
} from "./formatTime";
import { BookmarkMarkers } from "./BookmarkMarkers";
import { mark, measure } from "../perf";
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
  const sources = useSession((s) => s.sources);
  const timeMode = useSession((s) => s.timeMode);
  const decodeWaiting = useDecodeWaiting();

  const disabled = globalRange === null;

  const trackRef = useRef<HTMLDivElement | null>(null);
  const pendingNs = useRef<bigint | null>(null);
  const rafId = useRef<number | null>(null);

  const flushPending = () => {
    if (pendingNs.current !== null) {
      useSession.getState().setCursor(pendingNs.current);
      pendingNs.current = null;
    }
    rafId.current = null;
    // Issue #9 — perf budget mark closes the frame, paired with the
    // `transport:scrub:start` mark scheduled below. The end-to-end
    // budget spec asserts this stays ≤1 RAF.
    mark("transport:scrub:flush");
    measure("transport:scrub", "transport:scrub:start", "transport:scrub:flush");
  };

  const scheduleCommit = (ns: bigint) => {
    pendingNs.current = ns;
    if (rafId.current === null) {
      mark("transport:scrub:start");
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

  const setTimeMode = (mode: "relative" | "absolute") => {
    useSession.getState().setTimeMode(mode);
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

  // Issue #7 — segment markers. One tick per source's leading edge
  // (excluding the first, which would visually merge with the bar's
  // left rounding) plus a faint band so a gap between sources reads
  // as "segment boundary", not just a buffered gap. Sources already
  // carry `timeRange` so we don't invent a new ingest path.
  type SegmentEntry = {
    key: string;
    label: string;
    leftPct: number;
    widthPct: number;
    title: string;
  };
  const segmentEntries: SegmentEntry[] = [];
  if (globalRange && sources.length > 1) {
    const ordered = [...sources].sort((a, b) => {
      const da = a.timeRange.startNs - b.timeRange.startNs;
      return da === 0n ? 0 : da < 0n ? -1 : 1;
    });
    for (let i = 0; i < ordered.length; i++) {
      const src = ordered[i];
      const left = percentOf(src.timeRange.startNs, globalRange);
      const right = percentOf(src.timeRange.endNs, globalRange);
      const width = Math.max(0, right - left);
      const offsetNs = src.timeRange.startNs - globalRange.startNs;
      segmentEntries.push({
        key: `seg:${src.id}:${i}`,
        label: `${i + 1}`,
        leftPct: left,
        widthPct: width,
        title:
          `Segment ${i + 1} · ${src.name} · ` +
          `${formatRelative(src.timeRange.startNs, globalRange.startNs)} → ` +
          `${formatRelative(src.timeRange.endNs, globalRange.startNs)}` +
          (offsetNs > 0n ? "" : ""),
      });
    }
  }

  const span = globalRange ? globalRange.endNs - globalRange.startNs : 0n;
  // In absolute mode "/ total" reads more naturally as the session's
  // wall-clock end time than as elapsed duration ("06:04:00 / 06:09:00"
  // vs the off-key "06:04:00 / 00:05:00.000").
  const total = !globalRange
    ? "--:--.---"
    : timeMode === "relative"
      ? formatDuration(span)
      : formatAbsoluteClock(globalRange.endNs);
  const current = globalRange
    ? timeMode === "relative"
      ? formatRelative(cursorNs, globalRange.startNs)
      : formatAbsoluteClock(cursorNs)
    : "--:--.---";
  const subLabel = globalRange
    ? timeMode === "relative"
      ? formatAbsolute(globalRange.startNs)
      : formatDate(globalRange.startNs)
    : null;
  const startLabel = globalRange
    ? timeMode === "relative"
      ? formatRelative(globalRange.startNs, globalRange.startNs)
      : formatAbsoluteClock(globalRange.startNs)
    : "--:--";
  const endLabel = globalRange
    ? timeMode === "relative"
      ? formatDuration(globalRange.endNs - globalRange.startNs)
      : formatAbsoluteClock(globalRange.endNs)
    : "--:--";
  const readoutLabel = timeMode === "relative" ? "Elapsed / Total" : "Wall clock";
  const ariaValueText = globalRange
    ? timeMode === "relative"
      ? formatRelative(cursorNs, globalRange.startNs)
      : formatAbsolute(cursorNs)
    : "none";

  return (
    <div
      className={styles.bar}
      data-testid="transport"
      aria-disabled={disabled}
    >
      {/* Scrubber row — full width above the controls so the heartbeat
       *  of the app is the dominant element, not buried bottom-left.   */}
      <div className={styles.scrubRow}>
        <div
          ref={trackRef}
          className={`${styles.track} ${disabled ? styles.disabled : ""}`}
          data-testid="scrubber"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-valuemin={globalRange ? Number(globalRange.startNs) : 0}
          aria-valuemax={globalRange ? Number(globalRange.endNs) : 0}
          aria-valuenow={Number(cursorNs)}
          aria-valuetext={ariaValueText}
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
            {segmentEntries.length > 0 && (
              <div
                className={styles.segmentTicks}
                data-testid="transport-segments"
                aria-hidden
              >
                {segmentEntries.map((seg, i) => (
                  <span
                    key={seg.key}
                    className={styles.segmentTick}
                    data-segment-index={i}
                    style={{ left: `${seg.leftPct}%` }}
                    title={seg.title}
                  />
                ))}
              </div>
            )}
            <div
              className={styles.trackFill}
              style={{ width: `${fillPct}%` }}
            />
            <BookmarkMarkers />
            <div className={styles.thumbHit} style={{ left: `${fillPct}%` }}>
              <div
                className={
                  decodeWaiting
                    ? `${styles.thumb} ${styles.thumbWaiting}`
                    : styles.thumb
                }
                data-testid="scrubber-thumb"
              />
            </div>
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
        <div className={styles.scrubRowLabels} aria-hidden>
          <span>{startLabel}</span>
          {sources.length > 1 ? (
            <span
              className={styles.scrubDateBadge}
              data-testid="transport-segment-count"
            >
              {sources.length} segments
            </span>
          ) : (
            <span />
          )}
          <span>{endLabel}</span>
        </div>
      </div>

      {/* Controls row — play group + big readout + speed + time-mode */}
      <div className={styles.row}>
        <div className={styles.transportGroup}>
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

          <div
            className={styles.readoutBlock}
            data-testid="transport-readout-block"
          >
            <span className={styles.readoutLabel}>{readoutLabel}</span>
            <span
              className={styles.readoutTimes}
              data-testid="transport-readout"
              aria-live="off"
            >
              <span className={styles.readoutCurrent}>{current}</span>
              <span className={styles.readoutSep}>/</span>
              <span className={styles.readoutTotal}>{total}</span>
            </span>
            {subLabel && (
              <span
                className={styles.readoutSubLabel}
                data-testid="transport-readout-sub"
              >
                {timeMode === "relative" ? "starts " : ""}
                {subLabel}
              </span>
            )}
          </div>
        </div>

        <div className={styles.rowGrow} />

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="transport-time-mode">
            Time
          </label>
          <div
            id="transport-time-mode"
            className={styles.segmented}
            data-testid="transport-mode-group"
            role="group"
            aria-label="Time readout mode"
          >
            <button
              type="button"
              className={styles.segBtn}
              data-testid="transport-mode-relative"
              aria-pressed={timeMode === "relative"}
              disabled={disabled}
              onClick={() => setTimeMode("relative")}
              title="Show times relative to session start (00:12.345)"
            >
              Relative
            </button>
            <button
              type="button"
              className={styles.segBtn}
              data-testid="transport-mode-absolute"
              aria-pressed={timeMode === "absolute"}
              disabled={disabled}
              onClick={() => setTimeMode("absolute")}
              title="Show wall-clock times (06:08:42)"
            >
              Absolute
            </button>
          </div>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor="transport-speed">
            Speed
          </label>
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
      </div>
    </div>
  );
}
