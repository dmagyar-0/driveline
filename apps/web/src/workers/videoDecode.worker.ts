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
  PRIMING_BATCH,
  PULL_BATCH,
  codecStringFromSps,
  findSps,
  hex,
  makeOpQueue,
  ptsToMicros,
  shouldRefill,
  videoStreamOps,
  type DataCorePortApi,
  type Mp4Framing,
  type Mp4LazyPortApi,
  type VideoSourceKind,
  type VideoStreamOps,
} from "./videoDecodeOps";

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
  // Most recent PTS emitted to the sink (post-discard). Used by the
  // pacing gate in `maybeRefill` so a fast decoder does not run more
  // than `LOOKAHEAD_NS` ahead of the main-thread cursor.
  lastEmittedPtsNs: bigint | null;
  // Latest decoded frame whose PTS is strictly before the seek target,
  // held until the first frame at/after the target arrives. The panel
  // blits the newest frame whose PTS <= cursor; without this hand-off,
  // a seek that lands between frame boundaries (typical: 33 ms grid at
  // 30 fps) leaves the panel with only frames > cursor, so the canvas
  // stays frozen until the cursor advances — i.e. only during play.
  pendingPreTargetFrame: VideoFrame | null;
}

// Cursor watermark from the main thread. Updated via `setCursor`;
// the pull loop gates on `lastEmittedPtsNs - cursorNs < LOOKAHEAD_NS`.
let cursorNs: bigint = 0n;

let dataCore: Comlink.Remote<DataCorePortApi> | null = null;
let mp4Lazy: Comlink.Remote<Mp4LazyPortApi> | null = null;
let session: SessionState | null = null;
// Sink port set before open() lands; adopted by the session at open() time.
let pendingSink: MessagePort | null = null;

// ---------------------------------------------------------------------------
// isConfigSupported cache
// ---------------------------------------------------------------------------
//
// `VideoDecoder.isConfigSupported()` is an async call that must complete
// before `decoder.configure()`. In practice it resolves quickly, but on
// EVERY seek/open it adds a GPU-driver round-trip (100–200 µs on a warm
// path, potentially several ms after a GPU reset). The codec config for a
// given video source is derived from the SPS+PPS embedded in the bitstream
// and does NOT change within a session. Caching the result avoids this
// round-trip on all but the first open per unique config.
//
// Cache key: `<codec>:<descriptionByteLength>:<checksum>` where the
// checksum is the 32-bit unsigned sum of all description bytes (mod 2^32).
// This is stronger than codec + byteLength alone (a different AVC config of
// the same length with the same codec string would still be distinct), yet
// cheap: a description is ≤ 50 bytes. Collision risk within a single browser
// session is negligible. Null description (Annex-B / mcap path) maps to the
// constant key segment ":0:0" so it doesn't collide with any real avcC.
//
// The cache is module-level (lives for the worker's lifetime). It is never
// cleared — a truly unsupported codec remains cached as `false`, which is
// correct (it won't suddenly become supported mid-session). A codec marked
// supported can be safely reused across seeks for the same source.
const configSupportedCache = new Map<string, boolean>();

function descriptionChecksum(description: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < description.length; i++) {
    sum = (sum + description[i]) >>> 0; // keep as unsigned 32-bit
  }
  return sum;
}

function configCacheKey(
  codec: string,
  description: Uint8Array | null | undefined,
): string {
  if (!description || description.byteLength === 0) {
    return `${codec}:0:0`;
  }
  return `${codec}:${description.byteLength}:${descriptionChecksum(description)}`;
}

// Latched fatal decode error from the `VideoDecoder({ error })` callback.
// A mid-stream decode fault (corrupt NAL, GPU reset, unsupported feature)
// fires the async error callback OUTSIDE any open/seek/close body, so it
// can't reject a pending promise on its own. We latch it here and surface
// it two ways: (1) proactively, by posting a `decode-error` control message
// over the frame sink so the panel can flip to its stalled/retry UI without
// waiting for the 5 s stall timeout; (2) reactively, by rejecting the NEXT
// open()/seek() unless it is a forced retry that re-primes the decoder. The
// latch is cleared at the start of every `openInternal` so a re-open (the
// panel's retry path) recovers a wedged stream instead of staying broken.
let decodeError: Error | null = null;

