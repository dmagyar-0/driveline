// T5.1 · VideoPanel (MCAP path) — extended in T5.2 with a perf HUD and a
// tighter seek pipeline.
//
// v5 (off-thread blit): the per-frame video BLIT now happens in the
// videoDecode worker, not here. The panel transfers its video <canvas> to the
// worker via `transferControlToOffscreen()` + `setRenderCanvas`; the worker
// owns the frame queue, the MAX_QUEUE drop policy, and the blit (driven by its
// own decode/cursor events — workers have no rAF). The panel keeps its rAF
// tick, but that tick no longer touches the video canvas: it reads the latest
// worker STATUS (blit PTS, frame index, decode/blit queue, dropped, decoder
// liveness) off the sink MessagePort, then drives the LiDAR OVERLAY canvas
// (still main-thread), readiness, the HUD/stats DOM, and the
// VIDEO_FIRST_FRAME / VIDEO_SEEK_TO_BLIT perf marks (which the worker signals
// via one-shot flags in the status message). Seek is a trailing-debounced
// side effect on `seekEpoch`. Pan/zoom stays a CSS transform on the (now
// placeholder) canvas element — transferControlToOffscreen leaves the element
// usable for CSS transforms.
//
// T5.2 additions: a toggleable HUD (current PTS, frame index, decode queue,
// blit queue, dropped frames, codec) and guards that skip seeks that
// duplicate the open target or the last-issued target.

