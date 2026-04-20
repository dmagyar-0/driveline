// T5.1 · MCAP video path, extended in T5.3 for mp4+sidecar sources.
//
// This worker owns a single `VideoDecoder` configured from the first MCAP
// keyframe's inline SPS. It pulls encoded Annex-B chunks from the dataCore
// worker in batches (user-chosen wire shape — see plan), feeds the decoder,
// and posts `VideoFrame` objects over a `MessagePort` back to `VideoPanel`
// so the main thread can blit them. `VideoFrame` is the only thing that
// must stay in JS land — everything upstream is plain bytes owned by Rust
// until it crosses the wasm boundary.
//
// T5.3: the worker is reader-agnostic. `open()` takes a `sourceKind` and
// dispatches to the mcap or mp4 pull/close bindings; both readers emit
// Annex-B chunks with inline SPS on the first keyframe, so the decode
// path below is format-agnostic.

import * as Comlink from "comlink";
import type { EncodedChunkWire } from "./normalise";
import {
  CODEC_STRING_FALLBACK,
  codecStringFromSps,
  findSps,
  ptsToMicros,
  videoStreamOps,
  type DataCorePortApi,
  type VideoSourceKind,
  type VideoStreamOps,
} from "./videoDecodeOps";

const PULL_BATCH = 8;
const REFILL_LOW_WATER = 4;

export type { VideoSourceKind };

interface OpenResult {
  codec: string;
}

interface SessionState {
  sourceKind: VideoSourceKind;
  sourceHandle: number;
  channelId: string;
  streamId: number;
  ops: VideoStreamOps;
  decoder: VideoDecoder;
  sink: MessagePort | null;
  discardBeforePtsNs: bigint;
  // Number of chunks fed into the decoder but not yet emitted via the
  // `output` callback. Used to trigger the next pull; WebCodecs exposes
  // `decodeQueueSize` but it is async-observable and not a counter we can
  // decrement deterministically, so we track our own.
  inFlight: number;
  ended: boolean;
  // T5.2 HUD: monotonic count of frames emitted to the sink since the
  // current stream was opened. Reset in `openInternal`; incremented only
  // for frames that clear the discard gate so seek-prime frames don't
  // pollute the count.
  frameIndex: number;
  // `fromPtsNs` used at the last `openInternal` call. Used by `seek()` to
  // short-circuit when the debounce fires on an unchanged target.
  lastOpenedFromNs: bigint;
}

let dataCore: Comlink.Remote<DataCorePortApi> | null = null;
let session: SessionState | null = null;

function getDataCore(): Comlink.Remote<DataCorePortApi> {
  if (!dataCore) {
    throw new Error(
      "videoDecode: dataCore port not configured — main thread must " +
        "call setDataCorePort before open()",
    );
  }
  return dataCore;
}

async function pullAndFeed(): Promise<void> {
  if (!session) return;
  if (session.ended) return;
  const batch = (await session.ops.next(
    session.streamId,
    PULL_BATCH,
  )) as EncodedChunkWire[];
  if (batch.length === 0) {
    session.ended = true;
    return;
  }
  for (const c of batch) {
    if (!session) return;
    // `openInternal` awaits `ops.next` before calling
    // `configureFromFirstKeyframe`, which leaves a window where the
    // session is live but the decoder is still `unconfigured`. A
    // frame callback firing during that window (from a prior decode
    // cycle) would queue another pull here and hit WebCodecs'
    // `Cannot call 'decode' on an unconfigured codec`. Treat that as
    // benign — the post-configure initial-batch decode below will
    // pick up again.
    if (session.decoder.state !== "configured") return;
    const chunk = new EncodedVideoChunk({
      type: c.is_keyframe ? "key" : "delta",
      timestamp: ptsToMicros(c.pts_ns),
      data: c.data,
    });
    try {
      session.decoder.decode(chunk);
    } catch (e) {
      console.error("VideoDecoder error:", e);
      session.ended = true;
      return;
    }
    session.inFlight += 1;
  }
}

async function maybeRefill(): Promise<void> {
  if (!session) return;
  if (session.ended) return;
  if (session.inFlight >= REFILL_LOW_WATER) return;
  await pullAndFeed();
}

async function configureFromFirstKeyframe(
  initial: EncodedChunkWire[],
  decoder: VideoDecoder,
): Promise<OpenResult> {
  const first = initial[0];
  if (!first || !first.is_keyframe) {
    throw new Error("videoDecode: first chunk is not a keyframe");
  }
  const sps = findSps(first.data);
  const codec = sps ? codecStringFromSps(sps) : CODEC_STRING_FALLBACK;
  // Probe once without a HW hint; Chromium headless rejects
  // `prefer-hardware` when no HW decoder is wired in. Fall back to
  // `no-preference` if the probed support object reports unsupported
  // under either hint, so the app still works in CI.
  const baseConfig: VideoDecoderConfig = { codec, optimizeForLatency: false };
  const supported = await VideoDecoder.isConfigSupported(baseConfig);
  if (!supported.supported) {
    throw new Error(
      `videoDecode: codec not supported by this browser: ${codec}`,
    );
  }
  decoder.configure(baseConfig);
  return { codec };
}

