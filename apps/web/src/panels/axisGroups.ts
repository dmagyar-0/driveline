// Y-axis grouping for the Plot panel (UX overhaul issue #3).
//
// The v1 plot stacked every channel on a single auto-scaled Y axis. With
// heterogeneous channels (e.g. `steering_angle` in degrees, `gyro_z` in
// rad/s, `vehicle_speed` in m/s) the axis became meaningless: a 20 deg
// steering input and a 0.4 rad/s yaw rate share the canvas at radically
// different magnitudes.
//
// Grouping rule: channels with the same unit string share a y-scale.
// `null`/empty units fall into a single "unitless" group. With 1 group
// nothing changes. With 2 groups we render left + right axes. With ≥3
// groups uPlot still gets one scale per group (each charted in the
// background, only the first two get on-canvas axes) and the panel
// surfaces a warning chip so the user knows some series are normalised
// out of view.
//
// Iter2 issue #3 update — each group also carries an `axisColor`
// derived from its member channels' palette colours so the panel can
// tint axis labels/ticks/grid to match the series sharing that axis.
// Choice when a group has multiple series:
//   - if every series in the group hashes to the same palette colour,
//     use that colour;
//   - otherwise return a neutral grid tone so the axis doesn't lie
//     about which trace it belongs to. The axis label still carries the
//     unit so the user can still match by reading.
// This deliberately avoids picking one series' colour at random — that
// behaviour produced "the left axis is blue but two of the four blue-ish
// lines are amber" confusion in iter1 reviews.

import type { Channel } from "../state/store";
import { colorFor } from "./palette";

export interface AxisGroup {
  /** Canonical scale id used by uPlot — `y`, `y2`, `y3`, … */
  scaleKey: string;
  /** The unit string shared by every channel in the group. `""` when the
   *  channels are unitless. */
  unit: string;
  /** Channels assigned to this group, in original binding order. */
  channels: Channel[];
  /** Iter2 issue #3 — tint colour for the axis label, ticks, and grid.
   *  Equal to the channel's palette colour when every series in the
   *  group shares one; otherwise a neutral grey so a mixed-colour group
   *  doesn't visually claim one series. */
  axisColor: string;
}

/** Neutral fallback used when the channels on an axis disagree on a
 *  palette colour. Slightly lighter than the default grid so the
 *  user can still see the tinted axis differs from the grid lines. */
export const NEUTRAL_AXIS_COLOR = "#888888";

/**
 * Bucket channels by unit and assign each bucket a stable scale key.
 * Groups are returned in **first-appearance order** so the colour-to-
 * axis mapping is deterministic and reproduces across renders.
 *
 * Why not just sort by unit? Two reasons:
 *  - keep the user's mental order (the first channel they added sets the
 *    primary axis);
 *  - keep the left axis stable when they add a third channel with a new
 *    unit — appending to the end avoids the left axis silently swapping
 *    contents.
 */
export function groupByUnit(channels: Channel[]): AxisGroup[] {
  const groups = new Map<string, AxisGroup>();
  let nextIdx = 0;
  for (const c of channels) {
    const unit = (c.unit ?? "").trim();
    const key = unit; // empty string is its own bucket
    let g = groups.get(key);
    if (!g) {
      const scaleKey = nextIdx === 0 ? "y" : `y${nextIdx + 1}`;
      g = { scaleKey, unit, channels: [], axisColor: NEUTRAL_AXIS_COLOR };
      groups.set(key, g);
      nextIdx += 1;
    }
    g.channels.push(c);
  }
  // Iter2 issue #3 — resolve per-group axis tint after all channels are
  // bucketed. Run as a second pass so a group's colour depends on its
  // final membership, not the order channels were added.
  for (const g of groups.values()) {
    g.axisColor = resolveAxisColor(g.channels);
  }
  return Array.from(groups.values());
}

/** Pick the tint for an axis. When every channel in the group hashes to
 *  the same palette slot we return that colour (homogeneous case);
 *  otherwise we return `NEUTRAL_AXIS_COLOR`. The Y-axis label still
 *  reads the unit, so the unit + neutral tint case is "this axis spans
 *  multiple coloured traces — read the label".
 *
 *  Exported so the panel and tests can compute the same value. */