// Posts a structured control message over the active frame sink. The sink
// is the same `MessagePort` the worker already uses to hand `VideoFrame`s
// to the panel; the panel's `onmessage` discriminates frame vs control
// payloads. No-op when no sink is connected yet.
function postSinkControl(message: { type: "decode-error"; reason: string }): void {
  const sink = session?.sink ?? pendingSink;
  if (sink) sink.postMessage(message);
}

// Handle the async `VideoDecoder` error callback. Latch the error, end the
// current session so the pull loop and drains stop touching a dead decoder,
// and notify the panel proactively. Recovery happens on the next open/seek,
// which recreates the decoder from scratch.
function onDecoderError(e: DOMException | Error): void {
  const reason = e instanceof Error ? e.message : String(e);
  console.error("VideoDecoder error:", e);
  decodeError = e instanceof Error ? e : new Error(reason);
  if (session) {
    session.ended = true;
    if (session.pendingPreTargetFrame) {
      session.pendingPreTargetFrame.close();
      session.pendingPreTargetFrame = null;
    }
  }
  postSinkControl({ type: "decode-error", reason });
}

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
  // Capture the session at start: if `seek()` replaces the module-level
  // `session` while we're awaiting `ops.next`, the pull belongs to the
  // PRIOR stream. Resuming and mutating `session.*` would poison the
  // new session — most catastrophically, the empty batch we get back
  // for a closed stream would set the *new* session's `ended = true`,
  // wedging the decoder permanently (symptom: a big seek leaves the
  // canvas frozen on the prior frame; `frameIndex` stops advancing).
  const pulling = session;
  const batch = (await pulling.ops.next(
    pulling.streamId,
    PULL_BATCH,
  )) as EncodedChunkWire[];
  // Bail if seek/open swapped the active session while we awaited.
  // The new session does its own priming inside `openInternal`, so
  // discarding `batch` here doesn't leave it under-fed.
  if (session !== pulling) return;
  if (session.ended) return;
  if (batch.length === 0) {
    session.ended = true;
    await drainAtEnd(pulling);
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
      // Synchronous decode throw (e.g. unconfigured/closed codec, malformed
      // chunk). Latch + notify the same way the async error callback does so
      // the panel reacts immediately instead of waiting on the stall timer.
      onDecoderError(e as Error);
      return;
    }
    session.inFlight += 1;
  }
}

// `pullInFlight` serialises refills. Both `setCursor` and `onFrame` call
// `maybeRefill`; without a mutex they can start concurrent `pullAndFeed`s
// while the previous `await ops.next` is still pending, double-counting
// against `inFlight` and racing the reader stream.
let pullInFlight = false;

async function maybeRefill(): Promise<void> {
  if (!session) return;
  if (session.ended) return;
  if (pullInFlight) return;
  if (
    !shouldRefill({
      inFlight: session.inFlight,
      lastEmittedPtsNs: session.lastEmittedPtsNs,
      cursorNs,
    })
  ) {
    return;
  }
  pullInFlight = true;
  try {
    await pullAndFeed();
  } finally {
    pullInFlight = false;
  }
}

