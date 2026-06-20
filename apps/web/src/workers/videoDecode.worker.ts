// T5.1 · MCAP video path, extended in T5.3 for mp4+sidecar sources.
//
// This worker owns a single `VideoDecoder` configured from the first MCAP
// keyframe's inline SPS. It pulls encoded Annex-B chunks from the dataCore
// worker in batches (user-chosen wire shape — see plan), feeds the decoder,
// and BLITS the decoded `VideoFrame`s onto an `OffscreenCanvas` transferred
// from `VideoPanel` (the v5 off-thread blit). `VideoFrame` never leaves the
// worker now — everything upstream is plain bytes owned by Rust until it
// crosses the wasm boundary, and the decoded frames live and die here.
//
// v5 (off-thread blit): the worker owns the visible video canvas. The panel
// calls `setRenderCanvas(OffscreenCanvas)` (Comlink-transferred) and posts
// the desired pixel size via `setRenderSize`. The worker keeps a small queue
// of decoded frames and, on every decoded frame (`onFrame`) and on
// `setCursor`, blits the newest frame whose `ptsNs <= cursorNs` to the
// canvas's 2D context. The frame-drop / `MAX_QUEUE` policy that used to live
// in `VideoPanel`'s sink `onmessage` lives here now. Instead of transferring
// frames, the worker posts a lightweight STATUS object over the same sink
// MessagePort on each blit so the main thread can drive the LiDAR overlay,
// readiness, the HUD, and the seek/first-frame perf marks.
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

// A single decoded frame captured off the playback path (see
// `captureFrameAtInternal`). `png` is transferred (zero-copy) to the caller.
export interface CapturedFrame {
  /** PTS (ns) of the frame actually returned — the newest at/<= the request. */
  ptsNs: bigint;
  width: number;
  height: number;
  /** PNG-encoded RGBA bytes of the frame. */
  png: ArrayBuffer;
}

// Frame-pacing / smoothness summary over a rolling window of recent paints.
// The frame-*loss* counters (`drawn`/`skipped`) prove every frame was shown;
// these prove every frame was shown at the RIGHT TIME — the metric for
// judder-free ("smooth") playback. See the instrumentation block lower in this
// file for how each field is derived. Times are milliseconds (wall clock)
// unless the name ends in `Ns`.
export interface CadenceSummary {
  /** Distinct frames painted in the measured window. */
  paints: number;
  /** Median source-PTS step between consecutive paints (ns) ≈ one source frame
   *  interval; self-calibrating, so the clip fps need not be known up front. */
  sourceIntervalNs: number;
  /** Wall-clock dwell each frame *should* get = sourceInterval / speed. */
  idealDwellMs: number;
  /** Dwell-time distribution — how long each frame actually stayed on screen. */
  p50DwellMs: number;
  p95DwellMs: number;
  maxDwellMs: number;
  minDwellMs: number;
  meanDwellMs: number;
  /** Stdev of dwell — the headline smoothness number (lower = smoother). */
  jitterMs: number;
  /** Frames held ≥ 1.5× ideal (a visible stutter / "the same frame twice"). */
  repeats: number;
  /** Frames shown ≤ 0.5× ideal (a rushed double-step paint). */
  rushed: number;
  /** Paints whose PTS went backwards (must be 0 — a monotonic-guard breach). */
  backwardSteps: number;
  /** Actual ÷ ideal playback rate (1 = correct, 0.5 = running at half speed). */
  playbackRateRatio: number;
  /** Verdict against the smoothness thresholds. */
  smooth: boolean;
  // --- diagnostics (localise the cause; NOT part of the verdict) -----------
  /** Playback-rate ratio over the first / second half of the window — separates
   *  a startup catch-up burst from steady-state judder. */
  firstHalfRate: number;
  secondHalfRate: number;
  /** Blit-clock (200 Hz) tick-gap health. A starved interval (worker briefly
   *  unscheduled) → a capped catch-up burst of rushed frames. */
  tickGapMaxMs: number;
  tickGapP95Ms: number;
  starvedTicks: number;
  ticks: number;
  /** Dwell histogram in units of idealDwell — buckets
   *  [<0.25, 0.25–0.5, 0.5–0.75, 0.75–1.25, 1.25–1.75, 1.75–2.5, ≥2.5]. */
  histDwell: number[];
  /** Source irregularity: stdev of each painted frame's INTENDED dwell (its own
   *  PTS step / speed) — i.e. how uneven the captured data itself is (ms). */
  sourceJitterMs: number;
  /** PLAYER judder — the true smoothness metric: spread of (actual dwell −
   *  intended dwell), which cancels out source irregularity. Lower = the player
   *  reproduces the source timing faithfully (ms). */
  playerErrStdMs: number;
  playerErrP95Ms: number;
  playerErrMaxMs: number;
  /** Player error restricted to frames whose SOURCE interval is near the median
   *  (a "regular" interval). If this is small while playerErrStdMs is large, the
   *  residual judder is the player faithfully tracking an IRREGULAR source — not
   *  a player defect. If it's also large, the player itself is the cause. */
  playerErrStdRegularMs: number;
  /** Sample size for playerErrStdRegularMs (near-median-interval pairs). */
  regularPairs: number;
  /** Re-anchors of the pacing clock during the window. The pure-wall-clock
   *  display path no longer does per-tick resync, so resyncReanchors is now
   *  always 0 (retained for the cadence-scorer contract — a non-zero value
   *  would indicate a regression that reintroduced catch-up resync).
   *  scrubReanchors should be ~0 during steady play. */
  resyncReanchors: number;
  scrubReanchors: number;
}

// Lightweight per-blit status posted to the main thread over the sink port
// (v5 off-thread blit). Replaces the per-frame `VideoFrame` transfer: the main
// thread reads the latest status to drive the LiDAR overlay, readiness, the
// HUD, and the seek/first-frame perf marks. `blitPtsNs` crosses as a bigint
// (Comlink/structured-clone carries bigint fine over a raw MessagePort).
export interface BlitStatus {
  type: "status";
  /** PTS (ns) of the frame currently on the canvas, or null before any blit. */
  blitPtsNs: bigint | null;
  /** Monotonic visible-frame counter (mirrors `session.frameIndex`). */
  frameIndex: number;
  /** Decoder's `decodeQueueSize` at the moment of the blit (HUD metric). */
  decodeQueue: number;
  /** Total frames dropped by the worker's MAX_QUEUE policy since open. */
  dropped: number;
  /** Total frames actually painted to the canvas (monotonic since worker
   *  start). One increment per `ctx.drawImage`. The headless frame-loss
   *  harness diffs this across a playthrough to prove every frame was shown. */
  drawn: number;
  /** Total decoded frames that became due (PTS ≤ cursor) but were closed
   *  WITHOUT being painted because a later frame in the same blit was also
   *  ≤ cursor — i.e. the cursor jumped past them between blits. This is the
   *  true visualisation frame-loss (distinct from queue-full `dropped`):
   *  in smooth playback it stays 0. */
  skipped: number;
  /** Frames dropped as reorder stragglers (a decoded frame that flushed already
   *  behind the on-screen frame). 0 once the decoder leads its reorder window. */
  straggler: number;
  /** `performance.now()` (worker clock) of the most recent frame arrival —
   *  the main thread maps this onto its own clock-skew-free "decoder alive"
   *  check via a delta against the status it just received. */
  frameArrivedMs: number;
  /** Length of the worker's blit queue at status time (HUD `blitQueue`). */
  blitQueueLen: number;
  /** True on the very first blit since the worker started, so the main thread
   *  can stamp `VIDEO_FIRST_FRAME` on its own perf timeline. */
  firstBlit: boolean;
  /** True on the first blit after a seek was armed via `armSeekBlit`, so the
   *  main thread can close the `VIDEO_SEEK_TO_BLIT` bracket. */
  seekBlit: boolean;
  /** Frame-pacing / smoothness summary over a rolling window (see
   *  `CadenceSummary`). Recomputed at most every `CADENCE_RECOMPUTE_MS`. */
  cadence: CadenceSummary;
}

