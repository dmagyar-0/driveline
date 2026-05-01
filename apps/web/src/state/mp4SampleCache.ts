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
} from "./memoryBudget";

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

  constructor(
    file: File,
    index: Mp4SidecarIndex,
    budgetBytes: number = getInitialBudgetBytes(),
  ) {
    this.file = file;
    this.index = index;
    this.budget = budgetBytes;
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
    if (this.currentPending && this.currentPending.targetNs === targetNs) return;
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
    this.scheduleRangesNotify();
    this.evictIfNeeded();
    return bytes;
  }

  private evictIfNeeded(): void {
    const needsEviction = (): boolean =>
      this.cachedBytes > this.budget || memoryPressure() === "high";
    if (!needsEviction()) return;
    // Snapshot all evictable entries (anything not in the active set),
    // ordered by lastUsed ascending. We pop from the front until we are
    // back under budget or run out.
    const evictable: Array<{ idx: number; lastUsed: number; size: number }> = [];
    for (const [idx, entry] of this.cached) {
      if (this.active.has(idx)) continue;
      evictable.push({ idx, lastUsed: entry.lastUsed, size: entry.size });
    }
    evictable.sort((a, b) => a.lastUsed - b.lastUsed);
    let changed = false;
    for (const e of evictable) {
      if (!needsEviction()) break;
      if (this.cached.delete(e.idx)) {
        this.cachedBytes -= e.size;
        changed = true;
      }
    }
    if (changed) this.scheduleRangesNotify();
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
    const startNs = pts[startIdx];
    // End is exclusive: extend by half the frame interval to the next
    // sample's pts when available, otherwise +1 ns to keep the range
    // non-empty for a single-sample run.
    const lastPts = pts[endIdx];
    const nextPts = endIdx + 1 < pts.length ? pts[endIdx + 1] : lastPts + 1n;
    return { startNs, endNs: nextPts };
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
