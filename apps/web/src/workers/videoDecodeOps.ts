// Pure helpers extracted from `videoDecode.worker.ts` so vitest can exercise
// the H.264 codec-string derivation, Annex-B SPS scan, and the reader-kind
// dispatch without spinning up a wasm module or a real `VideoDecoder`.
//
// The worker itself stays thin: session management and decoder wiring live
// there; everything below is side-effect-free and can run in node.
//
// Lazy-load update: the mp4+sidecar path no longer goes through the dataCore
// worker for encoded chunks. Sample bodies are fetched from the main thread
// `Mp4SampleCache` (backed by the original `File` blob), Annex-B framed in
// `mp4AnnexB.ts`, and emitted to the decoder. The MCAP path is unchanged.

import type * as Comlink from "comlink";
import { buildAvccDescription, stripInlineParameterSets } from "./mp4AnnexB";
import type { EncodedChunkWire } from "./normalise";

export type VideoSourceKind = "mcap" | "mp4";

/** mp4 mdat sample framing.
 *
 * - "avcc" (the standard ISO/IEC 14496-15 layout): each NAL unit is preceded
 *   by a 4-byte big-endian length prefix. We synthesise an avcC description
 *   from the SPS+PPS in `stsd` and feed raw sample bytes to the decoder.
 * - "annexb" (non-standard, but real in the wild — produced by the
 *   `scripts/video/make_annexb_mp4.py` fixture, or by some broadcast tools):
 *   NAL units are separated by `00 00 00 01` start codes, the same way they
 *   appear in MCAP. The decoder runs in Annex-B mode (no `description`,
 *   raw sample bytes pass-through). */
export type Mp4Framing = "avcc" | "annexb";

// The subset of `DataCoreApi` that videoDecode actually needs. Bound to a
// MessagePort handed in from the main thread so we share the main-thread
// dataCore worker's wasm slab (where the source was opened) — spawning our
// own dataCore worker would give us an empty slab and every handle would
// fail to resolve.
export interface DataCorePortApi {
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
}

/** RPC surface for the JS-side mp4 lazy stream. Bound to the main thread
 * via a separate MessagePort so the decode worker can pull encoded
 * sample bytes from `Mp4SampleCache` without ever holding the source
 * `File` blob itself. */
export interface Mp4LazyPortApi {
  /** Per-sample table for the currently-bound mp4 source. */
  mp4Index(handle: number): Promise<Mp4LazyIndex>;
  /** Read a single sample's encoded body. Hits the LRU on the main thread. */
  mp4Sample(handle: number, idx: number): Promise<Uint8Array>;
  /** Notify the cache the decoder window has slid; used for prefetch + pinning. */
  mp4SetActive(handle: number, lo: number, hi: number): Promise<void>;
  /** Surface "fetch in flight" so the timeline can show a spinner. */
  mp4MarkPending(handle: number, targetNs: bigint): Promise<void>;
  /** Clear the spinner once playback can resume. */
  mp4ClearPending(handle: number): Promise<void>;
}

export interface Mp4LazyIndex {
  channelId: string;
  ptsNs: BigInt64Array;
  offsets: BigUint64Array;
  sizes: Uint32Array;
  isSync: Uint8Array;
  sps: Uint8Array;
  pps: Uint8Array;
}

// Resolves the three stream ops for a given reader kind. Keeping this as a
// single dispatch point means `openInternal` / `pullAndFeed` / `closeInternal`
// / `seek` never have to branch on `sourceKind` themselves.
//
// `open()` returns both a stream id and the optional `description` bytes the
// videoDecode worker passes to `VideoDecoderConfig.description`. mcap streams
// run in Annex-B mode and emit `null`; mp4 streams run in AVC (length-
// prefixed) mode and emit a synthesised `avcC` configuration record. The
// AVC-mode switch is the fix for ffmpeg-encoded mp4s whose samples carry a
// leading AUD: with Annex-B prepending, SPS/PPS landed before the AUD and
// Chrome's H.264 parser rejected the chunk with `DataError: A key frame is
// required after configure() or flush()`. Feeding raw AVCC samples plus an
// explicit `description` sidesteps the entire Annex-B ordering minefield.
export interface OpenStreamResult {
  streamId: number;
  /** AVCDecoderConfigurationRecord bytes, or null for Annex-B sources. */
  description: Uint8Array | null;
  /** mp4 framing mode, derived once at `open()` time by sniffing the first
   *  sample's first 5 bytes. Always `"avcc"` for the mcap path (which never
   *  uses a length-prefix layout, but the field is part of the union type). */
  framing: Mp4Framing;
}

