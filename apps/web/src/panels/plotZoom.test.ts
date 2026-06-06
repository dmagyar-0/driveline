import { describe, expect, it } from "vitest";
import type { PlotZoom } from "../state/store";
import {
  MIN_X_SPAN_NS,
  WHEEL_ZOOM_STEP,
  axisIdxFromScaleKey,
  isPlotZoomed,
  plotFractions,
  scaleWindowX,
  scaleWindowY,
  zoomTargetForPointer,
  type ZoomGeometry,
} from "./plotZoom";

// A 300×180 plot with a 50px left gutter (axis 0), a 50px right gutter
// (axis 2), and a 20px bottom gutter (x-axis) — the layout the panel would
// feed in for a two-y-axis plot.
const GEOM: ZoomGeometry = {
  plot: { left: 50, top: 0, width: 300, height: 180 },
  axes: [
    { target: { kind: "x" }, x0: 50, x1: 350, y0: 180, y1: 200 },
    { target: { kind: "y", axisIdx: 0 }, x0: 0, x1: 50, y0: 0, y1: 180 },
    { target: { kind: "y", axisIdx: 2 }, x0: 350, x1: 400, y0: 0, y1: 180 },
  ],
};

describe("isPlotZoomed", () => {
  it("is false for undefined / empty zoom", () => {
    expect(isPlotZoomed(undefined)).toBe(false);
    expect(isPlotZoomed({ x: null, y: {} })).toBe(false);
  });
  it("is true once x or any y window is present", () => {
    const x: PlotZoom = { x: { startNs: 0n, endNs: 1n }, y: {} };
    const y: PlotZoom = { x: null, y: { 0: { min: 0, max: 1 } } };
    expect(isPlotZoomed(x)).toBe(true);
    expect(isPlotZoomed(y)).toBe(true);
  });
});

describe("axisIdxFromScaleKey", () => {
  it("maps scale keys to 0-based y-axis indices", () => {
    expect(axisIdxFromScaleKey("x")).toBeNull();
    expect(axisIdxFromScaleKey("y")).toBe(0);
    expect(axisIdxFromScaleKey("y1")).toBe(1);
    expect(axisIdxFromScaleKey("y3")).toBe(3);
  });
  it("rejects malformed keys", () => {
    expect(axisIdxFromScaleKey("yX")).toBeNull();
    expect(axisIdxFromScaleKey("foo")).toBeNull();
  });
});

// Stacked layout for the same 300×180 plot with TWO data-bearing bands
// (axis 0 on top, axis 1 below). Mirrors what `buildZoomGeometry` emits while
// stacked: an x-gutter, then per band a left flank + right flank ("y") and a
// drawing-area slice ("both" tagged with the band's axis). The slices tile the
// whole drawing area, so no point falls through to the overlay "both" default.
const STACKED_GEOM: ZoomGeometry = {
  plot: { left: 50, top: 0, width: 300, height: 180 },
  axes: [
    { target: { kind: "x" }, x0: 50, x1: 350, y0: 180, y1: 1e6 },
    // Top band (axis 0): rows 0–90.
    { target: { kind: "y", axisIdx: 0 }, x0: 0, x1: 50, y0: 0, y1: 90 },
    { target: { kind: "y", axisIdx: 0 }, x0: 350, x1: 1e6, y0: 0, y1: 90 },
    { target: { kind: "both", axisIdx: 0 }, x0: 50, x1: 350, y0: 0, y1: 90 },
    // Bottom band (axis 1): rows 90–180.
    { target: { kind: "y", axisIdx: 1 }, x0: 0, x1: 50, y0: 90, y1: 180 },
    { target: { kind: "y", axisIdx: 1 }, x0: 350, x1: 1e6, y0: 90, y1: 180 },
    { target: { kind: "both", axisIdx: 1 }, x0: 50, x1: 350, y0: 90, y1: 180 },
  ],
};