async function configureFromFirstKeyframe(
  initial: EncodedChunkWire[],
  description: Uint8Array | null,
  framing: Mp4Framing,
  decoder: VideoDecoder,
): Promise<OpenResult> {
  const first = initial[0];
  if (!first || !first.is_keyframe) {
    throw new Error("videoDecode: first chunk is not a keyframe");
  }
  // AVC mode (standard mp4): the avcC description carries SPS/PPS, profile,
  // and length size. Derive the codec string from its profile/compat/level
  // bytes — the chunk data is raw AVCC NALs, not Annex-B, so `findSps`
  // would not find anything to parse anyway.
  // Annex-B mode (mcap, or non-standard mp4 detected at open()): scan the
  // first chunk for an inline SPS and derive the codec from there.
  let codec: string;
  if (framing === "avcc" && description) {
    codec = codecFromAvccDescription(description);
  } else {
    const sps = findSps(first.data);
    codec = sps ? codecStringFromSps(sps) : CODEC_STRING_FALLBACK;
  }
  const baseConfig: VideoDecoderConfig = {
    codec,
    optimizeForLatency: false,
    ...(framing === "avcc" && description ? { description } : {}),
  };
  const cacheKey = configCacheKey(codec, baseConfig.description as Uint8Array | null | undefined);
  let supported = configSupportedCache.get(cacheKey);
  if (supported === undefined) {
    // First time we've seen this config: ask the browser and cache the answer.
    const result = await VideoDecoder.isConfigSupported(baseConfig);
    supported = result.supported ?? false;
    configSupportedCache.set(cacheKey, supported);
  }
  if (!supported) {
    throw new Error(
      `videoDecode: codec not supported by this browser: ${codec}`,
    );
  }
  decoder.configure(baseConfig);
  return { codec };
}

