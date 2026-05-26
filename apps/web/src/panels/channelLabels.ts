// Compact channel-label helpers for the Plot panel (UX overhaul).
//
// The v1 plot panel printed the full topic-style channel name plus unit
// inside every chip — `/vehicle/wheel_speed_fr (m/s) ×` — which wrapped
// into 2–3 rows and crowded out the actual plot. In multi-segment views
// four chips that differed only by source were impossible to tell apart;
// the chip's tiny dot was the only disambiguator, and that dot didn't
// always reflect the line colour.
//
// `shortChannelLabel` returns the trailing path segment (the part that
// usually conveys meaning), and `sourceBadge` extracts a short identifier
// for the source the channel came from. Both are pure string operations,
// safe to call on every render; the full `name` (and unit) is still
// surfaced via the chip's `title` tooltip via `fullChannelLabel`.

import type { Channel, SourceMeta } from "../state/store";

/** Returns the last `/`-delimited path segment, or the full name when
 *  there is no slash. Falls back to the empty string defensively so the
 *  chip never renders `undefined`. */
export function shortChannelLabel(c: Channel): string {
  const name = c.name ?? "";
  if (!name) return "";
  const slash = name.lastIndexOf("/");
  if (slash >= 0 && slash < name.length - 1) return name.slice(slash + 1);
  return name;
}

/** Human-readable full label retained for tooltips and dense list rows. */
export function fullChannelLabel(c: Channel): string {
  return c.unit ? `${c.name} (${c.unit})` : c.name;
}

/** A short identifier for the source the channel belongs to, e.g. the
 *  filename without extension. Used on chip badges so a user can
 *  disambiguate four chips named `speed` coming from four files.
 *  Returns the empty string when the source cannot be resolved. */
export function sourceBadge(channel: Channel, sources: SourceMeta[]): string {
  const src = sources.find((s) => s.id === channel.sourceId);
  if (!src) return "";
  return shortenSourceName(src.name);
}

/** Strip the extension and any leading path. Truncate long stems to
 *  keep the badge visually compact (chips have a hard width budget). */
export function shortenSourceName(name: string): string {
  if (!name) return "";
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const tail = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  const dot = tail.lastIndexOf(".");
  const stem = dot > 0 ? tail.slice(0, dot) : tail;
  // Cap badge length — `comma2k19-segment-12_2018-08-13-15-08-32_03` is
  // a real fixture name in this repo and would otherwise dominate the
  // chip.
  if (stem.length <= 14) return stem;
  return `${stem.slice(0, 6)}…${stem.slice(-6)}`;
}

/** True when at least two of the bound channels share a `name`. When
 *  every short label is unique a source badge is just noise; we only
 *  surface it when it carries disambiguating information. */
export function shouldShowSourceBadges(channels: Channel[]): boolean {
  if (channels.length < 2) return false;
  const seen = new Set<string>();
  for (const c of channels) {
    const key = shortChannelLabel(c);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
