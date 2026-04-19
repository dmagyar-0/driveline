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
import type { EncodedChunkWire } from "./dataCore.worker";

const PULL_BATCH = 8;
const REFILL_LOW_WATER = 4;

export type VideoSourceKind = "mcap" | "mp4";

interface OpenResult {
  codec: string;
}

// The subset of `DataCoreApi` that videoDecode actually needs. Bound to a
// MessagePort handed in from the main thread so we share the main-thread
// dataCore worker's wasm slab (where the source was opened) — spawning our
// own dataCore worker would give us an empty slab and every handle would
// fail to resolve.
interface DataCorePortApi {
  openMcapVideoStream(
    handle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<number>;
  mcapVideoNextBatch(
    streamId: number,
    maxN: number,
  ): Promise<EncodedChunkWire[]>;
  closeMcapVideoStream(streamId: number): Promise<void>;
  openMp4VideoStream(
    handle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<number>;
  mp4VideoNextBatch(
    streamId: number,
    maxN: number,
  ): Promise<EncodedChunkWire[]>;
  closeMp4VideoStream(streamId: number): Promise<void>;
}

// Resolves the three stream ops for a given reader kind. Keeping this as a
// single dispatch point means `openInternal` / `pullAndFeed` / `closeInternal`
// / `seek` never have to branch on `sourceKind` themselves.
interface VideoStreamOps {
  open(handle: number, channelId: string, fromPtsNs: bigint): Promise<number>;
  next(streamId: number, maxN: number): Promise<EncodedChunkWire[]>;
  close(streamId: number): Promise<void>;
}

function videoStreamOps(
  dc: Comlink.Remote<DataCorePortApi>,
  kind: VideoSourceKind,
): VideoStreamOps {
  if (kind === "mcap") {
    return {
      open: (h, c, p) => dc.openMcapVideoStream(h, c, p),
      next: (s, m) => dc.mcapVideoNextBatch(s, m),
      close: (s) => dc.closeMcapVideoStream(s),
    };
  }
  return {
    open: (h, c, p) => dc.openMp4VideoStream(h, c, p),
    next: (s, m) => dc.mp4VideoNextBatch(s, m),
    close: (s) => dc.closeMp4VideoStream(s),
  };
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
  const codec = sps ? codecStringFromSps(sps) : "avc1.64002A";
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
    // `decode()` can throw synchronously when a key chunk's payload lacks an
    // IDR slice (e.g. the synthetic mp4 fixture, whose samples are just AUD
    // NALs). Async decoder faults already surface via the `error:` callback
    // without blowing up `open()`, so mirror that behaviour here — the codec
    // is resolved, the HUD can reflect it, and the session stays navigable.
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
