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

import { STACK_BAND_GAP, niceBandSplits, stackedBandRange } from "./PlotPanel";

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

describe("niceBandSplits", () => {
  it("returns evenly spaced, round ticks within the band extent", () => {
    // The wheel-speed case from the report: a ~3-unit band → integer ticks.
    const ticks = niceBandSplits([30.4, 33.6], 4);
    expect(ticks).toEqual([31, 32, 33]);
    // Every tick lies inside the data extent (so uPlot keeps it in the band).
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(30.4);
      expect(t).toBeLessThanOrEqual(33.6);
    }
    // Even spacing — the whole point of the fix.
    expect(ticks[1] - ticks[0]).toBeCloseTo(ticks[2] - ticks[1], 9);
  });

  it("snaps the step to the 1·2·5 ladder for sub-unit ranges", () => {
    // span 1.4, target 4 → rawStep 0.35 → nice step 0.5.
    expect(niceBandSplits([31.0, 32.4], 4)).toEqual([31, 31.5, 32]);
  });

  it("keeps the same density regardless of magnitude", () => {
    const small = niceBandSplits([0, 1], 4);
    const big = niceBandSplits([0, 1000], 4);
    expect(small).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(big).toEqual([0, 200, 400, 600, 800, 1000]);
    // Identical tick count across three orders of magnitude.
    expect(small.length).toBe(big.length);
  });

  it("scrubs floating-point drift so labels stay round", () => {
    // 0.1 steps are the classic float-accumulation trap (0.1+0.2 ≠ 0.3).
    expect(niceBandSplits([0, 0.5], 5)).toEqual([0, 0.1, 0.2, 0.3, 0.4, 0.5]);
  });

  it("returns no ticks for a null or degenerate extent", () => {
    expect(niceBandSplits(null, 4)).toEqual([]);
    expect(niceBandSplits([5, 5], 4)).toEqual([]); // flat
    expect(niceBandSplits([1, -1], 4)).toEqual([]); // inverted
  });
});
