// Frame-pacing / smoothness instrumentation for the video decode worker.
//
// Extracted verbatim from `videoDecode.worker.ts` (audit WAL-01): the decode
// state machine should own decoding + blitting, not the ~340 LOC of
// self-contained cadence math. This module is a PURE MOVE — the metric
// definitions, thresholds, rolling-window length, recompute throttle, and the
// `CadenceSummary` shape are byte-for-byte the same as before. Nothing here
// touches timing: the worker still drives every call (`recordPaint` from the
// one blit seam, `recordTick` from the 200 Hz blit clock, `reset` on temporal
// discontinuities), and `now()`/`speed` are injected so the module reads the
// SAME worker clock and playback speed it always did.
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

// Frame-pacing / smoothness summary over a rolling window of recent paints.
// The frame-*loss* counters (`drawn`/`skipped`) prove every frame was shown;
// these prove every frame was shown at the RIGHT TIME — the metric for
// judder-free ("smooth") playback. Times are milliseconds (wall clock)
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

/** Raw per-paint trace for offline analysis (pull-only via `getCadenceTrace`).
 *  dwellMs[i]/stepMs[i] describe the on-screen time + PTS advance of the frame
 *  painted at index i; leadDepth[i] is the buffer lead when it was painted. */
export interface CadenceTrace {
  dwellMs: number[];
  stepMs: number[];
  leadDepth: number[];
  clamped: boolean[];
}

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

const STARVED_TICK_MS = 12; // > ~2× the 5 ms tick target = a starved interval

// Smoothness verdict thresholds (tunable). Jitter is the dominant signal.
const SMOOTH_JITTER_RATIO = 0.25; // dwell stdev under a quarter-interval
const SMOOTH_P95_RATIO = 1.5; // no frame held > 50 % over ideal
const SMOOTH_REPEAT_RATIO = 0.05; // < 5 % of frames stuttered
const SMOOTH_RATE_LO = 0.9;
const SMOOTH_RATE_HI = 1.1;

// Snapshot recompute throttle for the per-status path; the pull `getCadence()`
// always recomputes fresh.
const CADENCE_RECOMPUTE_MS = 100;

/** The cadence tracker the worker owns. All mutable instrumentation state lives
 *  here; the worker drives it from the blit seam / blit clock and reads the
 *  worker clock + playback speed in via the injected `now()` and the `speed`
 *  argument to `compute`/`snapshot`, so timing is identical to the inline
 *  version. */
export interface CadenceTracker {
  /** Record one distinct paint. Called from `blitForCursor` immediately after
   *  the `ctx.drawImage` that put `ptsNs` on screen. */
  recordPaint(ptsNs: bigint, lead: number, clamped: boolean): void;
  /** Blit-clock health sample: the gap since the previous tick. Called once per
   *  200 Hz blit-clock tick, before the paint. */
  recordTick(tickNowMs: number): void;
  /** Count a genuine scrub/seek re-anchor of the pacing clock (diagnostic). */
  noteScrubReanchor(): void;
  /** Clear the window. Called on any temporal discontinuity (seek/close/
   *  paint-black via `flushBlitQueue`, and play-start) so a pause gap or a scrub
   *  can't pollute the dwell distribution with one giant interval. */
  reset(): void;
  /** Fresh summary over the current rolling window. */
  compute(speed: number): CadenceSummary;
  /** Throttled snapshot for the high-rate per-blit status message. */
  snapshot(speed: number): CadenceSummary;
  /** Raw per-paint trace for offline analysis (pull-only). */
  trace(): CadenceTrace;
}

/**
 * Create a cadence tracker. `now` returns the worker's monotonic clock in ms
 * (the same `performance.now()`-backed `workerNow()` the decode worker uses),
 * injected so the module stays portable and unit-testable while reading the
 * exact clock the rest of the worker reads.
 */
export function createCadenceTracker(now: () => number): CadenceTracker {
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

  // Diagnostic: how many times the playback clock RE-ANCHORED during the window.
  // With the per-tick step cap, a re-anchor forward (worker clock judged "behind"
  // the authoritative cursor) triggers a capped catch-up rush — the prime suspect
  // for the periodic single-frame slip. `scrubReanchors` counts genuine scrub/seek
  // snaps (expected ~0 during steady play); `resyncReanchors` counts the
  // RESYNC_THRESHOLD path (the suspect).
  let resyncReanchors = 0;
  let scrubReanchors = 0;

  let cachedCadence: CadenceSummary | null = null;
  let cadenceComputedMs = 0;

  function tickGapsArray(): number[] {
    return tickGapCount < CADENCE_WINDOW
      ? Array.from(tickGaps.subarray(0, tickGapCount))
      : Array.from(tickGaps);
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

  function computeCadence(speed: number): CadenceSummary {
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
    const sp = speed > 0 ? speed : 1;
    const idealDwellMs = sourceIntervalNs / sp / 1e6;
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
    const tickGapMaxMs = sortedGaps.length
      ? sortedGaps[sortedGaps.length - 1]
      : 0;
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
    const intendedDwells = step.map((s) => s / 1e6 / sp);
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

  return {
    recordPaint(ptsNs, lead, clamped) {
      paintSamples.push({ wallMs: now(), ptsNs, lead, clamped });
      if (paintSamples.length > CADENCE_WINDOW) paintSamples.shift();
    },

    recordTick(tickNowMs) {
      if (lastTickMs > 0) {
        tickGaps[tickGapIdx] = tickNowMs - lastTickMs;
        tickGapIdx = (tickGapIdx + 1) % CADENCE_WINDOW;
        if (tickGapCount < CADENCE_WINDOW) tickGapCount++;
      }
      lastTickMs = tickNowMs;
    },

    noteScrubReanchor() {
      scrubReanchors++;
    },

    reset() {
      paintSamples.length = 0;
      tickGapIdx = 0;
      tickGapCount = 0;
      lastTickMs = 0;
      resyncReanchors = 0;
      scrubReanchors = 0;
      cachedCadence = null;
    },

    compute(speed) {
      return computeCadence(speed);
    },

    snapshot(speed) {
      const t = now();
      if (!cachedCadence || t - cadenceComputedMs >= CADENCE_RECOMPUTE_MS) {
        cachedCadence = computeCadence(speed);
        cadenceComputedMs = t;
      }
      return cachedCadence;
    },

    trace() {
      const dwellMs: number[] = [];
      const stepMs: number[] = [];
      const leadDepth: number[] = [];
      const clamped: boolean[] = [];
      for (let i = 1; i < paintSamples.length; i++) {
        dwellMs.push(paintSamples[i].wallMs - paintSamples[i - 1].wallMs);
        stepMs.push(
          Number(paintSamples[i].ptsNs - paintSamples[i - 1].ptsNs) / 1e6,
        );
        leadDepth.push(paintSamples[i - 1].lead);
        clamped.push(paintSamples[i - 1].clamped);
      }
      return { dwellMs, stepMs, leadDepth, clamped };
    },
  };
}