// A decoded frame held in the worker's blit queue (v5). Mirrors the
// `QueueEntry` that used to live in `VideoPanel`.
interface QueueEntry {
  ptsNs: bigint;
  frame: VideoFrame;
  frameIndex: number;
  decodeQueue: number;
}

// Bounded blit queue. The decoder produces frames in PTS order, often far
// faster than real-time on a 4K stream with HW acceleration. A naïve
// drop-oldest policy lets the queue's PTS window slide past the cursor, after
// which the blit (which picks the newest frame ≤ cursor) has nothing to draw —
// the canvas stays frozen. Only evict the head once the cursor has passed it;
// otherwise drop the incoming frame, keeping the queue anchored at/behind the
// cursor. Mirrors the constant that used to live in `VideoPanel`.
// How many DECODED frames the worker keeps alive ahead of the cursor (reorder
// buffer + blit queue) before the pull loop stops feeding (see `maybeRefill`).
// This is a small FIXED count, NOT a memory budget: a `VideoDecoder`'s output
// pool is count-limited (the H.264 DPB, a handful of frames), and the decoder
// needs free output slots to hold its OWN in-flight B-frames before it can emit
// them. Holding too many output `VideoFrame`s here (e.g. a memory budget would
// let us hold ~64 at 1080p) drains that pool and wedges the decoder — it stops
// emitting, the panel goes "waiting", and the cursor gate freezes. Keeping the
// worker-side hold small (≈ this) leaves the decoder room to reorder while
// still buffering enough lead for smooth display.
const decodedAheadCap = 8;
// Hard safety cap on the blit/reorder buffer lengths (a drop, not a feed-stop).
// Above the feed-stop cap; only guards a runaway.
const maxQueue = 24;

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

// The PACING cursor. During playback it free-runs on the worker's own clock
// (see below); when paused it holds the last `setCursor` value. The pull loop
// gates the decoder on `lastEmittedPtsNs - cursorNs < LOOKAHEAD_NS`.
let cursorNs: bigint = 0n;

// --- worker-side playback clock (zero-frame-loss blit) ----------------------
//
// The blit used to fire ONLY when the main thread posted `setCursor`. That path
// is coalesced (~33 ms) AND subject to Comlink/main-thread scheduling jitter, so
// under the fusion render load the worker's cursor lagged the real cursor by
// 80–170 ms and arrived in uneven jumps — every jump that straddled ≥2 frame
// boundaries closed the in-between frames undrawn (measured: 81/224 frames
// skipped, p50 lag 168 ms) even though the decoded frames were sitting ready.
//
// Fix — a SINGLE wall-clock cursor driven by a worker-owned ~5 ms (200 Hz)
// interval, recomputed fresh each tick (NOT an accumulator):
//   • `cursorNs` = `anchorCursorNs + (workerNow() − anchorWallMs)·speed`, the
//     pure wall-clock position from a fixed play-start anchor. It runs at real
//     time WITHOUT inheriting the forwarded `setCursor`'s coalescing/Comlink
//     jitter, and is immune to tick starvation — a late tick reads the correct
//     time and paints the correct frame (no catch-up rush). The decoder paces
//     off it, so the lookahead stays a full second ahead of real time — enough
//     that every B-frame is decoded (in decode order) and reordered into
//     presentation order BEFORE the cursor reaches it (no stragglers).
//   • The blit picks the newest frame ≤ `cursorNs`. Because the main thread's
//     own cursor shares this exact anchor + rate, the two stay in lockstep with
//     no per-tick tracking — perfectly synced AND smooth.
//   • Gate backstop (in `blitClockTick`): if the wall clock runs past
//     `lastSetCursorNs + AHEAD_MARGIN` the main thread is holding its cursor
//     (startup priming / decode stall); pin to the cap and re-anchor so the
//     display stays a margin ahead (keeps blitting + heartbeating → the panel
//     reports ready, the gate releases) and resumes free-running cleanly.
// `setCursor` re-anchors only on a genuine scrub; normal jitter and gate holds
// are absorbed by the wall clock + backstop, never by per-tick resync.
let playbackActive = false;
let playbackSpeed = 1;
let anchorCursorNs = 0n;
let anchorWallMs = 0;
let lastSetCursorNs = 0n;
let blitClockId: ReturnType<typeof setInterval> | null = null;
// How often the worker re-evaluates the cursor + blits during play. 5 ms ≈
// 200 Hz: far finer than any real video frame rate, so every frame is the
// newest-≤-cursor for many ticks and is always painted. Each tick is cheap (a
// small queue walk; drawImage only when a new frame is actually due).
//
// CRUCIAL: the displayed cursor is a PURE function of the worker wall clock
// (`pacingCursorNs()` = anchor + elapsed·speed), recomputed fresh every tick —
// NOT an accumulator stepped per tick. So a starved/late tick is harmless: it
// simply reads the correct time once and paints the correct frame. There is
// nothing to "catch up", hence no catch-up rush (the old slew+resync design
// rushed ~5× after every starved interval). A late tick can at worst skip a
// frame if the gap exceeds one source interval — which is the correct outcome
// (you genuinely lost that wall time); rushing the skipped frame through would
// be visibly worse.
const BLIT_CLOCK_MS = 5;
// Max the DISPLAY cursor may lead the authoritative main-thread cursor before
// the gate backstop pins it. In STEADY play this never binds: the worker's
// wall-clock cursor and the main thread's cursor share the same play-start
// anchor and advance at the same rate, so they stay in lockstep (modulo a few
// ms of Comlink/coalescing lag) and the display free-runs smoothly off the
// worker clock — immune to the jitter in the forwarded `setCursor` stream. It
// binds only on a genuine HOLD (startup priming or a decode stall), where the
// main thread freezes its cursor: the display then catches up to this margin
// and pins (re-anchoring so it resumes cleanly on release). 150 ms ≈ 1.5
// source frames at 12 fps — generous enough to clear forwarding-jitter spikes
// so they never clip the smooth clock, tight enough to bound video↔timeline
// desync during a real hold.
const AHEAD_MARGIN_NS = 150_000_000n;
// Keep the free-running PACING cursor from drifting more than this past the
// authoritative cursor if the main thread stalls entirely — bounds how far the
// decoder reads ahead. Generous (a full lookahead), so normal play never hits
// it; it's just a backstop against a wedged main thread.
const MAX_PACING_AHEAD_NS = 1_000_000_000n;
// A `setCursor` this far from the pacing cursor is a real scrub/seek (not
// jitter or a gate hold): re-anchor the clock to it.
const SCRUB_THRESHOLD_NS = 500_000_000n;
// Cap a single interp evaluation so a throttled/backgrounded interval can't
// leap the cursor across many frames at once when it finally fires.
const MAX_INTERP_NS = 1_000_000_000n;

