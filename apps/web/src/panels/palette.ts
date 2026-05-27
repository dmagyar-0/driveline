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

// Iter3 issue #2 — per-source ribbon colours. Distinct ramp from the
// per-channel palette so a "source" ribbon on a chip cannot be confused
// with the line stroke colour. These are saturated banners (4 px ribbons
// on chips/rows) tuned so `comma2k19__seg4` vs `comma2k19__seg7` reads
// as two completely different colours at a glance — the iter2 audit's
// chief complaint about 1-char-suffix grey badges.
export const SOURCE_PALETTE = [
  "#7a5cff", // violet — sits opposite the warm half of PLOT_PALETTE
  "#ff8a3d", // burnt orange
  "#00c2a8", // teal
  "#ff5d8f", // hot pink
  "#3da5ff", // azure
  "#c2d22d", // lime
  "#ffb84d", // honey
  "#9b6bff", // lilac (cycles back near violet for >8 sources)
] as const;

export const MAX_PLOT_SERIES = 8;

export function colorFor(channelId: string): string {
  return PLOT_PALETTE[hashIndex(channelId, PLOT_PALETTE.length)];
}

/** Stable per-source ribbon colour. Drives the 4 px coloured bar on
 *  each chip and cursor-gutter row so two same-named channels from
 *  different files are unmistakable. */
export function colorForSource(sourceId: string): string {
  return SOURCE_PALETTE[hashIndex(sourceId, SOURCE_PALETTE.length)];
}

// FNV-1a 32-bit, coerced to unsigned via `>>> 0` so `% len` is safe.
function hashIndex(s: string, mod: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % mod;
}
