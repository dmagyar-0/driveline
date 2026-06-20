// Lazy windowed cache for mp4 sample bytes.
//
// Lives on the main thread; the dataCore worker only returns the per-sample
// index (offsets/sizes/sync flags/pts) at open time. This module reads
// individual sample bodies from the source `File` blob via `slice()` on
// demand, keeps an LRU window around the cursor, and evicts least-recently-
// used samples when total cached bytes exceed the configured budget or the
// browser reports memory pressure.
//
// Notification API: a single subscriber (the session store) is told when
// the set of cached samples changes — coalesced via rAF — so the timeline
// can render shaded buffered ranges. A second subscriber (also the store)
// observes pending fetches so the timeline can show a spinner near the
// cursor while a cold seek is in flight.

import type { Mp4SidecarIndex } from "../workers/dataCore.worker";
import {
  getInitialBudgetBytes,
  memoryPressure,
  sharedMp4Budget,
  type Mp4BudgetCoordinator,
} from "./memoryBudget";

/**
 * Factor applied to a cache's own budget to derive the *hard* ceiling at
 * which even active (pinned) samples become evictable. The active set is
 * normally exempt from eviction so the decoder never refetches a sample
 * it just decoded past — but a runaway active window must not let the
 * cache grow without bound. Once resident bytes cross
 * `budget * ACTIVE_HARD_MULTIPLIER`, the least-recently-used active
 * samples are evicted too. The multiplier leaves generous headroom for a
 * legitimately large GOP/active window before the hard bound bites.
 */
const ACTIVE_HARD_MULTIPLIER = 2;

/**
 * Absolute floor for the active hard ceiling, so a tiny per-cache budget
 * (tests shrink it to a handful of bytes) still permits a minimal active
 * window before the hard bound starts evicting pinned samples.
 */
const ACTIVE_HARD_FLOOR_BYTES = 32;

export interface BufferedRange {
  startNs: bigint;
  endNs: bigint;
}

export interface PendingFetch {
  targetNs: bigint;
}

interface CacheEntry {
  bytes: Uint8Array;
  size: number;
  /** Monotonic counter — most recently used wins. */
  lastUsed: number;
}

let lastUsedTick = 0;

export class Mp4SampleCache {
  private readonly file: File;
  readonly index: Mp4SidecarIndex;
  private budget: number;
  private cached = new Map<number, CacheEntry>();
  private inFlight = new Map<number, Promise<Uint8Array>>();
  /**
   * Sample indices the active decoder window is currently consuming;
   * these are exempt from eviction even under memory pressure so the
   * pull-and-feed loop never has to refetch a sample it just decoded
   * past. Maintained by `markActive` / `clearActive`.
   */
  private active = new Set<number>();
  private cachedBytes = 0;
  private rangesNotifyScheduled = false;
  private rangesListeners: Array<(ranges: BufferedRange[]) => void> = [];
  private pendingListeners: Array<(p: PendingFetch | null) => void> = [];
  private currentPending: PendingFetch | null = null;
  /**
   * Shared budget coordinator. Each cache reports its resident bytes here
   * and consults the aggregate when deciding to evict, so N mp4 sources
   * collectively stay under one heap-derived ceiling instead of each
   * claiming half the heap.
   */
  private readonly coordinator: Mp4BudgetCoordinator;

  constructor(
    file: File,
    index: Mp4SidecarIndex,
    budgetBytes: number = getInitialBudgetBytes(),
    coordinator: Mp4BudgetCoordinator = sharedMp4Budget,
  ) {
    this.file = file;
    this.index = index;
    this.budget = budgetBytes;
    this.coordinator = coordinator;
    this.coordinator.register(this);
  }

  /** Total bytes currently held by the cache. */
  byteSize(): number {
    return this.cachedBytes;
  }

  /** Number of samples in the index. */
  sampleCount(): number {
    return this.index.sizes.length;
  }

  /** Replace the budget. Triggers an eviction pass against the new value. */
  setBudgetBytes(n: number): void {
    // No lower clamp here — tests rely on shrinking to a few bytes to
    // exercise the eviction path. In production the budget always
    // comes from `getInitialBudgetBytes()`, which has its own floor.
    this.budget = Math.max(0, Math.floor(n));
    this.evictIfNeeded();
  }

  /**
   * Fetch a single sample's encoded bytes. Cache hit returns immediately;
   * cache miss issues a `File.slice().arrayBuffer()` and stores the result.
   * Concurrent callers requesting the same sample share one fetch.
   */
  async getSample(idx: number): Promise<Uint8Array> {
    const hit = this.cached.get(idx);
    if (hit) {
      hit.lastUsed = ++lastUsedTick;
      return hit.bytes;
    }
    const inFlight = this.inFlight.get(idx);
    if (inFlight) return inFlight;
    const promise = this.fetchSample(idx);
    this.inFlight.set(idx, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(idx);
    }
  }

