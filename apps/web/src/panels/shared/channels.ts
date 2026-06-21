// Shared channel-binding resolution.
//
// Every data panel resolves persisted binding ids back to live `Channel`
// records the same way; this used to be a verbatim copy in MapPanel,
// EnumPanel, ValuePanel, TablePanel, ScenePanel (and a `channelMap` variant in
// PlotPanel). One copy lives here now.
//
// Note: the state layer also exports `selectChannelsById(state)` for an O(1)
// lookup over the flat `state.channels` list (which is exactly
// `sources.flatMap(s => s.channels)`). Panels here already subscribe to
// `sources`, so a single linear scan over the handful of bound ids is cheap
// and keeps the dependency surface to `sources`; consumers that need a hot
// per-id lookup should prefer the store selector.

import type { Channel, SourceMeta } from "../../state/store";

/** First channel matching `channelId` across all open sources, or null. */
export function findChannel(
  sources: SourceMeta[],
  channelId: string,
): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

/** `channelId → Channel` lookup across all open sources. */
export function channelMap(sources: SourceMeta[]): Map<string, Channel> {
  const m = new Map<string, Channel>();
  for (const s of sources) for (const c of s.channels) m.set(c.id, c);
  return m;
}
