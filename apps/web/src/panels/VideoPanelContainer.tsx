// T6.2 · FlexLayout container for VideoPanel.
//
// Resolves `videoBindings[panelId]` from the store, finds the owning
// source (only MCAP is wired today; mp4+sidecar lands with T5.3), and
// renders the existing `VideoPanel` with props. When unbound, or when
// the bound channel no longer exists (session cleared, different file
// loaded), show a picker that lists every `kind === "video"` channel.

import { useMemo } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { VideoPanel } from "./VideoPanel";
import styles from "./VideoPanelContainer.module.css";

interface VideoPanelContainerProps {
  panelId: string;
}

interface Resolved {
  source: SourceMeta;
  channel: Channel;
}

function resolveBinding(
  sources: SourceMeta[],
  channelId: string | null | undefined,
): Resolved | null {
  if (!channelId) return null;
  for (const source of sources) {
    const channel = source.channels.find((c) => c.id === channelId);
    if (channel && channel.kind === "video") {
      return { source, channel };
    }
  }
  return null;
}

function videoChannels(sources: SourceMeta[]): { source: SourceMeta; channel: Channel }[] {
  const out: { source: SourceMeta; channel: Channel }[] = [];
  for (const source of sources) {
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

  if (resolved && resolved.source.kind === "mcap") {
    // Keyed by the binding id so switching channel tears down + remounts
    // the worker wiring (matches the previous `FirstVideo` pattern).
    return (
      <div className={styles.wrap} data-testid={`video-panel-${panelId}`}>
        <VideoPanel
          key={`${resolved.source.id}:${resolved.channel.id}`}
          mcapHandle={resolved.source.handle}
          channelId={resolved.channel.id}
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

  // Empty / unresolved state: show a small picker so the user can bind a
  // video channel without leaving the panel. mp4+sidecar is not yet
  // supported — T5.3 will route that source kind through here too.
  return (
    <div className={styles.empty} data-testid={`video-panel-${panelId}-empty`}>
      {candidates.length === 0 ? (
        <p className={styles.hint}>
          Drop an MCAP file with a video channel to bind this panel.
        </p>
      ) : (
        <>
          <p className={styles.hint}>
            {bindingId
              ? "The previously bound channel is no longer available."
              : "Pick a video channel for this panel:"}
          </p>
          <ul className={styles.list}>
            {candidates.map(({ source, channel }) => {
              const disabled = source.kind !== "mcap";
              return (
                <li key={channel.id}>
                  <button
                    type="button"
                    className={styles.choice}
                    disabled={disabled}
                    onClick={() => setVideoBinding(panelId, channel.id)}
                    data-testid={`video-pick-${channel.id}`}
                    title={
                      disabled
                        ? "mp4+sidecar video wiring lands with T5.3"
                        : undefined
                    }
                  >
                    <span className={styles.choiceSource}>{source.name}</span>
                    <span className={styles.choiceName}>{channel.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