  /**
   * Warm the cache for a contiguous range of sample indices without
   * awaiting completion. Safe to call repeatedly; in-flight fetches are
   * coalesced and already-cached samples are skipped. Used by the
   * videoDecode pull loop to keep ahead of the decoder watermark.
   */
  prefetchRange(startIdx: number, endIdx: number): void {
    const lo = Math.max(0, startIdx);
    const hi = Math.min(this.sampleCount() - 1, endIdx);
    for (let i = lo; i <= hi; i++) {
      if (this.cached.has(i) || this.inFlight.has(i)) continue;
      void this.getSample(i);
    }
  }

  /** Mark a sample as currently in use by the decoder window. */
  markActive(idx: number): void {
    this.active.add(idx);
  }

  /** Drop a sample from the active set. */
  clearActive(idx: number): void {
    this.active.delete(idx);
  }

  /** Replace the active set wholesale. Cheaper than per-idx for a slide. */
  setActive(idxs: Iterable<number>): void {
    this.active = new Set(idxs);
  }

  /**
   * Set / clear the "fetch in flight" indicator the timeline reads to
   * show a spinner. Only the most recent target is tracked; transient
   * mid-fetch updates are no-ops.
   */
  markPendingFetch(targetNs: bigint): void {
    if (this.currentPending && this.currentPending.targetNs === targetNs)
      return;
    this.currentPending = { targetNs };
    for (const cb of this.pendingListeners) cb(this.currentPending);
  }

  clearPendingFetch(): void {
    if (this.currentPending === null) return;
    this.currentPending = null;
    for (const cb of this.pendingListeners) cb(null);
  }

  /**
   * Subscribe to range updates. Returns an unsubscribe function. The
   * callback fires (coalesced via rAF) every time the cached set changes.
   */
  onLoadedRangesChange(cb: (ranges: BufferedRange[]) => void): () => void {
    this.rangesListeners.push(cb);
    // Fire once with the current snapshot so subscribers don't have to
    // race the first insert.
    cb(this.computeRanges());
    return () => {
      const i = this.rangesListeners.indexOf(cb);
      if (i >= 0) this.rangesListeners.splice(i, 1);
    };
  }

  /** Subscribe to pending-fetch updates. */
  onPendingFetchChange(cb: (p: PendingFetch | null) => void): () => void {
    this.pendingListeners.push(cb);
    cb(this.currentPending);
    return () => {
      const i = this.pendingListeners.indexOf(cb);
      if (i >= 0) this.pendingListeners.splice(i, 1);
    };
  }

  /** Drop everything. Called by the store on `clear()` or source removal. */
  dispose(): void {
    this.cached.clear();
    this.inFlight.clear();
    this.active.clear();
    this.cachedBytes = 0;
    // Detach from the shared budget so its bytes stop counting against the
    // global ceiling and the registry entry doesn't leak.
    this.coordinator.unregister(this);
    this.rangesListeners = [];
    this.pendingListeners = [];
    this.currentPending = null;
  }

  private async fetchSample(idx: number): Promise<Uint8Array> {
    if (idx < 0 || idx >= this.sampleCount()) {
      throw new Error(`mp4 sample idx ${idx} out of range`);
    }
    const offset = Number(this.index.offsets[idx]);
    const size = this.index.sizes[idx];
    const blob = this.file.slice(offset, offset + size);
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    // Fetch races: another caller may have already inserted while we awaited.
    const existing = this.cached.get(idx);
    if (existing) {
      existing.lastUsed = ++lastUsedTick;
      return existing.bytes;
    }
    this.cached.set(idx, {
      bytes,
      size,
      lastUsed: ++lastUsedTick,
    });
    this.cachedBytes += size;
    this.coordinator.report(this, this.cachedBytes);
    this.scheduleRangesNotify();
    this.evictIfNeeded();
    return bytes;
  }

  /**
   * Hard upper bound on resident bytes. Above this, even active (pinned)
   * samples are evictable — the active-set exemption must never let the
   * cache grow without limit. Derived from the per-cache budget with a
   * floor so tiny test budgets still allow a minimal active window.
   */
  private activeHardCeiling(): number {
    return Math.max(
      ACTIVE_HARD_FLOOR_BYTES,
      Math.floor(this.budget * ACTIVE_HARD_MULTIPLIER),
    );
  }

