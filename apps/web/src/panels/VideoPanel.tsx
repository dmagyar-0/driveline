// T5.1 · VideoPanel (MCAP path) — extended in T5.2 with a perf HUD and a
// tighter seek pipeline.
//
// Owns: a <canvas>, a small VideoFrame queue fed by the videoDecode worker
// over a MessagePort, and a rAF loop that blits the frame whose PTS is
// closest to the current cursor. Seek is a trailing-debounced side effect
// on `cursorNs`. FlexLayout docking is T6.2 — for now the panel renders in
// a plain container from App.tsx.
//
// T5.2 additions: a toggleable HUD (current PTS, frame index, decode queue,
// blit queue, dropped frames, codec) and guards that skip seeks that
// duplicate the open target or the last-issued target.

import { useCallback, useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import { useSession } from "../state/store";
import { makeVideoDecodeClient } from "../workerClient";
import type { VideoDecodeApi } from "../workerClient";
import {
  mark,
  measure,
  VIDEO_FIRST_FRAME,
  VIDEO_SEEK_END,
  VIDEO_SEEK_START,
  VIDEO_SEEK_TO_BLIT,
} from "../perf";
import {
  clearPanelReadiness,
  getReadinessSnapshot,
  setPanelReadiness,
  subscribeReadiness,
  type PanelReadiness,
  type ReadyState,
} from "./videoReadiness";
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
}

