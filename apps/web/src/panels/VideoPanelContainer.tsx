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
        />
        <button
          type="button"
          className={styles.clearBtn}
          onClick={() => setVideoBinding(panelId, null)}
          data-testid="video-clear-binding"
          aria-label="clear video binding"
        >
          Change channel
        </button>
      </div>
    );
  }

  // No bound channel and no candidates yet — render the rich empty
  // state with the "Try sample data" CTA. This is most users' first
  // impression of the panel, so it gets the full treatment.
  if (candidates.length === 0) {
    return (
      <div
        className={styles.emptyWrap}
        data-testid={`video-panel-${panelId}-empty`}
      >
        <VideoPanelEmptyState />
      </div>
    );
  }

  // Candidates exist; the user just needs to pick one. Render a
  // compact empty-state explainer above the picker so we keep the
  // visual identity but lean on the picker as the primary affordance.
  return (
    <div
      className={styles.emptyWrap}
      data-testid={`video-panel-${panelId}-empty`}
    >
      <VideoPanelEmptyState
        variant="compact"
        headline={
          bindingId
            ? "Channel no longer available"
            : "Pick a video channel"
        }
        description={
          bindingId
            ? "The previously bound channel isn't in the current session. Choose another one below."
            : "Select one of the loaded video tracks to start decoding."
        }
      />
      <ul className={styles.list}>
        {candidates.map(({ source, channel }) => (
          <li key={channel.id}>
            <button
              type="button"
              className={styles.choice}
              onClick={() => setVideoBinding(panelId, channel.id)}
              data-testid={`video-pick-${channel.id}`}
            >
              <span className={styles.choiceSource}>{source.name}</span>
              <span className={styles.choiceName}>{channel.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
