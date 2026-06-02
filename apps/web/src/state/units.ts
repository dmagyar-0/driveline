// Unit resolution for channels.
//
// Units are inferred from the file on load (`channel.unit`) but, since file
// metadata is frequently missing or wrong, the user can override the unit
// per channel. Overrides are GLOBAL — keyed by channel id and applied
// everywhere that channel is shown (plot chips + axes, table, value panel),
// because a unit is intrinsic to the signal, not to how one panel plots it.
//
// Override semantics:
//   - absent entry      → fall back to the file-inferred unit
//   - empty string `""` → "explicitly no unit" (suppress the inferred one)
//   - any other string  → that unit (trimmed)

import type { Channel } from "./store";

/**
 * The effective unit for a channel, honouring a user override. Returns
 * `null` when there is no unit to show (no inferred unit, or an explicit
 * empty override).
 */
export function effectiveUnit(
  channel: Pick<Channel, "id" | "unit">,
  overrides: Record<string, string>,
): string | null {
  const override = overrides[channel.id];
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed === "" ? null : trimmed;
  }
  const inferred = channel.unit;
  return inferred && inferred.trim() !== "" ? inferred : null;
}

/** `name (unit)` when a unit resolves, else the bare `name`. */
export function channelLabel(
  channel: Pick<Channel, "id" | "name" | "unit">,
  overrides: Record<string, string>,
): string {
  const unit = effectiveUnit(channel, overrides);
  return unit ? `${channel.name} (${unit})` : channel.name;
}
