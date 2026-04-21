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

import { useEffect, useRef, useState } from "react";
import * as Comlink from "comlink";
import { useSession } from "../state/store";
import { makeVideoDecodeClient } from "../workerClient";
import type { VideoDecodeApi } from "../workerClient";
import { mark } from "../perf";
import styles from "./VideoPanel.module.css";

interface VideoPanelProps {
  sourceKind: "mcap" | "mp4";
  sourceHandle: number;
  channelId: string;
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
const MAX_QUEUE = 8;

declare global {
  interface Window {
    __drivelineVideoLastBlitPtsNs?: bigint | null;
    __drivelineVideoHud?: VideoHudSnapshot;
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
}: VideoPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const queueRef = useRef<QueueEntry[]>([]);
  const cursorRef = useRef<bigint>(0n);
  const rafRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizedRef = useRef<boolean>(false);
  const videoDecodeRef = useRef<Comlink.Remote<VideoDecodeApi> | null>(null);
  const videoDecodeWorkerRef = useRef<Worker | null>(null);

  // HUD refs. We keep them off React state so metric updates don't churn
  // the reconciler; the rAF loop writes directly into the HUD DOM.
  const lastFrameIndexRef = useRef<number>(0);
  const lastDecodeQueueRef = useRef<number>(0);
  const droppedFramesRef = useRef<number>(0);
  const lastBlitPtsRef = useRef<bigint | null>(null);
  const codecRef = useRef<string | null>(null);
  const hudDomRef = useRef<HTMLDivElement | null>(null);
  const hudOnRef = useRef<boolean>(false);

  // `lastSeekTargetRef` starts null and is set to the initial `open()`
  // target once the worker has accepted it. The debounced cursor effect
  // skips a `seek()` that matches this — preventing a redundant seek on
  // mount when the cursor equals `globalRange.startNs`.
  const lastSeekTargetRef = useRef<bigint | null>(null);

  const [hudOn, setHudOn] = useState<boolean>(false);
  hudOnRef.current = hudOn;

  const cursorNs = useSession((s) => s.cursorNs);
  const globalRange = useSession((s) => s.globalRange);
  cursorRef.current = cursorNs;

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
        | null;
      if (!data) return;
      const { ptsNs, frame, frameIndex, decodeQueue } = data;
      lastFrameIndexRef.current = frameIndex;
      lastDecodeQueueRef.current = decodeQueue;
      // Drop the oldest when the queue saturates — a stalled blit is never
      // worth starving the GPU pool. Count it as a user-visible drop.
      if (queueRef.current.length >= MAX_QUEUE) {
        const dropped = queueRef.current.shift();
        dropped?.frame.close();
        droppedFramesRef.current += 1;
      }
      queueRef.current.push({ ptsNs, frame, frameIndex, decodeQueue });
      if (!sizedRef.current) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        sizedRef.current = true;
      }
    };

    let cancelled = false;
    const startNs = globalRange?.startNs ?? 0n;
    // Bridge the main-thread dataCore Remote into this panel's videoDecode
    // worker. Spawning a fresh dataCore inside the videoDecode worker would
    // give it an empty wasm slab, making `sourceHandle` invalid there.
    const dc = useSession.getState().getWorker();
    const bridge = new MessageChannel();
    const relay = {
      openMcapVideoStream: (h: number, c: string, p: bigint) =>
        dc!.openMcapVideoStream(h, c, p),
      mcapVideoNextBatch: (s: number, m: number) =>
        dc!.mcapVideoNextBatch(s, m),
      closeMcapVideoStream: (s: number) => dc!.closeMcapVideoStream(s),
      openMp4VideoStream: (h: number, c: string, p: bigint) =>
        dc!.openMp4VideoStream(h, c, p),
      mp4VideoNextBatch: (s: number, m: number) =>
        dc!.mp4VideoNextBatch(s, m),
      closeMp4VideoStream: (s: number) => dc!.closeMp4VideoStream(s),
    };
    Comlink.expose(relay, bridge.port1);
    (async () => {
      if (!dc) {
        console.error("VideoPanel: dataCore worker not initialised");
        return;
      }
      // Comlink needs an explicit transfer for MessagePort.
      await videoDecode.setDataCorePort(
        Comlink.transfer(bridge.port2, [bridge.port2]),
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
        ctx.drawImage(
          target.frame,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        if (lastBlitPtsRef.current === null) {
          mark("video:first-frame");
        }
        window.__drivelineVideoLastBlitPtsNs = target.ptsNs;
        lastBlitPtsRef.current = target.ptsNs;
        target.frame.close();
        q.shift();
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
        hudDomRef.current.textContent =
          `PTS         ${formatPts(snapshot.ptsNs)}\n` +
          `frame #     ${snapshot.frameIndex}\n` +
          `decodeQueue ${snapshot.decodeQueue}\n` +
          `blitQueue   ${snapshot.blitQueueLen} / ${MAX_QUEUE}\n` +
          `dropped     ${snapshot.dropped}\n` +
          `codec       ${snapshot.codec ?? "—"}`;
      }
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
      codecRef.current = null;
      lastFrameIndexRef.current = 0;
      lastDecodeQueueRef.current = 0;
      droppedFramesRef.current = 0;
      lastBlitPtsRef.current = null;
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
  }, [sourceKind, sourceHandle, channelId, globalRange?.startNs]);

  // Seek side effect: trailing-debounce on cursorNs changes. Skips the
  // fire when the target duplicates the most recent one — this is what
  // suppresses the redundant seek-on-mount (when the effect first runs,
  // the stream is already opened to that exact cursor).
  useEffect(() => {
    if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      const client = videoDecodeRef.current;
      if (!client) return;
      if (lastSeekTargetRef.current === cursorNs) return;
      lastSeekTargetRef.current = cursorNs;
      // Drop stale frames ahead of the seek so the blit loop converges fast.
      for (const e of queueRef.current) e.frame.close();
      queueRef.current = [];
      void client.seek(cursorNs).catch(() => undefined);
    }, SEEK_DEBOUNCE_MS);
    return () => {
      if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
    };
  }, [cursorNs]);

  // `h` toggles the HUD, but only when focus is inside the panel wrapper —
  // we don't want to hijack the key when the drop zone or a form input
  // owns focus.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "h" && e.key !== "H") return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    setHudOn((v) => !v);
  };

  return (
    <div className={styles.panel} tabIndex={0} onKeyDown={onKeyDown}>
      <canvas
        ref={canvasRef}
        data-testid="video-panel-canvas"
        className={styles.canvas}
      />
      <button
        type="button"
        data-testid="video-hud-toggle"
        className={styles.hudToggle}
        aria-pressed={hudOn}
        onClick={() => setHudOn((v) => !v)}
      >
        HUD
      </button>
      {hudOn && (
        <div
          ref={hudDomRef}
          data-testid="video-hud"
          className={styles.hud}
        />
      )}
    </div>
  );
}
