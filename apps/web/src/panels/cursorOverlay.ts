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
// `:root` at draw-time so the token (`apps/web/src/styles/tokens.css`)
// stays the single source of truth. `getComputedStyle` is fast on the
// document element (no layout thrash) and is invoked once per cursor
// tick — well inside the PlotPanel < 4 ms render budget. Falls back to
// the literal hex if the var is undefined (jsdom in unit tests).
export function cursorStrokeColor(): string {
  if (typeof document === "undefined") return "#f97316";
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue("--color-accent-orange")
    .trim();
  return v || "#f97316";
}