export interface VideoStreamOps {
  open(
    handle: number,
    channelId: string,
    fromPtsNs: bigint,
  ): Promise<OpenStreamResult>;
  next(streamId: number, maxN: number): Promise<EncodedChunkWire[]>;
  close(streamId: number): Promise<void>;
}

interface Mp4LazyStreamState {
  handle: number;
  channelId: string;
  index: Mp4LazyIndex;
  /** Index of the next sample to emit (0-based). */
  cursor: number;
  /** Detected at `open()` time; per-sample loop branches on it without
   *  re-sniffing. */
  framing: Mp4Framing;
  /** First sample bytes captured during `open()` for framing detection.
   *  Consumed (set back to null) on the first `next()` call so we don't
   *  refetch the sample we already have in memory. */
  firstSampleBytes: Uint8Array | null;
}

const PREFETCH_AHEAD = 12;

interface Mp4StreamSlot {
  state: Mp4LazyStreamState;
}

let nextMp4StreamId = 1;
const mp4Streams = new Map<number, Mp4StreamSlot>();

// ---------------------------------------------------------------------------
// mp4 index cache
// ---------------------------------------------------------------------------
//
// `mp4Port.mp4Index(handle)` is a Comlink RPC that structured-clones 4 typed
// arrays covering every sample in the file (ptsNs, offsets, sizes, isSync).
// For a typical 10-minute clip that's ≥ 18 000 entries × ~3 typed arrays ×
// ~8 bytes = several hundred KB crossing the postMessage boundary on EVERY
// seek/open. The index is immutable for the lifetime of the source — only the
// panel's disposal path on the main thread can change the underlying cache,
// and that always triggers a new `open()` with a different handle.
//
// We cache the last MAX_CACHED_HANDLES indices keyed by handle. When the
// cache is full, the least-recently-used entry is evicted (LRU-ish: a linear
// scan is fine for 4 entries). There is no explicit invalidation on source
// closure — the videoDecode worker has no close-source signal — but:
//  1. The LRU bound keeps the footprint fixed regardless of session count.
//  2. If the same handle is ever reused for a different source (not possible
//     in the current wasm slab model — handle ids are monotonically
//     increasing and never recycled within a session), the stale entry would
//     serve incorrect data. The LRU eviction order makes this a non-issue in
//     practice, and a future close-source signal could add explicit removal.
//
// Safety: the arrays arrive via structured clone (not transfer) so the main
// thread retains its own copies; caching our copy is safe.
const MAX_CACHED_HANDLES = 4;

interface Mp4IndexCacheEntry {
  handle: number;
  index: Mp4LazyIndex;
  lastUsed: number;
}

// Module-level (not per-ops-instance) because a single videoDecode worker
// serves one panel and rebuilds `makeMp4LazyOps` on every source open.
let mp4IndexCacheTick = 0;
const mp4IndexCache: Mp4IndexCacheEntry[] = [];

function getCachedMp4Index(handle: number): Mp4LazyIndex | undefined {
  const entry = mp4IndexCache.find((e) => e.handle === handle);
  if (!entry) return undefined;
  entry.lastUsed = ++mp4IndexCacheTick;
  return entry.index;
}

function setCachedMp4Index(handle: number, index: Mp4LazyIndex): void {
  // Check if already present (race: two opens of the same handle before the
  // first one completes would both fetch; the second store is a no-op update).
  const existing = mp4IndexCache.find((e) => e.handle === handle);
  if (existing) {
    existing.index = index;
    existing.lastUsed = ++mp4IndexCacheTick;
    return;
  }
  // Evict LRU when at capacity.
  if (mp4IndexCache.length >= MAX_CACHED_HANDLES) {
    let lruIdx = 0;
    for (let i = 1; i < mp4IndexCache.length; i++) {
      if (mp4IndexCache[i].lastUsed < mp4IndexCache[lruIdx].lastUsed) lruIdx = i;
    }
    mp4IndexCache.splice(lruIdx, 1);
  }
  mp4IndexCache.push({ handle, index, lastUsed: ++mp4IndexCacheTick });
}

