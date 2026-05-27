// Timeline UI (scrubber). Bottom-anchored transport bar that drives
// the state machine through `useSession` actions — clamping,
// end-of-session auto-pause, and speed bounds live in the store.
//
// The `transport:scrub` perf mark bounds the pointer-move work so the
// perfBudgets spec catches a regression past one RAF.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { TimeRange } from "../state/store";
import {
  formatAbsolute,
  formatAbsoluteClock,
  formatDate,
  formatDuration,
  formatPlayheadPrimary,
  formatRelative,
} from "./formatTime";
import { BookmarkMarkers } from "./BookmarkMarkers";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { mark, measure } from "../perf";
import {
  getReadinessSnapshot,
  subscribeReadiness,
  type ReadyState,
} from "../panels/videoReadiness";
import styles from "./Transport.module.css";

// Hysteresis for the decode-waiting dot. Don't show for sub-250 ms
// waits (every tiny scrub) and once shown keep visible ≥400 ms so a
// fast ready/waiting flap doesn't strobe.
const WAITING_VISIBLE_DELAY_MS = 250;
const WAITING_MIN_VISIBLE_MS = 400;
// "stalled" is deliberately excluded — see `anyPanelWaiting` JSDoc.
const STATES_THAT_SHOW_DOT: readonly ReadyState[] = ["waiting"];

/** True when at least one panel in the registry is in a state that
 *  should drive the loading affordance. "stalled" panels intentionally
 *  do NOT trigger the dot — they have their own inline error UI inside
 *  the VideoPanel. */
function anyPanelWaiting(): boolean {
  for (const r of getReadinessSnapshot().values()) {
    if (STATES_THAT_SHOW_DOT.includes(r.state)) return true;
  }
  return false;
}