interface QueueEntry {
  ptsNs: bigint;
  frame: VideoFrame;
  frameIndex: number;
  decodeQueue: number;
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
}: VideoPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const queueRef = useRef<QueueEntry[]>([]);
  const cursorRef = useRef<bigint>(0n);
  const rafRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizedRef = useRef<boolean>(false);
  // T7 — bound source's frame-coverage bounds, mirrored into refs so the
  // rAF blit loop can read them without a reactive selector on the hot path.
  // `uncoveredPaintedRef` debounces the black-fill so we clear the canvas
  // once on entry into an uncovered region rather than every tick.
  const coverageStartRef = useRef<bigint | null>(null);
  const coverageEndRef = useRef<bigint | null>(null);
  const uncoveredPaintedRef = useRef<boolean>(false);
  const videoDecodeRef = useRef<Comlink.Remote<VideoDecodeApi> | null>(null);
  const videoDecodeWorkerRef = useRef<Worker | null>(null);
  // Task 4 — set true when a debounced seek is dispatched (VIDEO_SEEK_START
  // marked); the rAF blit loop consumes it on the first post-seek blit to
  // stamp VIDEO_SEEK_END and emit the VIDEO_SEEK_TO_BLIT measure. A plain
  // boolean ref so the hot path neither allocates nor touches the store.
  const seekPendingBlitRef = useRef<boolean>(false);

  // HUD refs. We keep them off React state so metric updates don't churn
  // the reconciler; the rAF loop writes directly into the HUD DOM.
  // Task 3 — cache last written HUD/stats strings to skip identical DOM writes.
  const lastHudTextRef = useRef<string>("");
  const lastStatsTextRef = useRef<string>("");
  const lastFrameIndexRef = useRef<number>(0);
  const lastDecodeQueueRef = useRef<number>(0);
  const droppedFramesRef = useRef<number>(0);
  const lastBlitPtsRef = useRef<bigint | null>(null);
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
  // `lastFrameArrivedMsRef` is bumped on every decoder frame arrival
  // (in `port.onmessage`) — drives the "decoder alive" arm of the
  // readiness predicate.
  const readinessScratchRef = useRef<PanelReadiness>({
    state: "absent",
    lastReadyMs: 0,
    waitingSinceMs: null,
    lastBlitPtsNs: null,
  });
  const waitingSinceMsRef = useRef<number | null>(null);
  const lastFrameIndexAtWaitStartRef = useRef<number>(0);
  const lastReadyMsRef = useRef<number>(0);
  const lastFrameArrivedMsRef = useRef<number>(0);

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
  // target once the worker has accepted it. The debounced cursor effect
  // skips a `seek()` that matches this — preventing a redundant seek on
  // mount when the cursor equals `globalRange.startNs`.
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const { proxy: videoDecode, worker: videoDecodeWorker } =
      makeVideoDecodeClient();
    videoDecodeRef.current = videoDecode;
    videoDecodeWorkerRef.current = videoDecodeWorker;
    const channel = new MessageChannel();
    const port = channel.port1;

    port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as
        | {
            ptsNs: bigint;
            frame: VideoFrame;
            frameIndex: number;
            decodeQueue: number;
          }
        | { type: "decode-error"; reason: string }
        | null;
      if (!data) return;
      // Task 2 — control message: the worker latched a fatal decode fault.
      // Surface it proactively so the panel doesn't sit on a frozen canvas
      // until the 5 s stall timeout escalates. No VideoFrame to close here
      // (control messages carry no transferables).
      if ("type" in data) {
        if (decodeErrorRef.current === null) {
          decodeErrorRef.current = data.reason;
          setDecodeError(data.reason);
        }
        return;
      }
      const { ptsNs, frame, frameIndex, decodeQueue } = data;
      // A fresh frame means the stream recovered (e.g. after a forced-seek
      // retry re-primed the decoder); clear any standing decode-error badge.
      if (decodeErrorRef.current !== null) {
        decodeErrorRef.current = null;
        setDecodeError(null);
      }
      lastFrameIndexRef.current = frameIndex;
      lastDecodeQueueRef.current = decodeQueue;
      // Issue #2 — wall clock of the most recent frame arrival.
      // Drives the "decoder is alive" arm of the readiness predicate
      // so a healthy 4K stream that briefly outpaces ε is still
      // reported as ready instead of constantly tripping the gate.
      lastFrameArrivedMsRef.current = performance.now();
      if (!sizedRef.current) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        sizedRef.current = true;
      }
      // The decoder produces frames in PTS order, often far faster than
      // real-time on a 4K stream with HW acceleration. A naïve
      // drop-oldest policy lets the queue's PTS window slide past the
      // cursor, after which the blit loop (which picks the newest
      // frame ≤ cursor) has nothing to draw — the canvas stays frozen
      // on the first frame for the rest of playback. Only evict the
      // head once the cursor has passed it; otherwise drop the
      // incoming frame, which keeps the queue anchored at / behind
      // the cursor.
      if (queueRef.current.length >= MAX_QUEUE) {
        const cursor = cursorRef.current;
        const oldest = queueRef.current[0];
        if (oldest.ptsNs < cursor) {
          queueRef.current.shift();
          oldest.frame.close();
          droppedFramesRef.current += 1;
        } else {
          frame.close();
          droppedFramesRef.current += 1;
          return;
        }
      }
      queueRef.current.push({ ptsNs, frame, frameIndex, decodeQueue });
    };

    let cancelled = false;
    const startNs = globalRange?.startNs ?? 0n;
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
      try {
        const result = await videoDecode.open(
          sourceKind,
          sourceHandle,
          channelId,
          startNs,
        );
        codecRef.current = result.codec || null;
        // Seed the seek-dedupe ref so the mount cursor effect doesn't
        // issue a seek back to the same target that `open()` already took.
        lastSeekTargetRef.current = startNs;
      } catch (e) {
        console.error("VideoPanel: open failed", e);
      }
    })();

    const tick = () => {
      const q = queueRef.current;
      const cursor = cursorRef.current;
      // T7 — is the cursor inside this source's frame coverage?
      const covStart = coverageStartRef.current;
      const covEnd = coverageEndRef.current;
      const outOfCoverage =
        covStart !== null &&
        covEnd !== null &&
        (cursor < covStart || cursor > covEnd);

      if (outOfCoverage) {
        // No frame exists at this cursor. Don't leave a stale frame from a
        // different time on the canvas — paint it black once on entry so the
        // panel reads as honestly empty. Readiness below reports "uncovered"
        // (non-gating), so playback keeps rolling for the other panels.
        if (!uncoveredPaintedRef.current && sizedRef.current) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          uncoveredPaintedRef.current = true;
        }
      } else {
        uncoveredPaintedRef.current = false;
        // Walk forward while the next frame's PTS is also <= cursor. That
        // leaves us with the newest frame in [−∞, cursor], exactly the one
        // we want to blit.
        let blitIdx = -1;
        for (let i = 0; i < q.length; i++) {
          if (q[i].ptsNs <= cursor) blitIdx = i;
          else break;
        }
        if (blitIdx >= 0) {
          // Close every frame strictly before the one we're about to blit,
          // plus the one we blit (we keep it on the canvas via drawImage,
          // but drop the handle; the canvas owns its own pixels from here).
          const target = q[blitIdx];
          for (let i = 0; i < blitIdx; i++) q[i].frame.close();
          q.splice(0, blitIdx);
          ctx.drawImage(target.frame, 0, 0, canvas.width, canvas.height);
          if (lastBlitPtsRef.current === null) {
            mark(VIDEO_FIRST_FRAME);
          }
          // Task 4 — close the seek-to-blit bracket on the first frame
          // blitted after a seek was dispatched. `mark`/`measure` are cheap
          // (no allocation in the steady-state path: the flag is false on
          // every non-seek tick), and the measure lands on the standard
          // `performance` timeline so `__drivelinePerf`/e2e can assert the
          // T5.2 P50<120ms / P95<250ms budget.
          if (seekPendingBlitRef.current) {
            seekPendingBlitRef.current = false;
            mark(VIDEO_SEEK_END);
            measure(VIDEO_SEEK_TO_BLIT, VIDEO_SEEK_START, VIDEO_SEEK_END);
          }
          window.__drivelineVideoLastBlitPtsNs = target.ptsNs;
          lastBlitPtsRef.current = target.ptsNs;
          target.frame.close();
          q.shift();
        }
      }
      // Publish a HUD snapshot every tick. Cheap (plain object) and the
      // dev hook needs it available whether or not the HUD is visible.
      const snapshot: VideoHudSnapshot = {
        ptsNs: lastBlitPtsRef.current,
        frameIndex: lastFrameIndexRef.current,
        decodeQueue: lastDecodeQueueRef.current,
        blitQueueLen: queueRef.current.length,
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
            nowMsRead - lastFrameArrivedMsRef.current <=
            FRAME_LIVE_WINDOW_MS
          ) {
            isReady = true;
          } else {
            // Loose arm B: queue still holds undelivered frames
            // straddling the cursor — decoder finished its lookahead
            // burst and went idle by design (worker pacing). The
            // panel will catch up as cursor advances; this is not a
            // stall. Walking the queue once is O(MAX_QUEUE=16),
            // which is fine for a 60 Hz tick.
            for (let i = 0; i < q.length; i++) {
              if (q[i].ptsNs >= cursor) {
                isReady = true;
                break;
              }
            }
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
      for (const e of queueRef.current) e.frame.close();
      queueRef.current = [];
      lastSeekTargetRef.current = null;
      lastCursorSentRef.current = null;
      codecRef.current = null;
      lastFrameIndexRef.current = 0;
      lastDecodeQueueRef.current = 0;
      droppedFramesRef.current = 0;
      lastBlitPtsRef.current = null;
      seekPendingBlitRef.current = false;
      decodeErrorRef.current = null;
      lastHudTextRef.current = "";
      lastStatsTextRef.current = "";
      // Issue #2 — drop our entry from the readiness registry so the
      // playback rAF doesn't keep gating on an unmounted panel.
      waitingSinceMsRef.current = null;
      lastFrameIndexAtWaitStartRef.current = 0;
      lastReadyMsRef.current = 0;
      lastFrameArrivedMsRef.current = 0;
      clearPanelReadiness(panelId);
      window.__drivelineVideoHud = undefined;
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
    // Bracket the retry's seek-to-blit latency too (Task 4).
    mark(VIDEO_SEEK_START);
    seekPendingBlitRef.current = true;
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
        // Drop stale frames ahead of the seek so the blit loop converges fast.
        for (const e of queueRef.current) e.frame.close();
        queueRef.current = [];
        // Task 4 — open the seek-to-blit bracket. The rAF blit loop closes
        // it (VIDEO_SEEK_END + VIDEO_SEEK_TO_BLIT measure) on the first
        // frame it draws after this dispatch.
        mark(VIDEO_SEEK_START);
        seekPendingBlitRef.current = true;
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
      {/* Reset-zoom affordance — only mounted while magnified, so it stays
       *  out of the way during normal playback. Top-left to clear the HUD
       *  toggle (top-right) and the stats strip (bottom-right). */}
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
