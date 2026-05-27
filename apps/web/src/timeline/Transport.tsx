// T3.2 · Timeline UI (scrubber). Bottom-anchored transport bar that drives
// the T3.1 state machine through the existing `useSession` actions — all
// clamping, end-of-session auto-pause, and speed bounds live in the store
// (see `state/store.ts:170-201`).
//
// UX overhaul (Agent B, original issues #6-9). Iteration 2 (this rev):
//
//   #1 — Tall integrated scrub track (24 px tall, 32 px hit target).
//        The track is now the dominant element on the bar; controls
//        sit beneath it without a visual gap. Buffered / segment
//        colour bands fill the track so the eye reads the timeline
//        shape immediately.
//   #2 — Full-height playhead line + draggable handle + hover tooltip.
//        Pointer-move over the track previews the time under the
//        cursor; pointer-down on the line/handle scrubs.
//   #3 — Single source of truth for current time. The bottom-right
//        "Elapsed / Total" duplicate is gone; the time-of-day above
//        the playhead handle owns the current readout, and a small
//        "TOTAL hh:mm:ss" sits to the right of the controls.
//   #4 — Segments are visually obvious: alternating low-opacity bands
//        + per-segment labels ("S1 · S2 · S3") in the band row above
//        the track.
//   #5 — Speed stays prominent; relative/absolute is demoted to a
//        compact icon chip with a tooltip ("REL"/"ABS" toggle).
//   #6 — Keyboard shortcuts (Space / J / K / L / ←/→ / Home / End)
//        plus title hints on every control. A `?` button opens a
//        small overlay listing them all.
//
// A `transport:scrub` perf mark still bounds the pointer-move work so
// the existing perfBudgets spec catches a regression past one RAF.

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

  // Issue #2 — hover tooltip state. `hoverPct` drives the floating
  // ghost line (and the tooltip's `left`); `hoverPrimary`/`hoverSub`
  // carry the formatted preview time. Iter3: the hover tooltip now
  // also surfaces the *other* convention as a sub-line, so the cursor
  // badge can be slimmed down to a single number (issue #1) while the
  // hovering user still gets both. Iter4 (issue #6): `hoverSegment`
  // adds segment context inline ("Segment 2 · drive_2.mcap") so users
  // discover what those tick marks mean without having to hit a 1 px
  // boundary line. Stored in state so the tooltip re-renders, but
  // updates land at most once per rAF via a shared scheduler so the
  // hot path stays within budget.
  // Iter5 (issue #4) — hover chip is now a one-line scout: the
  // playhead badge owns the rich readout. We keep the rAF-scheduled
  // batch but the payload collapses to a single label string.
  // Boundary detection runs in `labelForHover` and returns either
  // "Segment N start"/"…end" near a tick, or the time otherwise.
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
    // Issue #9 — perf budget mark closes the frame, paired with the
    // `transport:scrub:start` mark scheduled below. The end-to-end
    // budget spec asserts this stays ≤1 RAF.
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

  // Iter5 (issue #4) — single label for the hover scout. When the
  // pointer is within `BOUNDARY_SNAP_PCT` of a segment boundary,
  // return "Segment N start" / "Segment N end" so the user
  // immediately understands the tick mark. Otherwise return the
  // canonical playhead time in the current mode. No more alt
  // convention, no more inline segment name — the cursor badge owns
  // the rich readout, this chip is just "where my mouse points".
  //
  // BOUNDARY_SNAP_PCT is generous (0.4 % of track width ≈ 5 px at
  // 1280 px) so users discover the boundary label easily without
  // having to hit the 2 px tick exactly.
  const BOUNDARY_SNAP_PCT = 0.4;
  const labelForHover = (ratio: number): string => {
    if (!globalRange) return "--:--.---";
    const span = globalRange.endNs - globalRange.startNs;
    if (span === 0n) return "--:--.---";
    const ratioPct = ratio * 100;

    // Multi-source: check boundary snap first. Compare in PERCENT
    // space so the snap distance scales with the track regardless
    // of zoom or device pixel ratio.
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

  // Global keyboard shortcuts. Iteration 2 adds VLC-style J/K/L on
  // top of Space / arrows / Home/End, plus `?` to toggle the help
  // overlay. Inputs and contentEditable still opt out.
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
      // `?` is the one shortcut that works even with no session loaded
      // (so users can discover bindings before they drop a file).
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

  // Issue #4 — segments are now bands + boundary ticks + labels.
  // Sources already carry `timeRange` so we don't invent a new
  // ingest path. Ordering by start so adjacent bands alternate
  // visually (even/odd index → two opacity classes).
  //
  // Iter5 (issue #2) — also carry the source `name` so the label
  // row can render "S2 · drive_2.mcap" inline when the band is wide
  // enough. The S-index is the load-bearing identifier; the name is
  // promoted to a visible label (not just a tooltip).
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
      // Iter4 (issue #6) — match the PlotPanel segment-tooltip
      // convention so users see the same metadata in the same shape
      // whether they hover a Plot band or a Transport tick. The plot
      // uses:
      //
      //   Segment N: <name>
      //   Start: <wall> (<relative>)
      //   End:   <relative>
      //
      // We don't have a wall-clock segment-start formatter handy in
      // this module (formatAbsoluteClock is HH:MM:SS without ms and
      // matches the plot's `formatRelativeTime24h` shape closely), so
      // reuse it for the wall-clock line. Newlines render as separators
      // in native browser title tooltips.
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
  // Iter3 (issue #1) — single canonical format for the playhead badge.
  // No more two-line stacked readout; the hover tooltip carries the
  // alternate convention when the user wants it.
  const current = globalRange
    ? formatPlayheadPrimary(cursorNs, globalRange.startNs, timeMode)
    : "--:--.---";
  // Iter3 (issue #3) — total promoted to a `current / total` pair next
  // to the playhead badge. In relative mode it's the session duration;
  // in absolute mode it's the wall-clock end of the session, formatted
  // with the same precision as `current` so the pair lines up.
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
  // Iter4 (issue #3) — the "2024-01-01" date stamp only appears in
  // ABSOLUTE mode now, and only in one place (a subtle sub-label
  // under the playhead badge). In relative mode the date is implied
  // by the session itself; surfacing it as a third visible format
  // alongside the canonical cursor readout and the start/end tick
  // anchors was the iter3 regression the designer flagged.
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

      {/* Per-segment label row sits above the track so the band ↔ label
       *  relationship is obvious. Suppressed when there's only one
       *  source.
       *
       *  Iter5 (issue #2) — labels promoted to primary navigational
       *  information: each entry now renders a high-contrast S-pill
       *  next to the source filename so segments are identifiable
       *  even in a narrow window. The S-pill is the load-bearing
       *  identifier; the name is auxiliary and truncates via the
       *  container's overflow:hidden when the band is too narrow. */}
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

      {/* Scrubber row — full width above the controls, tall enough to
       *  feel like the heartbeat of the app. */}
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
            {/* Segment bands — alternating low-opacity fills so the
             *  scrub track reads as "segmented, with this bit being
             *  segment 2". The active band gets a bit more colour. */}
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
                  // Suppress the leading tick — it would visually
                  // collide with the track's left border-radius.
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

            {/* Hover ghost line + tooltip — appears whenever the user
             *  is hovering somewhere on the track that isn't the
             *  current playhead position. Iter3 (issue #2): visually
             *  distinct from the cursor badge. Neutral border (no
             *  orange), softer shadow, no down-arrow tab. The cursor
             *  badge is "where I am"; this is "where my mouse is".
             *
             *  Iter5 (issue #4): collapsed to a SINGLE short line.
             *  The iter3/iter4 chip stacked the time + alt convention
             *  + inline segment name, redundantly mirroring what the
             *  cursor badge already shows. Now it's a quick scout:
             *  just the time, or "Segment N start"/"…end" when the
             *  pointer is near a boundary tick. */}
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

            {/* Issue #2 — full-height playhead line + handle. The line
             *  spans the strip; the handle is the grabbable disc on
             *  top. Both belong to the same translateX(-50%) wrapper
             *  so they stay co-located across resizes. */}
            <div
              className={styles.playheadGroup}
              style={{ left: `${fillPct}%` }}
              data-testid="transport-playhead"
            >
              <div className={styles.playheadLine} aria-hidden />
              {/* Iter3 (issues #1 + #3) — single canonical format for
               *  the current time, paired with the total session length
               *  as `current / total`. The total uses a muted weight
               *  but matches the current's font size so the pair
               *  reads as one unit. The alternate convention (wall
               *  clock vs duration) is intentionally NOT rendered
               *  here — hovering anywhere on the track shows it in
               *  the neutral hover tooltip. */}
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
                {/* Iter4 (issue #3) — the YYYY-MM-DD date stamp lives
                 *  inside the cursor badge as a tiny sublabel, but
                 *  only when the user has opted into absolute mode.
                 *  In relative mode the date is hidden entirely so
                 *  the bar carries exactly one canonical time format
                 *  at a glance. */}
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
        {/* Iter5 (issue #5) — REL/ABS toggle promoted from the
         *  bottom-right utility cluster (1300 px away from any time
         *  it formats) into the label row directly beneath the
         *  track, between the start and end edge labels. Proximity
         *  fix: the toggle now lives next to the very labels it
         *  governs (start / end / cursor badge), so the user reads
         *  "this chip controls THESE numbers" in one glance.
         *
         *  The sr-only segment-count slot is preserved for the
         *  e2e/AT consumers that read it; it's anchored as a
         *  sibling of the visible toggle inside the centre slot. */}
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
       * Iter4 (issue #4) — the iter3 layout had playback walled off
       * on the LEFT and speed pinned to the FAR RIGHT, with REL/ABS
       * and `?` between them. The designer audit: "speed and play
       * controls belong together". Regrouped into:
       *
       *   ┌─────────────────────────────────────────────────────────┐
       *   │ [⏮ ▶ ⏭] · [Speed ▾]              [REL/ABS] [?]          │
       *   └─────────────────────────────────────────────────────────┘
       *      └─── transportCluster (primary) ──┘   └ utilityCluster ┘
       *
       * Iter4 (issue #5) — REL/ABS and `?` are demoted to the right
       * corner with smaller chrome (see `.utilityCluster` /
       * `.helpBtn` rules) so they no longer compete with playback.
       *
       * The big current-time readout is intentionally NOT duplicated
       * here (iter3 #1+#3); it lives in the playhead badge. */}
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

          {/* Divider between play group and speed — same visual
           *  language as the iter3 meta-cluster divider, but it now
           *  groups two related controls (play + speed) rather than
           *  separating them. */}
          <span className={styles.clusterDivider} aria-hidden />

          {/* Iter4 (issue #4) — speed pill moved here, next to the
           *  play buttons. Label sits above the select rather than as
           *  floating microcaps so it's discoverable. */}
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

        {/* Iter5 (issue #5) — utility cluster now carries only `?`.
         *  REL/ABS moved up into the scrubRowLabels row next to the
         *  start/end time labels (proximity fix). The cluster wrapper
         *  + `transport-meta-cluster` testid stay so existing tests
         *  that look up the cluster keep working. */}
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