/// avcC byte layout: [0]=configurationVersion, [1]=AVCProfileIndication,
/// [2]=profile_compatibility, [3]=AVCLevelIndication. Mirrors what
/// `codecStringFromSps` does for an Annex-B SPS payload.
function codecFromAvccDescription(description: Uint8Array): string {
  if (description.length < 4) return CODEC_STRING_FALLBACK;
  return `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
}

async function openInternal(
  sourceKind: VideoSourceKind,
  sourceHandle: number,
  channelId: string,
  fromPtsNs: bigint,
): Promise<OpenResult> {
  await closeInternal();
  // Recovery point: a fresh open/seek recreates the decoder below, so any
  // previously-latched fatal decode error no longer applies. Clear it here
  // (rather than in the public `seek`/`open`) so every code path that builds
  // a new session — including the panel's forced retry — un-wedges the
  // stream.
  decodeError = null;
  // Re-seed the cursor watermark so the first pull respects the open
  // target. Without this, a stale `cursorNs` from a previous stream
  // would either over-pace or stall the new decode.
  if (cursorNs < fromPtsNs) cursorNs = fromPtsNs;
  const dc = getDataCore();
  const ops = videoStreamOps(dc, sourceKind, mp4Lazy ?? undefined);
  const { streamId, description, framing } = await ops.open(
    sourceHandle,
    channelId,
    fromPtsNs,
  );
  const decoder = new VideoDecoder({
    output: (frame) => onFrame(frame),
    // Fatal for this session: latch the error, end the session, and notify
    // the panel proactively (see `onDecoderError`). The next open/seek
    // recreates the decoder, so a wedged stream recovers on retry.
    error: (e) => onDecoderError(e),
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
    lastEmittedPtsNs: null,
    pendingPreTargetFrame: null,
  };

  const initial = (await ops.next(
    streamId,
    PRIMING_BATCH,
  )) as EncodedChunkWire[];
  if (initial.length === 0) {
    session.ended = true;
    return { codec: "" };
  }
  const result = await configureFromFirstKeyframe(
    initial,
    description,
    framing,
    decoder,
  );
  for (const c of initial) {
    const chunk = new EncodedVideoChunk({
      type: c.is_keyframe ? "key" : "delta",
      timestamp: ptsToMicros(c.pts_ns),
      data: c.data,
    });
    try {
      decoder.decode(chunk);
    } catch (e) {
      // A throw while feeding the priming batch is fatal for this session;
      // latch + notify, then abort priming. The returned codec is still
      // valid (configure() succeeded), so `open()` resolves — the panel
      // learns of the failure via the proactive `decode-error` message.
      onDecoderError(e as Error);
      break;
    }
    session.inFlight += 1;
  }
  return result;
}

function emitFrame(frame: VideoFrame, ptsNs: bigint): void {
  if (!session || !session.sink) {
    frame.close();
    return;
  }
  // HUD metrics. We only count frames that clear the discard gate — that
  // keeps `frameIndex` a "visible frames since open" counter even when a
  // seek primes the decoder with pre-target frames.
  session.frameIndex += 1;
  session.lastEmittedPtsNs = ptsNs;
  // `decodeQueueSize` is a hint per spec; some backends report 0 even with
  // chunks in flight. Surface it anyway — it's the metric `T5.2` asks for.
  const decodeQueue = session.decoder.decodeQueueSize;
  // Transfer the VideoFrame to VideoPanel. The panel owns `close()` from
  // here on.
  session.sink.postMessage(
    { ptsNs, frame, frameIndex: session.frameIndex, decodeQueue },
    [frame],
  );
}

function onFrame(frame: VideoFrame): void {
  if (!session) {
    frame.close();
    return;
  }
  session.inFlight = Math.max(0, session.inFlight - 1);
  const ptsNs = BigInt(frame.timestamp) * 1000n;
  if (ptsNs < session.discardBeforePtsNs) {
    // Pre-target frame: hold the most recent one so we can emit it just
    // before the first post-target frame. The decoder produces frames in
    // PTS order, so each new pre-target frame supersedes the prior one.
    if (session.pendingPreTargetFrame) {
      session.pendingPreTargetFrame.close();
    }
    session.pendingPreTargetFrame = frame;
    void maybeRefill();
    return;
  }
  if (!session.sink) {
    // No consumer connected yet. Drop to keep the GPU pool from starving.
    if (session.pendingPreTargetFrame) {
      session.pendingPreTargetFrame.close();
      session.pendingPreTargetFrame = null;
    }
    frame.close();
    void maybeRefill();
    return;
  }
  // First frame at/after the seek target — flush the buffered pre-target
  // frame first so the panel has a frame whose PTS <= cursor to blit when
  // the seek lands between frame boundaries.
  if (session.pendingPreTargetFrame) {
    const pre = session.pendingPreTargetFrame;
    session.pendingPreTargetFrame = null;
    const prePts = BigInt(pre.timestamp) * 1000n;
    emitFrame(pre, prePts);
  }
  emitFrame(frame, ptsNs);
  void maybeRefill();
}

// End-of-stream drain. WebCodecs buffers frames inside the decoder (the
// H.264 reorder window), so the tail of the final GOP only comes out on an
// explicit `flush()`. And when the cursor sits at or past the last sample's
// PTS there is never a post-target frame to trigger the held pre-target
// frame's emit in `onFrame`, so after flushing we hand the newest
// pre-target frame to the panel ourselves. Without this, a seek that lands
// on (or just before) the final frame leaves the canvas frozen on the prior
// position — the decode queue drains to empty and nothing is ever blitted.
// Runs only once per stream, at genuine end-of-stream, so it never touches
// the steady-state pull path.
async function drainAtEnd(s: SessionState): Promise<void> {
  if (s.decoder.state === "configured") {
    try {
      await s.decoder.flush();
    } catch {
      // flush() rejects if a concurrent seek reset/closed the decoder; the
      // superseding session primes itself, so there is nothing to drain.
    }
  }
  // A seek may have swapped the active session out while we awaited flush.
  if (session !== s) return;
  if (s.pendingPreTargetFrame) {
    const pre = s.pendingPreTargetFrame;
    s.pendingPreTargetFrame = null;
    emitFrame(pre, BigInt(pre.timestamp) * 1000n);
  }
}

async function closeInternal(): Promise<void> {
  if (!session) return;
  const s = session;
  session = null;
  if (s.pendingPreTargetFrame) {
    s.pendingPreTargetFrame.close();
    s.pendingPreTargetFrame = null;
  }
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

// --- open / seek serialisation ---------------------------------------------
//
// `open()`, `seek()` and `close()` each tear the current session down and
// rebuild it; running two concurrently corrupts the shared decoder and wedges
// the stream permanently (see `makeOpQueue` in `videoDecodeOps` for the full
// failure mode + the DataError/EncodingError it produces). `runExclusive`
// chains every open/seek/close so their bodies never overlap. `seekGeneration`
// then coalesces a burst to last-wins: a queued seek already superseded by a
// newer one returns immediately instead of replaying a now-pointless
// teardown+reopen, so the chain drains straight to the final target.
const { runExclusive } = makeOpQueue();
let seekGeneration = 0;

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
  setMp4LazyPort(port: MessagePort): void {
    // Bound separately from `dataCore` because the lazy mp4 reads come
    // from the main-thread `Mp4SampleCache`, not the dataCore worker.
    // Required before opening any `mp4` source; left null for `mcap`-only
    // sessions.
    mp4Lazy = Comlink.wrap<Mp4LazyPortApi>(port);
  },
  setFrameSink(port: MessagePort): void {
    if (session) session.sink = port;
    // If set before open(), the latest port wins and will be adopted at open().
    pendingSink = port;
  },
  // Backward-compatible additive method: lets the panel (or a test) poll the
  // latched fatal decode error reactively, as a fallback to the proactive
  // `decode-error` sink message. Returns null once a successful open/seek has
  // recovered the stream. Existing Comlink consumers are unaffected.
  lastError(): string | null {
    return decodeError ? decodeError.message : null;
  },
  setCursor(ns: bigint): void {
    cursorNs = ns;
    // Wake the pull loop in case the pacing gate was the only reason it
    // stopped — `maybeRefill` is otherwise driven by `onFrame`, which a
    // gated decoder no longer fires.
    void maybeRefill();
  },
  async open(
    sourceKind: VideoSourceKind,
    sourceHandle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<OpenResult> {
    return runExclusive(async () => {
      const result = await openInternal(
        sourceKind,
        sourceHandle,
        channelId,
        fromPtsNs,
      );
      if (session && pendingSink) session.sink = pendingSink;
      return result;
    });
  },
  async seek(targetNs: bigint, force = false): Promise<void> {
    // Stamp this seek up front so a newer one issued while we wait in the
    // queue can supersede us. `force` (the panel's "retry") bypasses both the
    // coalescing skip and the duplicate-target guard so a user can always
    // re-prime a stream that has gone bad at the current cursor.
    const myGen = ++seekGeneration;
    await runExclusive(async () => {
      // Coalesce: a queued seek that a later seek has already superseded does
      // nothing — the newer one will reopen at the final target.
      if (!force && myGen !== seekGeneration) return;
      if (!session) return;
      // Duplicate-target guard: the debounced effect in VideoPanel can fire
      // with an unchanged target after a drag that ended on the same PTS.
      // The teardown+reopen round-trip isn't free, so skip it — unless the
      // caller forces it (retry re-seeks the same PTS on a wedged stream),
      // or the session has latched a fatal decode error, in which case the
      // re-open below is the only way to un-wedge it.
      if (
        !force &&
        decodeError === null &&
        session.lastOpenedFromNs === targetNs
      )
        return;
      const { sourceKind, sourceHandle, channelId, ops } = session;
      try {
        session.decoder.reset();
      } catch {
        // If the decoder is already closed, restart fresh below.
      }
      const prevStreamId = session.streamId;
      // Close the pre-target frame held from the previous stream so the GPU
      // pool does not leak a VideoFrame across the seek boundary.
      if (session.pendingPreTargetFrame) {
        session.pendingPreTargetFrame.close();
        session.pendingPreTargetFrame = null;
      }
      // Null out session BEFORE the manual stream close so that the
      // `closeInternal()` call at the top of `openInternal()` sees a null
      // session and returns immediately — preventing a second `ops.close` on
      // the same stream id (double-close: one here, one inside closeInternal).
      session = null;
      try {
        await ops.close(prevStreamId);
      } catch {
        // ignore
      }
      await openInternal(sourceKind, sourceHandle, channelId, targetNs);
      // Re-read the module-level `session` — TypeScript narrowed it to `null`
      // above (from our explicit `session = null`), but `openInternal` may
      // have assigned a fresh SessionState to it. The cast re-widens the type.
      const newSession = session as SessionState | null;
      if (newSession && pendingSink) newSession.sink = pendingSink;
    });
  },
  async close(): Promise<void> {
    await runExclusive(() => closeInternal());
  },
};

export type VideoDecodeApi = typeof videoDecodeApi;

Comlink.expose(videoDecodeApi);
