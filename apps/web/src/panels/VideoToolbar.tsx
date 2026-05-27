// VideoToolbar — interactive controls + decode telemetry for a single
// VideoPanel (iter 3 video-polish cluster).
//
// Lives inside the video frame, just below the panel header. Owns:
//   • transport controls (frame-back / scrub-back 1 s / play-pause /
//     scrub-forward 1 s / frame-forward) that delegate to the existing
//     global Transport actions (`setCursor`, `play`, `pause`).
//   • a fit/fill toggle for the canvas object-fit mode (persisted per
//     panelId via localStorage — no store-shape change required).
//   • a decode-health badge (smoothed FPS, dropped frames since last
//     seek, codec string, dot tinted by health) plus a resolution
//     readout. Numbers come from the per-frame snapshot the rAF blit
//     loop writes into `window.__drivelineVideoHud`, plus a per-panel
//     sample of `frameIndex` over a 1 s window to derive FPS.
//
// Why a separate component:
//   • keeps VideoPanel.tsx focused on the decode/blit hot path.
//   • the toolbar re-renders on the cursor / playing slice — VideoPanel
//     deliberately does not, since 60 Hz cursor ticks would churn the
//     reconciler. Putting the toolbar in its own component isolates
//     that React work.
//
// We never reach into the decoder directly; everything we need is
// already exposed via the existing HUD snapshot or via the source's
// `mp4Cache.index.ptsNs` array. Sidecar PTS drives both frame stepping
// and the "expected fps" target the health-badge dot uses.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { VideoHudSnapshot } from "./VideoPanel";
import styles from "./VideoToolbar.module.css";

export type FitMode = "fit" | "fill";

interface VideoToolbarProps {
  panelId: string;
  /** Per-frame PTS table from the source's `mp4Cache.index.ptsNs`. When
   *  null (MCAP source, or sidecar still loading), the frame-step
   *  buttons are hidden and we fall back to a 30 fps target. */
  ptsNs: BigInt64Array | null;
  /** Bound to the canvas pixel dimensions reported by the first frame.
   *  Null until the decoder has produced anything. */
  resolution: { width: number; height: number } | null;
  fitMode: FitMode;
  onFitModeChange: (mode: FitMode) => void;
  /** Iter 4 issue #4 — the HUD toggle used to sit absolute-positioned
   *  *inside* the video frame, on top of the letterbox bars. Lifting
   *  it into the toolbar removes the overlap and reclaims pixels for
   *  the actual video region. Container forwards both the current
   *  bit and the toggle action so the toolbar stays state-free. */
  hudOn?: boolean;
  onHudToggle?: () => void;
  /** Iter 4 issue #4 — the "Change channel" pill used to sit
   *  hover-revealed inside the frame too. The container passes a
   *  no-op when no binding is set or change is disallowed; we render
   *  the button only when this is provided. */
  onClearBinding?: () => void;
}

const SCRUB_NS = 1_000_000_000n; // 1 second scrubs
const FPS_WINDOW_MS = 1000; // 1 s moving average
// History buffer is small — at 60 Hz the toolbar samples roughly once
// per rAF; 128 slots is enough headroom for the 1 s window even if a
// few stalls inflate the per-sample dt.
const FPS_HISTORY_CAP = 128;

interface FpsSample {
  tMs: number;
  frameIndex: number;
}

/**
 * Pick the median delta between consecutive sidecar PTS entries as the
 * expected frame interval. Falls back to 33.333 ms (30 fps) when the
 * sidecar is missing or has fewer than two samples. Median over mean
 * because the tail of a sidecar can contain a single oversized gap
 * (e.g. dropped key-frame at EOF) which would skew the target.
 */
