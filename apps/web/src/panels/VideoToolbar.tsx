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

type HealthTone = "ok" | "warn" | "bad" | "unknown";

function healthTone(
  fps: number | null,
  droppedRecent: boolean,
  targetFps: number,
): HealthTone {
  if (fps === null) return "unknown";
  if (fps < targetFps * 0.5) return "bad";
  if (droppedRecent || fps < targetFps * 0.9) return "warn";
  return "ok";
}

/**
 * Format a smoothed FPS as a short string. We use 0 decimals at 30+ fps
 * (whole numbers read cleaner in a tiny chip) and 1 decimal below that
 * so the difference between 24 and 25 fps is visible.
 */
function formatFps(fps: number | null): string {
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

  // Recent-drops flag: any drop counter > 0 in the current window. The
  // tone derivation pairs this with the FPS check so a brief glitch
  // tints the dot yellow even if FPS is otherwise nominal.
  const tone = healthTone(fps, drops > 0, expectedFps);
  const codecLabel = codec ?? "—";
  const fpsLabel = formatFps(fps);
  const tooltipParts = [
    codecLabel,
    fpsLabel,
    `${drops} drop${drops === 1 ? "" : "s"}`,
  ];
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
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.btn}
          onClick={onFrameBack}
          disabled={!canFrameStep}
          aria-label="Step back one frame"
          title={
            canFrameStep
              ? "Step back one frame"
              : "Frame stepping requires an mp4 sidecar"
          }
          data-testid="video-frame-back"
        >
          {/* ⏮ — visually distinct via stacked bar + triangle */}
          <span aria-hidden="true">{"⏮"}</span>
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onScrubBack}
          aria-label="Scrub back one second"
          title="Scrub back 1 s"
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
          title={playLabel}
          data-testid="video-play-pause"
        >
          <span aria-hidden="true">{playing ? "⏸" : "▶"}</span>
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onScrubForward}
          aria-label="Scrub forward one second"
          title="Scrub forward 1 s"
          data-testid="video-scrub-forward"
        >
          <span aria-hidden="true">{"⏩"}</span>
        </button>
        <button
          type="button"
          className={styles.btn}
          onClick={onFrameForward}
          disabled={!canFrameStep}
          aria-label="Step forward one frame"
          title={
            canFrameStep
              ? "Step forward one frame"
              : "Frame stepping requires an mp4 sidecar"
          }
          data-testid="video-frame-forward"
        >
          <span aria-hidden="true">{"⏭"}</span>
        </button>
      </div>

      <div className={styles.spacer} aria-hidden="true" />

      {/* Decode-health badge. Tooltip carries the full string; the
       *  visible chip is just dot + fps + drops so the toolbar stays
       *  slim. */}
      <div
        className={`${styles.badge} ${styles[`badge_${tone}`]}`}
        title={badgeTooltip}
        data-testid="video-health-badge"
        data-tone={tone}
        role="status"
        aria-label={`Decode health: ${badgeTooltip}`}
      >
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.codec}>{codecLabel}</span>
        <span className={styles.fps}>{fpsLabel}</span>
        {drops > 0 && (
          <span className={styles.drops} title={`${drops} dropped frames since last seek`}>
            {drops} drop{drops === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {/* Resolution readout — separate chip so the badge stays focused
       *  on health. Hidden until the first frame so it doesn't flash
       *  "—×—" on mount. */}
      {resolution && (
        <div
          className={styles.resolution}
          data-testid="video-resolution"
          title={`Source resolution ${resolution.width} × ${resolution.height}`}
        >
          {resolution.width}×{resolution.height}
        </div>
      )}

      <button
        type="button"
        className={styles.btn}
        onClick={() =>
          onFitModeChange(fitMode === "fit" ? "fill" : "fit")
        }
        aria-label={
          fitMode === "fit"
            ? "Switch to fill (crop to remove letterbox)"
            : "Switch to fit (preserve aspect ratio)"
        }
        aria-pressed={fitMode === "fill"}
        title={
          fitMode === "fit"
            ? "Fit — preserve aspect ratio"
            : "Fill — crop to remove letterbox"
        }
        data-testid="video-fit-toggle"
      >
        <span className={styles.fitLabel}>
          {fitMode === "fit" ? "Fit" : "Fill"}
        </span>
      </button>
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
