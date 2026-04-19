// T5.1 · VideoPanel (MCAP path).
//
// Owns: a <canvas>, a small VideoFrame queue fed by the videoDecode worker
// over a MessagePort, and a rAF loop that blits the frame whose PTS is
// closest to the current cursor. Seek is a trailing-debounced side effect
// on `cursorNs`. FlexLayout docking is T6.2 — for now the panel renders in
// a plain container from App.tsx.

import { useEffect, useRef } from "react";
import * as Comlink from "comlink";
import { useSession } from "../state/store";
import { makeVideoDecodeClient } from "../workerClient";
import type { VideoDecodeApi } from "../workerClient";

interface VideoPanelProps {
  mcapHandle: number;
  channelId: string;
}

interface QueueEntry {
  ptsNs: bigint;
  frame: VideoFrame;
}

const SEEK_DEBOUNCE_MS = 50;
const MAX_QUEUE = 8;

declare global {
  interface Window {
    __drivelineVideoLastBlitPtsNs?: bigint | null;
  }
}

export function VideoPanel({ mcapHandle, channelId }: VideoPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const queueRef = useRef<QueueEntry[]>([]);
  const cursorRef = useRef<bigint>(0n);
  const rafRef = useRef<number | null>(null);
  const seekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizedRef = useRef<boolean>(false);
  const videoDecodeRef = useRef<Comlink.Remote<VideoDecodeApi> | null>(null);

  // Keep cursorRef fresh without re-subscribing the rAF loop. The rAF loop
  // itself does the reading; useRef guarantees monomorphic access.
  const cursorNs = useSession((s) => s.cursorNs);
  const globalRange = useSession((s) => s.globalRange);
  cursorRef.current = cursorNs;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const videoDecode = makeVideoDecodeClient();
    videoDecodeRef.current = videoDecode;
    const channel = new MessageChannel();
    const port = channel.port1;

    port.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { ptsNs: bigint; frame: VideoFrame } | null;
      if (!data) return;
      const { ptsNs, frame } = data;
      // Drop the oldest when the queue saturates — a stalled blit is never
      // worth starving the GPU pool.
      if (queueRef.current.length >= MAX_QUEUE) {
        const dropped = queueRef.current.shift();
        dropped?.frame.close();
      }
      queueRef.current.push({ ptsNs, frame });
      if (!sizedRef.current) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
        sizedRef.current = true;
      }
    };

    let cancelled = false;
    (async () => {
      // Comlink needs an explicit transfer for MessagePort.
      await videoDecode.setFrameSink(
        Comlink.transfer(channel.port2, [channel.port2]),
      );
      if (cancelled) return;
      const startNs = globalRange?.startNs ?? 0n;
      try {
        await videoDecode.open(mcapHandle, channelId, startNs);
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
        window.__drivelineVideoLastBlitPtsNs = target.ptsNs;
        target.frame.close();
        q.shift();
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
      const dc = videoDecodeRef.current;
      videoDecodeRef.current = null;
      if (dc) void dc.close().catch(() => undefined);
    };
  }, [mcapHandle, channelId, globalRange?.startNs]);

  // Seek side effect: trailing-debounce on cursorNs changes. The initial
  // render issues no seek — `open()` already starts at globalRange.startNs.
  useEffect(() => {
    if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      const client = videoDecodeRef.current;
      if (!client) return;
      // Drop stale frames ahead of the seek so the blit loop converges fast.
      for (const e of queueRef.current) e.frame.close();
      queueRef.current = [];
      void client.seek(cursorNs).catch(() => undefined);
    }, SEEK_DEBOUNCE_MS);
    return () => {
      if (seekTimerRef.current !== null) clearTimeout(seekTimerRef.current);
    };
  }, [cursorNs]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="video-panel-canvas"
      style={{ width: "100%", height: "100%", background: "#000" }}
    />
  );
}