function expectedFpsFromSidecar(ptsNs: BigInt64Array | null): number {
  if (!ptsNs || ptsNs.length < 2) return 30;
  // Sample up to the first 200 intervals — enough to be representative,
  // bounded so the toolbar's mount cost stays trivial on a 4-hour clip.
  const sampleN = Math.min(ptsNs.length - 1, 200);
  const deltasMs: number[] = new Array(sampleN);
  for (let i = 0; i < sampleN; i++) {
    const dNs = ptsNs[i + 1] - ptsNs[i];
    // Negative deltas only happen when a fixture is corrupt; treat as
    // zero so they sort to the bottom of the median.
    deltasMs[i] = dNs > 0n ? Number(dNs / 1000n) / 1000 : 0;
  }
  deltasMs.sort((a, b) => a - b);
  const median = deltasMs[Math.floor(deltasMs.length / 2)];
  if (median <= 0) return 30;
  return 1000 / median;
}

/**
 * Binary search the sidecar PTS table for the entry closest to (and
 * <= or > depending on `direction`) the cursor. Returns the PTS to
 * seek to, or null if no such frame exists (e.g. step-back at frame 0).
 */
function neighbourPts(
  ptsNs: BigInt64Array,
  cursorNs: bigint,
  direction: "back" | "forward",
): bigint | null {
  if (ptsNs.length === 0) return null;
  // Find largest index where ptsNs[i] <= cursorNs.
  let lo = 0;
  let hi = ptsNs.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ptsNs[mid] <= cursorNs) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (direction === "back") {
    // Step back: previous frame strictly before the *current* frame.
    // If the cursor sits exactly on a frame boundary, idx is that
    // frame and back == idx - 1. If the cursor sits between two
    // frames, idx is the previous frame and back == idx (so we snap
    // to the previous frame boundary rather than jumping two frames).
    const onBoundary = idx >= 0 && ptsNs[idx] === cursorNs;
    const target = onBoundary ? idx - 1 : idx;
    if (target < 0) return null;
    return ptsNs[target];
  }
  // Forward: next frame strictly after the cursor.
  const next = idx + 1;
  if (next >= ptsNs.length) return null;
  return ptsNs[next];
}

const FIT_STORAGE_PREFIX = "driveline.video.fitMode.";

export function loadFitMode(panelId: string): FitMode {
  try {
    const raw = localStorage.getItem(FIT_STORAGE_PREFIX + panelId);
    if (raw === "fill" || raw === "fit") return raw;
  } catch {
    // localStorage blocked (private mode, SSR shim, etc.) — fall back
    // silently to the default.
  }
  return "fit";
}

export function saveFitMode(panelId: string, mode: FitMode): void {
  try {
    localStorage.setItem(FIT_STORAGE_PREFIX + panelId, mode);
  } catch {
    // Same posture as `loadFitMode` — non-fatal.
  }
}

// Iter 4 issue #1 — health tones are now decoupled from playback state.
//   - "paused": video is intentionally paused; FPS=0 is expected and the
//     dot reads neutral grey, never red.
//   - "buffering": a seek/scrub just landed and the decoder hasn't yet
//     produced the matching frame. Amber, transient.
//   - "ok"/"warn"/"bad": live decode health *while playing* — matches
//     against the sidecar's target FPS so a healthy 30 fps stream isn't
//     flagged as bad when the user expected 60 fps.
//   - "unknown": pre-first-frame.
type HealthTone =
  | "ok"
  | "warn"
  | "bad"
  | "unknown"
  | "paused"
  | "buffering";

/** Inputs that determine the health tone. Grouped into a single argument
 *  so future signals (decoder error, etc.) can be added without churning
 *  every call site. */
interface HealthInput {
  /** Smoothed FPS over the last second, or null if no sample yet. */
  fps: number | null;
  /** Whether the panel observed a drop in the last sample window. */
  droppedRecent: boolean;
  /** Frame interval the source advertises — derived from sidecar PTS. */
  targetFps: number;
  /** Transport play/pause flag. When false, FPS=0 is the *expected*
   *  steady state and must not turn the dot red. */
  playing: boolean;
  /** ms since the most recent user seek (Number.POSITIVE_INFINITY if no
   *  seek has happened in the panel's lifetime). During the buffering
   *  window the dot is amber regardless of FPS. */
  msSinceSeek: number;
}

const BUFFERING_WINDOW_MS = 400;