export function videoStreamOps(
  dc: Comlink.Remote<DataCorePortApi>,
  kind: VideoSourceKind,
  mp4Port?: Comlink.Remote<Mp4LazyPortApi>,
): VideoStreamOps {
  if (kind === "mcap") {
    return {
      open: async (h, c, p) => ({
        streamId: await dc.openMcapVideoStream(h, c, p),
        description: null,
        // mcap doesn't use mp4 framing at all, but the field is part of the
        // union type. Decoder code only uses framing in conjunction with a
        // non-null description, so this value is inert here.
        framing: "avcc",
      }),
      next: (s, m) => dc.mcapVideoNextBatch(s, m),
      close: (s) => dc.closeMcapVideoStream(s),
    };
  }
  if (!mp4Port) {
    throw new Error(
      "videoDecode: mp4 lazy port not configured — main thread must " +
        "call setMp4LazyPort before opening an mp4 source",
    );
  }
  return makeMp4LazyOps(mp4Port);
}

export function makeMp4LazyOps(
  mp4Port: Comlink.Remote<Mp4LazyPortApi>,
): VideoStreamOps {
  return {
    async open(handle, channelId, fromPtsNs) {
      // Serve from the module-level index cache when available — avoids a
      // main-thread RPC + structured clone of the full typed-array index on
      // every seek/open. The index is immutable for a source handle's
      // lifetime; see the cache comment above `MAX_CACHED_HANDLES`.
      let index = getCachedMp4Index(handle);
      if (!index) {
        index = await mp4Port.mp4Index(handle);
        setCachedMp4Index(handle, index);
      }
      const cursor = pickStartCursor(index, fromPtsNs);
      const streamId = nextMp4StreamId++;
      // Surface a "fetching" indicator if the start sample isn't already
      // resident; the cache reports back via the main-thread store and
      // the timeline lights its spinner. Fire this BEFORE the sample fetch
      // below so the spinner is up while the slice is in flight; the
      // cleared signal comes from the first sample fetch completing
      // inside `next()`.
      let framing: Mp4Framing = "avcc";
      let firstSampleBytes: Uint8Array | null = null;
      if (cursor < index.ptsNs.length) {
        await mp4Port.mp4MarkPending(handle, index.ptsNs[cursor]);
        // One-shot framing detection: pull the first sample we'd emit
        // anyway, sniff its first 5 bytes, and stash it on the slot so
        // `next()` doesn't refetch. This shifts one `File.slice()` from
        // the first `next()` call into `open()`; net latency-to-first-
        // frame is unchanged.
        firstSampleBytes = await mp4Port.mp4Sample(handle, cursor);
        framing = detectMp4Framing(firstSampleBytes);
      }
      mp4Streams.set(streamId, {
        state: {
          handle,
          channelId,
          index,
          cursor,
          framing,
          firstSampleBytes,
        },
      });
      // AVCC mode (the standard mp4 layout) needs the synthesised avcC
      // description. Annex-B framed mp4s carry start codes and inline
      // SPS/PPS, just like the mcap path — the decoder derives the codec
      // string from inline SPS and runs without a `description`.
      const description =
        framing === "avcc" ? buildAvccDescription(index.sps, index.pps) : null;
      return { streamId, description, framing };
    },
    async next(streamId, maxN) {
      const slot = mp4Streams.get(streamId);
      if (!slot) return [];
      const { state } = slot;
      const total = state.index.ptsNs.length;
      if (state.cursor >= total) return [];
      const out: EncodedChunkWire[] = [];
      const take = Math.min(maxN, total - state.cursor);
      // Pin the active range so the cache doesn't evict samples we're
      // about to feed to the decoder. `setActive` overwrites — caller's
      // intent is "this is the live window".
      const activeLo = state.cursor;
      const activeHi = Math.min(total - 1, state.cursor + take + PREFETCH_AHEAD);
      await mp4Port.mp4SetActive(state.handle, activeLo, activeHi);
      for (let i = 0; i < take; i++) {
        const idx = state.cursor;
        // The very first call to `next()` after `open()` reuses the bytes
        // already fetched for framing detection; subsequent calls slice
        // from the main-thread cache as usual.
        const cached = i === 0 ? state.firstSampleBytes : null;
        const raw = cached ?? (await mp4Port.mp4Sample(state.handle, idx));
        if (i === 0) state.firstSampleBytes = null; // release reference
        let body: Uint8Array;
        if (state.framing === "avcc") {
          // Raw AVCC sample bytes (4-byte length-prefixed NAL units). The
          // worker hands these straight to `VideoDecoder.decode` after
          // configuring with the avcC `description` from `open()` — no
          // Annex-B conversion, no SPS/PPS prepend. We do drop any
          // in-band SPS/PPS NALs (x264 `repeat-headers=1` style) since
          // they're already in the description and, when they appear
          // before the AUD, Chrome's H.264 parser stalls the decoder.
          body = stripInlineParameterSets(raw);
        } else {
          // Annex-B mode: pass the sample bytes through untouched. NAL
          // units are already separated by start codes, the same shape
          // the mcap path uses, and parameter sets are in-band.
          body = raw;
        }
        out.push({
          pts_ns: state.index.ptsNs[idx],
          is_keyframe: state.index.isSync[idx] === 1,
          data: body,
        });
        state.cursor += 1;
        if (i === 0) {
          // The first sample of the batch landed → playback can resume;
          // hide the spinner.
          await mp4Port.mp4ClearPending(state.handle);
        }
      }
      return out;
    },
    async close(streamId) {
      const slot = mp4Streams.get(streamId);
      if (!slot) return;
      mp4Streams.delete(streamId);
      try {
        await mp4Port.mp4ClearPending(slot.state.handle);
      } catch {
        // best-effort
      }
    },
  };
}