  private evictIfNeeded(): void {
    // Soft eviction fires when this cache is over its own budget, the
    // *aggregate* across all caches is over the shared ceiling, or the
    // browser reports memory pressure. The coordinator check keeps the
    // global footprint bounded even though each cache also has a local
    // budget; the pressure signal alone is never relied upon for the cap.
    const needsEviction = (): boolean =>
      this.cachedBytes > this.budget ||
      this.coordinator.overBudget() ||
      memoryPressure() === "high";

    // Hard eviction fires when resident bytes cross the per-cache hard
    // ceiling regardless of the active set — this is what prevents a large
    // pinned active window from starving eviction and growing unbounded.
    const overHardCeiling = (): boolean =>
      this.cachedBytes > this.activeHardCeiling();

    if (!needsEviction() && !overHardCeiling()) return;

    let changed = false;

    // Pass 1: evict non-active samples (LRU first) — the common case,
    // which preferentially retains the active set.
    const evictable: Array<{ idx: number; lastUsed: number; size: number }> =
      [];
    for (const [idx, entry] of this.cached) {
      if (this.active.has(idx)) continue;
      evictable.push({ idx, lastUsed: entry.lastUsed, size: entry.size });
    }
    evictable.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of evictable) {
      if (!needsEviction() && !overHardCeiling()) break;
      if (this.cached.delete(e.idx)) {
        this.active.delete(e.idx);
        this.cachedBytes -= e.size;
        changed = true;
      }
    }

    // Pass 2: only if we are still above the hard ceiling — i.e. the
    // active set alone exceeds it — evict the least-recently-used active
    // samples too. Bounded growth wins over the pin guarantee here.
    if (overHardCeiling()) {
      const pinned: Array<{ idx: number; lastUsed: number; size: number }> = [];
      for (const [idx, entry] of this.cached) {
        pinned.push({ idx, lastUsed: entry.lastUsed, size: entry.size });
      }
      pinned.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const e of pinned) {
        if (!overHardCeiling()) break;
        if (this.cached.delete(e.idx)) {
          this.active.delete(e.idx);
          this.cachedBytes -= e.size;
          changed = true;
        }
      }
    }

    if (changed) {
      this.coordinator.report(this, this.cachedBytes);
      this.scheduleRangesNotify();
    }
  }

  private scheduleRangesNotify(): void {
    if (this.rangesNotifyScheduled) return;
    this.rangesNotifyScheduled = true;
    const fire = () => {
      this.rangesNotifyScheduled = false;
      const ranges = this.computeRanges();
      for (const cb of this.rangesListeners) cb(ranges);
    };
    if (typeof queueMicrotask === "function") queueMicrotask(fire);
    else Promise.resolve().then(fire);
  }

  private computeRanges(): BufferedRange[] {
    const ks = Array.from(this.cached.keys()).sort((a, b) => a - b);
    if (ks.length === 0) return [];
    const pts = this.index.ptsNs;
    const ranges: BufferedRange[] = [];
    let runStart = ks[0];
    let runEnd = ks[0];
    for (let i = 1; i < ks.length; i++) {
      if (ks[i] === runEnd + 1) {
        runEnd = ks[i];
        continue;
      }
      ranges.push(this.indexRangeToTime(runStart, runEnd, pts));
      runStart = ks[i];
      runEnd = ks[i];
    }
    ranges.push(this.indexRangeToTime(runStart, runEnd, pts));
    return ranges;
  }

  private indexRangeToTime(
    startIdx: number,
    endIdx: number,
    pts: BigInt64Array,
  ): BufferedRange {
    // `pts` is in DECODE order and — for B-frame streams — non-monotonic (the
    // Mp4SidecarReader maps presentation-ordered sidecar times onto decode-order
    // samples). So a contiguous decode-index run [startIdx..endIdx] covers the
    // presentation span [min, max] of its samples, NOT pts[startIdx]..pts[endIdx]
    // (which could start on a P-frame whose presentation time is the run's max).
    let min = pts[startIdx];
    let max = pts[startIdx];
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const p = pts[i];
      if (p < min) min = p;
      if (p > max) max = p;
    }
    // End is exclusive: +1 ns keeps a single-sample run non-empty.
    return { startNs: min, endNs: max + 1n };
  }
}

/**
 * Find the largest sample index whose `pts_ns` is `<= target`. Returns
 * `-1` if no sample qualifies (target precedes the first sample). Linear
 * fallback if the typed array is short; binary search otherwise.
 */
export function findIndexAtOrBeforePts(
  ptsNs: BigInt64Array,
  target: bigint,
): number {
  const n = ptsNs.length;
  if (n === 0) return -1;
  if (target < ptsNs[0]) return -1;
  if (target >= ptsNs[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (ptsNs[mid] <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Return the largest sync-sample index `<= target`, falling back to the
 * first sync sample if `target` predates every keyframe. Returns `-1`
 * when the track has no sync samples at all.
 */
export function findKeyframeAtOrBefore(
  ptsNs: BigInt64Array,
  isSync: Uint8Array,
  target: bigint,
): number {
  const upperBound = findIndexAtOrBeforePts(ptsNs, target);
  let firstKey = -1;
  for (let i = 0; i < isSync.length; i++) {
    if (isSync[i]) {
      firstKey = i;
      break;
    }
  }
  if (firstKey < 0) return -1;
  if (upperBound < 0) return firstKey;
  for (let i = upperBound; i >= 0; i--) {
    if (isSync[i]) return i;
  }
  return firstKey;
}