describe("zoomTargetForPointer", () => {
  it("scales both axes inside the drawing area", () => {
    expect(zoomTargetForPointer(GEOM, 200, 90)).toEqual({ kind: "both" });
  });
  it("scales only x over the x-axis gutter", () => {
    expect(zoomTargetForPointer(GEOM, 200, 190)).toEqual({ kind: "x" });
  });
  it("scales only the y-axis under the pointer (left vs right gutter)", () => {
    expect(zoomTargetForPointer(GEOM, 25, 90)).toEqual({
      kind: "y",
      axisIdx: 0,
    });
    expect(zoomTargetForPointer(GEOM, 375, 90)).toEqual({
      kind: "y",
      axisIdx: 2,
    });
  });
  it("returns null outside every interactive region", () => {
    expect(zoomTargetForPointer(GEOM, 500, 500)).toBeNull();
  });

  it("stacked: drawing-area slice scales x + that band's y", () => {
    // Vertical position picks the band; horizontal position doesn't.
    expect(zoomTargetForPointer(STACKED_GEOM, 200, 45)).toEqual({
      kind: "both",
      axisIdx: 0,
    });
    expect(zoomTargetForPointer(STACKED_GEOM, 200, 135)).toEqual({
      kind: "both",
      axisIdx: 1,
    });
  });
  it("stacked: gutter flank scales only that band's y (either side)", () => {
    // Left flank of the top band and right flank of the bottom band.
    expect(zoomTargetForPointer(STACKED_GEOM, 25, 45)).toEqual({
      kind: "y",
      axisIdx: 0,
    });
    expect(zoomTargetForPointer(STACKED_GEOM, 375, 135)).toEqual({
      kind: "y",
      axisIdx: 1,
    });
  });
  it("stacked: x-gutter still scales only x", () => {
    expect(zoomTargetForPointer(STACKED_GEOM, 200, 190)).toEqual({ kind: "x" });
  });
});

describe("plotFractions", () => {
  it("reports the pointer position as a clamped [0,1] fraction", () => {
    expect(plotFractions(GEOM, 200, 90)).toEqual({ fracX: 0.5, fracTop: 0.5 });
    expect(plotFractions(GEOM, 50, 0)).toEqual({ fracX: 0, fracTop: 0 });
    // Past the right edge clamps to 1 rather than overshooting.
    expect(plotFractions(GEOM, 9999, 9999)).toEqual({ fracX: 1, fracTop: 1 });
  });
});

describe("scaleWindowX", () => {
  const full = { startNs: 0n, endNs: 10_000_000_000n }; // 0–10 s

  it("zooms in around the pointer, keeping the anchor fixed", () => {
    const out = scaleWindowX(full, 0.5, 1 / WHEEL_ZOOM_STEP, full);
    expect(out).not.toBeNull();
    // Narrower than the full range…
    expect(out!.startNs).toBeGreaterThan(full.startNs);
    expect(out!.endNs).toBeLessThan(full.endNs);
    // …and centred on the 50% anchor (5 s).
    const mid = out!.startNs + (out!.endNs - out!.startNs) / 2n;
    expect(Number(mid)).toBeCloseTo(5_000_000_000, -3);
    // Span shrank by the zoom factor.
    const span = Number(out!.endNs - out!.startNs);
    expect(span).toBeCloseTo(10_000_000_000 / WHEEL_ZOOM_STEP, -4);
  });

  it("anchors the window on an off-centre pointer", () => {
    // Zooming in near the left edge keeps the left side roughly pinned.
    const out = scaleWindowX(full, 0, 1 / WHEEL_ZOOM_STEP, full)!;
    expect(out.startNs).toBe(0n); // anchor at frac 0 stays at the start
    expect(out.endNs).toBeLessThan(full.endNs);
  });

  it("returns null when zoom-out covers the whole timeline", () => {
    const nearFull = { startNs: 100_000_000n, endNs: 9_900_000_000n };
    expect(scaleWindowX(nearFull, 0.5, WHEEL_ZOOM_STEP, full)).toBeNull();
  });

  it("clamps a zoomed window to the timeline bound", () => {
    // A window already at the right edge, zoomed out: the right edge pins
    // to the bound rather than running past it.
    const right = { startNs: 6_000_000_000n, endNs: 10_000_000_000n };
    const out = scaleWindowX(right, 1, WHEEL_ZOOM_STEP, full)!;
    expect(out.endNs).toBeLessThanOrEqual(full.endNs);
    expect(out.startNs).toBeGreaterThanOrEqual(full.startNs);
  });

  it("enforces a minimum span so zoom-in cannot collapse the window", () => {
    const out = scaleWindowX(full, 0.5, 1e-12, full)!;
    expect(out.endNs - out.startNs).toBe(MIN_X_SPAN_NS);
  });
});

describe("scaleWindowY", () => {
  const base = { min: 0, max: 10 };

  it("keeps the max fixed when anchored at the top", () => {
    expect(scaleWindowY(base, 0, 0.5)).toEqual({ min: 5, max: 10 });
  });
  it("keeps the min fixed when anchored at the bottom", () => {
    expect(scaleWindowY(base, 1, 0.5)).toEqual({ min: 0, max: 5 });
  });
  it("zooms symmetrically around a centred pointer", () => {
    expect(scaleWindowY(base, 0.5, 0.5)).toEqual({ min: 2.5, max: 7.5 });
  });
  it("widens a degenerate (flat) base to a finite span", () => {
    const out = scaleWindowY({ min: 5, max: 5 }, 0.5, 0.5);
    expect(Number.isFinite(out.min)).toBe(true);
    expect(Number.isFinite(out.max)).toBe(true);
    expect(out.max).toBeGreaterThan(out.min);
  });
});
