// Deterministic colour assignment for PlotPanel series (T4.2).
//
// Hash the full `channelId` so the same channel gets the same colour
// regardless of which panel renders it or in what order it was added
// (per docs/06-ui-and-panels.md:139-140). The 16-colour palette is picked
// to stay legible on the dark theme; collisions are possible but
// acceptable at the cap of 16 series per panel.
//
// The first 8 entries are the original MVP palette and MUST stay in
// place — `colorFor` hashes into the array by index, so reordering or
// inserting ahead of them would silently re-colour every existing
// binding. The second 8 extend the cap to 16 (P2) with distinct hues
// that keep ≥3:1 contrast against the dark panel surface.
export const PLOT_PALETTE = [
  // — original 8 (stable; do not reorder) —
  "#3b82f6", // blue
  "#f97316", // orange
  "#10b981", // emerald
  "#ef4444", // red
  "#a855f7", // purple
  "#eab308", // amber
  "#14b8a6", // teal
  "#ec4899", // pink
  // — extension 8 (P2: cap 8 → 16) —
  "#60a5fa", // light blue
  "#fb923c", // light orange
  "#34d399", // light green
  "#f87171", // salmon
  "#c084fc", // lavender
  "#facc15", // yellow
  "#22d3ee", // cyan
  "#a3e635", // lime
] as const;

export const MAX_PLOT_SERIES = 16;

export function colorFor(channelId: string): string {
  // FNV-1a 32-bit, coerced to unsigned via `>>> 0` so `% len` is safe.
  let h = 0x811c9dc5;
  for (let i = 0; i < channelId.length; i++) {
    h ^= channelId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return PLOT_PALETTE[h % PLOT_PALETTE.length];
}
