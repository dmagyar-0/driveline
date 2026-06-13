/**
 * Offline heuristic layout proposer (docs/12-format-agent.md §7).
 *
 * `proposeLayoutHeuristic` is a PURE function: given the channel manifest (and
 * optionally the per-channel dry-run stats), it proposes a panel layout with NO
 * API key and NO network. It is the visualisation-bootstrap FLOOR — the LLM call
 * (`layoutProposal.ts`) only runs when the user asks to refine, improving the
 * grouping/naming over this baseline.
 *
 * SDK-free and cheap, so the Apply UI may import it eagerly. Anything that pulls
 * `@anthropic-ai/sdk` stays in the lazy chunk behind a dynamic import.
 *
 * Rules (in order):
 *  1. lat/lon pair → a `map` panel. Detected by NAME (`/lat/`, `/lon|lng/`)
 *     AND, when stats are available, a plausible degree range
 *     (|lat| ≤ 90, |lon| ≤ 180). The two channels are then removed from the
 *     plot pool so they don't also appear as scalar traces.
 *  2. enum-kind channels → one `enum` lane.
 *  3. remaining scalars → `plot` panels, grouped by their top-level name
 *     segment, each capped at `MAX_PLOT_SERIES` series (splitting into multiple
 *     plots when a group is larger).
 */

import { MAX_PLOT_SERIES } from "../panels/palette";
import type {
  LayoutProposal,
  PanelProposal,
  ProposalChannel,
  ProposalChannelStat,
} from "./layoutProposal.types";

/** Re-export the cap so callers don't reach into `panels/palette` themselves. */
export { MAX_PLOT_SERIES } from "../panels/palette";

// Match "lat"/"latitude" and "lon"/"lng"/"longitude" as a WHOLE word or path
// segment, not as a substring — so `imu/accel_lateral` does NOT read as a
// latitude. Boundaries are start/end or any non-letter (`/`, `_`, digits…).
const LAT_RE = /(^|[^a-z])(lat|latitude)([^a-z]|$)/i;
const LON_RE = /(^|[^a-z])(lon|lng|longitude)([^a-z]|$)/i;

/** A name plus stats, plausible as a latitude channel. */
function isPlausibleLat(
  ch: ProposalChannel,
  stat: ProposalChannelStat | undefined,
): boolean {
  if (!LAT_RE.test(ch.name)) return false;
  if (!stat) return true; // name-only when stats are absent
  // A latitude lives in [-90, 90]; allow a hair of slack for noise.
  return (
    Number.isFinite(stat.min) &&
    Number.isFinite(stat.max) &&
    stat.min >= -90.5 &&
    stat.max <= 90.5
  );
}

/** A name plus stats, plausible as a longitude channel. */
function isPlausibleLon(
  ch: ProposalChannel,
  stat: ProposalChannelStat | undefined,
): boolean {
  if (!LON_RE.test(ch.name)) return false;
  if (!stat) return true;
  return (
    Number.isFinite(stat.min) &&
    Number.isFinite(stat.max) &&
    stat.min >= -180.5 &&
    stat.max <= 180.5
  );
}

/** The top-level segment of a channel name (before the first `/`), used to
 * group related scalars onto the same plot (`vehicle/speed` + `vehicle/brake`
 * → "vehicle"). Falls back to the whole name when there's no separator. */
function groupKey(name: string): string {
  const slash = name.indexOf("/");
  return slash > 0 ? name.slice(0, slash) : name;
}

/** Title-case a group key for a plot title (`vehicle` → "Vehicle"). */
function titleForGroup(key: string): string {
  if (key.length === 0) return "Signals";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/**
 * Propose a panel layout from the channel manifest + optional per-channel stats.
 * Pure and deterministic. `stats` is keyed by channel id (min/max/constant from
 * the dry-run report); `hint` is currently unused by the heuristic (the LLM call
 * consumes it) but accepted for signature parity.
 */
export function proposeLayoutHeuristic(
  channels: ProposalChannel[],
  stats?: Record<string, ProposalChannelStat>,
  hint?: string,
): LayoutProposal {
  void hint;
  const statOf = (id: string) => stats?.[id];

  const panels: PanelProposal[] = [];
  const placed = new Set<string>();
  const rationaleParts: string[] = [];

  // 1. lat/lon → map. Pick the first plausible lat and the first plausible lon
  //    (distinct channels); only one map is proposed.
  const lat = channels.find((c) => isPlausibleLat(c, statOf(c.id)));
  const lon = channels.find(
    (c) => c.id !== lat?.id && isPlausibleLon(c, statOf(c.id)),
  );
  if (lat && lon) {
    panels.push({
      kind: "map",
      latChannelId: lat.id,
      lonChannelId: lon.id,
    });
    placed.add(lat.id);
    placed.add(lon.id);
    rationaleParts.push(`mapped ${lat.name} / ${lon.name} as a GPS track`);
  }

  // 2. enum-kind channels → one enum lane.
  const enums = channels.filter((c) => !placed.has(c.id) && c.kind === "enum");
  if (enums.length > 0) {
    panels.push({ kind: "enum", channelIds: enums.map((c) => c.id) });
    for (const c of enums) placed.add(c.id);
    rationaleParts.push(
      `grouped ${enums.length} discrete-state channel${
        enums.length === 1 ? "" : "s"
      } into an enum lane`,
    );
  }

  // 3. remaining scalars → plots, grouped by top-level name segment, each
  //    capped at MAX_PLOT_SERIES (splitting larger groups across panels).
  const scalars = channels.filter(
    (c) => !placed.has(c.id) && c.kind === "scalar",
  );
  // Stable group ordering: first-seen order of the group keys.
  const groupOrder: string[] = [];
  const groups = new Map<string, ProposalChannel[]>();
  for (const c of scalars) {
    const key = groupKey(c.name);
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(c);
  }

  let plotCount = 0;
  for (const key of groupOrder) {
    const members = groups.get(key)!;
    // Split a group that overflows the cap into successive plots.
    for (let i = 0; i < members.length; i += MAX_PLOT_SERIES) {
      const slice = members.slice(i, i + MAX_PLOT_SERIES);
      const multi = members.length > MAX_PLOT_SERIES;
      const part = multi ? ` (${Math.floor(i / MAX_PLOT_SERIES) + 1})` : "";
      panels.push({
        kind: "plot",
        title: `${titleForGroup(key)}${part}`,
        channelIds: slice.map((c) => c.id),
      });
      plotCount += 1;
    }
  }
  if (plotCount > 0) {
    rationaleParts.push(
      `plotted ${scalars.length} scalar channel${
        scalars.length === 1 ? "" : "s"
      } across ${plotCount} panel${plotCount === 1 ? "" : "s"}`,
    );
  }

  const rationale =
    rationaleParts.length > 0
      ? `Heuristic layout: ${rationaleParts.join("; ")}.`
      : "No channels to lay out.";

  return { panels, rationale };
}
