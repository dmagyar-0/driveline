import { describe, expect, it } from "vitest";

import { type CadenceTracker, createCadenceTracker } from "./videoCadence";

// A mutable monotonic clock so the tests drive `now()` exactly the way the
// decode worker's `workerNow()` would. Every `recordPaint`/`snapshot` reads
// this, so paint dwell times are whatever the test dictates — the module is
// pure given the clock, which is the whole point of injecting it.
function harness() {
  const clock = { t: 0 };
  const tracker = createCadenceTracker(() => clock.t);
  return { clock, tracker };
}

const MS = 1_000_000n; // ns per ms
const STEP = 40n * MS; // 40 ms source interval == 25 fps

/** Paint a frame at wall-clock `wallMs` carrying source pts `ptsNs`. */
function paint(
  clock: { t: number },
  tracker: CadenceTracker,
  wallMs: number,
  ptsNs: bigint,
  lead = 3,
  clamped = false,
): void {
  clock.t = wallMs;
  tracker.recordPaint(ptsNs, lead, clamped);
}

/** A perfectly even run: `count` paints, one source step and one wall step
 *  apart each. `dwellMs` defaults to the ideal (== 40 ms at speed 1). */
function evenRun(
  clock: { t: number },
  tracker: CadenceTracker,
  count: number,
  dwellMs = 40,
): void {
  for (let i = 0; i < count; i++) {
    paint(clock, tracker, i * dwellMs, BigInt(i) * STEP);
  }
}