// --- temporary pacing diagnostics (flag-gated; removed before final) ---------
const DBG_PACING = true as boolean;
let dbgTick = 0;
let dbgAnchor0 = 0n;
let dbgT0 = 0;
function dbgLog(kind: string, extra: Record<string, unknown>): void {
  const t = (workerNow() - dbgT0).toFixed(0);
  // eslint-disable-next-line no-console
  console.log(`DBGPACE ${t}ms ${kind} ${JSON.stringify(extra)}`);
}

function workerNow(): number {
  return performance.now();
}

// Free-running real-time advance of the pacing cursor from its anchor.
function pacingCursorNs(): bigint {
  const elapsedMs = workerNow() - anchorWallMs;
  let deltaNs = BigInt(Math.round(elapsedMs * 1e6 * playbackSpeed));
  if (deltaNs < 0n) deltaNs = 0n;
  if (deltaNs > MAX_INTERP_NS) deltaNs = MAX_INTERP_NS;
  let next = anchorCursorNs + deltaNs;
  // Backstop: don't read arbitrarily far ahead of the authoritative cursor.
  const ceil = lastSetCursorNs + MAX_PACING_AHEAD_NS;
  if (next > ceil) next = ceil;
  return next;
}

// Diagnostic: set true on the tick whenever the gate backstop bound (the
// display caught up to `lastSetCursorNs + AHEAD_MARGIN` and was pinned —
// startup priming or a decode stall, NOT steady play). Recorded per paint so
// the cadence trace can show that smooth playback never clamps.
let blitCursorClamped = false;

// Advance the DISPLAY/pacing cursor on the worker's own clock and blit. No-op
// when not playing. Also nudges the pull loop so the decoder stays fed against
// the advancing cursor even after it goes idle at the lookahead ceiling
// (otherwise refill is only driven by `onFrame`, which a caught-up decoder
// stops firing).
//
// The cursor is the PURE wall-clock value (`pacingCursorNs()`), recomputed
// fresh each tick — never an accumulator. A late/starved tick therefore reads
// the correct position and paints the correct frame with no catch-up rush. The
// only adjustment is the gate backstop: if the wall clock has run past
// `lastSetCursorNs + AHEAD_MARGIN` the main thread is holding its cursor
// (priming/stall), so pin to the cap AND re-anchor the wall clock to it, so
// that on release the clock resumes free-running from here instead of carrying
// the held interval (which would otherwise peg the display to the noisy main
// cursor forever after the first hold).
function blitClockTick(): void {
  if (!playbackActive) return;
  // Blit-clock health sample (diagnostics): the gap since the previous tick.
  const tickNow = workerNow();
  if (lastTickMs > 0) {
    tickGaps[tickGapIdx] = tickNow - lastTickMs;
    tickGapIdx = (tickGapIdx + 1) % CADENCE_WINDOW;
    if (tickGapCount < CADENCE_WINDOW) tickGapCount++;
  }
  lastTickMs = tickNow;
  const free = pacingCursorNs();
  const cap = lastSetCursorNs + AHEAD_MARGIN_NS;
  if (free > cap) {
    cursorNs = cap;
    anchorCursorNs = cap;
    anchorWallMs = tickNow;
    blitCursorClamped = true;
  } else {
    cursorNs = free;
    blitCursorClamped = false;
  }
  if (DBG_PACING) {
    dbgTick++;
    if (dbgTick % 10 === 0) {
      dbgLog("tick", {
        cur: Number(cursorNs - dbgAnchor0) / 1e6,
        free: Number(free - dbgAnchor0) / 1e6,
        cap: Number(cap - dbgAnchor0) / 1e6,
        lastSet: Number(lastSetCursorNs - dbgAnchor0) / 1e6,
        clamped: blitCursorClamped,
        bq: blitQueue.length,
        ended: session?.ended ?? null,
      });
    }
  }
  blitForCursor();
  void maybeRefill();
}

function startBlitClock(): void {
  if (blitClockId !== null) return;
  blitClockId = setInterval(blitClockTick, BLIT_CLOCK_MS);
}

function stopBlitClock(): void {
  if (blitClockId !== null) {
    clearInterval(blitClockId);
    blitClockId = null;
  }
}

let dataCore: Comlink.Remote<DataCorePortApi> | null = null;
let mp4Lazy: Comlink.Remote<Mp4LazyPortApi> | null = null;
let session: SessionState | null = null;
// Sink port set before open() lands; adopted by the session at open() time.
let pendingSink: MessagePort | null = null;

// --- v5 off-thread blit state ----------------------------------------------
//
// The worker owns the visible video canvas (transferred from the panel via
// `setRenderCanvas`) and the blit queue. Both live module-level (like `session`
// and `cursorNs`) so the blit can run from `onFrame`/`setCursor` without
// threading them through the session — the canvas survives open/seek/close,
// only the queue is flushed on a stream change.
let renderCanvas: OffscreenCanvas | null = null;
let renderCtx: OffscreenCanvasRenderingContext2D | null = null;
// Desired pixel size posted by the main thread (mount + ResizeObserver). The
// canvas is sized from the decoded frame's display dimensions on first blit
// (so the pixel buffer matches the video), but the panel's requested size is
// recorded so a future intrinsic-size mode could honour it; CSS object-fit on
// the element handles the visual letterboxing today, exactly as before.
let renderSizeW = 0;
let renderSizeH = 0;
let canvasSized = false;
// Worker-side blit queue + the metrics the status message carries.
const blitQueue: QueueEntry[] = [];
let droppedFrames = 0;

// --- presentation-order reorder buffer --------------------------------------
//
// A `VideoDecoder` emits frames in DECODE order, not presentation order: with
// B-frames a frame can carry a PTS well below one emitted just before it
// (observed reorder spread on the nuScenes clips: ~250 ms). Feeding those
// straight to the blit makes the queue non-monotonic, and any low-PTS frame
// that flushes after the cursor has passed its PTS is lost (stale). That cost
// ~1/3 of frames during the decoder's lookahead ramp-up.
//
// Fix: emitted frames land here first, sorted by PTS, and only the most-recent
// `REORDER_HOLD_FRAMES` are held back — everything older is RELEASED to
// `blitQueue` in PTS order. Holding by a fixed FRAME COUNT (not a time window)
// is deliberate: the B-frame reorder depth is a property of the GOP structure
// (~a handful of frames) regardless of frame rate, and — crucially — a fixed
// count caps how many decoded `VideoFrame`s we keep alive at once. A time-based
// guard holds (guard × fps) frames, which for a SLOW high-res decoder (whose
// decode frontier crawls) piles up dozens of 4K frames and exhausts the
// decoder's output-frame pool, wedging it. A small fixed hold can't.
const reorderBuffer: QueueEntry[] = [];
// Frames held back for reorder. Must exceed the decoder's B-frame reorder depth
// (IBBBP ≈ 4–5; observed ≤ ~8 across our clips). Kept small so the live
// VideoFrame footprint stays bounded.
const REORDER_HOLD_FRAMES = 4;

// Insert into a PTS-ascending array (queues are small — linear from the tail).
function insertSorted(arr: QueueEntry[], e: QueueEntry): void {
  let i = arr.length;
  while (i > 0 && arr[i - 1].ptsNs > e.ptsNs) i--;
  arr.splice(i, 0, e);
}

