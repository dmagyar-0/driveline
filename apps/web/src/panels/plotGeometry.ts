// Pure geometry helpers for PlotPanel: wheel-zoom hit-test layout and hover
// tooltip placement. Extracted from PlotPanel.tsx so the component file holds
// wiring only; behaviour is unchanged.

import type { CSSProperties } from "react";
import type uPlot from "uplot";
import {
  axisIdxFromScaleKey,
  type ZoomGeometry,
  type ZoomHitRect,
} from "./plotZoom";

// P3 — hover tooltip placement. The box is nudged off the pointer by
// `TOOLTIP_OFFSET_PX`; `TOOLTIP_MAX_WIDTH_PX` mirrors `.tooltip`'s
// `max-width: 16rem` in PlotPanel.module.css (16rem ≈ 256px at the 16px
// root). Both feed `tooltipPositionStyle`, which flips the tooltip to the
// far side of the pointer before it would spill past the plot area — without
// it, hovering near the right edge renders the value readout entirely
// outside the panel.
export const TOOLTIP_OFFSET_PX = 12;
export const TOOLTIP_MAX_WIDTH_PX = 256;

// Build the wheel-zoom hit-test geometry from a live uPlot instance. The
// drawing area comes from `plot.bbox`; the gutters are partitioned from the
// axes' resolved layout (`_pos`, the post-layout CSS-pixel offset uPlot
// computes for every axis — not in the public typings, so read through a
// narrow cast, mirroring the existing `axis.font` access in `yAxisSize`).
//
// Overlay mode: each y-gutter rect spans the WHOLE band for its axis (ticks +
// values + label), not just the tick strip, by partitioning the space outside
// the drawing area between adjacent axes — so wheeling anywhere over an axis,
// including its unit label, targets that axis. The drawing area itself isn't
// rectangled here; `zoomTargetForPointer` falls back to "both" for it.
//
// Stacked mode: horizontal position no longer picks the axis — the bands are
// stacked vertically — so the panel is sliced into `dataAxisOrder.length`
// horizontal bands (top→bottom, ascending axis index, matching
// `stackedBandRange`'s slot order). Each band gets a drawing-area slice tagged
// "both" (x + that band's y) plus left/right gutter flanks tagged "y" (that
// band's y only). The slices tile the whole drawing area, so the overlay
// "both" fallback never fires while stacked.
//
// Returns null before the first layout (zero-size bbox).
export function buildZoomGeometry(
  plot: uPlot,
  stacking: boolean,
  dataAxisOrder: number[],
): ZoomGeometry | null {
  const bbox = plot.bbox;
  if (!bbox) return null;
  const dpr = window.devicePixelRatio || 1;
  const left = bbox.left / dpr;
  const top = bbox.top / dpr;
  const width = bbox.width / dpr;
  const height = bbox.height / dpr;
  if (!(width > 0) || !(height > 0)) return null;
  const right = left + width;
  const bottom = top + height;
  // Sentinel beyond any in-container pointer — the outermost gutter runs to
  // the panel edge without needing the container's measured size.
  const OUT = 1e6;

  const axisPos = (ax: uPlot.Axis): number | null => {
    const g = ax as unknown as { _show?: boolean; _pos?: number };
    if (g._show === false || ax.show === false || g._pos == null) return null;
    return g._pos;
  };

  const axes: ZoomHitRect[] = [];

  // X-axis gutter(s): full-width band on the top/bottom side of the drawing
  // area. Independent of stacking — x always scales the shared timeline.
  for (const ax of plot.axes) {
    if (ax.scale !== "x") continue;
    const pos = axisPos(ax);
    if (pos == null) continue;
    if (ax.side === 0) {
      axes.push({ target: { kind: "x" }, x0: left, x1: right, y0: 0, y1: top });
    } else {
      axes.push({
        target: { kind: "x" },
        x0: left,
        x1: right,
        y0: bottom,
        y1: OUT,
      });
    }
  }

  if (stacking && dataAxisOrder.length >= 2) {
    const n = dataAxisOrder.length;
    for (let k = 0; k < n; k++) {
      const axisIdx = dataAxisOrder[k];
      // Band k owns the k-th horizontal slice (top→bottom). Boundaries use the
      // same `(k/n)*height` expression for adjacent bands so they meet exactly
      // — no float gap that would leak a pointer to the "both" fallback.
      const y0 = top + (k / n) * height;
      const y1 = top + ((k + 1) / n) * height;
      // Gutter flanks beside this band (left and right of the drawing area):
      // y-only zoom for the band. Both flanks map to the same band so wheeling
      // next to its ticks works regardless of which side the axis renders on.
      axes.push({ target: { kind: "y", axisIdx }, x0: 0, x1: left, y0, y1 });
      axes.push({ target: { kind: "y", axisIdx }, x0: right, x1: OUT, y0, y1 });
      // Drawing-area slice: x + this band's y.
      axes.push({
        target: { kind: "both", axisIdx },
        x0: left,
        x1: right,
        y0,
        y1,
      });
    }
    return { plot: { left, top, width, height }, axes };
  }

  // Overlay: y-axes partition the gutters horizontally — axis 0 on the left,
  // higher indices stacked on the right — each spanning the full plot height.
  const lefts: { axisIdx: number; pos: number }[] = [];
  const rights: { axisIdx: number; pos: number }[] = [];
  for (const ax of plot.axes) {
    const pos = axisPos(ax);
    if (pos == null || ax.scale == null || ax.scale === "x") continue;
    const axisIdx = axisIdxFromScaleKey(ax.scale);
    if (axisIdx == null) continue;
    (ax.side === 3 ? lefts : rights).push({ axisIdx, pos });
  }

  // Left axes stack outward from the drawing area; partition [0, left] so
  // each owns the slice up to its position (a single left axis ⇒ [0, left]).
  lefts.sort((a, b) => a.pos - b.pos);
  let leftStart = 0;
  for (const a of lefts) {
    axes.push({
      target: { kind: "y", axisIdx: a.axisIdx },
      x0: leftStart,
      x1: a.pos,
      y0: top,
      y1: bottom,
    });
    leftStart = a.pos;
  }
  // Right axes stack outward; each owns [its pos, next axis pos], the
  // outermost running to the panel edge.
  rights.sort((a, b) => a.pos - b.pos);
  for (let i = 0; i < rights.length; i++) {
    axes.push({
      target: { kind: "y", axisIdx: rights[i].axisIdx },
      x0: rights[i].pos,
      x1: i + 1 < rights.length ? rights[i + 1].pos : OUT,
      y0: top,
      y1: bottom,
    });
  }

  return { plot: { left, top, width, height }, axes };
}