/** Find the largest sync-sample index whose pts is `<= target`, falling
 *  back to the first sync sample if `target` predates every keyframe.
 *  Returns 0 for tracks without an explicit sync table (every sample
 *  treated as a keyframe). */
export function pickStartCursor(
  idx: Mp4LazyIndex,
  target: bigint,
): number {
  const n = idx.ptsNs.length;
  if (n === 0) return 0;
  // First sync index — used as fallback.
  let firstSync = -1;
  for (let i = 0; i < idx.isSync.length; i++) {
    if (idx.isSync[i] === 1) {
      firstSync = i;
      break;
    }
  }
  if (firstSync < 0) firstSync = 0;
  // Largest sample with pts <= target via binary search.
  let lo = 0;
  let hi = n - 1;
  let cand = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (idx.ptsNs[mid] <= target) {
      cand = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (cand < 0) return firstSync;
  // Walk back to the nearest preceding sync sample.
  for (let i = cand; i >= 0; i--) {
    if (idx.isSync[i] === 1) return i;
  }
  return firstSync;
}

export function hex(b: number): string {
  return b.toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Sniff a single mp4 sample to decide whether the mdat carries the standard
 * 4-byte length-prefixed NAL units (`"avcc"`) or, non-standardly, NAL units
 * separated by `00 00 00 01` Annex-B start codes (`"annexb"`).
 *
 * Run once per `open()` against the first sample we'd emit anyway. The
 * heuristic is: bytes [0..4] must be the Annex-B start code AND byte [4]
 * must look like a valid NAL header (forbidden_zero_bit clear, nal_unit_type
 * in 1..23). Otherwise we treat the sample as AVCC.
 *
 * The first sample for the streams Driveline ingests is always a keyframe
 * whose first NAL is SPS (type 7) — both for x264 with `repeat-headers=1`
 * (the canonical mp4) and for the synthesised Annex-B fixture
 * (`scripts/video/make_annexb_mp4.py`). The detector is unambiguous on
 * every realistic input. The only false-positive a real AVCC sample could
 * trigger requires a NAL whose 4-byte BE length is exactly 0x00000001
 * (= 1 byte) AND whose single payload byte happens to be a valid
 * non-unspecified NAL header. The spec-mandated minimum NAL is 2 bytes
 * (header + at least one rbsp byte for SODB), so 1-byte NAL lengths don't
 * occur in conformant streams. The 16,777,217-byte case (length prefix
 * `00 00 00 01` interpreted as a 1-byte NAL plus run-on data) is similarly
 * not realistic for H.264.
 */
export function detectMp4Framing(firstSample: Uint8Array): Mp4Framing {
  if (firstSample.length < 5) return "avcc";
  if (
    firstSample[0] !== 0x00 ||
    firstSample[1] !== 0x00 ||
    firstSample[2] !== 0x00 ||
    firstSample[3] !== 0x01
  ) {
    return "avcc";
  }
  const nalHeader = firstSample[4];
  const forbiddenBit = (nalHeader >> 7) & 1;
  const nalType = nalHeader & 0x1f;
  if (forbiddenBit !== 0) return "avcc";
  if (nalType === 0) return "avcc";
  if (nalType > 23) return "avcc";
  return "annexb";
}

/// Scan an Annex-B buffer for the first SPS (NAL type 7). Returns the SPS
/// payload bytes (excluding the start code and the NAL header byte) or null.
/// We only need bytes [1..4] — profile_idc, constraint flags, level_idc —
/// to derive the `avc1.XXXXXX` codec string.
export function findSps(annexB: Uint8Array): Uint8Array | null {
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

// Safe-ish default when we can't derive from the stream: High @ L4.2,
// matches the 4K/30 fixtures from Spike T0.2 §4.
export const CODEC_STRING_FALLBACK = "avc1.64002A";

export function codecStringFromSps(sps: Uint8Array): string {
  // profile_idc, constraint flags byte, level_idc.
  if (sps.length < 3) return CODEC_STRING_FALLBACK;
  return `avc1.${hex(sps[0])}${hex(sps[1])}${hex(sps[2])}`;
}

export function ptsToMicros(ptsNs: bigint): number {
  // WebCodecs timestamps are microseconds. We lose sub-µs resolution but
  // preserve frame ordering; the VideoPanel keeps the original ns alongside
  // the VideoFrame in its queue for exact cursor comparison.
  return Number(ptsNs / 1000n);
}

// Pull-loop tuning. Kept here (not in the worker) so the pacing predicate
// `shouldRefill` is testable in a node env without spinning up Comlink or
// a real `VideoDecoder`.
export const REFILL_LOW_WATER = 4;
// Steady-state batch fed to the decoder per refill. Sized so a pull can
// keep the decoder pipeline busy without overrunning the panel's
// `MAX_QUEUE = 16` buffer.
export const PULL_BATCH = 4;
// Open / seek priming batch. Larger than `PULL_BATCH` so the decoder
// gets a full GOP's worth of reference frames (4K H.264 High @ L4.2 is
// typically IBBP/IBBBP) before steady-state pacing engages — keeps
// seek-to-blit inside the T5.2 budget (P50 < 120ms / P95 < 250ms).
export const PRIMING_BATCH = 8;
// Decoder pacing watermark — the most recently emitted frame's PTS may
// not run further than this beyond the main-thread cursor. Sized to fit
// inside `MAX_QUEUE = 16` frames at 30 fps content (≈ 9 frames of lead),
// so the worker stops pulling well before a queue-full drop can occur
// while still letting the HW decoder keep up with cursor advance even
// on slower test hardware.
export const LOOKAHEAD_NS: bigint = 300_000_000n;

export interface RefillState {
  inFlight: number;
  lastEmittedPtsNs: bigint | null;
  cursorNs: bigint;
}

// Pure pacing predicate: `true` when the worker should pull another batch.
// `lastEmittedPtsNs === null` means we haven't emitted any post-discard
// frames yet — keep priming the decoder so seek/open converges quickly.
export function shouldRefill(state: RefillState): boolean {
  if (state.inFlight >= REFILL_LOW_WATER) return false;
  if (state.lastEmittedPtsNs === null) return true;
  return state.lastEmittedPtsNs - state.cursorNs <= LOOKAHEAD_NS;
}

/**
 * Serialises the async open/seek/close operations in `videoDecode.worker`.
 *
 * Each of those ops tears the decode session down and builds a new one
 * (`reset()` the decoder, close the reader stream, reopen + reconfigure).
 * If two run concurrently — a scrub burst, or a jump that lands while the
 * previous reopen is still awaiting its first mp4 slice — one reopen will
 * `reset()`/close a decoder the other is mid-`configure()` on, so a delta
 * NAL reaches the decoder before its keyframe. WebCodecs then throws
 * `DataError: A key frame is required after configure()` /
 * `EncodingError: Decoder failed`, the worker latches the session as ended,
 * and the stream wedges permanently ("stream stalled").
 *
 * `runExclusive` chains every submitted op onto a private promise queue so
 * their bodies never overlap. A rejected op does NOT break the chain — the
 * next op still runs. Returned from a factory (rather than module-level
 * state) so the "ops never interleave" invariant is unit-testable without a
 * real `VideoDecoder`.
 */
export function makeOpQueue(): {
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let opChain: Promise<unknown> = Promise.resolve();
  function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // `.then(fn, fn)` runs `fn` whether the previous op fulfilled or
    // rejected, so one failed op can't stall the queue forever.
    const run = opChain.then(fn, fn);
    // Swallow this op's result/error for the *chain's* purposes only; the
    // caller still observes it through the returned `run` promise.
    opChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  return { runExclusive };
}