// Release every reorder-buffer frame except the most-recent `REORDER_HOLD_FRAMES`
// (or all of them, on `flushAll` at end-of-stream) into the blit queue, in PTS
// order, then blit. `flushAll` is used by the EOS drain so the final held frames
// aren't stranded when the decode frontier stops advancing.
function releaseReordered(flushAll: boolean): void {
  const keep = flushAll ? 0 : REORDER_HOLD_FRAMES;
  while (reorderBuffer.length > keep) {
    blitQueue.push(reorderBuffer.shift()!);
  }
  blitForCursor();
}
// Exact visualisation metrics (module-level, monotonic since worker start —
// the harness reads them via the BlitStatus → HUD chain and diffs across a
// measured playthrough, so they never need resetting). `drawnFrames` counts
// frames actually painted; `skippedUndrawnFrames` counts frames that became
// due but were closed without ever being painted (cursor jumped past them).
let drawnFrames = 0;
let skippedUndrawnFrames = 0;
let stragglerDrops = 0;
let lastBlitPtsNs: bigint | null = null;
let lastFrameArrivedMs = 0;
// First-blit / post-seek-blit flags so the main thread can stamp the
// VIDEO_FIRST_FRAME and VIDEO_SEEK_TO_BLIT marks on ITS perf timeline (the
// budget measure must land on the main thread; the worker only signals when).
let firstBlitDone = false;
let seekBlitPending = false;

// --- frame-pacing / smoothness instrumentation ------------------------------
//
// Frame *loss* is proven by `drawnFrames`/`skippedUndrawnFrames`; smoothness is
// a separate axis. Even when every frame is painted, the on-screen CADENCE can
// be uneven — one frame held two intervals, the next rushed — which the eye
// reads as judder / "the same frame shown twice, then a jump". We capture it at
// the only seam that paints: each `ctx.drawImage` in `blitForCursor` is exactly
// ONE distinct frame (the drawn frame is closed + removed and the monotonic
// guard prevents a repaint), so the wall-clock gap between consecutive paints is
// the DWELL TIME of the frame just replaced, and the PTS gap is how many source
// frames that step advanced. A rolling window of recent paints feeds the
// percentiles / jitter, computed on demand. NB this measures when the WORKER
// updates the canvas (the cadence we control); the compositor then samples it at
// vsync — there is no per-presentation feedback for a worker OffscreenCanvas, so
// an even worker cadence is the necessary-and-sufficient lever we have.
interface PaintSample {
  wallMs: number;
  ptsNs: bigint;
  /** Blit-queue depth kept AHEAD of the cursor right after this paint — the
   *  display buffer lead. A dip toward 0 means the decoder/reorder pipeline is
   *  delivering just-in-time; correlating it with dwell error localises judder
   *  caused by bursty frame availability (e.g. a slow keyframe decode). */
  lead: number;
  /** Whether the AHEAD_MARGIN clamp bound when this frame was chosen (display
   *  pinned to the authoritative cursor + margin vs. the smooth pacing clock). */
  clamped: boolean;
}
// Rolling window length. ~600 paints ≈ 20 s at 30 fps / 50 s at 12 fps — a few
// seconds of recent playback so the summary always reflects "now".
const CADENCE_WINDOW = 600;
const paintSamples: PaintSample[] = [];

// Blit-clock health: gaps between consecutive 200 Hz ticks. A starved interval
// (the worker briefly not scheduled — decode / GC / contention) shows up as a
// large gap and, via the per-tick step cap, a catch-up burst of rushed frames.
// Fixed ring buffer — NOT a growable array. This is sampled at 200 Hz, so an
// O(n) `Array.shift()` here would itself load the worker thread and inflate the
// very tick-starvation it measures (observer effect). Order within the ring is
// irrelevant: the gap stats (max / p95 / starved-count) don't depend on it.
const tickGaps = new Float64Array(CADENCE_WINDOW);
let tickGapIdx = 0;
let tickGapCount = 0;
let lastTickMs = 0;
const STARVED_TICK_MS = 12; // > ~2× the 5 ms tick target = a starved interval

function tickGapsArray(): number[] {
  return tickGapCount < CADENCE_WINDOW
    ? Array.from(tickGaps.subarray(0, tickGapCount))
    : Array.from(tickGaps);
}

// Smoothness verdict thresholds (tunable). Jitter is the dominant signal.
const SMOOTH_JITTER_RATIO = 0.25; // dwell stdev under a quarter-interval
const SMOOTH_P95_RATIO = 1.5; // no frame held > 50 % over ideal
const SMOOTH_REPEAT_RATIO = 0.05; // < 5 % of frames stuttered
const SMOOTH_RATE_LO = 0.9;
const SMOOTH_RATE_HI = 1.1;

// Snapshot recompute throttle for the per-status path; the pull `getCadence()`
// always recomputes fresh.
let cachedCadence: CadenceSummary | null = null;
let cadenceComputedMs = 0;
const CADENCE_RECOMPUTE_MS = 100;

// Clear the window. Called on any temporal discontinuity (seek/close/paint-black
// via `flushBlitQueue`, and play-start) so a pause gap or a scrub can't pollute
// the dwell distribution with one giant interval.
// Diagnostic: how many times the playback clock RE-ANCHORED during the window.
// With the per-tick step cap, a re-anchor forward (worker clock judged "behind"
// the authoritative cursor) triggers a capped catch-up rush — the prime suspect
// for the periodic single-frame slip. `scrubReanchors` counts genuine scrub/seek
// snaps (expected ~0 during steady play); `resyncReanchors` counts the
// RESYNC_THRESHOLD path (the suspect).
let resyncReanchors = 0;
let scrubReanchors = 0;

function resetCadenceState(): void {
  paintSamples.length = 0;
  tickGapIdx = 0;
  tickGapCount = 0;
  lastTickMs = 0;
  resyncReanchors = 0;
  scrubReanchors = 0;
  cachedCadence = null;
}

// Record one distinct paint. Called from `blitForCursor` immediately after the
// `ctx.drawImage` that put `ptsNs` on screen.
function recordPaint(ptsNs: bigint, lead: number, clamped: boolean): void {
  paintSamples.push({ wallMs: workerNow(), ptsNs, lead, clamped });
  if (paintSamples.length > CADENCE_WINDOW) paintSamples.shift();
}

// Raw per-paint trace for offline analysis (pull-only via `getCadenceTrace`).
// dwellMs[i]/stepMs[i] describe the on-screen time + PTS advance of the frame
// painted at index i; leadDepth[i] is the buffer lead when it was painted.
function cadenceTrace(): {
  dwellMs: number[];
  stepMs: number[];
  leadDepth: number[];
  clamped: boolean[];
} {
  const dwellMs: number[] = [];
  const stepMs: number[] = [];
  const leadDepth: number[] = [];
  const clamped: boolean[] = [];
  for (let i = 1; i < paintSamples.length; i++) {
    dwellMs.push(paintSamples[i].wallMs - paintSamples[i - 1].wallMs);
    stepMs.push(Number(paintSamples[i].ptsNs - paintSamples[i - 1].ptsNs) / 1e6);
    leadDepth.push(paintSamples[i - 1].lead);
    clamped.push(paintSamples[i - 1].clamped);
  }
  return { dwellMs, stepMs, leadDepth, clamped };
}

function emptyCadence(): CadenceSummary {
  return {
    paints: paintSamples.length,
    sourceIntervalNs: 0,
    idealDwellMs: 0,
    p50DwellMs: 0,
    p95DwellMs: 0,
    maxDwellMs: 0,
    minDwellMs: 0,
    meanDwellMs: 0,
    jitterMs: 0,
    repeats: 0,
    rushed: 0,
    backwardSteps: 0,
    playbackRateRatio: 0,
    smooth: false,
    firstHalfRate: 0,
    secondHalfRate: 0,
    tickGapMaxMs: 0,
    tickGapP95Ms: 0,
    starvedTicks: 0,
    ticks: tickGapCount,
    histDwell: [0, 0, 0, 0, 0, 0, 0],
    sourceJitterMs: 0,
    playerErrStdMs: 0,
    playerErrP95Ms: 0,
    playerErrMaxMs: 0,
    playerErrStdRegularMs: 0,
    regularPairs: 0,
    resyncReanchors,
    scrubReanchors,
  };
}

