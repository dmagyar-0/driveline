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