export function resolveAxisColor(channels: Channel[]): string {
  if (channels.length === 0) return NEUTRAL_AXIS_COLOR;
  const first = colorFor(channels[0].id);
  for (let i = 1; i < channels.length; i++) {
    if (colorFor(channels[i].id) !== first) return NEUTRAL_AXIS_COLOR;
  }
  return first;
}

/** A human-readable label for an axis: the unit, or `"(unitless)"`
 *  fall-through so the y-axis caption never reads `""`. */
export function axisLabel(g: AxisGroup): string {
  return g.unit ? g.unit : "(unitless)";
}

/** Iter4 alignment item #3 — align dual-axis tick rows.
 *
 *  When the Plot panel shows two Y axes (one per unit group), the left
 *  axis picks its own ticks via uPlot's `incrs` heuristic and the right
 *  axis does the same in its own value space. The two ladders end up
 *  on **different y-pixel rows** and the gridlines wander — useless for
 *  reading two values off the same horizontal slice, which is the only
 *  reason dual-axis plots exist.
 *
 *  This helper computes splits for the *secondary* axis by taking the
 *  primary axis's splits as authoritative pixel positions and linearly
 *  interpolating each one into the secondary's value domain. The
 *  resulting secondary ticks land on exactly the same y-pixel rows as
 *  the primary's, so a single horizontal slice of the canvas crosses
 *  one tick on each side. The numbers themselves stay in the
 *  secondary's unit space (`12, 10, 8, …` keep their meaning); only the
 *  *positions* are forced into agreement.
 *
 *  Returns the empty array when the inputs are degenerate (primary
 *  scale collapsed to a point); uPlot then falls back to its own
 *  splits — better than a divide-by-zero `NaN`.
 */
export function alignedSecondarySplits(
  primarySplits: number[],
  primaryMin: number,
  primaryMax: number,
  secondaryMin: number,
  secondaryMax: number,
): number[] {
  if (primarySplits.length === 0) return [];
  if (!Number.isFinite(primaryMin) || !Number.isFinite(primaryMax)) return [];
  if (!Number.isFinite(secondaryMin) || !Number.isFinite(secondaryMax)) {
    return [];
  }
  const span = primaryMax - primaryMin;
  if (span === 0) return [];
  const secondarySpan = secondaryMax - secondaryMin;
  return primarySplits.map((p) => {
    const frac = (p - primaryMin) / span;
    return secondaryMin + frac * secondarySpan;
  });
}

/** Compute a "nice" tick ladder for the primary axis, mirroring uPlot's
 *  default behaviour closely enough that we can compute it ourselves
 *  before uPlot does its own pass. We pick the smallest increment from
 *  the standard `1·10^n, 2·10^n, 5·10^n` family that yields no more than
 *  `targetTicks` ticks across `[min, max]`.
 *
 *  Exported so the secondary-axis split function and unit tests can
 *  share one source of truth. */
export function niceTicks(
  min: number,
  max: number,
  targetTicks = 6,
): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const span = Math.abs(max - min);
  // Rough increment: span / targetTicks; round up to the next `1, 2, 5`.
  const rough = span / Math.max(1, targetTicks);
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  // Pick the smallest "nice" multiplier ≥ norm so we don't exceed
  // targetTicks.
  let mult: number;
  if (norm <= 1) mult = 1;
  else if (norm <= 2) mult = 2;
  else if (norm <= 5) mult = 5;
  else mult = 10;
  const incr = mult * pow;
  const start = Math.ceil(min / incr) * incr;
  const end = Math.floor(max / incr) * incr;
  const out: number[] = [];
  // Guard against floating-point drift accumulating an extra tick.
  for (let v = start; v <= end + incr * 1e-9; v += incr) {
    // Snap to incr to avoid 33.300000000000004 drift.
    out.push(Math.round(v / incr) * incr);
  }
  return out;
}
