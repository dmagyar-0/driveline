// Project the playback cursor (ns) to a pixel offset inside the plot area.
// Keep the subtraction in BigInt so we don't lose precision on epoch-scale
// timestamps (~1.7e18 ns). The ratio is a small Float64 so the final `* widthPx`
// is safe.

export interface NsRange {
  startNs: bigint;
  endNs: bigint;
}

export function cursorXPx(
  cursorNs: bigint,
  range: NsRange,
  widthPx: number,
): number | null {
  if (widthPx <= 0) return null;
  if (range.endNs <= range.startNs) return null;
  if (cursorNs < range.startNs || cursorNs > range.endNs) return null;
  const span = range.endNs - range.startNs;
  const off = cursorNs - range.startNs;
  const ratio = Number(off) / Number(span);
  return ratio * widthPx;
}

// Phase 7 · cursor stroke colour. Reads `--color-accent-orange` from
// `:root` and caches the result, since the design system has no
// runtime theme switch — re-reading per cursor tick is wasted work
// inside the PlotPanel < 4 ms render budget. Falls back to the
// literal hex if the var is undefined (jsdom in unit tests).
//
// `__resetCursorStrokeColorCache` exists for tests that need to
// override CSS-vars between cases; production code should never call
// it.
let cursorStrokeColorCache: string | null = null;

export function cursorStrokeColor(): string {
  if (cursorStrokeColorCache !== null) return cursorStrokeColorCache;
  if (typeof document === "undefined") {
    cursorStrokeColorCache = "#f97316";
    return cursorStrokeColorCache;
  }
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-accent-orange")
    .trim();
  cursorStrokeColorCache = v || "#f97316";
  return cursorStrokeColorCache;
}

export function __resetCursorStrokeColorCache(): void {
  cursorStrokeColorCache = null;
}