function healthTone(input: HealthInput): HealthTone {
  // Order matters: paused beats buffering beats unknown beats live-fps.
  // A paused panel mid-seek should still read "paused" rather than amber
  // — the user can see they're not playing, the buffering tint is noise.
  if (!input.playing) return "paused";
  if (input.msSinceSeek < BUFFERING_WINDOW_MS) return "buffering";
  if (input.fps === null) return "unknown";
  if (input.fps < input.targetFps * 0.5) return "bad";
  if (input.droppedRecent || input.fps < input.targetFps * 0.9) return "warn";
  return "ok";
}

/**
 * Format a smoothed FPS as a short string. We use 0 decimals at 30+ fps
 * (whole numbers read cleaner in a tiny chip) and 1 decimal below that
 * so the difference between 24 and 25 fps is visible. When the transport
 * is paused, FPS is meaningless — return "paused" so the chip doesn't
 * read "0.0 fps" as if the stream had stalled (iter 4 issue #1).
 */
function formatFps(fps: number | null, playing = true): string {
  if (!playing) return "paused";
  if (fps === null) return "— fps";
  if (fps >= 30) return `${Math.round(fps)} fps`;
  return `${fps.toFixed(1)} fps`;
}

export function VideoToolbar({
  panelId,
  ptsNs,
  resolution,
  fitMode,
  onFitModeChange,
  hudOn,
  onHudToggle,
  onClearBinding,
}: VideoToolbarProps) {
  const playing = useSession((s) => s.playing);
  const play = useSession((s) => s.play);
  const pause = useSession((s) => s.pause);
  const setCursor = useSession((s) => s.setCursor);

  // Live decode telemetry. We sample the published HUD snapshot inside a
  // rAF loop so this toolbar is the *only* place that re-renders on
  // health changes — VideoPanel itself stays out of the React commit
  // phase as designed. `prevSnapshotPts` tracks the PTS the badge last
  // observed; when it changes (i.e. a seek happened) we reset the
  // dropped-frames baseline so the counter reads "drops since last
  // user-initiated jump," which is the metric a user actually wants
  // when reviewing decode health.
  const [fps, setFps] = useState<number | null>(null);
  const [drops, setDrops] = useState<number>(0);
  const [codec, setCodec] = useState<string | null>(null);
  const historyRef = useRef<FpsSample[]>([]);
  const dropBaselineRef = useRef<number>(0);
  const lastFrameIndexRef = useRef<number>(0);

  const expectedFps = useMemo(() => expectedFpsFromSidecar(ptsNs), [ptsNs]);

  // Reset all telemetry when the panel id, sidecar, or playback target
  // changes — those are the points at which "since last seek" naturally
  // re-baselines.
  useEffect(() => {
    historyRef.current = [];
    dropBaselineRef.current = 0;
    lastFrameIndexRef.current = 0;
    setFps(null);
    setDrops(0);
  }, [panelId, ptsNs]);

  // Iter 4 issue #1 — buffering window. We stamp `lastSeekMsRef` on
  // every seek-epoch bump; the health-tone resolver flips to "buffering"
  // for BUFFERING_WINDOW_MS so the dot reads amber while the decoder is
  // catching up after a scrub, then returns to green/yellow/red based on
  // live FPS. A ref keeps the tick loop allocation-free; React state
  // would force a 60 Hz re-render here.
  const lastSeekMsRef = useRef<number>(Number.NEGATIVE_INFINITY);

  // Subscribe to seekEpoch so a user scrub resets the drops baseline.
  useEffect(() => {
    const unsub = useSession.subscribe((state, prev) => {
      if (state.seekEpoch === prev.seekEpoch) return;
      // Pull the *current* HUD snapshot dropped count as the new
      // baseline. The HUD's dropped counter is monotonic across the
      // life of the panel, so "drops since last seek" = current -
      // baseline-at-seek.
      const snap = window.__drivelineVideoHud as VideoHudSnapshot | undefined;
      dropBaselineRef.current = snap?.dropped ?? 0;
      setDrops(0);
      historyRef.current = [];
      lastSeekMsRef.current = performance.now();
    });
    return () => unsub();
  }, []);

  // Poll the HUD snapshot at rAF cadence to derive smoothed FPS.
  // Bounded array + linear scan is fine — at 60 Hz the window holds at
  // most ~60 samples and we scan it once per tick.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const snap = window.__drivelineVideoHud as
        | VideoHudSnapshot
        | undefined;
      if (snap) {
        const tMs = performance.now();
        const hist = historyRef.current;
        // Only push a sample when frameIndex actually advances — keeps
        // the moving average honest while paused (fps reads as 0, not
        // a stale 30).
        if (snap.frameIndex !== lastFrameIndexRef.current) {
          lastFrameIndexRef.current = snap.frameIndex;
          hist.push({ tMs, frameIndex: snap.frameIndex });
          if (hist.length > FPS_HISTORY_CAP) hist.shift();
        }
        // Evict samples older than the window.
        while (hist.length > 1 && tMs - hist[0].tMs > FPS_WINDOW_MS) {
          hist.shift();
        }
        // FPS = (frameIndex_now - frameIndex_oldest) / dtSec.
        let nextFps: number | null = null;
        if (hist.length >= 2) {
          const oldest = hist[0];
          const newest = hist[hist.length - 1];
          const dt = (newest.tMs - oldest.tMs) / 1000;
          if (dt > 0) {
            nextFps = (newest.frameIndex - oldest.frameIndex) / dt;
          }
        } else if (hist.length === 1 && tMs - hist[0].tMs > FPS_WINDOW_MS) {
          // One sample inside an otherwise empty window for > 1 s — the
          // decoder is idle (paused / EOF). Report 0 so the badge
          // doesn't appear stuck.
          nextFps = 0;
        }
        setFps((cur) => {
          if (nextFps === null) return cur;
          // Smooth jitter: snap to 0 when it would round there anyway
          // so the chip doesn't read "0.4 fps" on a freshly-paused
          // panel.
          if (nextFps < 0.5) return 0;
          return nextFps;
        });
        // Drops since baseline (set on mount + on every seek).
        const sinceSeek = snap.dropped - dropBaselineRef.current;
        setDrops(sinceSeek < 0 ? 0 : sinceSeek);
        if (snap.codec !== codec) setCodec(snap.codec ?? null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
    // `codec` is intentionally a dependency-free read inside the tick;
    // wrapping it in deps would resubscribe on every codec change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --------- transport handlers ---------
  const onPlayPause = () => {
    if (playing) pause();
    else play();
  };
  const onScrubBack = () => {
    const cur = useSession.getState().cursorNs;
    setCursor(cur - SCRUB_NS);
  };
  const onScrubForward = () => {
    const cur = useSession.getState().cursorNs;
    setCursor(cur + SCRUB_NS);
  };
  const onFrameBack = () => {
    if (!ptsNs) return;
    const cur = useSession.getState().cursorNs;
    const target = neighbourPts(ptsNs, cur, "back");
    if (target !== null) setCursor(target);
  };
  const onFrameForward = () => {
    if (!ptsNs) return;
    const cur = useSession.getState().cursorNs;
    const target = neighbourPts(ptsNs, cur, "forward");
    if (target !== null) setCursor(target);
  };

  const canFrameStep = ptsNs !== null && ptsNs.length > 0;

  // Iter 4 issue #3 — frame-step keyboard shortcuts. `,` / `.` mirror
  // the standard YouTube/VLC convention for frame-accurate review and
  // — crucially — don't collide with the global Transport bindings
  // (which already own ←/→/J/L for 1 s steps). The handler attaches
  // to `window` rather than the panel wrapper so the user doesn't have
  // to chase focus into the canvas after each scrub. Mirrors the
  // Transport's input-guard convention (skip when typing).
  useEffect(() => {
    if (!canFrameStep) return;
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
      if (e.key === ",") {
        e.preventDefault();
        onFrameBack();
      } else if (e.key === ".") {
        e.preventDefault();
        onFrameForward();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `onFrameBack`/`onFrameForward` read fresh state from the store
    // each invocation, so re-binding only on `canFrameStep` changes is
    // safe and avoids re-attaching on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFrameStep]);

  // Iter 4 issue #1 — recompute the tone from the *current* signals,
  // not from FPS alone. `playing` short-circuits to a neutral grey dot
  // so a deliberate pause never trips the red "stalled stream" reading.
  // The buffering window is driven from `lastSeekMsRef` (stamped on
  // every seek-epoch bump above).
  const msSinceSeek = performance.now() - lastSeekMsRef.current;
  const tone = healthTone({
    fps,
    droppedRecent: drops > 0,
    targetFps: expectedFps,
    playing,
    msSinceSeek,
  });
  const codecLabel = codec ?? "—";
  const fpsLabel = formatFps(fps, playing);
  // Tooltip carries the verbose breakdown; the chip itself stays slim.
  // We surface decode-status words ("paused", "buffering") so the
  // tooltip explains *why* the dot is grey/amber when the chip text
  // ("paused") would otherwise look like the only state cue.
  const statusWord: Record<HealthTone, string> = {
    ok: "decode healthy",
    warn: "decode degraded",
    bad: "decode failing",
    unknown: "decode initialising",
    paused: "paused",
    buffering: "buffering after seek",
  };
  const tooltipParts: string[] = [statusWord[tone], codecLabel, fpsLabel];
  if (drops > 0) {
    tooltipParts.push(`${drops} drop${drops === 1 ? "" : "s"}`);
  }
  if (resolution) {
    tooltipParts.push(`${resolution.width}×${resolution.height}`);
  }
  const badgeTooltip = tooltipParts.join(" · ");

  const playLabel = playing ? "Pause" : "Play";

  // The frame-step buttons render conditionally because there's no
  // sensible behaviour without a per-frame PTS table. The button slot
  // remains in DOM as a disabled element so the toolbar layout doesn't
  // shift when a sidecar finishes loading mid-session.
  return (
    <div
      className={styles.toolbar}
      data-testid={`video-toolbar-${panelId}`}
      role="toolbar"
      aria-label="Video panel controls"
    >
      {/* Iter 4 issue #3 — frame-step buttons promoted to 36 px hit
       *  targets and grouped explicitly with the play-pause cluster.
       *  Tooltips include the keyboard shortcut so users discover the
       *  bindings without opening the shortcuts overlay. */}
      <div className={styles.transport}>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnStep}`}
          onClick={onFrameBack}
          disabled={!canFrameStep}
          aria-label="Step back one frame"
          aria-keyshortcuts=","
          title={
            canFrameStep
              ? "Frame back (,)"
              : "Frame stepping requires an mp4 sidecar"
          }
          data-testid="video-frame-back"
        >
          <span aria-hidden="true">{"⏮"}</span>
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onScrubBack}
          aria-label="Scrub back one second"
          title="Step back 1 s (Shift+,)"
          data-testid="video-scrub-back"
        >
          <span aria-hidden="true">{"⏪"}</span>
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={onPlayPause}
          aria-label={playLabel}
          aria-pressed={playing}
          title={playing ? "Pause (Space)" : "Play (Space)"}
          data-testid="video-play-pause"
        >
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onScrubForward}
          aria-label="Scrub forward one second"
          title="Step forward 1 s (Shift+.)"
          data-testid="video-scrub-forward"
        >
          <span aria-hidden="true">{"⏩"}</span>
        </button>
        <button
          type="button"
          className={`${styles.btn} ${styles.btnStep}`}
          onClick={onFrameForward}
          disabled={!canFrameStep}
          aria-label="Step forward one frame"
          aria-keyshortcuts="."
          title={
            canFrameStep
              ? "Frame forward (.)"
              : "Frame stepping requires an mp4 sidecar"
          }
          data-testid="video-frame-forward"
        >
          <span aria-hidden="true">{"⏭"}</span>
        </button>
      </div>

      <div className={styles.spacer} aria-hidden="true" />

      {/* Iter 4 issue #1+6 — health dot is now the *only* always-on
       *  affordance; the FPS/codec/resolution readouts are grouped into
       *  a single subordinate "decode info" pill that only carries
       *  weight on hover (tooltip) or when a drop count > 0 visually
       *  promotes the chip to a warning. Keeps the toolbar legible at a
       *  glance without losing the diagnostic surface. */}
      <div
        className={`${styles.badge} ${styles[`badge_${tone}`]}`}
        title={badgeTooltip}
        data-testid="video-health-badge"
        data-tone={tone}
        role="status"
        aria-label={`Decode health: ${badgeTooltip}`}
      >
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.decodeInfo} aria-hidden="true">
          <span className={styles.fps}>{fpsLabel}</span>
          {resolution && (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <span className={styles.resInline}>
                {resolution.width}×{resolution.height}
              </span>
            </>
          )}
          {codec && (
            <>
              <span className={styles.sep} aria-hidden="true">
                ·
              </span>
              <span className={styles.codec}>{codec}</span>
            </>
          )}
        </span>
        {drops > 0 && (
          <span
            className={styles.drops}
            title={`${drops} dropped frames since last seek`}
          >
            {drops} drop{drops === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Iter 4 issue #2 — FIT/FILL as a 2-state segmented control.
       *  Both options are always visible; the active segment has a
       *  filled background, the inactive segment is outline-only. Each
       *  segment carries its own `aria-pressed` so AT users can tell
       *  the current mode without inferring from the tooltip. */}
      <div
        className={styles.segmented}
        role="group"
        aria-label="Video sizing mode"
        data-testid="video-fit-segmented"
      >
        <button
          type="button"
          className={`${styles.segBtn} ${
            fitMode === "fit" ? styles.segBtnActive : ""
          }`}
          aria-pressed={fitMode === "fit"}
          aria-label="Fit: preserve aspect ratio with letterbox"
          title="Fit — preserve aspect ratio"
          data-testid="video-fit-segment-fit"
          onClick={() => {
            if (fitMode !== "fit") onFitModeChange("fit");
          }}
        >
          Fit
        </button>
        <button
          type="button"
          className={`${styles.segBtn} ${
            fitMode === "fill" ? styles.segBtnActive : ""
          }`}
          aria-pressed={fitMode === "fill"}
          aria-label="Fill: crop to fill panel"
          title="Fill — crop to remove letterbox"
          data-testid="video-fit-segment-fill"
          onClick={() => {
            if (fitMode !== "fill") onFitModeChange("fill");
          }}
        >
          Fill
        </button>
      </div>

      {/* Iter 4 issue #4 — HUD toggle lives in the toolbar now so it
       *  doesn't overlap the letterbox bars when the panel aspect
       *  doesn't match the source's. The visual style stays distinct
       *  from the FIT/FILL segments (smaller, monospaced) so it reads
       *  as a diagnostic toggle, not a primary mode. */}
      {onHudToggle && (
        <button
          type="button"
          className={`${styles.btn} ${styles.btnHud}`}
          onClick={onHudToggle}
          aria-pressed={hudOn ?? false}
          aria-label={hudOn ? "Hide diagnostics HUD" : "Show diagnostics HUD"}
          title="Toggle decode HUD (H)"
          data-testid="video-hud-toggle"
        >
          HUD
        </button>
      )}

      {/* Iter 4 issue #4 — clearing the binding moves out of the
       *  frame too. Hover-reveal on a label that you can't see is
       *  also bad UX (the iter3 audit didn't flag this directly but
       *  the same letterbox argument applies — it was painted over
       *  black bars). The toolbar carries it as a small text link
       *  styled as a button so it stays discoverable but doesn't
       *  fight the transport row for attention. */}
      {onClearBinding && (
        <button
          type="button"
          className={`${styles.btn} ${styles.btnGhost}`}
          onClick={onClearBinding}
          aria-label="Change channel — clear current video binding"
          title="Pick a different video channel"
          data-testid="video-clear-binding"
        >
          Change
        </button>
      )}
    </div>
  );
}

// Test seam — re-exported so unit tests can exercise the binary search
// without rendering the component.
export const __test = {
  neighbourPts,
  expectedFpsFromSidecar,
  healthTone,
  formatFps,
};