function computeCadence(): CadenceSummary {
  const n = paintSamples.length;
  if (n < 3) return emptyCadence();
  const dwell: number[] = [];
  const step: number[] = [];
  let backwardSteps = 0;
  for (let i = 1; i < n; i++) {
    dwell.push(paintSamples[i].wallMs - paintSamples[i - 1].wallMs);
    const d = Number(paintSamples[i].ptsNs - paintSamples[i - 1].ptsNs);
    step.push(d);
    if (d < 0) backwardSteps++;
  }
  const sortedDwell = [...dwell].sort((a, b) => a - b);
  const sortedStep = [...step].sort((a, b) => a - b);
  const at = (arr: number[], p: number): number =>
    arr[Math.min(arr.length - 1, Math.max(0, Math.floor(arr.length * p)))];
  // Median PTS step = the true source frame interval (robust to skips / the odd
  // backward straggler that a mean would smear).
  const sourceIntervalNs = Math.abs(at(sortedStep, 0.5));
  const speed = playbackSpeed > 0 ? playbackSpeed : 1;
  const idealDwellMs = sourceIntervalNs / speed / 1e6;
  const mean = dwell.reduce((a, b) => a + b, 0) / dwell.length;
  const variance =
    dwell.reduce((a, b) => a + (b - mean) * (b - mean), 0) / dwell.length;
  const jitterMs = Math.sqrt(variance);
  let repeats = 0;
  let rushed = 0;
  if (idealDwellMs > 0) {
    for (const d of dwell) {
      if (d >= 1.5 * idealDwellMs) repeats++;
      else if (d <= 0.5 * idealDwellMs) rushed++;
    }
  }
  const p95 = at(sortedDwell, 0.95);
  // ideal / mean: 1 = correct speed, 0.5 = playing at half speed even if the
  // jitter is low (a "smooth but wrong-rate" failure jitter alone would miss).
  const playbackRateRatio = mean > 0 ? idealDwellMs / mean : 0;
  // --- diagnostics ---------------------------------------------------------
  const meanOf = (arr: number[]): number =>
    arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const half = Math.floor(dwell.length / 2);
  const firstMean = meanOf(dwell.slice(0, half));
  const secondMean = meanOf(dwell.slice(half));
  const firstHalfRate = firstMean > 0 ? idealDwellMs / firstMean : 0;
  const secondHalfRate = secondMean > 0 ? idealDwellMs / secondMean : 0;
  const gaps = tickGapsArray();
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const tickGapMaxMs = sortedGaps.length ? sortedGaps[sortedGaps.length - 1] : 0;
  const tickGapP95Ms = sortedGaps.length ? at(sortedGaps, 0.95) : 0;
  let starvedTicks = 0;
  for (const g of gaps) if (g > STARVED_TICK_MS) starvedTicks++;
  const histDwell = [0, 0, 0, 0, 0, 0, 0];
  if (idealDwellMs > 0) {
    const edges = [0.25, 0.5, 0.75, 1.25, 1.75, 2.5];
    for (const d of dwell) {
      const r = d / idealDwellMs;
      let b = edges.length;
      for (let k = 0; k < edges.length; k++) {
        if (r < edges[k]) {
          b = k;
          break;
        }
      }
      histDwell[b]++;
    }
  }
  // Per-frame timing faithfulness: compare each frame's ACTUAL on-screen dwell
  // to its OWN intended duration (its source PTS step / speed). This isolates
  // PLAYER judder from SOURCE irregularity — a variable-rate real-world capture
  // has uneven intended dwells, and faithfully reproducing them is not judder.
  const stdOf = (arr: number[]): number => {
    if (!arr.length) return 0;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(
      arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length,
    );
  };
  const intendedDwells = step.map((s) => s / 1e6 / speed);
  const errs = dwell.map((d, i) => d - intendedDwells[i]);
  const absErrs = errs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const sourceJitterMs = stdOf(intendedDwells);
  const playerErrStdMs = stdOf(errs);
  const playerErrP95Ms = absErrs.length ? at(absErrs, 0.95) : 0;
  const playerErrMaxMs = absErrs.length ? absErrs[absErrs.length - 1] : 0;
  // Decompose: restrict the player error to frames whose SOURCE interval is
  // near the median. Small-here-but-large-overall ⇒ the residual is the player
  // tracking an irregular source (inherent), not a player defect.
  let regErrSum = 0;
  let regErrSumSq = 0;
  let regularPairs = 0;
  for (let i = 0; i < errs.length; i++) {
    const intended = intendedDwells[i];
    if (intended >= 0.75 * idealDwellMs && intended <= 1.25 * idealDwellMs) {
      regErrSum += errs[i];
      regErrSumSq += errs[i] * errs[i];
      regularPairs++;
    }
  }
  const regMean = regularPairs ? regErrSum / regularPairs : 0;
  const playerErrStdRegularMs = regularPairs
    ? Math.sqrt(Math.max(0, regErrSumSq / regularPairs - regMean * regMean))
    : 0;
  const smooth =
    idealDwellMs > 0 &&
    backwardSteps === 0 &&
    jitterMs <= SMOOTH_JITTER_RATIO * idealDwellMs &&
    p95 <= SMOOTH_P95_RATIO * idealDwellMs &&
    repeats <= SMOOTH_REPEAT_RATIO * dwell.length &&
    playbackRateRatio >= SMOOTH_RATE_LO &&
    playbackRateRatio <= SMOOTH_RATE_HI;
  return {
    paints: n,
    sourceIntervalNs,
    idealDwellMs,
    p50DwellMs: at(sortedDwell, 0.5),
    p95DwellMs: p95,
    maxDwellMs: sortedDwell[sortedDwell.length - 1],
    minDwellMs: sortedDwell[0],
    meanDwellMs: mean,
    jitterMs,
    repeats,
    rushed,
    backwardSteps,
    playbackRateRatio,
    smooth,
    firstHalfRate,
    secondHalfRate,
    tickGapMaxMs,
    tickGapP95Ms,
    starvedTicks,
    ticks: tickGapCount,
    histDwell,
    sourceJitterMs,
    playerErrStdMs,
    playerErrP95Ms,
    playerErrMaxMs,
    playerErrStdRegularMs,
    regularPairs,
    resyncReanchors,
    scrubReanchors,
  };
}