async function openInternal(
  sourceKind: VideoSourceKind,
  sourceHandle: number,
  channelId: string,
  fromPtsNs: bigint,
): Promise<OpenResult> {
  await closeInternal();
  const dc = getDataCore();
  const ops = videoStreamOps(dc, sourceKind);
  const streamId = await ops.open(sourceHandle, channelId, fromPtsNs);
  const decoder = new VideoDecoder({
    output: (frame) => onFrame(frame),
    error: (e) => {
      // Fatal for this session. Surface once; callers can observe via the
      // next `open()` / `seek()` rejection.
      console.error("VideoDecoder error:", e);
    },
  });

  session = {
    sourceKind,
    sourceHandle,
    channelId,
    streamId,
    ops,
    decoder,
    sink: session?.sink ?? null,
    discardBeforePtsNs: fromPtsNs,
    inFlight: 0,
    ended: false,
    frameIndex: 0,
    lastOpenedFromNs: fromPtsNs,
  };

  const initial = (await ops.next(streamId, PULL_BATCH)) as EncodedChunkWire[];
  if (initial.length === 0) {
    session.ended = true;
    return { codec: "" };
  }
  const result = await configureFromFirstKeyframe(initial, decoder);
  for (const c of initial) {
    const chunk = new EncodedVideoChunk({
      type: c.is_keyframe ? "key" : "delta",
      timestamp: ptsToMicros(c.pts_ns),
      data: c.data,
    });
    try {
      decoder.decode(chunk);
    } catch (e) {
      console.error("VideoDecoder error:", e);
      break;
    }
    session.inFlight += 1;
  }
  return result;
}

function onFrame(frame: VideoFrame): void {
  if (!session) {
    frame.close();
    return;
  }
  session.inFlight = Math.max(0, session.inFlight - 1);
  // Discard frames that predate the current seek target; they exist only to
  // prime the decoder's reference buffers.
  const ptsNs = BigInt(frame.timestamp) * 1000n;
  if (ptsNs < session.discardBeforePtsNs) {
    frame.close();
    void maybeRefill();
    return;
  }
  if (!session.sink) {
    // No consumer connected yet. Drop to keep the GPU pool from starving.
    frame.close();
    void maybeRefill();
    return;
  }
  // HUD metrics. We only count frames that clear the discard gate — that
  // keeps `frameIndex` a "visible frames since open" counter even when a
  // seek primes the decoder with pre-target frames.
  session.frameIndex += 1;
  // `decodeQueueSize` is a hint per spec; some backends report 0 even with
  // chunks in flight. Surface it anyway — it's the metric `T5.2` asks for.
  const decodeQueue = session.decoder.decodeQueueSize;
  // Transfer the VideoFrame to VideoPanel. The panel owns `close()` from
  // here on.
  session.sink.postMessage(
    { ptsNs, frame, frameIndex: session.frameIndex, decodeQueue },
    [frame],
  );
  void maybeRefill();
}

async function closeInternal(): Promise<void> {
  if (!session) return;
  const s = session;
  session = null;
  try {
    if (s.decoder.state !== "closed") {
      try {
        await s.decoder.flush();
      } catch {
        // flush() rejects when the decoder was reset or errored; safe to ignore.
      }
      s.decoder.close();
    }
  } finally {
    try {
      await s.ops.close(s.streamId);
    } catch {
      // Stream handle may already be freed on the Rust side.
    }
  }
}

export const videoDecodeApi = {
  ping(): string {
    return "pong";
  },
  setDataCorePort(port: MessagePort): void {
    // One-shot; last port wins. Comlink.wrap around a MessagePort gives us
    // a Remote whose calls tunnel to whatever `Comlink.expose` has bound
    // the other end to (on the main thread, that's a relay forwarding to
    // the real dataCore Remote).
    dataCore = Comlink.wrap<DataCorePortApi>(port);
  },
  setFrameSink(port: MessagePort): void {
    if (session) session.sink = port;
    // If set before open(), the latest port wins and will be adopted at open().
    pendingSink = port;
  },
  async open(
    sourceKind: VideoSourceKind,
    sourceHandle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<OpenResult> {
    const result = await openInternal(
      sourceKind,
      sourceHandle,
      channelId,
      fromPtsNs,
    );
    if (session && pendingSink) session.sink = pendingSink;
    return result;
  },
  async seek(targetNs: bigint): Promise<void> {
    if (!session) return;
    // Duplicate-target guard: the debounced effect in VideoPanel can fire
    // with an unchanged target after a drag that ended on the same PTS.
    // The teardown+reopen round-trip isn't free, so skip it.
    if (session.lastOpenedFromNs === targetNs) return;
    const { sourceKind, sourceHandle, channelId, ops } = session;
    try {
      session.decoder.reset();
    } catch {
      // If the decoder is already closed, restart fresh below.
    }
    const prevStreamId = session.streamId;
    try {
      await ops.close(prevStreamId);
    } catch {
      // ignore
    }
    await openInternal(sourceKind, sourceHandle, channelId, targetNs);
    if (session && pendingSink) session.sink = pendingSink;
  },
  async close(): Promise<void> {
    await closeInternal();
  },
};

let pendingSink: MessagePort | null = null;

export type VideoDecodeApi = typeof videoDecodeApi;

Comlink.expose(videoDecodeApi);