import { useCallback, useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import { useSession } from "../state/store";
import { makeVideoDecodeClient } from "../workerClient";
import type { VideoDecodeApi } from "../workerClient";
import type { BlitStatus } from "../workers/videoDecode.worker";
import {
  mark,
  measure,
  OVERLAY_DRAW,
  OVERLAY_DRAW_END,
  OVERLAY_DRAW_START,
  VIDEO_FIRST_FRAME,
  VIDEO_SEEK_END,
  VIDEO_SEEK_START,
  VIDEO_SEEK_TO_BLIT,
} from "../perf";
import { fetchDecodedSpin } from "./pointCloudSpinCache";
import {
  makeProjectionBuffers,
  projectPointsInto,
  type ProjectionBuffers,
} from "./cameraProjection";
import { pickOverlayCamera, pickOverlayPointCloud } from "./overlayDefaults";
import {
  buildDepthPalette,
  contentRect,
  depthBucketIndex,
  type DepthPalette,
} from "./videoOverlay";
import {
  clearVideoOverlayInfo,
  setVideoOverlayInfo,
} from "./videoOverlayDevState";
import type { CameraCalibration } from "./calibrationFromArrow";
import type { PointCloudOverlayBinding } from "../layout/persist";
import {
  clearPanelReadiness,
  getReadinessSnapshot,
  setPanelReadiness,
  subscribeReadiness,
  type PanelReadiness,
  type ReadyState,
} from "./videoReadiness";
import {
  registerVideoPanel,
  unregisterVideoPanel,
} from "./videoCanvasRegistry";
import styles from "./VideoPanel.module.css";

// Issue #2 — readiness predicate constants. The panel reports "ready"
// in two regimes:
//   1. A frame has been blitted *and* it is within READY_EPSILON_NS of
//      the cursor (steady-state play, decoder is keeping up frame for
//      frame).
//   2. The decoder is alive — `frameIndex` advanced within the last
//      FRAME_LIVE_WINDOW_MS — even if `lastBlitPts` is briefly more
//      than ε behind. Without this, a 4K decode on a slow CPU (where
//      individual frames take 30–80 ms each) constantly trips the ε
//      threshold for healthy streams, the gate engages, and the worker
//      stops emitting because its lookahead pacing follows the gated
//      cursor — a feedback loop that throttles playback to ~25 % real
//      time. Treating "decoder is producing frames" as a ready signal
//      is honest: if frames are arriving the user IS seeing playback,
//      whether or not the most-recent blit happens to be within the
//      tight ε at the moment we polled.
//
// Mirrors `READY_EPSILON_NS` in `timeline/playback.ts`; both modules
// independently consult their own copy so neither has to import across
// the panels/timeline seam.
const READY_EPSILON_NS = 100_000_000n;
const FRAME_LIVE_WINDOW_MS = 250;
// Issue #2 — once a panel has been "waiting" continuously for this long
// AND `frameIndex` has not advanced since the wait began, the panel
// transitions to "stalled" and the cursor is allowed to proceed past it.
const STALLED_TIMEOUT_MS = 5000;

interface VideoPanelProps {
  sourceKind: "mcap" | "mp4";
  sourceHandle: number;
  channelId: string;
  /** FlexLayout panel id — keys per-panel UI state in the store
   *  (HUD overlay bit, future per-panel toggles). */
  panelId: string;
  /** Source filename for the bound video (e.g. `camera_front_wide_120fov.mp4`).
   *  The mp4 *channel* name is a generic `track_0`, so this is what the LiDAR
   *  overlay matches against a calibration camera name to pick a default camera
   *  on a multi-camera rig. Optional (undefined → fall back to the first
   *  camera). */
  videoSourceName?: string;
}

export interface VideoHudSnapshot {
  ptsNs: bigint | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  codec: string | null;
  hudOn: boolean;
}

const SEEK_DEBOUNCE_MS = 50;
// Display-only mirror of the worker's blit-queue cap (the real bound + drop
// policy live in `videoDecode.worker.ts`). Used purely to render `q N/16` in
// the HUD/stats strip.
const MAX_QUEUE = 16;

// Video zoom bounds. 1× is "fit" (the object-fit: contain default); we let
// the user magnify up to 8× to inspect a plate, a sign, a far-off cut-in.
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
// Per-keystroke zoom multiplier for the +/- accelerators.
const ZOOM_KEY_STEP = 1.25;
// Wheel sensitivity. deltaY is in (roughly) pixels; exp() makes zoom
// feel uniform regardless of starting magnification.
const ZOOM_WHEEL_SENSITIVITY = 0.0015;

declare global {
  interface Window {
    __drivelineVideoLastBlitPtsNs?: bigint | null;
    __drivelineVideoHud?: VideoHudSnapshot;
    /** Current video zoom factor (1 = fit). Mirrors the most recently
     *  interacted panel so Playwright can assert zoom/reset behaviour. */
    __drivelineVideoZoom?: number;
  }
}

function formatPts(ptsNs: bigint | null): string {
  if (ptsNs === null) return "—";
  // Milliseconds with 3 decimals is enough for the HUD; the acceptance
  // windows are single-GOP slop anyway.
  const ms = Number(ptsNs / 1000n) / 1000;
  return `${ms.toFixed(3)} ms`;
}

export function VideoPanel({
  sourceKind,
  sourceHandle,
  channelId,
  panelId,
  videoSourceName,
}: VideoPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Point-cloud overlay (docs/13). A second canvas sized to the letterboxed
  // content rect; the rAF tick projects the bound LiDAR spin onto it after the
  // video blit. All overlay hot-path inputs are mirrored into refs so the tick
  // never reads a reactive selector.
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayBindingRef = useRef<PointCloudOverlayBinding | null>(null);
  const overlayCalibRef = useRef<CameraCalibration | null>(null);
  // Spin start timestamps for the bound point-cloud channel.
  const overlaySpinTimesRef = useRef<BigInt64Array | null>(null);
  // The spin index currently projected + its cached projection, so we only
  // recompute when the active spin index OR the calibration changes.
  const overlaySpinIdxRef = useRef<number>(-1);
  const overlayProjRef = useRef<ProjectionBuffers | null>(null);
  const overlayProjCountRef = useRef<number>(0);
  const overlayDepthsRef = useRef<{ near: number; far: number }>({
    near: 1,
    far: 60,
  });
  // Bumped whenever the cached projection changes (new spin landed, or it
  // emptied). The per-tick overlay draw compares this against the last paint to
  // skip a redundant clear+redraw when nothing visible changed.
  const overlayGenRef = useRef<number>(0);
  // The (gen, canvas size, depth range) actually last painted onto the overlay.
  // A sentinel `gen: -1` means the overlay canvas currently holds nothing.
  const overlayDrawnRef = useRef<{
    gen: number;
    w: number;
    h: number;
    near: number;
    far: number;
  }>({ gen: -1, w: -1, h: -1, near: NaN, far: NaN });
  // Cached depth->colour palette (rebuilt only when the depth range changes)
  // and the per-bucket Path2D scratch reused across redraws.
  const overlayPaletteRef = useRef<DepthPalette | null>(null);
  const overlayBucketPathsRef = useRef<Path2D[] | null>(null);
  // True while an async spin fetch+project is inflight, so the tick coalesces
  // to ≤1 outstanding overlay refresh (never stacks fetches per rAF).
  const overlayBusyRef = useRef<boolean>(false);
  // Monotonic token so a late spin fetch result for a stale binding is dropped.
  const overlayReqRef = useRef<number>(0);
  const cursorRef = useRef<bigint>(0n);
  const rafRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // v5: set once we've transferred the video canvas to the worker. The
  // transfer is one-shot per element (a second `transferControlToOffscreen`
  // throws), so this guards the effect from re-transferring on a re-run.
  const offscreenTransferredRef = useRef<boolean>(false);
  // T7 — bound source's frame-coverage bounds, mirrored into refs so the
  // rAF loop can read them without a reactive selector on the hot path.
  // `uncoveredPaintedRef` debounces the worker-side black-fill request so we
  // clear the canvas once on entry into an uncovered region, not every tick.
  const coverageStartRef = useRef<bigint | null>(null);
  const coverageEndRef = useRef<bigint | null>(null);
  const uncoveredPaintedRef = useRef<boolean>(false);
  const videoDecodeRef = useRef<Comlink.Remote<VideoDecodeApi> | null>(null);
  const videoDecodeWorkerRef = useRef<Worker | null>(null);

  // HUD refs. We keep them off React state so metric updates don't churn
  // the reconciler; the rAF loop writes directly into the HUD DOM.
  // Task 3 — cache last written HUD/stats strings to skip identical DOM writes.
  const lastHudTextRef = useRef<string>("");
  const lastStatsTextRef = useRef<string>("");
  // v5: these mirror the latest worker STATUS message (no local frame queue
  // anymore). `lastBlitPtsRef` is the PTS of the frame the worker last blitted
  // to the OffscreenCanvas — it drives the overlay spin pick, readiness, and
  // the HUD, exactly as it did when the panel owned the blit.
  const lastFrameIndexRef = useRef<number>(0);
  const lastDecodeQueueRef = useRef<number>(0);
  const blitQueueLenRef = useRef<number>(0);
  const droppedFramesRef = useRef<number>(0);
  const lastBlitPtsRef = useRef<bigint | null>(null);
  // Main-thread receipt time of the most recent status whose `frameArrivedMs`
  // advanced (i.e. the worker decoded a fresh frame). Drives the "decoder is
  // alive" readiness arm using OUR clock, so worker↔main clock skew can't
  // poison the FRAME_LIVE_WINDOW_MS check.
  const lastFrameArrivedLocalMsRef = useRef<number>(0);
  const lastWorkerFrameArrivedMsRef = useRef<number>(0);
  const codecRef = useRef<string | null>(null);
  const hudDomRef = useRef<HTMLDivElement | null>(null);
  const hudOnRef = useRef<boolean>(false);
  const statsDomRef = useRef<HTMLDivElement | null>(null);

  // Video zoom (pan + magnify of the rendered frame). This is panel-local
  // UI chrome, NOT on the cursor hot path, so it never touches the store.
  // We drive the canvas transform imperatively through refs so a wheel-zoom
  // or a pan-drag doesn't re-render the React tree (and so it never fights
  // the rAF blit loop, which keeps drawing into the same canvas underneath
  // the CSS transform). The only React state is the `zoomed` bit, which
  // toggles the "Reset zoom" affordance — it flips at most twice per
  // interaction (1× → >1× and back), never per wheel tick.
  const zoomScaleRef = useRef<number>(1);
  const zoomTxRef = useRef<number>(0);
  const zoomTyRef = useRef<number>(0);
  const panActiveRef = useRef<boolean>(false);
  const panStartRef = useRef<{
    x: number;
    y: number;
    tx: number;
    ty: number;
  } | null>(null);
  const [zoomed, setZoomed] = useState<boolean>(false);

  // Write the current pan/zoom to the canvas. transform-origin is the panel
  // centre so 1× sits exactly where object-fit: contain put it. We also set
  // the cursor (grab/grabbing) so the panning affordance reads on hover.
  const applyZoomTransform = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = zoomScaleRef.current;
    canvas.style.transformOrigin = "center";
    canvas.style.transform = `translate(${zoomTxRef.current}px, ${zoomTyRef.current}px) scale(${s})`;
    canvas.style.cursor =
      s > 1 ? (panActiveRef.current ? "grabbing" : "grab") : "";
    // Keep the overlay canvas locked to the same zoom/pan as the video so
    // projected dots track the frame under magnification. Same transform-origin
    // (panel centre) so 1× sits exactly where object-fit: contain placed both.
    const overlay = overlayCanvasRef.current;
    if (overlay) {
      overlay.style.transformOrigin = "center";
      overlay.style.transform = `translate(${zoomTxRef.current}px, ${zoomTyRef.current}px) scale(${s})`;
    }
    window.__drivelineVideoZoom = s;
  }, []);

  // Keep the magnified frame covering the panel — clamp the translation so
  // you can't pan the image off into the letterbox void. At scale s the
  // content overhangs each edge by (s−1)·half, which is the max pan.
  const clampPan = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = zoomScaleRef.current;
    const maxX = ((s - 1) * canvas.clientWidth) / 2;
    const maxY = ((s - 1) * canvas.clientHeight) / 2;
    zoomTxRef.current = Math.max(-maxX, Math.min(maxX, zoomTxRef.current));
    zoomTyRef.current = Math.max(-maxY, Math.min(maxY, zoomTyRef.current));
  }, []);

  // Zoom toward an anchor point (qcx, qcy) given relative to the panel
  // centre, keeping the content under that anchor stationary. `next` is the
  // desired absolute scale; we clamp it to [MIN_ZOOM, MAX_ZOOM].
  const zoomToward = useCallback(
    (next: number, qcx: number, qcy: number) => {
      const s0 = zoomScaleRef.current;
      const s1 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next));
      if (s1 === s0) return;
      // Solve for the translation that pins the anchor across the scale
      // change: t1 = q − (s1/s0)·(q − t0).
      zoomTxRef.current = qcx - (s1 / s0) * (qcx - zoomTxRef.current);
      zoomTyRef.current = qcy - (s1 / s0) * (qcy - zoomTyRef.current);
      zoomScaleRef.current = s1;
      if (s1 === MIN_ZOOM) {
        zoomTxRef.current = 0;
        zoomTyRef.current = 0;
      }
      clampPan();
      applyZoomTransform();
      setZoomed(s1 > MIN_ZOOM);
    },
    [applyZoomTransform, clampPan],
  );

  const resetZoom = useCallback(() => {
    zoomScaleRef.current = 1;
    zoomTxRef.current = 0;
    zoomTyRef.current = 0;
    panActiveRef.current = false;
    panStartRef.current = null;
    applyZoomTransform();
    setZoomed(false);
  }, [applyZoomTransform]);

  // Issue #2 — readiness bookkeeping. Reused across rAF ticks so the
  // hot path doesn't allocate per frame. `lastFrameIndexAtWaitStartRef`
  // records the `frameIndex` at the moment the panel flipped from
  // "ready" to "waiting"; if it changes before STALLED_TIMEOUT_MS
  // elapses we restart the wait clock (decoder is alive, just slow).
  // `waitingSinceMsRef` is the wall clock at which the panel last
  // transitioned out of "ready"; the rAF loop derives the "have we
  // been waiting long enough to escalate to stalled" check from this.
  // The "decoder alive" arm of the readiness predicate is driven by
  // `lastFrameArrivedLocalMsRef` (declared above), which is bumped whenever a
  // worker STATUS message reports a fresh frame arrival.
  const readinessScratchRef = useRef<PanelReadiness>({
    state: "absent",
    lastReadyMs: 0,
    waitingSinceMs: null,
    lastBlitPtsNs: null,
  });
  const waitingSinceMsRef = useRef<number | null>(null);
  const lastFrameIndexAtWaitStartRef = useRef<number>(0);
  const lastReadyMsRef = useRef<number>(0);

  // Issue #2 — inline stalled badge inside the panel. The rAF loop
  // doesn't write to React state directly (no per-frame renders); the
  // dedicated readiness subscriber below mirrors the registry into
  // local state once per state transition, which is rare.
  const [readyState, setReadyState] = useState<ReadyState>("absent");

  // Task 2 — proactive decode-failure surface. The worker posts a
  // `{ type: "decode-error" }` control message over the frame sink the
  // instant the `VideoDecoder({ error })` callback (or a synchronous
  // decode throw) latches a fatal fault. We flip to an error badge
  // immediately instead of waiting out the 5 s STALLED_TIMEOUT_MS. The
  // existing `onRetry` (forced seek) re-primes the worker, which clears
  // the latch on re-open; we clear this local state when a fresh frame
  // arrives so a successful retry dismisses the badge.
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const decodeErrorRef = useRef<string | null>(null);
  decodeErrorRef.current = decodeError;

  // `lastSeekTargetRef` starts null and is set to the initial `open()`
  // target (the cursor at mount) once the worker has accepted it. The
  // debounced cursor effect skips a `seek()` that matches this — preventing
  // a redundant seek on mount when the cursor hasn't moved since open.
  const lastSeekTargetRef = useRef<bigint | null>(null);
  // Watermark of the cursor most recently pushed via `client.setCursor`.
  // Used to coalesce 60 Hz cursor ticks to ~30 Hz — the worker's pacing
  // gate compares `lastEmittedPtsNs - cursorNs` against `LOOKAHEAD_NS`,
  // so a stale watermark tightens the gate and stalls refills mid-play
  // (see `videoDecode.worker.ts:shouldRefill`).
  const lastCursorSentRef = useRef<bigint | null>(null);

  // Phase 5: HUD bit lives in the store (`videoHudOn[panelId]`) so the
  // Panel drawer can flip it from outside the panel. The local ref stays
  // — the rAF loop reads it every tick to decide whether to repaint the
  // HUD textContent without rerendering the React tree.
  const hudOn = useSession((s) => s.videoHudOn[panelId] ?? false);
  hudOnRef.current = hudOn;
  const toggleHud = () => useSession.getState().toggleVideoHudOn(panelId);

  // Only re-render this panel when the open() inputs change. Cursor and
  // playing state are read non-reactively below via `useSession.subscribe`
  // so a 60 Hz cursor tick during playback doesn't churn the React tree.
  const globalRange = useSession((s) => s.globalRange);

  // Point-cloud overlay binding for this panel (docs/13). Reactive — changing
  // it re-runs the binding effect that loads spin times + calibration, and the
  // tick reads the mirrored refs. `overlayBinding` is the persisted binding;
  // `sources` drives the picker dropdowns (calibration channels, point-cloud
  // channels, camera names).
  const overlayBinding = useSession(
    (s) => s.pointCloudOverlays[panelId] ?? null,
  );
  const sources = useSession((s) => s.sources);
  const calibrationCache = useSession((s) => s.calibrationCache);
  const [overlayMenuOpen, setOverlayMenuOpen] = useState<boolean>(false);

  // Candidate channels for the pickers.
  const calibrationChannels = sources.flatMap((s) =>
    s.channels.filter((c) => c.kind === "camera_calibration"),
  );
  const pointCloudChannels = sources.flatMap((s) =>
    s.channels.filter((c) => c.kind === "point_cloud"),
  );
  // Cameras available in the bound (or first) calibration channel.
  const activeCalibChannelId =
    overlayBinding?.calibrationChannelId ?? calibrationChannels[0]?.id ?? null;
  const camerasForActiveCalib: CameraCalibration[] = activeCalibChannelId
    ? (calibrationCache[activeCalibChannelId] ?? [])
    : [];

  // T7 — this source's own time coverage. The cursor roams the whole
  // session timeline, but a source only has frames inside [startNs, endNs]
  // (e.g. a 60 s dashcam dropped alongside signals that span 11 min). When
  // the cursor is outside it we show an honest "no video at this time"
  // state instead of escalating to the misleading "stream stalled" error.
  // Select the bounds as bigint primitives (not a fresh object) so a 60 Hz
  // cursor tick — which lives in the same store — can't churn this panel.
  const storeSourceKind = sourceKind === "mp4" ? "mp4+sidecar" : "mcap";
  const coverageStartNs = useSession(
    (s) =>
      s.sources.find(
        (x) => x.kind === storeSourceKind && x.handle === sourceHandle,
      )?.timeRange.startNs ?? null,
  );
  const coverageEndNs = useSession(
    (s) =>
      s.sources.find(
        (x) => x.kind === storeSourceKind && x.handle === sourceHandle,
      )?.timeRange.endNs ?? null,
  );
  coverageStartRef.current = coverageStartNs;
  coverageEndRef.current = coverageEndNs;

  // Mark this panel live for the agent API's `listVideoPanels()` /
  // `captureVideoFrame` for the panel's lifetime (registry pattern, like
  // sceneDevState). v5: we no longer register the canvas element — it's been
  // transferred to the worker and can't be read back — only the panel id.
  useEffect(() => {
    registerVideoPanel(panelId);
    return () => unregisterVideoPanel(panelId);
  }, [panelId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { proxy: videoDecode, worker: videoDecodeWorker } =
      makeVideoDecodeClient();
    videoDecodeRef.current = videoDecode;
    videoDecodeWorkerRef.current = videoDecodeWorker;
    const channel = new MessageChannel();
    const port = channel.port1;

    // v5: the sink port no longer carries VideoFrames — the worker owns the
    // blit. It carries (a) a one-time decode-error control message and (b) a
    // lightweight STATUS object on every blit. The rAF tick reads the latest
    // status; here we just stash it and react to the edges (decode-error
    // recovery, the first-blit/seek-blit perf marks, decoder-liveness clock).
    port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as
        | BlitStatus
        | { type: "decode-error"; reason: string }
        | null;
      if (!data) return;
      // Task 2 — control message: the worker latched a fatal decode fault.
      // Surface it proactively so the panel doesn't sit on a frozen canvas
      // until the 5 s stall timeout escalates.
      if (data.type === "decode-error") {
        if (decodeErrorRef.current === null) {
          decodeErrorRef.current = data.reason;
          setDecodeError(data.reason);
        }
        return;
      }
      // STATUS message. A blit means the stream is producing frames — clear
      // any standing decode-error badge (a forced-retry re-prime recovered).
      if (decodeErrorRef.current !== null) {
        decodeErrorRef.current = null;
        setDecodeError(null);
      }
      lastFrameIndexRef.current = data.frameIndex;
      lastDecodeQueueRef.current = data.decodeQueue;
      blitQueueLenRef.current = data.blitQueueLen;
      droppedFramesRef.current = data.dropped;
      lastBlitPtsRef.current = data.blitPtsNs;
      // Issue #2 — track decoder liveness on OUR clock. When the worker's
      // `frameArrivedMs` advances (a fresh frame decoded), stamp the local
      // receipt time; the readiness predicate's "decoder alive" arm compares
      // that against FRAME_LIVE_WINDOW_MS, immune to worker↔main clock skew.
      if (data.frameArrivedMs !== lastWorkerFrameArrivedMsRef.current) {
        lastWorkerFrameArrivedMsRef.current = data.frameArrivedMs;
        lastFrameArrivedLocalMsRef.current = performance.now();
      }
      // First-blit + seek-to-blit perf marks must land on the MAIN-thread
      // perf timeline (so __drivelinePerf / e2e budgets read them). The worker
      // can't mark there, so it flags the edge and we stamp it here.
      if (data.firstBlit) {
        mark(VIDEO_FIRST_FRAME);
      }
      if (data.seekBlit) {
        mark(VIDEO_SEEK_END);
        measure(VIDEO_SEEK_TO_BLIT, VIDEO_SEEK_START, VIDEO_SEEK_END);
      }
      window.__drivelineVideoLastBlitPtsNs = data.blitPtsNs;
    };

    let cancelled = false;
    // Open at the CURRENT cursor, not the session start. A VideoPanel is keyed
    // by source:channel and remounts whenever the bound channel changes, so
    // picking a different video track mid-session re-runs this effect. Opening
    // at `globalRange.startNs` would blit the first frame of the stream and
    // leave it parked there until playback advanced the cursor far enough for
    // the worker to catch up — the frame wouldn't sync to the cursor on its
    // own. The store guarantees `cursorNs` is always inside `globalRange`
    // (seeded to `startNs` on first load), so on a fresh drop this is still
    // `startNs`; on a re-pick it's where the user is actually looking. The
    // readers clamp the target to the nearest preceding keyframe.
    const openTargetNs = useSession.getState().cursorNs;
    // Worker-to-worker MCAP video bridge. `connectMcapVideoBridge` exposes
    // `{ openMcapVideoStream, mcapVideoNextBatch, closeMcapVideoStream }` on
    // bridge.port1 directly inside the dataCore worker, so MCAP chunk batches
    // travel dataCore→videoDecode without touching the main thread.
    //
    // Spawning a fresh dataCore inside the videoDecode worker is not an option:
    // a new wasm init gives it an empty slab, making `sourceHandle` invalid
    // there. This bridge reuses the live slab and its OPFS sync handles.
    const dc = useSession.getState().getWorker();
    const bridge = new MessageChannel();
    // Pass bridge.port1 into the dataCore worker; it will Comlink.expose the
    // MCAP stream API on that port. bridge.port2 goes to the videoDecode worker.
    void dc?.connectMcapVideoBridge(
      Comlink.transfer(bridge.port1, [bridge.port1]),
    );

    // Lazy mp4 bridge: encoded sample bytes for `mp4+sidecar` sources
    // come from `Mp4SampleCache` on the main thread, not from the
    // dataCore worker. Resolve the cache via the source handle since
    // the videoDecode worker only knows the wasm slab key.
    const findMp4Cache = (handle: number) => {
      const src = useSession
        .getState()
        .sources.find((s) => s.kind === "mp4+sidecar" && s.handle === handle);
      return src?.mp4Cache ?? null;
    };
    const mp4Bridge = new MessageChannel();
    const mp4Relay = {
      mp4Index: async (handle: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) throw new Error(`mp4 cache missing for handle ${handle}`);
        return cache.index;
      },
      mp4Sample: async (handle: number, idx: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) throw new Error(`mp4 cache missing for handle ${handle}`);
        return cache.getSample(idx);
      },
      mp4SetActive: async (handle: number, lo: number, hi: number) => {
        const cache = findMp4Cache(handle);
        if (!cache) return;
        const idxs: number[] = [];
        for (let i = lo; i <= hi; i++) idxs.push(i);
        cache.setActive(idxs);
        cache.prefetchRange(lo, hi);
      },
      mp4MarkPending: async (handle: number, targetNs: bigint) => {
        findMp4Cache(handle)?.markPendingFetch(targetNs);
      },
      mp4ClearPending: async (handle: number) => {
        findMp4Cache(handle)?.clearPendingFetch();
      },
    };
    Comlink.expose(mp4Relay, mp4Bridge.port1);

    (async () => {
      if (!dc) {
        console.error("VideoPanel: dataCore worker not initialised");
        return;
      }
      // Comlink needs an explicit transfer for MessagePort.
      await videoDecode.setDataCorePort(
        Comlink.transfer(bridge.port2, [bridge.port2]),
      );
      await videoDecode.setMp4LazyPort(
        Comlink.transfer(mp4Bridge.port2, [mp4Bridge.port2]),
      );
      await videoDecode.setFrameSink(
        Comlink.transfer(channel.port2, [channel.port2]),
      );
      if (cancelled) return;
      // v5: transfer the visible video canvas to the worker so it owns the
      // blit. `transferControlToOffscreen` is one-shot per element (a second
      // call throws) and detaches the element from any main-thread 2D/WebGL
      // context — which is exactly why the panel no longer draws here. The
      // element stays usable for CSS transforms (pan/zoom). jsdom/happy-dom
      // don't implement it, so guard for that (unit tests run the status path
      // without a real blit). Post the desired pixel size first so the worker
      // can pre-size the surface before the first frame lands.
      try {
        const desiredW = canvas.clientWidth || canvas.width || 1600;
        const desiredH = canvas.clientHeight || canvas.height || 900;
        await videoDecode.setRenderSize(desiredW, desiredH);
        if (
          !offscreenTransferredRef.current &&
          typeof canvas.transferControlToOffscreen === "function"
        ) {
          const offscreen = canvas.transferControlToOffscreen();
          offscreenTransferredRef.current = true;
          await videoDecode.setRenderCanvas(
            Comlink.transfer(offscreen, [offscreen]),
          );
        }
      } catch (e) {
        console.error("VideoPanel: OffscreenCanvas transfer failed", e);
      }
      if (cancelled) return;
      try {
        const result = await videoDecode.open(
          sourceKind,
          sourceHandle,
          channelId,
          openTargetNs,
        );
        codecRef.current = result.codec || null;
        // Seed the seek-dedupe ref so the mount cursor effect doesn't
        // issue a seek back to the same target that `open()` already took.
        lastSeekTargetRef.current = openTargetNs;
      } catch (e) {
        console.error("VideoPanel: open failed", e);
      }
    })();

    // Largest spin index with `times[i] <= ptsNs`, or -1 if before the first
    // spin. `times` is ascending. Same binary search the ScenePanel uses.
    const activeSpinIndex = (times: BigInt64Array, ptsNs: bigint): number => {
      if (times.length === 0 || ptsNs < times[0]) return -1;
      let lo = 0;
      let hi = times.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (times[mid] <= ptsNs) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    };

    // Fetch + decode + project the spin at `idx` into the cached projection
    // buffers. Coalesced: at most one outstanding refresh; a stale binding's
    // late result is dropped via the request token. Off the synchronous tick.
    const refreshOverlaySpin = (idx: number) => {
      const binding = overlayBindingRef.current;
      const calib = overlayCalibRef.current;
      const times = overlaySpinTimesRef.current;
      if (!binding || !calib || !times || idx < 0 || idx >= times.length) {
        return;
      }
      if (overlayBusyRef.current) return;
      overlayBusyRef.current = true;
      const token = ++overlayReqRef.current;
      const ts = times[idx];
      void (async () => {
        try {
          // Shared with the 3D scene panel: the spin is decoded once per
          // (channel, ts) and both viewers read the same buffers.
          const res = await fetchDecodedSpin(binding.pointcloudChannelId, ts);
          if (token !== overlayReqRef.current) return;
          if (!res.ok || res.count === 0) {
            overlayProjCountRef.current = 0;
            overlaySpinIdxRef.current = idx;
            overlayGenRef.current += 1;
            return;
          }
          // Grow the reusable projection buffers when the spin gets denser.
          let buf = overlayProjRef.current;
          if (!buf || buf.us.length < res.count) {
            buf = makeProjectionBuffers(res.count);
            overlayProjRef.current = buf;
          }
          const visible = projectPointsInto(
            calib,
            res.positions,
            res.count,
            buf,
          );
          overlayProjCountRef.current = res.count;
          overlaySpinIdxRef.current = idx;
          overlayGenRef.current += 1;
          setVideoOverlayInfo(panelId, {
            enabled: true,
            cameraName: binding.cameraName,
            spinTsNs: (res.tsNs ?? ts).toString(),
            pointCount: res.count,
            projectedVisibleCount: visible,
          });
        } catch {
          /* advisory overlay; leave the previous projection on screen */
        } finally {
          if (token === overlayReqRef.current) overlayBusyRef.current = false;
        }
      })();
    };

    // Per-tick overlay paint. Sizes the overlay canvas to the panel and, when
    // the active spin index changed, kicks a (coalesced) async refresh. The
    // actual clear + redraw of the cached projection only runs when the painted
    // pixels would differ from the last frame (see the dirty check below), so a
    // 60 Hz tick does not force a 60 Hz redraw of a cloud that changes at the
    // spin rate.
    const drawOverlay = () => {
      const overlayCanvas = overlayCanvasRef.current;
      const overlayCtx = overlayCanvas?.getContext("2d") ?? null;
      if (!overlayCanvas || !overlayCtx) return;
      const binding = overlayBindingRef.current;
      const calib = overlayCalibRef.current;
      const times = overlaySpinTimesRef.current;
      const blitPts = lastBlitPtsRef.current;
      const drawn = overlayDrawnRef.current;
      // Match the overlay canvas's pixel buffer to its CSS box (the panel) so
      // its coordinate space is panel pixels. Setting width/height clears the
      // canvas, so only touch it on an actual size change.
      const cw = overlayCanvas.clientWidth;
      const ch = overlayCanvas.clientHeight;
      if (cw > 0 && ch > 0) {
        if (overlayCanvas.width !== cw) overlayCanvas.width = cw;
        if (overlayCanvas.height !== ch) overlayCanvas.height = ch;
      }

      if (!binding || !calib || !times || blitPts === null) {
        // Nothing to project. Clear once on the transition into this state so a
        // stale cloud doesn't linger; then stay idle (no per-tick clears).
        if (drawn.gen !== -1) {
          overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
          drawn.gen = -1;
        }
        return;
      }
      // Refetch only when the active spin actually changes.
      const idx = activeSpinIndex(times, blitPts);
      if (idx !== overlaySpinIdxRef.current && idx >= 0) {
        refreshOverlaySpin(idx);
      }
      const { near, far } = overlayDepthsRef.current;

      // The overlay canvas is a separate layer stacked over the video, and
      // zoom/pan is a CSS transform on the element — not a pixel redraw. So the
      // painted pixels are a pure function of the projected spin
      // (`overlayGenRef`), the canvas size, and the depth range. When none of
      // those changed since the last paint, the cached pixels are still correct
      // and we skip the (expensive) clear + per-point redraw entirely. This
      // collapses a ~60 Hz redraw into a ~spin-rate one, freeing the main
      // thread for the video blit and keeping playback smooth under load.
      const gen = overlayGenRef.current;
      if (
        drawn.gen === gen &&
        drawn.w === overlayCanvas.width &&
        drawn.h === overlayCanvas.height &&
        drawn.near === near &&
        drawn.far === far
      ) {
        return;
      }
      drawn.gen = gen;
      drawn.w = overlayCanvas.width;
      drawn.h = overlayCanvas.height;
      drawn.near = near;
      drawn.far = far;

      mark(OVERLAY_DRAW_START);
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      const buf = overlayProjRef.current;
      const count = overlayProjCountRef.current;
      if (buf && count > 0) {
        // Rebuild the colour palette only when the depth range changes.
        let palette = overlayPaletteRef.current;
        if (!palette || palette.near !== near || palette.far !== far) {
          palette = buildDepthPalette(near, far);
          overlayPaletteRef.current = palette;
        }
        const rect = contentRect(
          calib.intrinsics.width,
          calib.intrinsics.height,
          overlayCanvas.width,
          overlayCanvas.height,
        );
        const radius = Math.max(1, rect.width / 760);
        const fw = calib.intrinsics.width;
        const fh = calib.intrinsics.height;
        const sx = rect.width / fw;
        const sy = rect.height / fh;
        // One Path2D per depth bucket: accumulate every dot, then emit a single
        // fill per bucket. Turns a fillStyle assignment + beginPath + arc +
        // fill *per point* into ~`buckets` fills total — the dominant overlay
        // cost when a dense spin lands. Path2D has no clear, so re-allocate.
        let paths = overlayBucketPathsRef.current;
        if (!paths || paths.length !== palette.buckets) {
          paths = Array.from({ length: palette.buckets }, () => new Path2D());
        } else {
          for (let b = 0; b < paths.length; b++) paths[b] = new Path2D();
        }
        overlayBucketPathsRef.current = paths;
        const TWO_PI = Math.PI * 2;
        for (let i = 0; i < count; i++) {
          if (buf.visible[i] === 0) continue;
          const px = rect.left + buf.us[i] * sx;
          const py = rect.top + buf.vs[i] * sy;
          const path = paths[depthBucketIndex(buf.depths[i], palette)];
          // `moveTo` before `arc` starts a fresh subpath so the dots don't get
          // chained together by an implicit line from the previous arc's end.
          path.moveTo(px + radius, py);
          path.arc(px, py, radius, 0, TWO_PI);
        }
        for (let b = 0; b < paths.length; b++) {
          overlayCtx.fillStyle = palette.colors[b];
          overlayCtx.fill(paths[b]);
        }
      }
      mark(OVERLAY_DRAW_END);
      measure(OVERLAY_DRAW, OVERLAY_DRAW_START, OVERLAY_DRAW_END);
    };

    const tick = () => {
      const cursor = cursorRef.current;
      // T7 — is the cursor inside this source's frame coverage?
      const covStart = coverageStartRef.current;
      const covEnd = coverageEndRef.current;
      const outOfCoverage =
        covStart !== null &&
        covEnd !== null &&
        (cursor < covStart || cursor > covEnd);

      // v5: the worker owns the video blit, so the panel no longer draws a
      // frame here. Coverage handling moves to a worker request: on entry into
      // an uncovered region, ask the worker to paint the canvas black once (so
      // a stale frame from another time doesn't linger); reset the latch on
      // re-entry into coverage. Readiness below reports "uncovered"
      // (non-gating), so playback keeps rolling for the other panels.
      if (outOfCoverage) {
        if (!uncoveredPaintedRef.current) {
          uncoveredPaintedRef.current = true;
          lastBlitPtsRef.current = null;
          window.__drivelineVideoLastBlitPtsNs = null;
          void videoDecodeRef.current?.paintBlack().catch(() => undefined);
        }
      } else {
        uncoveredPaintedRef.current = false;
      }

      // Point-cloud overlay (docs/13). After the video blit, project the LiDAR
      // spin nearest the on-screen frame PTS onto the overlay canvas. The heavy
      // fetch+decode+project is coalesced to ≤1 outstanding refresh and only
      // re-run when the active spin index (or the calibration) changes — so the
      // per-tick cost is just a clear+redraw of the cached projection, which we
      // bracket with a perf measure to keep it inside the hot-path budget.
      drawOverlay();

      // Publish a HUD snapshot every tick. Cheap (plain object) and the
      // dev hook needs it available whether or not the HUD is visible.
      const snapshot: VideoHudSnapshot = {
        ptsNs: lastBlitPtsRef.current,
        frameIndex: lastFrameIndexRef.current,
        decodeQueue: lastDecodeQueueRef.current,
        blitQueueLen: blitQueueLenRef.current,
        dropped: droppedFramesRef.current,
        codec: codecRef.current,
        hudOn: hudOnRef.current,
      };
      window.__drivelineVideoHud = snapshot;
      if (hudOnRef.current && hudDomRef.current) {
        const hudText =
          `PTS         ${formatPts(snapshot.ptsNs)}\n` +
          `frame #     ${snapshot.frameIndex}\n` +
          `decodeQueue ${snapshot.decodeQueue}\n` +
          `blitQueue   ${snapshot.blitQueueLen} / ${MAX_QUEUE}\n` +
          `dropped     ${snapshot.dropped}\n` +
          `codec       ${snapshot.codec ?? "—"}`;
        // Mirror the className guard below — skip the DOM write when unchanged.
        if (hudText !== lastHudTextRef.current) {
          lastHudTextRef.current = hudText;
          hudDomRef.current.textContent = hudText;
        }
      }
      // Subtle always-on stats strip. Lag is `cursor - lastBlitPts`,
      // i.e. how far behind the cursor the visible frame is — usually
      // 0–33 ms when the pipeline is healthy, larger if the decoder is
      // falling behind. We light the strip up in the error colour when
      // either drops > 0 or the visible frame is more than two content
      // frames stale, so a glance at the panel is enough to catch
      // regressions while watching playback.
      const stats = statsDomRef.current;
      if (stats) {
        let lagText = "—";
        let lagWarn = false;
        if (snapshot.ptsNs !== null) {
          const lagNs = cursor - snapshot.ptsNs;
          const lagMs = Number(lagNs / 1_000_000n);
          lagText = `${lagMs}ms`;
          lagWarn = lagMs > 66; // > 2 frames at 30fps
        }
        const statsText =
          `drop ${snapshot.dropped}` +
          `  lag ${lagText}` +
          `  q ${snapshot.blitQueueLen}/${MAX_QUEUE}`;
        // Only write textContent when the string changed, mirroring the
        // className guard below.
        if (statsText !== lastStatsTextRef.current) {
          lastStatsTextRef.current = statsText;
          stats.textContent = statsText;
        }
        const warn = snapshot.dropped > 0 || lagWarn;
        const cls = warn ? `${styles.stats} ${styles.statsWarn}` : styles.stats;
        if (stats.className !== cls) stats.className = cls;
      }

      // Issue #2 — publish per-panel readiness. The rAF blit loop is
      // the single source of truth for "has a frame within ε of the
      // cursor actually been blitted." Routing this through the same
      // tick keeps the readiness signal honest with the on-canvas HUD.
      //
      // Predicate: ready iff a frame has been blitted AND that frame's
      // PTS is within READY_EPSILON_NS behind (or anywhere ahead of)
      // the cursor. Cursor-ahead-of-frame within ε is the steady-state
      // shape during playback; cursor-behind-frame happens after a
      // backwards scrub and is also "ready" (frame is on canvas).
      const nowMsRead = performance.now();
      const lastBlitPts = lastBlitPtsRef.current;
      let isReady = false;
      if (lastBlitPts !== null) {
        const behindNs = cursor - lastBlitPts;
        // Tight arm: visible frame is within ε of cursor. behindNs<0
        // means cursor is *behind* the visible frame (just-scrubbed-
        // back), which is also ready.
        if (behindNs <= READY_EPSILON_NS) {
          isReady = true;
        } else {
          // Loose arm A: decoder is producing frames recently.
          // Without this, a 4K stream whose decoder is real-time but
          // per-frame arrival jitters a couple of frames behind cursor
          // would trip the tight arm constantly, gate would engage,
          // worker pacing would follow the gated cursor, and playback
          // would throttle into a feedback loop.
          if (
            nowMsRead - lastFrameArrivedLocalMsRef.current <=
            FRAME_LIVE_WINDOW_MS
          ) {
            isReady = true;
          } else if (blitQueueLenRef.current > 0) {
            // Loose arm B: the worker's blit queue still holds frames the
            // panel hasn't reached yet. The worker always blits the newest
            // frame ≤ cursor immediately, so anything still queued is ahead
            // of the cursor — the decoder finished its lookahead burst and
            // went idle by design (worker pacing). The panel catches up as
            // the cursor advances; this is not a stall.
            isReady = true;
          }
        }
      }

      // Compute readiness state with stalled escalation.
      let nextState: ReadyState;
      if (outOfCoverage) {
        // The cursor is outside this source's coverage — there is no frame
        // to wait for. Report "uncovered" (the playback gate treats it as
        // non-blocking, like "stalled") and reset the wait clock so a later
        // jump back into coverage doesn't inherit a stale "we've been
        // waiting forever" timestamp and instantly escalate to stalled.
        nextState = "uncovered";
        waitingSinceMsRef.current = null;
      } else if (isReady) {
        nextState = "ready";
        waitingSinceMsRef.current = null;
        lastReadyMsRef.current = nowMsRead;
      } else {
        // Not-ready. Either we just transitioned out of ready or we've
        // been waiting since some earlier tick. Track when the wait
        // started so the Transport can apply hysteresis.
        if (waitingSinceMsRef.current === null) {
          waitingSinceMsRef.current = nowMsRead;
          lastFrameIndexAtWaitStartRef.current = lastFrameIndexRef.current;
        }
        const waitedMs = nowMsRead - waitingSinceMsRef.current;
        // If `frameIndex` advanced since the wait started, the decoder
        // is alive — reset the stalled clock by re-anchoring the wait
        // start to "now" with the current frameIndex. Keeps a slow but
        // healthy pipeline from being declared stalled.
        if (
          lastFrameIndexRef.current !== lastFrameIndexAtWaitStartRef.current
        ) {
          waitingSinceMsRef.current = nowMsRead;
          lastFrameIndexAtWaitStartRef.current = lastFrameIndexRef.current;
          nextState = "waiting";
        } else if (waitedMs >= STALLED_TIMEOUT_MS) {
          nextState = "stalled";
        } else {
          nextState = "waiting";
        }
      }

      const scratch = readinessScratchRef.current;
      scratch.state = nextState;
      scratch.lastReadyMs = lastReadyMsRef.current;
      scratch.waitingSinceMs = waitingSinceMsRef.current;
      scratch.lastBlitPtsNs = lastBlitPts;
      setPanelReadiness(panelId, scratch);

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
      port.onmessage = null;
      // v5: no local frame queue to close — the worker owns/closes frames.
      // The worker is terminated below, which drops its canvas + queue.
      lastSeekTargetRef.current = null;
      lastCursorSentRef.current = null;
      codecRef.current = null;
      lastFrameIndexRef.current = 0;
      lastDecodeQueueRef.current = 0;
      blitQueueLenRef.current = 0;
      droppedFramesRef.current = 0;
      lastBlitPtsRef.current = null;
      decodeErrorRef.current = null;
      lastHudTextRef.current = "";
      lastStatsTextRef.current = "";
      // Issue #2 — drop our entry from the readiness registry so the
      // playback rAF doesn't keep gating on an unmounted panel.
      waitingSinceMsRef.current = null;
      lastFrameIndexAtWaitStartRef.current = 0;
      lastReadyMsRef.current = 0;
      lastFrameArrivedLocalMsRef.current = 0;
      lastWorkerFrameArrivedMsRef.current = 0;
      clearPanelReadiness(panelId);
      window.__drivelineVideoHud = undefined;
      // Don't leave a ghost blit PTS behind: the next panel to mount (e.g. a
      // track re-pick) must not read a stale frame timestamp from this one.
      window.__drivelineVideoLastBlitPtsNs = null;
      const dc = videoDecodeRef.current;
      const w = videoDecodeWorkerRef.current;
      videoDecodeRef.current = null;
      videoDecodeWorkerRef.current = null;
      if (dc) {
        dc.close()
          .catch(() => undefined)
          .finally(() => {
            dc[Comlink.releaseProxy]();
            w?.terminate();
          });
      } else {
        w?.terminate();
      }
    };
  }, [sourceKind, sourceHandle, channelId, globalRange?.startNs, panelId]);

  // Issue #2 — mirror our own readiness state into local React state so
  // we can render the inline "stream stalled" badge. The subscriber is
  // coalesced (rAF-batched) and only fires on state transitions, so this
  // does NOT trigger a 60 Hz render.
  useEffect(() => {
    const sync = () => {
      const r = getReadinessSnapshot().get(panelId);
      setReadyState(r?.state ?? "absent");
    };
    sync();
    const unsub = subscribeReadiness(sync);
    return () => unsub();
  }, [panelId]);

  // Overlay binding effect. When the binding (or its calibration camera /
  // point-cloud channel) changes, resolve the camera calibration and load the
  // point-cloud spin timestamps, then mirror everything the rAF tick needs into
  // refs. Reset the cached projection so the next tick recomputes. None of this
  // is on the cursor hot path — it runs once per binding change.
  useEffect(() => {
    overlayBindingRef.current = overlayBinding;
    overlayCalibRef.current = null;
    overlaySpinTimesRef.current = null;
    overlaySpinIdxRef.current = -1;
    overlayProjCountRef.current = 0;
    // Clear stale dots immediately when the binding goes away / changes.
    const oc = overlayCanvasRef.current;
    if (oc) {
      const octx = oc.getContext("2d");
      if (octx) octx.clearRect(0, 0, oc.width, oc.height);
    }
    if (!overlayBinding) {
      setVideoOverlayInfo(panelId, {
        enabled: false,
        cameraName: null,
        spinTsNs: null,
        pointCount: 0,
        projectedVisibleCount: 0,
      });
      return;
    }
    let aborted = false;
    void (async () => {
      const st = useSession.getState();
      const cams = await st.loadCalibration(
        overlayBinding.calibrationChannelId,
      );
      if (aborted || overlayBindingRef.current !== overlayBinding) return;
      const cam =
        cams.find((c) => c.name === overlayBinding.cameraName) ?? null;
      overlayCalibRef.current = cam;
      try {
        const times = await st.lidarSpinTimes(
          overlayBinding.pointcloudChannelId,
        );
        if (aborted || overlayBindingRef.current !== overlayBinding) return;
        overlaySpinTimesRef.current = times;
      } catch {
        overlaySpinTimesRef.current = null;
      }
      setVideoOverlayInfo(panelId, {
        enabled: true,
        cameraName: overlayBinding.cameraName,
        spinTsNs: null,
        pointCount: 0,
        projectedVisibleCount: 0,
      });
    })();
    return () => {
      aborted = true;
    };
  }, [overlayBinding, panelId]);

  useEffect(() => () => clearVideoOverlayInfo(panelId), [panelId]);

  // v5: keep the worker's notion of the panel's pixel size current. The worker
  // can't read the transferred OffscreenCanvas's CSS box, and it can't be sized
  // from the main thread post-transfer, so the panel posts the desired size on
  // mount (in the worker effect) and on every resize here. Sizing is advisory
  // today — the worker sizes the surface to the decoded frame's intrinsic
  // dimensions and CSS object-fit letterboxes the element — but honouring the
  // contract keeps the seam correct for a future intrinsic-vs-container mode.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) {
        void videoDecodeRef.current?.setRenderSize(w, h).catch(() => undefined);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // Wheel-to-zoom. Registered as a native, non-passive listener because
  // React's synthetic onWheel is passive — `preventDefault` there is a
  // no-op and the page/panel would scroll instead of zooming. The anchor
  // is the pointer position relative to the panel centre so the pixel under
  // the cursor stays put as you spin the wheel.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const qcx = e.clientX - rect.left - rect.width / 2;
      const qcy = e.clientY - rect.top - rect.height / 2;
      const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENSITIVITY);
      zoomToward(zoomScaleRef.current * factor, qcx, qcy);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [zoomToward]);

  // Drag-to-pan when magnified. Pointer capture keeps the gesture alive even
  // if the pointer leaves the panel mid-drag.
  const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (zoomScaleRef.current <= 1) return;
    panActiveRef.current = true;
    panStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: zoomTxRef.current,
      ty: zoomTyRef.current,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    applyZoomTransform();
  };
  const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = panStartRef.current;
    if (!panActiveRef.current || !start) return;
    zoomTxRef.current = start.tx + (e.clientX - start.x);
    zoomTyRef.current = start.ty + (e.clientY - start.y);
    clampPan();
    applyZoomTransform();
  };
  const onCanvasPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!panActiveRef.current) return;
    panActiveRef.current = false;
    panStartRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    applyZoomTransform();
  };

  const onRetry = () => {
    // Re-issue a seek against the current cursor. The seek pipeline
    // tears down + reconfigures the decoder, which is exactly what a
    // user pressing "retry" on a broken stream wants. `force` bypasses
    // the worker's duplicate-target / coalescing guards so retry always
    // re-primes — otherwise a stall whose cursor still equals the last
    // opened target (or a seek superseded mid-stall) would no-op and the
    // stream would stay frozen.
    const target = useSession.getState().cursorNs;
    const client = videoDecodeRef.current;
    if (!client) return;
    waitingSinceMsRef.current = null;
    lastReadyMsRef.current = performance.now();
    // Task 2 — optimistically drop the error badge; if the retry's re-open
    // fails again the worker re-posts `decode-error` and we flip back.
    decodeErrorRef.current = null;
    setDecodeError(null);
    // Bracket the retry's seek-to-blit latency too (Task 4). The worker arms
    // its seek-blit flag inside `seek()`; the first post-seek STATUS message
    // carries `seekBlit: true`, and the sink handler closes the bracket here.
    mark(VIDEO_SEEK_START);
    void client.seek(target, true).catch(() => undefined);
  };

  // Cursor + seek side effect.
  //
  // Subscribed to the store directly (not via a reactive selector) so
  // cursor ticks at 60 Hz don't re-render this panel — the rAF blit
  // loop reads `cursorRef.current` imperatively.
  //
  // Seek decisions are driven by `seekEpoch`, not by `cursorNs`:
  // playback rAF advances via `advanceCursor` (which leaves `seekEpoch`
  // alone) so a natural 60 Hz tick is invisible here, while every
  // user-initiated `setCursor` (scrub, keyboard step, Home/End,
  // play-from-end rewind) bumps the epoch and fires a debounced seek.
  // That fixes the "video freezes on scrub during playback" symptom
  // — previously the seek was suppressed whenever `playing` was true,
  // so the canvas held the old frame until natural decoder advance
  // caught up to the new cursor. The epoch counter lets us seek even
  // during play without misreading playback ticks as scrubs.
  useEffect(() => {
    cursorRef.current = useSession.getState().cursorNs;
    // Coalesce setCursor against ~one frame at 30fps so a 60 Hz tick
    // doesn't churn 60 postMessages per second, but the worker's view
    // of the cursor never drifts more than a frame behind reality.
    // Earlier we coalesced at LOOKAHEAD_NS/2 (150 ms); that caused the
    // worker to sit idle for the first ~300 ms of play after open
    // because the pacing gate (lastEmittedPtsNs - cursorNs ≤ 300 ms)
    // didn't trip until cursorNs caught up — and with a 150 ms-stale
    // worker cursor that took two coalesce intervals, long enough to
    // drain the panel queue on slower decoders and freeze the canvas.
    const SETCURSOR_DELTA_NS = 33_000_000n;
    const unsubscribe = useSession.subscribe((state, prev) => {
      cursorRef.current = state.cursorNs;
      if (state.cursorNs !== prev.cursorNs) {
        // Push the cursor watermark to the worker so the decoder can
        // pace itself against playback — without this the decoder
        // races to the end of the encoded stream, frames pile up past
        // the cursor, and the bounded queue empties while the cursor
        // is still mid-session.
        const last = lastCursorSentRef.current;
        const delta =
          last === null
            ? SETCURSOR_DELTA_NS
            : state.cursorNs > last
              ? state.cursorNs - last
              : last - state.cursorNs;
        if (last === null || delta >= SETCURSOR_DELTA_NS) {
          lastCursorSentRef.current = state.cursorNs;
          const client = videoDecodeRef.current;
          if (client)
            void client.setCursor(state.cursorNs).catch(() => undefined);
        }
      }
      if (state.seekEpoch === prev.seekEpoch) return;
      if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
      seekTimerRef.current = setTimeout(() => {
        seekTimerRef.current = null;
        const client = videoDecodeRef.current;
        if (!client) return;
        const target = useSession.getState().cursorNs;
        if (lastSeekTargetRef.current === target) return;
        lastSeekTargetRef.current = target;
        // The seek itself resets the worker's notion of cursor, so the
        // setCursor coalescer should re-baseline at the same target.
        lastCursorSentRef.current = target;
        // Task 4 — open the seek-to-blit bracket on the MAIN-thread perf
        // timeline. The worker flushes its blit queue + arms its seek-blit
        // flag inside `seek()`; the first post-seek STATUS carries
        // `seekBlit: true`, and the sink handler stamps VIDEO_SEEK_END +
        // the VIDEO_SEEK_TO_BLIT measure here on the main thread.
        mark(VIDEO_SEEK_START);
        void client.seek(target).catch(() => undefined);
      }, SEEK_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (seekTimerRef.current !== null) {
        clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, []);

  // `h` toggles the HUD, but only when focus is inside the panel wrapper —
  // we don't want to hijack the key when the drop zone or a form input
  // owns focus.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Keyboard zoom accelerators — the wheel/drag gestures aren't reachable
    // without a pointer, so mirror them on the keyboard. Anchored at the
    // panel centre (0, 0). `+`/`=` in, `-`/`_` out, `0` reset to fit.
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      zoomToward(zoomScaleRef.current * ZOOM_KEY_STEP, 0, 0);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      zoomToward(zoomScaleRef.current / ZOOM_KEY_STEP, 0, 0);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      resetZoom();
      return;
    }
    if (e.key !== "h" && e.key !== "H") return;
    e.preventDefault();
    toggleHud();
  };

  // Overlay control handlers. The binding only becomes active once all three
  // parts are chosen; the pickers patch the current (or a freshly-defaulted)
  // binding and commit via `setPointCloudOverlay`. Picking "— none —" anywhere
  // clears the overlay for this panel.
  const setOverlay = useSession((s) => s.setPointCloudOverlay);
  const commitOverlay = useCallback(
    (patch: Partial<PointCloudOverlayBinding>) => {
      const cur = useSession.getState().pointCloudOverlays[panelId] ?? null;
      const next: Partial<PointCloudOverlayBinding> = {
        calibrationChannelId:
          cur?.calibrationChannelId ?? activeCalibChannelId ?? undefined,
        cameraName: cur?.cameraName,
        pointcloudChannelId:
          cur?.pointcloudChannelId ?? pointCloudChannels[0]?.id,
        ...patch,
      };
      if (
        next.calibrationChannelId &&
        next.cameraName &&
        next.pointcloudChannelId
      ) {
        setOverlay(panelId, {
          calibrationChannelId: next.calibrationChannelId,
          cameraName: next.cameraName,
          pointcloudChannelId: next.pointcloudChannelId,
        });
      } else {
        setOverlay(panelId, null);
      }
    },
    [panelId, activeCalibChannelId, pointCloudChannels, setOverlay],
  );
  const onToggleOverlay = () => {
    if (overlayBinding !== null) {
      setOverlay(panelId, null);
      setOverlayMenuOpen(false);
      return;
    }
    // Open the pickers so the auto-chosen defaults can be adjusted (an Alpamayo
    // bundle carries 7 cameras — the user may want a different one).
    setOverlayMenuOpen(true);
    if (!activeCalibChannelId) return;
    const pc = pickOverlayPointCloud(pointCloudChannels);
    if (!pc) return;
    // Auto-commit a binding so the toggle "just works" in one click. Pick the
    // calibration camera that matches THIS panel's video (by source filename)
    // and a LiDAR cloud, so a multi-camera rig gets a *correct* overlay rather
    // than the wrong camera's extrinsic (which projects the spin nowhere
    // sensible). On the first toggle the calibration may not be decoded yet
    // (cold cache): commit synchronously when warm, else await the decode.
    const commit = (cams: CameraCalibration[]) => {
      const cam = pickOverlayCamera(cams, videoSourceName);
      if (cam) {
        setOverlay(panelId, {
          calibrationChannelId: activeCalibChannelId,
          cameraName: cam,
          pointcloudChannelId: pc,
        });
      }
    };
    if (camerasForActiveCalib.length > 0) {
      commit(camerasForActiveCalib);
    } else {
      void useSession
        .getState()
        .loadCalibration(activeCalibChannelId)
        .then(commit);
    }
  };
  const onPickCalibration = (id: string) => {
    if (!id) {
      setOverlay(panelId, null);
      return;
    }
    void useSession.getState().loadCalibration(id);
    commitOverlay({ calibrationChannelId: id, cameraName: undefined });
  };
  const onPickCamera = (name: string) => {
    commitOverlay({ cameraName: name || undefined });
  };
  const onPickPointCloud = (id: string) => {
    commitOverlay({ pointcloudChannelId: id || undefined });
  };

  return (
    <div className={styles.panel} tabIndex={0} onKeyDown={onKeyDown}>
      <canvas
        ref={canvasRef}
        data-testid="video-panel-canvas"
        className={styles.canvas}
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onCanvasPointerMove}
        onPointerUp={onCanvasPointerUp}
        onPointerCancel={onCanvasPointerUp}
      />
      {/* Point-cloud overlay canvas (docs/13) — always mounted (empty when no
       *  binding) so the rAF tick can size + draw into it without remounting.
       *  pointer-events:none lets the pan/zoom gestures fall through to the
       *  video canvas underneath. */}
      <canvas
        ref={overlayCanvasRef}
        data-testid="video-overlay-canvas"
        className={styles.overlayCanvas}
        aria-hidden="true"
      />
      {/* Overlay control cluster — toggle + camera / point-cloud pickers. */}
      <div className={styles.overlayControls}>
        <button
          type="button"
          data-testid="video-overlay-toggle"
          className={styles.overlayToggle}
          aria-pressed={overlayBinding !== null}
          aria-expanded={overlayMenuOpen}
          onClick={onToggleOverlay}
          disabled={
            calibrationChannels.length === 0 || pointCloudChannels.length === 0
          }
          title={
            calibrationChannels.length === 0 || pointCloudChannels.length === 0
              ? "Load a calibration (.calib.json) and a LiDAR point-cloud source first"
              : "Toggle the LiDAR point-cloud overlay"
          }
        >
          LiDAR overlay
        </button>
        {overlayMenuOpen && (
          <div
            className={styles.overlayPickers}
            data-testid="video-overlay-pickers"
          >
            <label className={styles.overlaySelectLabel}>
              Calibration
              <select
                className={styles.overlaySelect}
                data-testid="video-overlay-calib-select"
                value={overlayBinding?.calibrationChannelId ?? ""}
                onChange={(e) => onPickCalibration(e.target.value)}
              >
                <option value="">— none —</option>
                {calibrationChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.overlaySelectLabel}>
              Camera
              <select
                className={styles.overlaySelect}
                data-testid="video-overlay-camera-select"
                value={overlayBinding?.cameraName ?? ""}
                onChange={(e) => onPickCamera(e.target.value)}
                disabled={camerasForActiveCalib.length === 0}
              >
                <option value="">— none —</option>
                {camerasForActiveCalib.map((cam) => (
                  <option key={cam.name} value={cam.name}>
                    {cam.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.overlaySelectLabel}>
              Point cloud
              <select
                className={styles.overlaySelect}
                data-testid="video-overlay-pointcloud-select"
                value={overlayBinding?.pointcloudChannelId ?? ""}
                onChange={(e) => onPickPointCloud(e.target.value)}
              >
                <option value="">— none —</option>
                {pointCloudChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>
      {/* Top-right cluster: the HUD toggle, plus the Reset-zoom affordance to
       *  its left while magnified. Grouping them in one pinned row keeps them
       *  from overlapping each other or the LiDAR overlay controls (top-left).
       *  Reset zoom is only mounted while magnified, so it stays out of the
       *  way during normal playback. */}
      <div className={styles.topRightControls}>
        {zoomed && (
          <button
            type="button"
            data-testid="video-zoom-reset"
            className={styles.zoomReset}
            onClick={resetZoom}
          >
            Reset zoom
          </button>
        )}
        <button
          type="button"
          data-testid="video-hud-toggle"
          className={styles.hudToggle}
          aria-pressed={hudOn}
          onClick={toggleHud}
        >
          HUD
        </button>
      </div>
      {hudOn && (
        <div ref={hudDomRef} data-testid="video-hud" className={styles.hud} />
      )}
      <div
        ref={statsDomRef}
        data-testid="video-stats"
        className={styles.stats}
        aria-live="off"
      />
      {/* T7 — neutral "no video at this time" pill when the cursor is
       *  outside this source's coverage. Distinct from the stalled badge:
       *  informational, no retry (there is nothing to retry — the source
       *  simply has no frame here). */}
      {readyState === "uncovered" && (
        <div
          className={styles.uncoveredBadge}
          data-testid="video-panel-uncovered-badge"
          role="status"
        >
          <span>no video at this time</span>
        </div>
      )}
      {/* Issue #2 / Task 2 — inline error badge. Reuses the stalled-badge
       *  UI for two failure modes: a latched fatal decode error surfaced
       *  proactively by the worker (decodeError !== null), or the slower
       *  5 s stall escalation (readyState === "stalled"). The decode error
       *  takes precedence so its more-specific copy wins when both are
       *  true. "waiting" is the Transport's responsibility (the orange dot
       *  next to play) and is intentionally excluded here. */}
      {(decodeError !== null || readyState === "stalled") && (
        <div
          className={styles.stalledBadge}
          data-testid="video-panel-stalled-badge"
          data-error={decodeError !== null ? "decode" : "stall"}
          role="alert"
        >
          <span>
            {decodeError !== null ? "decode error" : "stream stalled"}
          </span>
          <button
            type="button"
            className={styles.stalledRetry}
            data-testid="video-panel-stalled-retry"
            onClick={onRetry}
          >
            retry
          </button>
        </div>
      )}
    </div>
  );
}
