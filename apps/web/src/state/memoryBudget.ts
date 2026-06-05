// Memory-budget detection for the lazy mp4 sample cache.
//
// `performance.memory` is a non-standard Chromium-only diagnostic API.
// Where present, it gives us a rough tab-level heap ceiling
// (`jsHeapSizeLimit`) and current usage (`usedJSHeapSize`). On other
// browsers (Firefox, Safari) the field is `undefined` and we fall back to
// a conservative constant so the cache still has a meaningful bound.

const FALLBACK_BUDGET_BYTES = 512 * 1024 * 1024; // 512 MB

interface PerformanceMemory {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory;
}

function memoryInfo(): PerformanceMemory | null {
  if (typeof performance === "undefined") return null;
  const m = (performance as PerformanceWithMemory).memory;
  if (!m || typeof m.jsHeapSizeLimit !== "number") return null;
  return m;
}

/**
 * Initial cache budget in bytes. We claim half of `jsHeapSizeLimit` so
 * the rest of the app (React tree, video frames, Arrow batches) keeps
 * head-room. Browsers without `performance.memory` get a fixed 512 MB
 * default — a sensible compromise for typical 4–16 GB workstation RAM.
 */
export function getInitialBudgetBytes(): number {
  const m = memoryInfo();
  if (!m) return FALLBACK_BUDGET_BYTES;
  return Math.max(64 * 1024 * 1024, Math.floor(m.jsHeapSizeLimit * 0.5));
}

/**
 * Coarse pressure signal. `"high"` means the cache should evict
 * aggressively even below its budget — the rest of the app is close to
 * the heap ceiling and any further allocation risks an OOM-induced tab
 * crash. Returns `"low"` on browsers without `performance.memory`.
 */
export function memoryPressure(): "low" | "high" {
  const m = memoryInfo();
  if (!m) return "low";
  if (m.jsHeapSizeLimit === 0) return "low";
  return m.usedJSHeapSize / m.jsHeapSizeLimit > 0.8 ? "high" : "low";
}

/**
 * Shared global budget ceiling across *all* `Mp4SampleCache` instances.
 *
 * Each mp4 source builds its own cache, but they must not each claim
 * half the heap independently — with N sources that over-commits to
 * N × (heap/2). The coordinator holds a single heap-derived ceiling and
 * tracks the aggregate cached bytes across every registered cache, so a
 * cache can ask "are we over the global cap?" and evict accordingly.
 *
 * The ceiling is derived from the heap *and* is correct on browsers
 * where `performance.memory` (and therefore `memoryPressure()`) is
 * inert: it falls back to the same fixed constant as
 * `getInitialBudgetBytes()`, so the cap never relies on the pressure
 * signal being live.
 */
export class Mp4BudgetCoordinator {
  /** Aggregate cached bytes, summed across all registered caches. */
  private totalBytes = 0;
  /** Per-cache reported byte counts; identity-keyed so dispose is clean. */
  private readonly perCache = new Map<object, number>();
  private ceiling: number;

  constructor(ceilingBytes: number = getInitialBudgetBytes()) {
    this.ceiling = Math.max(0, Math.floor(ceilingBytes));
  }

  /** Register a cache. Idempotent; starts it at zero reported bytes. */
  register(cache: object): void {
    if (!this.perCache.has(cache)) this.perCache.set(cache, 0);
  }

  /** Drop a cache from the registry and reclaim its reported bytes. */
  unregister(cache: object): void {
    const prev = this.perCache.get(cache);
    if (prev === undefined) return;
    this.totalBytes -= prev;
    this.perCache.delete(cache);
  }

  /** Record a cache's current resident byte count. */
  report(cache: object, bytes: number): void {
    const prev = this.perCache.get(cache) ?? 0;
    this.totalBytes += bytes - prev;
    this.perCache.set(cache, bytes);
  }

  /** Aggregate cached bytes across all registered caches. */
  total(): number {
    return this.totalBytes;
  }

  /** The shared ceiling in bytes. */
  ceilingBytes(): number {
    return this.ceiling;
  }

  /** Replace the ceiling (used by tests; production derives it once). */
  setCeilingBytes(n: number): void {
    this.ceiling = Math.max(0, Math.floor(n));
  }

  /**
   * True when the global total exceeds the shared ceiling, or the
   * browser reports memory pressure. Caches consult this in addition to
   * their own per-cache budget so the *aggregate* stays bounded.
   */
  overBudget(): boolean {
    return this.totalBytes > this.ceiling || memoryPressure() === "high";
  }
}

/**
 * Process-wide coordinator every cache uses by default. A single ceiling
 * shared across sources keeps the aggregate cache footprint bounded.
 */
export const sharedMp4Budget = new Mp4BudgetCoordinator();