// Throttled snapshot for the high-rate per-blit status message.
function currentCadence(): CadenceSummary {
  const t = workerNow();
  if (!cachedCadence || t - cadenceComputedMs >= CADENCE_RECOMPUTE_MS) {
    cachedCadence = computeCadence();
    cadenceComputedMs = t;
  }
  return cachedCadence;
}

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
function postSinkControl(message: {
  type: "decode-error";
  reason: string;
}): void {
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

// Post the current blit metrics to the main thread over the sink port. Cheap
// (a plain object, no transferables). `firstBlit`/`seekBlit` are one-shot
// edges consumed by the caller, so they're passed in explicitly.
function postBlitStatus(firstBlit: boolean, seekBlit: boolean): void {
  const sink = session?.sink ?? pendingSink;
  if (!sink) return;
  const status: BlitStatus = {
    type: "status",
    blitPtsNs: lastBlitPtsNs,
    frameIndex: session?.frameIndex ?? 0,
    decodeQueue: session?.decoder?.decodeQueueSize ?? 0,
    dropped: droppedFrames,
    drawn: drawnFrames,
    skipped: skippedUndrawnFrames,
    straggler: stragglerDrops,
    frameArrivedMs: lastFrameArrivedMs,
    blitQueueLen: blitQueue.length,
    firstBlit,
    seekBlit,
    cadence: currentCadence(),
  };
  sink.postMessage(status);
}

// Blit the newest queued frame whose PTS <= cursor onto the render canvas,
// then drop every queued frame that is now at/behind the cursor. No-op when
// there is no canvas yet or no frame at/<= cursor. Runs from `onFrame` (a fresh
// frame may now be blittable), `setCursor`, and the worker's playback clock.
//
// IMPORTANT: a `VideoDecoder` emits frames in presentation order *per GOP*, but
// across the lookahead window the worker's `blitQueue` can hold locally
// out-of-PTS-order frames (B-frame reorder; also brief straggler arrival). The
// blit therefore SCANS the whole queue for the true newest frame ≤ cursor — a
// "stop at the first frame > cursor" walk assumes ascending order and strands
// the real target behind an out-of-order neighbour, which silently dropped ~36%
// of frames unshown under the fusion load. Display is kept monotonic: a frame
// older than what is already on screen is a reorder straggler and is dropped,
// never presented (no backwards flicker).
function blitForCursor(): void {
  const ctx = renderCtx;
  if (!ctx || !renderCanvas) return;
  if (blitQueue.length === 0) return;
  const shownPts = lastBlitPtsNs; // frames with pts <= this are already shown
  // The DISPLAY cursor. During play `blitClockTick` sets `cursorNs` to the pure
  // wall-clock position (gate-backstop-clamped); while paused/scrubbing it is
  // the authoritative cursor set directly by `setCursor`/`open`. Either way the
  // blit picks the newest frame whose PTS <= this.
  const bc = cursorNs;

  // Newest frame with PTS <= cursor, scanning the entire (possibly unordered)
  // queue.
  let bestIdx = -1;
  let bestPts = -1n;
  for (let i = 0; i < blitQueue.length; i++) {
    const p = blitQueue[i].ptsNs;
    if (p <= bc && (bestIdx < 0 || p > bestPts)) {
      bestPts = p;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return; // nothing due yet

  const target = blitQueue[bestIdx];
  // Monotonic display guard: if even the newest due frame isn't newer than the
  // frame on screen, every due frame is a reorder straggler — drop them all and
  // draw nothing this tick.
  const advance = shownPts === null || target.ptsNs > shownPts;

  // Partition the queue: everything at/behind the cursor leaves (drawn or
  // dropped); everything ahead of the cursor stays for a future tick. Rebuild
  // in place to avoid per-blit allocation on the 200 Hz clock.
  let skippedThisBlit = 0;
  let w = 0;
  for (let i = 0; i < blitQueue.length; i++) {
    const e = blitQueue[i];
    if (e.ptsNs > bc) {
      blitQueue[w++] = e; // keep — still in the future
      continue;
    }
    if (i === bestIdx) continue; // the target is handled after the loop
    // A due frame newer than the on-screen frame but older than the target was
    // genuinely skipped (cursor advanced past >1 frame). Frames at/behind the
    // shown PTS are reorder stragglers, not skips.
    if (advance && (shownPts === null || e.ptsNs > shownPts)) skippedThisBlit++;
    e.frame.close();
  }

  if (!advance) {
    // Target is a straggler too: drop it, draw nothing, keep only the future.
    stragglerDrops += 1 + skippedThisBlit;
    target.frame.close();
    blitQueue.length = w;
    return;
  }

  skippedUndrawnFrames += skippedThisBlit;
  // Size the canvas pixel buffer to the decoded frame once (clears the canvas,
  // so only on first blit / a dimension change). Sizing the *transferred*
  // OffscreenCanvas is the worker's job — the main thread can't touch it.
  const fw = target.frame.displayWidth || target.frame.codedWidth;
  const fh = target.frame.displayHeight || target.frame.codedHeight;
  if (!canvasSized || renderCanvas.width !== fw || renderCanvas.height !== fh) {
    renderCanvas.width = fw;
    renderCanvas.height = fh;
    canvasSized = true;
  }
  ctx.drawImage(target.frame, 0, 0, renderCanvas.width, renderCanvas.height);
  drawnFrames += 1;
  // Frame-pacing sample: this is the one seam that paints a distinct frame, so
  // the gap to the previous call is its predecessor's on-screen dwell time.
  // `w` is the number of future frames kept after this paint = the buffer lead.
  recordPaint(target.ptsNs, w, blitCursorClamped);
  const firstBlit = !firstBlitDone;
  firstBlitDone = true;
  const seekBlit = seekBlitPending;
  seekBlitPending = false;
  lastBlitPtsNs = target.ptsNs;
  target.frame.close();
  blitQueue.length = w; // commit the kept (future) frames as the new queue
  postBlitStatus(firstBlit, seekBlit);
}

// Drop and close every queued frame (blit queue AND reorder buffer). Called on
// seek/close so the blit loop converges to the new stream instead of drawing
// stale frames; also resets the reorder frontier and the monotonic-display
// reference. Resetting `lastBlitPtsNs` is essential: a seek is a temporal
// discontinuity, so the frame that WAS on screen must not constrain which frame
// the new position may show. Without this, seeking forward and then playing
// from an earlier point freezes the video — every earlier frame looks like a
// reorder straggler (PTS < the stale on-screen PTS) and is dropped until the
// cursor climbs back to where the scrub had landed.
function flushBlitQueue(): void {
  for (const e of blitQueue) e.frame.close();
  blitQueue.length = 0;
  for (const e of reorderBuffer) e.frame.close();
  reorderBuffer.length = 0;
  lastBlitPtsNs = null;
  // A flush is a temporal discontinuity (seek/close/paint-black). Drop the
  // pacing window so the gap across it isn't counted as one giant dwell.
  resetCadenceState();
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
  // Bound the number of DECODED frames kept alive ahead of the cursor by COUNT,
  // not just by the LOOKAHEAD time window. A time window holds (window × fps)
  // frames, which for a slow high-resolution decoder is dozens of 4K
  // `VideoFrame`s — enough to exhaust the decoder's output-frame pool and wedge
  // it (it stops emitting, the panel goes "waiting", the cursor gate freezes).
  // A fixed count keeps the live footprint flat regardless of frame rate /
  // resolution / decode speed.
  if (reorderBuffer.length + blitQueue.length >= decodedAheadCap) return;
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
  const cacheKey = configCacheKey(
    codec,
    baseConfig.description as Uint8Array | null | undefined,
  );
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

// Enqueue a decoded frame for the off-thread blit (v5). Replaces the old
// per-frame transfer to the panel: the frame stays in the worker, gets queued
// under the MAX_QUEUE drop policy that used to live in `VideoPanel`'s sink
// `onmessage`, and `blitForCursor` draws the newest queued frame ≤ cursor.
function emitFrame(frame: VideoFrame, ptsNs: bigint): void {
  if (!session) {
    frame.close();
    return;
  }
  // HUD metrics. We only count frames that clear the discard gate — that
  // keeps `frameIndex` a "visible frames since open" counter even when a
  // seek primes the decoder with pre-target frames.
  session.frameIndex += 1;
  // Pacing watermark: the literal last-emitted PTS (decode order). Using the
  // running MAX instead makes `shouldRefill` read a decode-order P-frame as
  // "the decoder is already far ahead" and stop feeding prematurely, starving
  // the decoder until it wedges.
  session.lastEmittedPtsNs = ptsNs;
  // `decodeQueueSize` is a hint per spec; some backends report 0 even with
  // chunks in flight. Surface it anyway — it's the metric `T5.2` asks for.
  const decodeQueue = session.decoder.decodeQueueSize;
  // Safety bound against an unbounded buffer if pacing ever fails: drop the
  // single furthest-FUTURE frame (highest PTS) rather than a low-PTS one we
  // still owe the display. With the feed-stop pacing this never triggers.
  if (reorderBuffer.length + blitQueue.length >= maxQueue) {
    const victim = reorderBuffer.pop();
    if (victim) {
      victim.frame.close();
      droppedFrames += 1;
    }
  }
  // Land in the reorder buffer (PTS-sorted); release to the blit queue only
  // once safely past the reorder window so the blit always sees presentation
  // order and never has to drop a late-flushing B-frame.
  insertSorted(reorderBuffer, {
    ptsNs,
    frame,
    frameIndex: session.frameIndex,
    decodeQueue,
  });
  // Hold the reorder window only while PLAYING (smooth in-order display). When
  // paused/scrubbing the cursor is static, so flush immediately and let the
  // blit refine to the true newest-≤-cursor as later frames arrive — keeps
  // seek-to-blit latency inside its budget instead of waiting out the guard.
  releaseReordered(!playbackActive);
  // Heartbeat the panel even when this emit produced no draw (cursor held, or
  // the frame is still ahead of the cursor in the reorder window). The panel's
  // readiness "decoder alive" / "blit queue non-empty" arms key off this status
  // — without a heartbeat, a briefly-held cursor stops blits, the panel goes
  // stale → "waiting", the decode-aware gate holds the cursor, and the two
  // deadlock (the cursor never resumes, ~1/3 of frames lost to the stall). The
  // emitted frame proves the decoder is alive, so always surface it.
  postBlitStatus(false, false);
}

function onFrame(frame: VideoFrame): void {
  if (!session) {
    frame.close();
    return;
  }
  session.inFlight = Math.max(0, session.inFlight - 1);
  // Wall clock (worker) of this frame's arrival — surfaced in the status
  // message so the main thread can run the "decoder is alive" arm of the
  // readiness predicate against its own receipt time.
  lastFrameArrivedMs = performance.now();
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
  if (!renderCanvas) {
    // No canvas connected yet (the panel hasn't transferred one). Drop to
    // keep the GPU pool from starving.
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
  // End of stream: the decode frontier stops advancing, so the final
  // REORDER_GUARD worth of frames would be stranded in the reorder buffer.
  // Flush them to the blit queue in presentation order so the clip's tail is
  // shown in full.
  releaseReordered(true);
}

async function closeInternal(): Promise<void> {
  if (!session) return;
  const s = session;
  session = null;
  // Drop any frames still queued for the (now-dead) stream so they don't get
  // blitted against the next stream's cursor. The canvas itself is left as-is
  // (last frame stays visible until the new stream produces one) — the panel
  // owns when to clear via coverage logic on the main thread.
  flushBlitQueue();
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

// --- agent frame capture (off the playback path) ---------------------------
//
// Decode the single frame nearest (at or before) `atPtsNs` on a THROWAWAY
// decoder + stream and return it as PNG bytes. Used by the agent surface's
// `snapshotAt` so an automation can read the camera at any timestamp without a
// video panel, without disturbing live playback, and without the cursor having
// to be there. It never touches the module-level `session`: it owns its own
// `streamId` and `VideoDecoder`, both torn down before it returns. Runs under
// `runExclusive` (below) so it never overlaps a playback open/seek teardown.
async function captureFrameAtInternal(
  sourceKind: VideoSourceKind,
  sourceHandle: number,
  channelId: string,
  atPtsNs: bigint,
): Promise<CapturedFrame | null> {
  const dc = getDataCore();
  const ops = videoStreamOps(dc, sourceKind, mp4Lazy ?? undefined);
  const { streamId, description, framing } = await ops.open(
    sourceHandle,
    channelId,
    atPtsNs,
  );
  // Newest frame whose PTS is <= the target; a frame strictly after the target
  // is only kept as a fallback when the target precedes the very first frame.
  let best: VideoFrame | null = null;
  let captureError: Error | null = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const pts = BigInt(frame.timestamp) * 1000n;
      if (pts <= atPtsNs) {
        if (best) best.close();
        best = frame;
      } else if (best === null) {
        best = frame;
      } else {
        frame.close();
      }
    },
    error: (e) => {
      captureError = e as Error;
    },
  });
  try {
    let batch = (await ops.next(streamId, PRIMING_BATCH)) as EncodedChunkWire[];
    if (batch.length === 0) return null;
    await configureFromFirstKeyframe(batch, description, framing, decoder);
    // Feed forward until we have decoded past the target (so the reorder
    // window definitely contains the frame at/just before it), then flush.
    let fedPastTarget = false;
    while (batch.length > 0) {
      for (const c of batch) {
        if (captureError) throw captureError;
        decoder.decode(
          new EncodedVideoChunk({
            type: c.is_keyframe ? "key" : "delta",
            timestamp: ptsToMicros(c.pts_ns),
            data: c.data,
          }),
        );
        if (c.pts_ns > atPtsNs) fedPastTarget = true;
      }
      if (fedPastTarget) break;
      batch = (await ops.next(streamId, PULL_BATCH)) as EncodedChunkWire[];
    }
    if (decoder.state === "configured") {
      try {
        await decoder.flush();
      } catch {
        // A flush race shouldn't fail the capture once we already hold a frame.
      }
    }
    if (captureError) throw captureError;
    const frame = best as VideoFrame | null;
    if (!frame) return null;
    const width = frame.displayWidth || frame.codedWidth;
    const height = frame.displayHeight || frame.codedHeight;
    const oc = new OffscreenCanvas(width, height);
    const ctx = oc.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(frame, 0, 0, width, height);
    const blob = await oc.convertToBlob({ type: "image/png" });
    const png = await blob.arrayBuffer();
    return { ptsNs: BigInt(frame.timestamp) * 1000n, width, height, png };
  } finally {
    if (best) (best as VideoFrame).close();
    if (decoder.state !== "closed") {
      try {
        decoder.close();
      } catch {
        // already closed
      }
    }
    try {
      await ops.close(streamId);
    } catch {
      // stream handle may already be freed on the Rust side
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
  // Frame-pacing / smoothness metrics (see `CadenceSummary`). `getCadence`
  // recomputes fresh over the current rolling window; `resetCadence` clears the
  // window so a measurement run can scope to a clean playback span. Both are
  // additive — existing Comlink consumers are unaffected.
  getCadence(): CadenceSummary {
    return computeCadence();
  },
  getCadenceTrace(): {
    dwellMs: number[];
    stepMs: number[];
    leadDepth: number[];
    clamped: boolean[];
  } {
    return cadenceTrace();
  },
  resetCadence(): void {
    resetCadenceState();
  },
  setCursor(ns: bigint): void {
    if (playbackActive) {
      // `ns` is the authoritative timeline cursor. In steady play the worker
      // does NOT track it tick-to-tick — the display free-runs on the worker
      // wall clock (which shares the play-start anchor and rate, so it stays in
      // lockstep without inheriting the forwarded cursor's coalescing/Comlink
      // jitter). `ns` is used only as (a) the gate backstop reference
      // (`lastSetCursorNs + AHEAD_MARGIN`, applied in `blitClockTick`) and
      // (b) scrub detection. A SCRUB is detected by how far `ns` jumped from the
      // PREVIOUS authoritative cursor — NOT from the free-running pacing cursor:
      // a decode-gate hold keeps re-sending the same held `ns` while the clock
      // runs ahead, and measuring against the pacing cursor would mistake that
      // growing gap for a backward scrub and snap the clock back, freezing the
      // video and deadlocking the gate.
      const prevSet = lastSetCursorNs;
      lastSetCursorNs = ns;
      const jumped =
        ns > prevSet + SCRUB_THRESHOLD_NS || ns + SCRUB_THRESHOLD_NS < prevSet;
      if (jumped) {
        // Real scrub/seek: snap the clock to the new position.
        anchorCursorNs = ns;
        anchorWallMs = workerNow();
        cursorNs = ns;
        scrubReanchors++;
        if (DBG_PACING) {
          dbgLog("setCursor-SCRUB", {
            ns: Number(ns - dbgAnchor0) / 1e6,
            prev: Number(prevSet - dbgAnchor0) / 1e6,
          });
        }
      } else if (DBG_PACING && dbgTick % 10 === 0) {
        dbgLog("setCursor", {
          ns: Number(ns - dbgAnchor0) / 1e6,
          prev: Number(prevSet - dbgAnchor0) / 1e6,
        });
      }
      // else: normal advance / jitter / gate hold — keep free-running on the
      // wall clock; the backstop in `blitClockTick` handles a genuine hold and
      // its heartbeat releases the gate. No per-tick resync (it was the
      // catch-up-rush source).
      blitForCursor();
    } else {
      // Paused / scrubbing: this is the sole blit driver.
      cursorNs = ns;
      lastSetCursorNs = ns;
      blitForCursor();
    }
    // Wake the pull loop in case the pacing gate was the only reason it
    // stopped — `maybeRefill` is otherwise driven by `onFrame`, which a
    // gated decoder no longer fires.
    void maybeRefill();
  },
  // Zero-frame-loss playback clock. The main thread calls this whenever the
  // session's play state or speed changes, passing the authoritative cursor as
  // the anchor. While `playing`, the worker free-runs a PACING cursor on its own
  // ~5 ms interval (keeps the decoder a full second ahead → every B-frame is
  // decoded in presentation order before the cursor reaches it) and blits the
  // DISPLAY cursor (pacing clamped to a margin ahead of the authoritative
  // cursor). See the clock comments near `playbackActive`.
  setPlayback(playing: boolean, speed: number, cursorAnchorNs: bigint): void {
    playbackSpeed = speed > 0 ? speed : 1;
    if (playing) {
      anchorCursorNs = cursorAnchorNs;
      anchorWallMs = workerNow();
      cursorNs = cursorAnchorNs;
      lastSetCursorNs = cursorAnchorNs;
      playbackActive = true;
      if (DBG_PACING) {
        dbgAnchor0 = cursorAnchorNs;
        dbgT0 = workerNow();
        dbgTick = 0;
        dbgLog("play-start", { speed, anchor: 0 });
      }
      // Fresh pacing window per play session (the gap across a pause is not a
      // frame dwell).
      resetCadenceState();
      startBlitClock();
      blitForCursor();
      void maybeRefill();
    } else {
      playbackActive = false;
      stopBlitClock();
      // Settle exactly on the authoritative cursor where play stopped, and
      // flush the reorder window (no longer playing, so no in-order guard
      // needed) so a paused frame isn't held back behind it.
      cursorNs = cursorAnchorNs;
      lastSetCursorNs = cursorAnchorNs;
      releaseReordered(true);
    }
  },
  // v5 off-thread blit: adopt the visible video canvas transferred from the
  // panel (Comlink-transferred OffscreenCanvas). The worker owns its 2D
  // context and all blits from here on. `alpha: false` matches the panel's
  // old main-thread context (opaque video, no compositing cost). If a frame
  // is already queued for the current cursor, draw it immediately so a
  // late-attached canvas (or a re-attach) paints without waiting for the next
  // decode/cursor event.
  setRenderCanvas(canvas: OffscreenCanvas): void {
    renderCanvas = canvas;
    renderCtx = canvas.getContext("2d", {
      alpha: false,
    }) as OffscreenCanvasRenderingContext2D | null;
    canvasSized = false;
    // Pre-size to the panel's requested size if we have it, so the canvas is
    // never a 0×0 surface before the first decoded frame lands (the agent's
    // capture path + the overlay sizing read off the element box, not this
    // buffer, but a non-zero buffer avoids a one-frame flash). The first blit
    // re-sizes to the frame's intrinsic dimensions.
    if (renderSizeW > 0 && renderSizeH > 0) {
      canvas.width = renderSizeW;
      canvas.height = renderSizeH;
    }
    blitForCursor();
  },
  // The panel posts its desired pixel size on mount and on resize (it can't
  // size the transferred canvas itself). We record it; the canvas is sized to
  // the decoded frame's intrinsic dimensions on blit (CSS object-fit on the
  // element letterboxes it visually, exactly as the pre-v5 path did), so this
  // is advisory today — kept so the contract is honoured and a future
  // intrinsic-vs-container sizing mode has the value.
  setRenderSize(w: number, h: number): void {
    renderSizeW = w;
    renderSizeH = h;
  },
  // T7: paint the canvas black. The panel asks for this once on entry into a
  // region its source doesn't cover, so a stale frame from another time
  // doesn't linger while the cursor sits outside coverage. No-op without a
  // canvas. Also clears the blit queue so a frame buffered for the old cursor
  // can't immediately repaint over the black fill.
  paintBlack(): void {
    if (!renderCtx || !renderCanvas) return;
    flushBlitQueue();
    renderCtx.fillStyle = "#000";
    renderCtx.fillRect(0, 0, renderCanvas.width, renderCanvas.height);
    lastBlitPtsNs = null;
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
    // v5: arm the seek-to-blit bracket. The main thread marks VIDEO_SEEK_START
    // when it dispatches the (debounced) seek; the first blit after this seek
    // lands carries `seekBlit: true` so the main thread can close the
    // VIDEO_SEEK_TO_BLIT measure on its own perf timeline. Armed on every seek
    // call (including the forced retry), matching the pre-v5 main-thread flag.
    seekBlitPending = true;
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
      // Drop stale queued frames ahead of the seek so the blit converges to
      // the new target fast (the canvas keeps showing its last blit until the
      // first post-seek frame lands). Mirrors the queue flush that used to run
      // in VideoPanel's debounced seek effect.
      flushBlitQueue();
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
  // Agent surface: decode the camera frame nearest `atPtsNs` and return it as
  // PNG bytes, independent of playback. Serialised behind `runExclusive` so it
  // never interleaves with a playback open/seek teardown. Returns null when no
  // frame covers the timestamp (e.g. before the first sample or empty stream).
  async captureFrameAt(
    sourceKind: VideoSourceKind,
    sourceHandle: number,
    channelId: string,
    atPtsNs: bigint,
  ): Promise<CapturedFrame | null> {
    const captured = await runExclusive(() =>
      captureFrameAtInternal(sourceKind, sourceHandle, channelId, atPtsNs),
    );
    if (!captured) return null;
    return Comlink.transfer(captured, [captured.png]);
  },
};

export type VideoDecodeApi = typeof videoDecodeApi;

Comlink.expose(videoDecodeApi);