/** Drives the "decode-waiting" dot. Subscribes to the readiness
 *  registry (coalesced to rAF) and applies hysteresis so the dot
 *  ignores sub-250 ms blips and stays visible for at least 400 ms
 *  once shown. Re-renders the Transport only on hysteresis
 *  transitions, never per rAF frame. */
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

    // The registry's notify is rAF-batched, so this doesn't fire 60×/s.
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

  // Hover tooltip state. `hoverPct` drives the ghost line (and the
  // tooltip's `left`); `hoverLabel` carries the formatted preview.
  // Boundary detection runs in `labelForHover` and returns either
  // "Segment N start"/"…end" near a tick, or the time otherwise.
  // Updates are rAF-batched via a shared scheduler so the cursor hot
  // path stays within budget.
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string>("");
  const hoverRafId = useRef<number | null>(null);
  const pendingHover = useRef<{
    pct: number;
    label: string;
  } | null>(null);

  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const flushPending = () => {
    if (pendingNs.current !== null) {
      useSession.getState().setCursor(pendingNs.current);
      pendingNs.current = null;
    }
    rafId.current = null;
    // Paired with `transport:scrub:start` below — the perf budget spec
    // asserts the round trip stays ≤1 RAF.
    mark("transport:scrub:flush");
    measure(
      "transport:scrub",
      "transport:scrub:start",
      "transport:scrub:flush",
    );
  };

  const scheduleCommit = (ns: bigint) => {
    pendingNs.current = ns;
    if (rafId.current === null) {
      mark("transport:scrub:start");
      rafId.current = requestAnimationFrame(flushPending);
    }
  };

  const flushHover = () => {
    if (pendingHover.current !== null) {
      setHoverPct(pendingHover.current.pct);
      setHoverLabel(pendingHover.current.label);
      pendingHover.current = null;
    }
    hoverRafId.current = null;
  };

  const scheduleHover = (pct: number, label: string) => {
    pendingHover.current = { pct, label };
    if (hoverRafId.current === null) {
      hoverRafId.current = requestAnimationFrame(flushHover);
    }
  };

  const ratioFromEvent = (e: PointerEvent | React.PointerEvent): number => {
    const track = trackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return (e.clientX - rect.left) / rect.width;
  };

  // When the pointer is within `BOUNDARY_SNAP_PCT` of a segment
  // boundary, return "Segment N start" / "Segment N end" so the
  // tick mark is self-explanatory. Otherwise return the canonical
  // playhead time. 0.4 % of track width ≈ 5 px at 1280 px so users
  // discover the boundary label without having to hit the 2 px tick.
  const BOUNDARY_SNAP_PCT = 0.4;
  const labelForHover = (ratio: number): string => {
    if (!globalRange) return "--:--.---";
    const span = globalRange.endNs - globalRange.startNs;
    if (span === 0n) return "--:--.---";
    const ratioPct = ratio * 100;

    // Multi-source: compare in PERCENT space so the snap distance
    // scales with the track regardless of zoom or DPR.
    if (sources.length > 1) {
      const ordered = [...sources].sort((a, b) => {
        const d = a.timeRange.startNs - b.timeRange.startNs;
        return d === 0n ? 0 : d < 0n ? -1 : 1;
      });
      for (let i = 0; i < ordered.length; i++) {
        const s = ordered[i];
        const startPct = percentOf(s.timeRange.startNs, globalRange);
        const endPct = percentOf(s.timeRange.endNs, globalRange);
        if (Math.abs(ratioPct - startPct) < BOUNDARY_SNAP_PCT) {
          return `Segment ${i + 1} start`;
        }
        if (Math.abs(ratioPct - endPct) < BOUNDARY_SNAP_PCT) {
          return `Segment ${i + 1} end`;
        }
      }
    }

    const ns = globalRange.startNs + BigInt(Math.round(ratio * Number(span)));
    return formatPlayheadPrimary(ns, globalRange.startNs, timeMode);
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
    if (!track) return;
    const ratio = ratioFromEvent(e);
    // Two responsibilities split by capture state: when the user is
    // dragging (we hold pointer capture) we commit the cursor; when
    // they're just hovering we paint the preview tooltip.
    if (track.hasPointerCapture(e.pointerId)) {
      scheduleCommit(nsFromRatio(ratio, globalRange));
      return;
    }
    const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    scheduleHover(clamped * 100, labelForHover(clamped));
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

  const onPointerEnter = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || !globalRange) return;
    const ratio = ratioFromEvent(e);
    const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
    scheduleHover(clamped * 100, labelForHover(clamped));
  };

  const onPointerLeave = () => {
    if (hoverRafId.current !== null) {
      cancelAnimationFrame(hoverRafId.current);
      hoverRafId.current = null;
      pendingHover.current = null;
    }
    setHoverPct(null);
    setHoverLabel("");
  };

  // Cancel any in-flight rAF on unmount.
  useEffect(() => {
    return () => {
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      if (hoverRafId.current !== null) {
        cancelAnimationFrame(hoverRafId.current);
        hoverRafId.current = null;
      }
    };
  }, []);

  // Global keyboard shortcuts: Space / J / K / L / arrows / Home /
  // End, plus `?` to toggle the help overlay. Inputs and
  // contentEditable opt out.
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
      // `?` works even with no session loaded so users can discover
      // bindings before they drop a file.
      if (e.key === "?" || (e.shiftKey && e.code === "Slash")) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      if (!range) return;

      if (e.code === "Space" || e.code === "KeyK") {
        e.preventDefault();
        if (store.playing) store.pause();
        else store.play();
      } else if (e.code === "Home") {
        e.preventDefault();
        store.setCursor(range.startNs);
      } else if (e.code === "End") {
        e.preventDefault();
        store.setCursor(range.endNs);
      } else if (e.code === "ArrowLeft" || e.code === "KeyJ") {
        e.preventDefault();
        store.setCursor(store.cursorNs - ONE_SEC_NS);
      } else if (e.code === "ArrowRight" || e.code === "KeyL") {
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

  const toggleTimeMode = () => {
    useSession
      .getState()
      .setTimeMode(timeMode === "relative" ? "absolute" : "relative");
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

  // Sources are ordered by start so adjacent bands alternate visually
  // (even/odd index → two opacity classes). The S-index is the
  // load-bearing identifier; `name` is the visible label.
  type SegmentEntry = {
    key: string;
    label: string;
    name: string;
    leftPct: number;
    widthPct: number;
    title: string;
  };
  const segmentEntries: SegmentEntry[] = useMemo(() => {
    if (!globalRange || sources.length <= 1) return [];
    const ordered = [...sources].sort((a, b) => {
      const da = a.timeRange.startNs - b.timeRange.startNs;
      return da === 0n ? 0 : da < 0n ? -1 : 1;
    });
    const entries: SegmentEntry[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const src = ordered[i];
      const left = percentOf(src.timeRange.startNs, globalRange);
      const right = percentOf(src.timeRange.endNs, globalRange);
      const width = Math.max(0, right - left);
      // Match the PlotPanel segment-tooltip shape so the user sees the
      // same metadata whether hovering a Plot band or a Transport tick.
      // Newlines render as separators in native browser title tooltips.
      const startRel = formatRelative(src.timeRange.startNs, globalRange.startNs);
      const endRel = formatRelative(src.timeRange.endNs, globalRange.startNs);
      const startWall = formatAbsoluteClock(src.timeRange.startNs);
      entries.push({
        key: `seg:${src.id}:${i}`,
        label: `S${i + 1}`,
        name: src.name,
        leftPct: left,
        widthPct: width,
        title:
          `Segment ${i + 1}: ${src.name}\n` +
          `Start: ${startWall} (${startRel})\n` +
          `End: ${endRel}`,
      });
    }
    return entries;
  }, [globalRange, sources]);

  // Which segment does the cursor fall inside? Drives the "now in"
  // hint above the readout and styles the active segment band.
  const activeSegmentIndex = useMemo(() => {
    if (segmentEntries.length === 0 || !globalRange) return -1;
    const span = globalRange.endNs - globalRange.startNs;
    if (span === 0n) return -1;
    const cursorPct = percentOf(cursorNs, globalRange);
    for (let i = 0; i < segmentEntries.length; i++) {
      const e = segmentEntries[i];
      if (cursorPct >= e.leftPct && cursorPct <= e.leftPct + e.widthPct) {
        return i;
      }
    }
    return -1;
  }, [segmentEntries, cursorNs, globalRange]);

  const span = globalRange ? globalRange.endNs - globalRange.startNs : 0n;
  const current = globalRange
    ? formatPlayheadPrimary(cursorNs, globalRange.startNs, timeMode)
    : "--:--.---";
  // In relative mode `totalLabel` is the session duration; in absolute
  // mode it's the wall-clock end, formatted with the same precision so
  // the `current / total` pair lines up.
  const totalLabel = !globalRange
    ? "--:--.---"
    : timeMode === "relative"
      ? formatDuration(span)
      : formatPlayheadPrimary(globalRange.endNs, globalRange.startNs, "absolute");
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
  // Date stamp appears only in absolute mode as a subtle sublabel
  // under the playhead badge; relative mode keeps a single canonical
  // time format on the bar.
  const sessionDate =
    globalRange && timeMode === "absolute"
      ? formatDate(globalRange.startNs)
      : null;
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
      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}

      {/* Per-segment label row sits above the track so the band ↔
       *  label relationship is obvious. Suppressed for single-source. */}
      {segmentEntries.length > 0 && (
        <div
          className={styles.segmentLabelRow}
          data-testid="transport-segment-labels"
          aria-hidden
        >
          {segmentEntries.map((seg, i) => (
            <span
              key={`${seg.key}:label`}
              className={
                i === activeSegmentIndex
                  ? `${styles.segmentLabel} ${styles.segmentLabelActive}`
                  : styles.segmentLabel
              }
              style={{
                left: `${seg.leftPct}%`,
                width: `${seg.widthPct}%`,
              }}
              title={seg.title}
            >
              <span className={styles.segmentIndex}>{seg.label}</span>
              <span className={styles.segmentName}>{seg.name}</span>
            </span>
          ))}
        </div>
      )}

      {/* Scrubber row — full width above the controls. */}
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
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
        >
          <div className={styles.trackStrip}>
            {/* Alternating low-opacity fills; the active band gets a
             *  bit more colour. */}
            {segmentEntries.length > 0 && (
              <div
                className={styles.segmentBands}
                data-testid="transport-segment-bands"
                aria-hidden
              >
                {segmentEntries.map((seg, i) => (
                  <div
                    key={`${seg.key}:band`}
                    className={
                      i === activeSegmentIndex
                        ? `${styles.segmentBand} ${styles.segmentBandActive}`
                        : i % 2 === 0
                          ? `${styles.segmentBand} ${styles.segmentBandEven}`
                          : `${styles.segmentBand} ${styles.segmentBandOdd}`
                    }
                    style={{
                      left: `${seg.leftPct}%`,
                      width: `${seg.widthPct}%`,
                    }}
                    title={seg.title}
                  />
                ))}
              </div>
            )}
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
            {/* Segment boundary ticks for hard separation between bands. */}
            {segmentEntries.length > 0 && (
              <div
                className={styles.segmentTicks}
                data-testid="transport-segments"
                aria-hidden
              >
                {segmentEntries.map((seg, i) =>
                  // Suppress the leading tick — collides with the
                  // track's left border-radius.
                  i === 0 ? null : (
                    <span
                      key={seg.key}
                      className={styles.segmentTick}
                      data-segment-index={i}
                      style={{ left: `${seg.leftPct}%` }}
                      title={seg.title}
                    />
                  ),
                )}
              </div>
            )}
            <div
              className={styles.trackFill}
              style={{ width: `${fillPct}%` }}
            />
            <BookmarkMarkers />

            {/* Hover ghost + tooltip — neutral shape so it can't be
             *  confused with the orange cursor badge. */}
            {hoverPct !== null && (
              <>
                <div
                  className={styles.hoverLine}
                  style={{ left: `${hoverPct}%` }}
                  aria-hidden
                  data-testid="transport-hover-line"
                />
                <div
                  className={styles.hoverTooltip}
                  style={{ left: `${hoverPct}%` }}
                  data-testid="transport-hover-tooltip"
                  role="tooltip"
                >
                  <span className={styles.hoverTooltipPrimary}>
                    {hoverLabel}
                  </span>
                </div>
              </>
            )}

            {/* Playhead line + handle. translateX(-50%) wrapper keeps
             *  them co-located across resizes. */}
            <div
              className={styles.playheadGroup}
              style={{ left: `${fillPct}%` }}
              data-testid="transport-playhead"
            >
              <div className={styles.playheadLine} aria-hidden />
              <div
                className={styles.playheadBadge}
                data-testid="transport-playhead-badge"
                aria-hidden
              >
                <div className={styles.playheadBadgeMain}>
                  <span className={styles.playheadBadgeTime}>{current}</span>
                  <span className={styles.playheadBadgeSep} aria-hidden>
                    /
                  </span>
                  <span
                    className={styles.playheadBadgeTotal}
                    data-testid="transport-playhead-total"
                  >
                    {totalLabel}
                  </span>
                </div>
                {sessionDate && (
                  <div
                    className={styles.playheadBadgeDate}
                    data-testid="transport-playhead-date"
                  >
                    {sessionDate}
                  </div>
                )}
              </div>
              <div
                className={
                  decodeWaiting
                    ? `${styles.thumb} ${styles.thumbWaiting}`
                    : styles.thumb
                }
                data-testid="scrubber-thumb"
                title="Drag to seek"
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
        {/* REL/ABS toggle lives next to the labels it governs (proximity).
         *  The sr-only segment-count is anchored as a sibling for
         *  e2e/AT consumers. */}
        <div className={styles.scrubRowLabels}>
          <span className={styles.scrubEdgeLabel} aria-hidden>
            {startLabel}
          </span>
          <span className={styles.scrubCenter}>
            {sources.length > 1 && (
              <span
                className={styles.srOnly}
                data-testid="transport-segment-count"
                data-segment-count={sources.length}
              >
                {sources.length} segments
              </span>
            )}
            <button
              type="button"
              className={
                timeMode === "absolute"
                  ? `${styles.modeChip} ${styles.modeChipActive}`
                  : styles.modeChip
              }
              data-testid="transport-mode-toggle"
              data-time-mode={timeMode}
              aria-pressed={timeMode === "absolute"}
              aria-label={
                timeMode === "relative"
                  ? "Relative time mode (elapsed since start). Click to switch to wall-clock."
                  : "Wall-clock time mode (absolute). Click to switch to relative."
              }
              onClick={toggleTimeMode}
              disabled={disabled}
              title={
                timeMode === "relative"
                  ? "Relative time mode — readout shows elapsed since session start (00:12.345). Click for wall-clock."
                  : "Wall-clock time mode — readout shows time of day (06:08:42.123). Click for relative."
              }
            >
              {timeMode === "relative" ? "REL" : "ABS"}
            </button>
          </span>
          <span className={styles.scrubEdgeLabel} aria-hidden>
            {endLabel}
          </span>
        </div>
      </div>

      {/* Controls row.
       *
       *   ┌─────────────────────────────────────────────────────────┐
       *   │ [⏮ ▶ ⏭] · [Speed ▾]              [REL/ABS] [?]          │
       *   └─────────────────────────────────────────────────────────┘
       *      └─── transportCluster (primary) ──┘   └ utilityCluster ┘
       *
       * The current-time readout is intentionally NOT duplicated here;
       * it lives in the playhead badge. */}
      <div className={styles.row}>
        <div
          className={styles.transportCluster}
          data-testid="transport-cluster"
        >
          <div className={styles.btnGroup}>
            <button
              type="button"
              className={styles.btnT}
              data-testid="transport-prev-1s"
              aria-label="Step back 1 second"
              onClick={onPrev1s}
              disabled={disabled}
              title="Step back 1 s (J or ←)"
            >
              <span aria-hidden>◀◀</span>
            </button>
            <button
              type="button"
              className={`${styles.btnT} ${styles.play}`}
              data-testid="play-pause"
              aria-label={playing ? "Pause" : "Play"}
              aria-pressed={playing}
              onClick={onPlayPause}
              disabled={disabled}
              title={playing ? "Pause (Space or K)" : "Play (Space or K)"}
            >
              <span aria-hidden>{playing ? "❚❚" : "▶"}</span>
            </button>
            <button
              type="button"
              className={styles.btnT}
              data-testid="transport-next-1s"
              aria-label="Step forward 1 second"
              onClick={onNext1s}
              disabled={disabled}
              title="Step forward 1 s (L or →)"
            >
              <span aria-hidden>▶▶</span>
            </button>
            {/* Pulses when a bound video panel has been "waiting"
             *  continuously for ≥250 ms. Stalled panels surface their
             *  own per-panel error badge so they don't trigger this. */}
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

          <span className={styles.clusterDivider} aria-hidden />

          <div className={styles.speedPill}>
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
              title="Playback speed"
            >
              {SPEED_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}×
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={styles.rowGrow} />

        {/* Utility cluster carries only `?`; REL/ABS lives above in
         *  the scrubRowLabels row. The `transport-meta-cluster`
         *  testid stays for existing test lookups. */}
        <div
          className={`${styles.utilityCluster} ${styles.metaCluster}`}
          data-testid="transport-meta-cluster"
        >
          <button
            type="button"
            className={styles.helpBtn}
            data-testid="transport-shortcuts-toggle"
            aria-label="Show keyboard shortcuts"
            aria-expanded={shortcutsOpen}
            title="Keyboard shortcuts (?)"
            onClick={() => setShortcutsOpen((open) => !open)}
          >
            ?
          </button>
        </div>
      </div>
    </div>
  );
}
