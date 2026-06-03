// @vitest-environment jsdom
//
// Unit test for the stacked-axes band maths. `stackedBandRange` expands a
// single axis's data extent so its samples land in a horizontal band of the
// plot instead of the full height, letting several axes be read at once
// without overlapping. The test asserts the *normalised position* a value
// lands at (0 = bottom, 1 = top of the plot) rather than the raw [min, max],
// since that's the property the feature actually cares about.

import { describe, expect, it, vi } from "vitest";

// uPlot calls `matchMedia()` at module load (importing PlotPanel pulls it
// in). jsdom doesn't ship one — stub before the import chain resolves.
// Mirrors yAxisSize.test.ts / PlotPanel.test.tsx.
vi.hoisted(() => {
  (
    globalThis as unknown as { matchMedia: (q: string) => MediaQueryList }
  ).matchMedia = (q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
});

import { STACK_BAND_GAP, bandTickFilter, stackedBandRange } from "./PlotPanel";

// uPlot maps a scale's [min, max] across the full plot height with min at
// the bottom (0) and max at the top (1). This is the normalised vertical
// position a data value resolves to under that range.
function frac(v: number, [min, max]: [number, number]): number {
  return (v - min) / (max - min);
}

describe("stackedBandRange", () => {
  it("centres a single band's data, inset by the configured gap", () => {
    const r = stackedBandRange(0, 1, 0, 1);
    // Data midpoint sits dead-centre; the extremes inset by STACK_BAND_GAP.
    expect(frac(0.5, r)).toBeCloseTo(0.5, 6);
    expect(frac(0, r)).toBeCloseTo(STACK_BAND_GAP, 6);
    expect(frac(1, r)).toBeCloseTo(1 - STACK_BAND_GAP, 6);
  });

  it("places slot 0 in the top band and slot 1 in the bottom band", () => {
    const top = stackedBandRange(0, 1, 0, 2);
    const bottom = stackedBandRange(0, 1, 1, 2);
    const gap = STACK_BAND_GAP * 0.5;

    // Top band: data spans the upper half (above 0.5), inset by the gap.
    expect(frac(0, top)).toBeCloseTo(0.5 + gap, 6);
    expect(frac(1, top)).toBeCloseTo(1 - gap, 6);
    // Bottom band: data spans the lower half (below 0.5).
    expect(frac(0, bottom)).toBeCloseTo(gap, 6);
    expect(frac(1, bottom)).toBeCloseTo(0.5 - gap, 6);

    // The two bands never overlap.
    expect(frac(0, top)).toBeGreaterThan(frac(1, bottom));
  });

  it("stacks N bands top-to-bottom by ascending slot, without overlap", () => {
    const n = 4;
    // Midpoint position of each band, top (slot 0) to bottom (slot n-1).
    const mids = Array.from({ length: n }, (_, slot) =>
      frac(0.5, stackedBandRange(0, 1, slot, n)),
    );
    for (let i = 1; i < n; i++) {
      // Each successive slot sits strictly lower than the previous.
      expect(mids[i]).toBeLessThan(mids[i - 1]);
    }
    // Bands are evenly spaced at 1/n centres: 7/8, 5/8, 3/8, 1/8.
    expect(mids[0]).toBeCloseTo(7 / 8, 6);
    expect(mids[3]).toBeCloseTo(1 / 8, 6);
  });

  it("keeps a flat (zero-span) extent finite and centred in its band", () => {
    const r = stackedBandRange(5, 5, 0, 2);
    expect(Number.isFinite(r[0])).toBe(true);
    expect(Number.isFinite(r[1])).toBe(true);
    expect(r[1]).toBeGreaterThan(r[0]);
    // The constant value lands at the top band's centre (0.75).
    expect(frac(5, r)).toBeCloseTo(0.75, 6);
  });

  it("falls back to a finite unit range when the extent is non-finite", () => {
    const r = stackedBandRange(NaN, Infinity, 0, 2);
    expect(Number.isFinite(r[0])).toBe(true);
    expect(Number.isFinite(r[1])).toBe(true);
    // Falls back to the [0, 1] extent → same top-band placement.
    expect(frac(0, r)).toBeCloseTo(0.5 + STACK_BAND_GAP * 0.5, 6);
  });

  it("clamps an out-of-range slot into the band set", () => {
    // slot 5 with 2 bands clamps to the bottom band; slot -1 to the top.
    expect(stackedBandRange(0, 1, 5, 2)).toEqual(stackedBandRange(0, 1, 1, 2));
    expect(stackedBandRange(0, 1, -1, 2)).toEqual(stackedBandRange(0, 1, 0, 2));
  });
});

describe("bandTickFilter", () => {
  it("nulls out splits outside the band's data extent (inclusive bounds)", () => {
    // Scale expanded to [-3, 2] but data only spans [-1, 1]: the ticks at
    // -3 and 2 sit in empty space and are hidden; -1, 0, 1 stay.
    expect(bandTickFilter([-3, -2, -1, 0, 1, 2], [-1, 1])).toEqual([
      null,
      null,
      -1,
      0,
      1,
      null,
    ]);
  });

  it("keeps every split when the extent is null (degenerate / unknown)", () => {
    const splits = [-3, -2, -1, 0, 1];
    expect(bandTickFilter(splits, null)).toBe(splits);
  });

  it("falls back to all splits rather than blanking the axis", () => {
    // No split lands inside the band → keep them all so the band still
    // shows a label instead of an empty gutter.
    expect(bandTickFilter([10, 20, 30], [-1, 1])).toEqual([10, 20, 30]);
  });
});
