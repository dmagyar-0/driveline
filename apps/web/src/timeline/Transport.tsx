// T3.2 · Timeline UI (scrubber). Bottom-anchored transport bar that drives
// the T3.1 state machine through the existing `useSession` actions — all
// clamping, end-of-session auto-pause, and speed bounds live in the store
// (see `state/store.ts:170-201`).

import { useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { TimeRange } from "../state/store";
import { formatAbsolute, formatDuration, formatRelative } from "./formatTime";
import { BookmarkMarkers } from "./BookmarkMarkers";
import styles from "./Transport.module.css";

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
              className={styles.thumb}
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
