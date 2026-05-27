// FlexLayout container for VideoPanel.
//
// Resolves `videoBindings[panelId]` from the store, finds the owning
// source (MCAP or mp4+sidecar), and renders VideoPanel. When unbound
// or the bound channel no longer exists, surfaces VideoPanelEmptyState
// in either the primary or the compact variant depending on whether a
// previous binding is being replaced.

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
    // Surface the sidecar's per-frame PTS table to the panel so the
    // toolbar can drive frame stepping + derive expected FPS for the
    // health badge. Only mp4+sidecar sources expose one; MCAP sources
    // stay null and the toolbar falls back to a 30 fps target with
    // frame-step buttons disabled.
    const sidecarPtsNs =
      resolved.source.kind === "mp4+sidecar"
        ? resolved.source.mp4Cache?.index.ptsNs ?? null
        : null;
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

  // Empty state structure (same regardless of variant):
  //   1. Drop zone (primary)
  //   2. Try sample data (secondary text link)
  //   3. Picker list (tertiary, rendered only when candidates > 0)
  //
  // The "channel no longer available" branch uses the compact variant
  // so the explainer copy fits in a tighter space.
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
