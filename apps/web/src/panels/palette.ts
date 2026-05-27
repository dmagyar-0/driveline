// Deterministic colour assignment for PlotPanel series (T4.2).
//
// Hash the full `channelId` so the same channel gets the same colour
// regardless of which panel renders it or in what order it was added
// (per docs/06-ui-and-panels.md:139-140). The chip swatch in the panel
// header MUST be the exact same colour the uPlot line is stroked with;
// `colorFor` is the single source of truth.
//
// Iter5 issue #6 — colourblind-safe palette. The audit found the iter4
// palette still collided in the wheel-speed cluster: `f07a6f` (coral),
// `e69f00` (amber), and `cc79a7` (pink) all sit in the warm 30–60°
// hue region and overplot identically under deuteranopia. We now use
// **Wong's 2011 ordered categorical palette** ("Points of view: Colour
// blindness", Nature Methods 8, 441) — eight hues spaced such that
// every pair is distinguishable under deuteranopia, protanopia, and
// tritanopia. The order matches Wong's recommended order:
//   black, orange, sky blue, bluish green, yellow, blue, vermillion,
//   reddish purple.
// We replace Wong's "black" (which would vanish on the near-black
// canvas) with a desaturated cool grey — bright enough to read on
// `--color-bg-3` but muted enough that it doesn't dominate the jewel-
// tone hues. Otherwise the colours and order are Wong's exactly.
//
// iter7 wave2 — slot 0 was `#e6e6e6` (near-white), which over-fired:
// any channel that hashed there (e.g. comma2k19's IMU_Accel) was the
// brightest stroke on the canvas and visually swamped neighbouring
// jewel-tones. `#9aa0aa` keeps slot 0 neutral but reads as "quiet
// background trace" rather than "the most important series".
//
// The mapping algorithm is unchanged: FNV-1a hash on the channel id,
// modulo palette length. Callers across panels MUST agree on the
// colour for the same channel — see `palette.test.ts`.

export const PLOT_PALETTE = [
  "#9aa0aa", // muted cool grey (replaces Wong's #000000; was #e6e6e6 pre-iter7w2)
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#009e73", // bluish green
  "#f0e442", // yellow
  "#0072b2", // blue
  "#d55e00", // vermillion
  "#cc79a7", // reddish purple
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

// Iter5 issue #7 — dash patterns as a colour-fallback channel. When
// four or more series share a plot, even the Wong palette is only
// borderline distinguishable for users with severe colour-vision
// deficiency, and a grayscale screenshot strips all the colour cues.
// Cycle through four patterns positioned by binding order:
//   0: solid    1: dashed    2: dotted    3: dash-dot
// Two patterns repeat per palette cycle (we have 8 colours, 4 dashes),
// so the (colour, dash) pair is unique across at least 8 series.
//
// Encoded as uPlot's `series.dash` format (alternating filled/gap
// lengths in px). The empty array — uPlot's no-dash sentinel — sits at
// slot 0 so the solid-line case stays the default and chips render an
// uninterrupted swatch bar for single-series binding.
export const DASH_PATTERNS: ReadonlyArray<readonly number[]> = [
  [], // solid
  [8, 4], // dashed
  [2, 4], // dotted
  [8, 4, 2, 4], // dash-dot
] as const;

/** Threshold above which dash patterns kick in. Below this, every
 *  trace stays solid — the colour palette alone has enough headroom
 *  for ≤3 series. At ≥4 we engage dashes as a second discriminator. */
export const DASH_THRESHOLD = 4;

/** Dash pattern for a series at `index` within a plot's binding list,
 *  given the total trace `count`. Returns `[]` (solid) for plots with
 *  fewer than `DASH_THRESHOLD` traces so single/few-series plots aren't
 *  visually busy. */
export function dashForIndex(
  index: number,
  count: number,
): readonly number[] {
  if (count < DASH_THRESHOLD) return DASH_PATTERNS[0];
  return DASH_PATTERNS[index % DASH_PATTERNS.length];
}
