// Minimal `performance.mark` / `performance.measure` wrapper used by the
// T6.3 perfBudgets spec.
//
// Callers in `state/store.ts`, `timeline/playback.ts`, and the video + plot
// panels emit marks at named seams; Playwright reads the resulting
// `PerformanceEntry` list via `window.__drivelinePerf`. Keeping this in one
// module makes it easy to remove later — every seam imports `perf` and
// nothing reaches into `performance` directly.

// Named perf seams. Kept here next to the wrapper so callers reference one
// canonical string and e2e / perfBudgets can assert against the same name.
//
// `VIDEO_FIRST_FRAME` is the one-shot mark stamped the first time the panel
// blits a frame after open. `VIDEO_SEEK_*` brackets a seek: the panel marks
// `VIDEO_SEEK_START` when it dispatches a debounced seek to the worker, then
// stamps `VIDEO_SEEK_END` and emits the `VIDEO_SEEK_TO_BLIT` measure when the
// first post-seek frame lands on the canvas. The measure is the seek-to-blit
// latency the T5.2 budget (P50 < 120 ms / P95 < 250 ms) gates on.
export const VIDEO_FIRST_FRAME = "video:first-frame";
export const VIDEO_SEEK_START = "video:seek:start";
export const VIDEO_SEEK_END = "video:seek:end";
export const VIDEO_SEEK_TO_BLIT = "video:seek-to-blit";

export interface PerfSnapshot {
  readonly entries: ReadonlyArray<{
    name: string;
    startTime: number;
    duration: number;
    entryType: string;
  }>;
  readonly memory: {
    usedJSHeapSize: number | null;
    totalJSHeapSize: number | null;
  };
}

type PerformanceWithMemory = Performance & {
  memory?: {
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
  };
};

function now(): number {
  return performance.now();
}

// Per-name counters for mark/measure retention. When a name exceeds the
// threshold its entries are pruned to prevent unbounded accumulation during
// long sessions (~650 k entries/hour from the playback tick alone).
// E2e sessions are short (< 30 s / ~1800 ticks at 60 Hz), well under the
// 10 000 threshold, so pruning never fires during tests.
const RETAIN_THRESHOLD = 10_000;
const markCounts = new Map<string, number>();
const measureCounts = new Map<string, number>();

function bumpAndMaybeClear(
  counts: Map<string, number>,
  name: string,
  clearFn: (n: string) => void,
): void {
  const n = (counts.get(name) ?? 0) + 1;
  if (n >= RETAIN_THRESHOLD) {
    clearFn(name);
    counts.set(name, 0);
  } else {
    counts.set(name, n);
  }
}

export function mark(name: string): void {
  bumpAndMaybeClear(markCounts, name, (n) => performance.clearMarks(n));
  performance.mark(name);
}

// Wraps `performance.measure` so callers don't need to catch the "start mark
// not found" `DOMException` themselves. This is a best-effort perf seam — a
// missing start mark should never fail user code.
export function measure(
  name: string,
  startMark: string,
  endMark?: string,
): void {
  bumpAndMaybeClear(measureCounts, name, (n) => performance.clearMeasures(n));
  try {
    if (endMark) performance.measure(name, startMark, endMark);
    else performance.measure(name, startMark);
  } catch {
    /* swallow; the measure is advisory */
  }
}

// Wraps an async operation with `<prefix>:start` / `<prefix>:end` marks and a
// `<prefix>` measure. Returns whatever the wrapped op returns.
export async function timed<T>(
  prefix: string,
  op: () => Promise<T>,
): Promise<T> {
  const start = `${prefix}:start`;
  const end = `${prefix}:end`;
  mark(start);
  try {
    return await op();
  } finally {
    mark(end);
    measure(prefix, start, end);
  }
}

// Snapshot-style getter used by the Playwright dev hook.
export function snapshot(): PerfSnapshot {
  const entries = performance.getEntries().map((e) => ({
    name: e.name,
    startTime: e.startTime,
    duration: e.duration,
    entryType: e.entryType,
  }));
  const mem = (performance as PerformanceWithMemory).memory;
  return {
    entries,
    memory: {
      usedJSHeapSize: mem?.usedJSHeapSize ?? null,
      totalJSHeapSize: mem?.totalJSHeapSize ?? null,
    },
  };
}

// Installs `window.__drivelinePerf` for Playwright. Idempotent; safe to
// call multiple times during HMR.
export function installPerfHooks(): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __drivelinePerf?: unknown };
  w.__drivelinePerf = {
    snapshot,
    clear(): void {
      performance.clearMarks();
      performance.clearMeasures();
    },
    now,
  };
}
