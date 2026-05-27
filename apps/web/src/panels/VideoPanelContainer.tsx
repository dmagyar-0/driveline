// T6.2 · FlexLayout container for VideoPanel.
//
// Resolves `videoBindings[panelId]` from the store, finds the owning
// source (MCAP or mp4+sidecar), and renders the existing `VideoPanel`
// with props. When unbound, or when the bound channel no longer exists
// (session cleared, different file loaded), we surface either:
//   - the rich `VideoPanelEmptyState` (no candidate channels — first
//     impression, with the "Try sample data" CTA wired through), or
//   - a compact picker on top of a stripped-down empty state when
//     candidate channels exist but the user hasn't bound one.

import { useMemo } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { VideoPanel } from "./VideoPanel";
import { VideoPanelEmptyState } from "./VideoPanelEmptyState";
import styles from "./VideoPanelContainer.module.css";

interface VideoPanelContainerProps {
  panelId: string;
}

interface Resolved {
  source: SourceMeta;
  channel: Channel;
  sourceKind: "mcap" | "mp4";
}

function resolveBinding(
  sources: SourceMeta[],
  channelId: string | null | undefined,
): Resolved | null {
  if (!channelId) return null;
  for (const source of sources) {
    if (source.kind !== "mcap" && source.kind !== "mp4+sidecar") continue;
    const channel = source.channels.find((c) => c.id === channelId);
    if (channel && channel.kind === "video") {
      const sourceKind: "mcap" | "mp4" =
        source.kind === "mcap" ? "mcap" : "mp4";
      return { source, channel, sourceKind };
    }
  }
  return null;
}

function videoChannels(
  sources: SourceMeta[],
): { source: SourceMeta; channel: Channel }[] {
  const out: { source: SourceMeta; channel: Channel }[] = [];
  for (const source of sources) {
    if (source.kind !== "mcap" && source.kind !== "mp4+sidecar") continue;
    for (const channel of source.channels) {
      if (channel.kind === "video") out.push({ source, channel });
    }
  }
  return out;
}

export function VideoPanelContainer({ panelId }: VideoPanelContainerProps) {
  const sources = useSession((s) => s.sources);
  const bindingId = useSession((s) => s.videoBindings[panelId] ?? null);
  const setVideoBinding = useSession((s) => s.setVideoBinding);

  const resolved = useMemo(
    () => resolveBinding(sources, bindingId),
    [sources, bindingId],
  );
  const candidates = useMemo(() => videoChannels(sources), [sources]);

  if (resolved) {
    // Iter 3 — surface the sidecar's per-frame PTS table to the panel
    // so the toolbar can drive frame stepping + derive expected FPS
    // for the decode-health badge. Only mp4+sidecar sources expose
    // one; MCAP sources stay null and the toolbar falls back gracefully
    // (frame buttons disabled, target FPS = 30).
    const sidecarPtsNs =
      resolved.source.kind === "mp4+sidecar"
        ? resolved.source.mp4Cache?.index.ptsNs ?? null
        : null;
    // Iter 4 issue #4 — the "Change channel" button used to live here
    // as an absolute-positioned, hover-revealed pill that painted over
    // the letterbox bars. It now lives in the VideoToolbar so it never
    // overlaps the video region; the container forwards the action and
    // the toolbar renders the affordance.
    // Keyed by the binding id so switching channel tears down + remounts
    // the worker wiring.
    return (
      <div className={styles.wrap} data-testid={`video-panel-${panelId}`}>
        <VideoPanel
          key={`${resolved.source.id}:${resolved.channel.id}`}
          sourceKind={resolved.sourceKind}
          sourceHandle={resolved.source.handle}
          channelId={resolved.channel.nativeId}
          panelId={panelId}
          sidecarPtsNs={sidecarPtsNs}
          onClearBinding={() => setVideoBinding(panelId, null)}
        />
      </div>
    );
  }

  // iter5 issue #5 — single unified empty state. Whether or not
  // candidates already exist, the user sees the same layout:
  //   1. Drop zone (primary)
  //   2. Try sample data (secondary text link)
  //   3. Picker list (tertiary, rendered only when candidates > 0)
  //
  // The previous two-design split ("rich" vs "compact + picker") was
  // the audit finding the iter5 brief calls out: two empty states for
  // the same panel state. The container now passes candidates +
  // onPick down and lets the empty state render them inline.
  //
  // The "channel no longer available" branch still uses the compact
  // variant so the explainer copy fits in a tighter space; the rest
  // of the structure (drop zone, sample link, picker) stays the same.
  const headline = bindingId ? "Channel no longer available" : undefined;
  const description = bindingId
    ? "The previously bound channel isn't in the current session. Drop a new recording or pick another channel below."
    : undefined;

  return (
    <div
      className={styles.emptyWrap}
      data-testid={`video-panel-${panelId}-empty`}
    >
      <VideoPanelEmptyState
        variant={bindingId ? "compact" : "primary"}
        headline={headline}
        description={description}
        candidates={candidates}
        onPick={(channelId) => setVideoBinding(panelId, channelId)}
      />
    </div>
  );
}
