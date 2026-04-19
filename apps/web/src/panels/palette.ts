// Deterministic colour assignment for PlotPanel series (T4.2).
//
// Hash the full `channelId` so the same channel gets the same colour
// regardless of which panel renders it or in what order it was added
// (per docs/06-ui-and-panels.md:139-140). The 8-colour palette is picked
// to stay legible on the dark theme; collisions are possible but
// acceptable at the MVP cap of 8 series per panel.

export const PLOT_PALETTE = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#ef4444",
  "#a855f7",
  "#eab308",
  "#14b8a6",
  "#ec4899",
] as const;

export const MAX_PLOT_SERIES = 8;

export function colorFor(channelId: string): string {
  // FNV-1a 32-bit, coerced to unsigned via `>>> 0` so `% len` is safe.
  let h = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    h ^= channelId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PLOT_PALETTE[h % PLOT_PALETTE.length];
}
