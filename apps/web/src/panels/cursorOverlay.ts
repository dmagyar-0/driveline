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
