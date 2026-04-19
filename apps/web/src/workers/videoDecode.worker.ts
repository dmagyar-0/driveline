// T5.1 · MCAP video path.
//
// This worker owns a single `VideoDecoder` configured from the first MCAP
// keyframe's inline SPS. It pulls encoded Annex-B chunks from the dataCore
// worker in batches (user-chosen wire shape — see plan), feeds the decoder,
// and posts `VideoFrame` objects over a `MessagePort` back to `VideoPanel`
// so the main thread can blit them. `VideoFrame` is the only thing that
// must stay in JS land — everything upstream is plain bytes owned by Rust
// until it crosses the wasm boundary.
//
// Out of scope for T5.1 (→ T5.2): HUD counters (dropped / queue depth),
// seek UX, scrub-debounce tuning. We expose `seek()` and `close()` for
// VideoPanel to drive; the queue is kept shallow.

import * as Comlink from "comlink";
import type { DataCoreApi, EncodedChunkWire } from "./dataCore.worker";
import { makeDataCoreClient } from "../workerClient";

const PULL_BATCH = 8;
const REFILL_LOW_WATER = 4;

interface OpenResult {
  codec: string;
}

interface SessionState {
  mcapHandle: number;
  channelId: string;
  streamId: number;
  decoder: VideoDecoder;
  sink: MessagePort | null;
  discardBeforePtsNs: bigint;
  // Number of chunks fed into the decoder but not yet emitted via the
  // `output` callback. Used to trigger the next pull; WebCodecs exposes
  // `decodeQueueSize` but it is async-observable and not a counter we can
  // decrement deterministically, so we track our own.
  inFlight: number;
  ended: boolean;
}

let dataCore: Comlink.Remote<DataCoreApi> | null = null;
let session: SessionState | null = null;

function getDataCore(): Comlink.Remote<DataCoreApi> {
  if (!dataCore) dataCore = makeDataCoreClient();
  return dataCore;
}

function hex(b: number): string {
  return b.toString(16).padStart(2, "0").toUpperCase();
}

/// Scan an Annex-B buffer for the first SPS (NAL type 7). Returns the SPS
/// payload bytes (excluding the start code and the NAL header byte) or null.
/// We only need bytes [1..4] — profile_idc, constraint flags, level_idc —
/// to derive the `avc1.XXXXXX` codec string.
function findSps(annexB: Uint8Array): Uint8Array | null {
  let i = 0;
  while (i + 2 < annexB.length) {
    const is3 =
      annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1;
    const is4 =
      i + 3 < annexB.length &&
      annexB[i] === 0 &&
      annexB[i + 1] === 0 &&
      annexB[i + 2] === 0 &&
      annexB[i + 3] === 1;
    if (!is3 && !is4) {
      i += 1;
      continue;
    }
    const nalStart = i + (is4 ? 4 : 3);
    if (nalStart >= annexB.length) return null;
    const nalType = annexB[nalStart] & 0x1f;
    if (nalType === 7) {
      // Find next start code to bound the SPS.
      let j = nalStart + 1;
      while (j + 2 < annexB.length) {
        if (
          annexB[j] === 0 &&
          annexB[j + 1] === 0 &&
          (annexB[j + 2] === 1 ||
            (j + 3 < annexB.length &&
              annexB[j + 2] === 0 &&
              annexB[j + 3] === 1))
        )
          break;
        j += 1;
      }
      // Return bytes AFTER the NAL header byte, so [0]=profile, [1]=flags,
      // [2]=level. (If the stream is too short, the caller falls back.)
      return annexB.slice(nalStart + 1, j);
    }
    i = nalStart + 1;
  }
  return null;
}

function codecStringFromSps(sps: Uint8Array): string {
  // profile_idc, constraint flags byte, level_idc.
  if (sps.length < 3) {
    // Safe-ish default: High @ L4.2 matches 4K/30 fixtures. Spike T0.2 §4.
    return "avc1.64002A";
  }
  return `avc1.${hex(sps[0])}${hex(sps[1])}${hex(sps[2])}`;
}

