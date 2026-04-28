// Pure helpers extracted from `videoDecode.worker.ts` so vitest can exercise
// the H.264 codec-string derivation, Annex-B SPS scan, and the reader-kind
// dispatch without spinning up a wasm module or a real `VideoDecoder`.
//
// The worker itself stays thin: session management and decoder wiring live
// there; everything below is side-effect-free and can run in node.

import type * as Comlink from "comlink";
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
export interface VideoStreamOps {
  open(handle: number, channelId: string, fromPtsNs: bigint): Promise<number>;
  next(streamId: number, maxN: number): Promise<EncodedChunkWire[]>;
  close(streamId: number): Promise<void>;
}

export function videoStreamOps(
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
// Steady-state batch fed to the decoder per refill. Small so each pull
// adds at most a couple of frames to the panel queue (`MAX_QUEUE = 8`),
// even when the HW 4K decoder drains the encoded stream in a fraction
// of real-time.
export const PULL_BATCH = 2;
// Open / seek priming batch. Larger than `PULL_BATCH` so the decoder
// gets a full GOP's worth of reference frames (4K H.264 High @ L4.2 is
// typically IBBP/IBBBP) before steady-state pacing engages — keeps
// seek-to-blit inside the T5.2 budget (P50 < 120ms / P95 < 250ms).
export const PRIMING_BATCH = 8;
// Decoder pacing watermark — the most recently emitted frame's PTS may
// not run further than this beyond the main-thread cursor. Sized to fit
// inside `MAX_QUEUE = 8` frames at 30 fps content (≈ 4.5 frames of lead),
// so the worker stops pulling well before a queue-full drop can occur.
export const LOOKAHEAD_NS: bigint = 150_000_000n;

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
