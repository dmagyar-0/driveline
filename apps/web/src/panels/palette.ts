// Deterministic colour assignment for PlotPanel series (T4.2).
//
// Hash the full `channelId` so the same channel gets the same colour
// regardless of which panel renders it or in what order it was added
// (per docs/06-ui-and-panels.md:139-140). The chip swatch in the panel
// header MUST be the exact same colour the uPlot line is stroked with;
// `colorFor` is the single source of truth.
//
// UX overhaul note: the v1 palette leaned on saturated neons (magenta,
// lime, hot pink, electric blue) which on near-black became fatiguing
// and confusable side-by-side. v2 is an Okabe-Ito-inspired ordered
// categorical ramp tuned for dark backgrounds and selected to stay
// distinguishable under deuteranopia / protanopia (the two most common
// red/green colour-vision deficiencies).
//
// The mapping algorithm is unchanged: FNV-1a hash on the channel id,
// modulo palette length. Callers across panels MUST agree on the
// colour for the same channel — see `palette.test.ts`.

export const PLOT_PALETTE = [
  "#56b4e9", // sky blue — primary, calm on near-black
  "#e69f00", // amber — distinct from sky blue under deuteranopia
  "#009e73", // bluish green
  "#f07a6f", // soft coral — replaces hot red, easier on the eyes
  "#cc79a7", // dusty pink
  "#f1c453", // muted gold — replaces electric yellow
  "#80b1d3", // mid blue — deep but readable on near-black
  "#bcbd22", // olive — non-neon green/yellow accent
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
