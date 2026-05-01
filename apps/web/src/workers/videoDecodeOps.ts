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
import {
  avccToAnnexB,
  buildFirstAnnexBChunk,
} from "./mp4AnnexB";
import type { EncodedChunkWire } from "./normalise";

export type VideoSourceKind = "mcap" | "mp4";

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
export interface VideoStreamOps {
  open(handle: number, channelId: string, fromPtsNs: bigint): Promise<number>;
  next(streamId: number, maxN: number): Promise<EncodedChunkWire[]>;
  close(streamId: number): Promise<void>;
}

interface Mp4LazyStreamState {
  handle: number;
  channelId: string;
  index: Mp4LazyIndex;
  /** Index of the next sample to emit (0-based). */
  cursor: number;
  /** True until the first chunk goes out — gates the SPS/PPS prepend. */
  awaitingExtradata: boolean;
}

const PREFETCH_AHEAD = 12;

interface Mp4StreamSlot {
  state: Mp4LazyStreamState;
}

let nextMp4StreamId = 1;
const mp4Streams = new Map<number, Mp4StreamSlot>();

export function videoStreamOps(
  dc: Comlink.Remote<DataCorePortApi>,
  kind: VideoSourceKind,
  mp4Port?: Comlink.Remote<Mp4LazyPortApi>,
): VideoStreamOps {
  if (kind === "mcap") {
    return {
      open: (h, c, p) => dc.openMcapVideoStream(h, c, p),
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
      const index = await mp4Port.mp4Index(handle);
      const cursor = pickStartCursor(index, fromPtsNs);
      const streamId = nextMp4StreamId++;
      mp4Streams.set(streamId, {
        state: {
          handle,
          channelId,
          index,
          cursor,
          awaitingExtradata: true,
        },
      });
      // Surface a "fetching" indicator if the start sample isn't already
      // resident; the cache reports back via the main-thread store and
      // the timeline lights its spinner. The cleared signal comes from
      // the first sample fetch completing inside `next()`.
      if (cursor >= 0) {
        await mp4Port.mp4MarkPending(handle, index.ptsNs[cursor]);
      }
      return streamId;
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
        const body = await mp4Port.mp4Sample(state.handle, idx);
        const annexB = avccToAnnexB(body);
        const chunkData = state.awaitingExtradata
          ? buildFirstAnnexBChunk(annexB, state.index.sps, state.index.pps)
          : annexB;
        if (state.awaitingExtradata) state.awaitingExtradata = false;
        out.push({
          pts_ns: state.index.ptsNs[idx],
          is_keyframe: state.index.isSync[idx] === 1,
          data: chunkData,
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