function ptsToMicros(ptsNs: bigint): number {
  // WebCodecs timestamps are microseconds. We lose sub-µs resolution but
  // preserve frame ordering; the VideoPanel keeps the original ns alongside
  // the VideoFrame in its queue for exact cursor comparison.
  return Number(ptsNs / 1000n);
}

async function pullAndFeed(): Promise<void> {
  if (!session) return;
  if (session.ended) return;
  const dc = getDataCore();
  const batch = (await dc.mcapVideoNextBatch(
    session.streamId,
    PULL_BATCH,
  )) as EncodedChunkWire[];
  if (batch.length === 0) {
    session.ended = true;
    return;
  }
  for (const c of batch) {
    if (!session) return;
    const chunk = new EncodedVideoChunk({
      type: c.is_keyframe ? "key" : "delta",
      timestamp: ptsToMicros(c.pts_ns),
      data: c.data,
    });
    session.decoder.decode(chunk);
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
  const codec = sps ? codecStringFromSps(sps) : "avc1.64002A";
  const supported = await VideoDecoder.isConfigSupported({ codec });
  if (!supported.supported) {
    throw new Error(
      `videoDecode: codec not supported by this browser: ${codec}`,
    );
  }
  decoder.configure({
    codec,
    optimizeForLatency: false,
    hardwareAcceleration: "prefer-hardware",
  });
  return { codec };
}

async function openInternal(
  mcapHandle: number,
  channelId: string,
  fromPtsNs: bigint,
): Promise<OpenResult> {
  await closeInternal();
  const dc = getDataCore();
  const streamId = await dc.openMcapVideoStream(
    mcapHandle,
    channelId,
    fromPtsNs,
  );
  const decoder = new VideoDecoder({
    output: (frame) => onFrame(frame),
    error: (e) => {
      // Fatal for this session. Surface once; callers can observe via the
      // next `open()` / `seek()` rejection.
      console.error("VideoDecoder error:", e);
    },
  });

  session = {
    mcapHandle,
    channelId,
    streamId,
    decoder,
    sink: session?.sink ?? null,
    discardBeforePtsNs: fromPtsNs,
    inFlight: 0,
    ended: false,
  };

  const initial = (await dc.mcapVideoNextBatch(
    streamId,
    PULL_BATCH,
  )) as EncodedChunkWire[];
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
    decoder.decode(chunk);
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
  // Transfer the VideoFrame to VideoPanel. The panel owns `close()` from
  // here on.
  session.sink.postMessage({ ptsNs, frame }, [frame]);
  void maybeRefill();
}

async function closeInternal(): Promise<void> {
  if (!session) return;
  const dc = getDataCore();
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
      await dc.closeMcapVideoStream(s.streamId);
    } catch {
      // Stream handle may already be freed on the Rust side.
    }
  }
}

export const videoDecodeApi = {
  ping(): string {
    return "pong";
  },
  setFrameSink(port: MessagePort): void {
    if (session) session.sink = port;
    // If set before open(), the latest port wins and will be adopted at open().
    pendingSink = port;
  },
  async open(
    mcapHandle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<OpenResult> {
    const result = await openInternal(mcapHandle, channelId, fromPtsNs);
    if (session && pendingSink) session.sink = pendingSink;
    return result;
  },
  async seek(targetNs: bigint): Promise<void> {
    if (!session) return;
    const { mcapHandle, channelId } = session;
    try {
      session.decoder.reset();
    } catch {
      // If the decoder is already closed, restart fresh below.
    }
    const prevStreamId = session.streamId;
    const dc = getDataCore();
    try {
      await dc.closeMcapVideoStream(prevStreamId);
    } catch {
      // ignore
    }
    await openInternal(mcapHandle, channelId, targetNs);
    if (session && pendingSink) session.sink = pendingSink;
  },
  async close(): Promise<void> {
    await closeInternal();
  },
};

let pendingSink: MessagePort | null = null;

export type VideoDecodeApi = typeof videoDecodeApi;

Comlink.expose(videoDecodeApi);