describe("createCadenceTracker", () => {
  it("returns an empty summary until at least three paints exist", () => {
    const { clock, tracker } = harness();
    expect(tracker.compute(1).paints).toBe(0);

    paint(clock, tracker, 0, 0n);
    paint(clock, tracker, 40, STEP);
    // Two paints == one interval: still below the n>=3 floor.
    const s = tracker.compute(1);
    expect(s.paints).toBe(2);
    expect(s.sourceIntervalNs).toBe(0);
    expect(s.smooth).toBe(false);
  });

  it("scores a perfectly even run as smooth with zero jitter", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 12);

    const s = tracker.compute(1);
    expect(s.paints).toBe(12);
    // Median pts step recovers the true source interval without being told fps.
    expect(s.sourceIntervalNs).toBe(Number(STEP));
    expect(s.idealDwellMs).toBeCloseTo(40, 6);
    expect(s.jitterMs).toBeCloseTo(0, 6);
    expect(s.repeats).toBe(0);
    expect(s.rushed).toBe(0);
    expect(s.backwardSteps).toBe(0);
    expect(s.playbackRateRatio).toBeCloseTo(1, 6);
    expect(s.smooth).toBe(true);
  });

  it("derives ideal dwell from playback speed", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 12);

    // Same 40 ms source interval, but at 2x the frame should only be held 20 ms.
    expect(tracker.compute(2).idealDwellMs).toBeCloseTo(20, 6);
    // A non-positive speed is clamped to 1 rather than dividing by zero.
    expect(tracker.compute(0).idealDwellMs).toBeCloseTo(40, 6);
  });

  it("stays smooth at 2x when the wall cadence keeps up", () => {
    const { clock, tracker } = harness();
    // 20 ms wall dwell against a 40 ms source step == correct double-speed play.
    evenRun(clock, tracker, 12, 20);

    const s = tracker.compute(2);
    expect(s.idealDwellMs).toBeCloseTo(20, 6);
    expect(s.playbackRateRatio).toBeCloseTo(1, 6);
    expect(s.smooth).toBe(true);
  });

  it("flags a held frame as a repeat and breaks smoothness", () => {
    const { clock, tracker } = harness();
    // Even 40 ms cadence except one frame held ~2x (80 ms) — a visible stutter.
    const walls = [0, 40, 80, 120, 160, 240, 280, 320, 360, 400, 440, 480];
    walls.forEach((w, i) => paint(clock, tracker, w, BigInt(i) * STEP));

    const s = tracker.compute(1);
    expect(s.repeats).toBe(1);
    expect(s.maxDwellMs).toBeCloseTo(80, 6);
    expect(s.smooth).toBe(false);
  });

  it("flags a rushed frame held at or under half the ideal dwell", () => {
    const { clock, tracker } = harness();
    // One frame shown only 20 ms (<= 0.5x ideal) — a rushed double-step paint.
    const walls = [0, 40, 80, 120, 140, 180, 220, 260, 300, 340, 380, 420];
    walls.forEach((w, i) => paint(clock, tracker, w, BigInt(i) * STEP));

    const s = tracker.compute(1);
    expect(s.rushed).toBe(1);
    expect(s.minDwellMs).toBeCloseTo(20, 6);
  });

  it("counts backward pts steps and never calls them smooth", () => {
    const { clock, tracker } = harness();
    const pts = [0n, STEP, 2n * STEP, STEP, 4n * STEP, 5n * STEP, 6n * STEP];
    pts.forEach((p, i) => paint(clock, tracker, i * 40, p));

    const s = tracker.compute(1);
    expect(s.backwardSteps).toBe(1);
    expect(s.smooth).toBe(false);
  });

  it("recovers the source interval from the median, tolerating one skip", () => {
    const { clock, tracker } = harness();
    // Mostly even, but frame 6 skips two source frames — the median ignores it.
    const steps = [1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1];
    let pts = 0n;
    paint(clock, tracker, 0, 0n);
    steps.forEach((k, i) => {
      pts += BigInt(k) * STEP;
      paint(clock, tracker, (i + 1) * 40, pts);
    });
    expect(tracker.compute(1).sourceIntervalNs).toBe(Number(STEP));
  });

  it("reports tick-gap health and counts starved intervals", () => {
    const { clock, tracker } = harness();
    // Tick stats only populate alongside a real paint window (the empty-summary
    // path zeroes them), so feed an even run first.
    evenRun(clock, tracker, 12);
    // 5 ms target ticks, with one 20 ms starved gap (> STARVED_TICK_MS == 12).
    // Ticks start at a non-zero clock (the real worker clock never reports 0),
    // so the very first tick establishes the baseline that gaps measure from.
    const ticks = [5, 10, 15, 20, 40, 45, 50];
    ticks.forEach((t) => tracker.recordTick(t));

    const s = tracker.compute(1);
    // First tick only sets the baseline; the rest produce one gap each.
    expect(s.ticks).toBe(ticks.length - 1);
    expect(s.starvedTicks).toBe(1);
    expect(s.tickGapMaxMs).toBeCloseTo(20, 6);
  });

  it("reset() clears the rolling window and tick history", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 12);
    tracker.recordTick(0);
    tracker.recordTick(20);
    expect(tracker.compute(1).paints).toBe(12);

    tracker.reset();
    const s = tracker.compute(1);
    expect(s.paints).toBe(0);
    expect(s.ticks).toBe(0);
    expect(s.sourceIntervalNs).toBe(0);
  });

  it("snapshot() caches within the recompute throttle and refreshes after it", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 12);

    clock.t = 1000;
    const first = tracker.snapshot(1);
    // Within 100 ms the throttle hands back the very same object.
    clock.t = 1050;
    expect(tracker.snapshot(1)).toBe(first);
    // Past the throttle window it recomputes a fresh summary.
    clock.t = 1101;
    expect(tracker.snapshot(1)).not.toBe(first);
  });

  it("trace() exposes per-paint dwell and pts-step arrays", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 5);

    const t = tracker.trace();
    expect(t.dwellMs).toHaveLength(4);
    expect(t.stepMs).toHaveLength(4);
    expect(t.dwellMs.every((d) => Math.abs(d - 40) < 1e-6)).toBe(true);
    expect(t.stepMs.every((s) => Math.abs(s - 40) < 1e-6)).toBe(true);
  });

  it("counts scrub re-anchors as a pull-only diagnostic", () => {
    const { clock, tracker } = harness();
    evenRun(clock, tracker, 12);
    tracker.noteScrubReanchor();
    tracker.noteScrubReanchor();
    expect(tracker.compute(1).scrubReanchors).toBe(2);
    // resync re-anchors must stay at 0 — a non-zero value is the regression the
    // scorer guards against.
    expect(tracker.compute(1).resyncReanchors).toBe(0);
  });
});