// Position the hover tooltip beside the pointer, flipping to the opposite
// side before it would overflow the plot area. Anchoring by `right`/`bottom`
// (instead of `left`/`top`) when flipped makes the box grow away from the
// near edge so it can never render outside the panel — the fix for the
// value readout spilling past the right edge when hovering near it.
//
// `leftPx`/`topPx` are pointer coordinates relative to the plot area;
// `areaW`/`areaH` are that area's size. Horizontal flips only when a
// max-width tooltip wouldn't fit on the right AND the pointer is past the
// midpoint, so a panel narrower than the tooltip still lands the box on the
// side with more room rather than off the left edge. The tooltip's height is
// content-driven (one row per channel), so vertical flips by whichever half
// has more room.
export function tooltipPositionStyle(t: {
  leftPx: number;
  topPx: number;
  areaW: number;
  areaH: number;
}): CSSProperties {
  const flipX =
    t.leftPx + TOOLTIP_OFFSET_PX + TOOLTIP_MAX_WIDTH_PX > t.areaW &&
    t.leftPx > t.areaW / 2;
  const flipY = t.topPx > t.areaH / 2;
  return {
    ...(flipX
      ? { right: `${t.areaW - t.leftPx + TOOLTIP_OFFSET_PX}px` }
      : { left: `${t.leftPx + TOOLTIP_OFFSET_PX}px` }),
    ...(flipY
      ? { bottom: `${t.areaH - t.topPx + TOOLTIP_OFFSET_PX}px` }
      : { top: `${t.topPx + TOOLTIP_OFFSET_PX}px` }),
  };
}
