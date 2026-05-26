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

import type { Channel } from "../state/store";

export interface AxisGroup {
  /** Canonical scale id used by uPlot — `y`, `y2`, `y3`, … */
  scaleKey: string;
  /** The unit string shared by every channel in the group. `""` when the
   *  channels are unitless. */
  unit: string;
  /** Channels assigned to this group, in original binding order. */
  channels: Channel[];
}

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
      g = { scaleKey, unit, channels: [] };
      groups.set(key, g);
      nextIdx += 1;
    }
    g.channels.push(c);
  }
  return Array.from(groups.values());
}

/** A human-readable label for an axis: the unit, or `"(unitless)"`
 *  fall-through so the y-axis caption never reads `""`. */
export function axisLabel(g: AxisGroup): string {
  return g.unit ? g.unit : "(unitless)";
}
