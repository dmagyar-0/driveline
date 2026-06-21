// Video panel settings body, split out of `PanelDrawer.tsx`.

import { useSession } from "../../../state/store";
import { colorFor } from "../../../panels/palette";
import { selectChannelsById } from "../../../state/store";
import { usePolledSnapshot } from "./hooks";
import type { BodyProps } from "./shared";
import s from "../PanelDrawer.module.css";

export function VideoBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const bindingId = useSession((st) => st.videoBindings[panelId] ?? null);
  const hudOn = useSession((st) => st.videoHudOn[panelId] ?? false);

  const codec = useDecoderCodec(bindingId);
  const boundChannel = bindingId
    ? (selectChannelsById({ channels }).get(bindingId) ?? null)
    : null;

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Decoder</h4>
        <p className={s.codec} data-testid="panel-video-decoder">
          {codec ?? "—"}
        </p>
      </section>

      <section className={s.section}>
        <h4 className={s.sectionTitle}>Toggles</h4>
        <button
          type="button"
          role="switch"
          aria-checked={hudOn}
          className={`${s.toggle} ${hudOn ? s.toggleOn : ""}`}
          onClick={() => useSession.getState().toggleVideoHudOn(panelId)}
          data-testid="panel-drawer-hud-toggle"
        >
          <span>HUD overlay</span>
          <span className={s.toggleState}>{hudOn ? "on" : "off"}</span>
        </button>
        <button
          type="button"
          role="switch"
          aria-checked={false}
          aria-disabled
          className={`${s.toggle} ${s.toggleDisabled}`}
          title="Pending VideoPanel step-hold support"
          data-testid="panel-drawer-step-hold"
        >
          <span>Step-hold</span>
          <span className={s.toggleState}>pending</span>
        </button>
      </section>

      <section className={s.section}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        {boundChannel === null ? (
          <p className={s.empty}>
            No channel bound. Use the Channels drawer to bind one.
          </p>
        ) : (
          <ul className={s.list} data-testid="panel-video-list">
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(boundChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={boundChannel.name}>
                  {boundChannel.name}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() =>
                  useSession.getState().setVideoBinding(panelId, null)
                }
                aria-label={`Remove ${boundChannel.name}`}
                data-testid={`panel-video-remove-${boundChannel.id}`}
              >
                ×
              </button>
            </li>
          </ul>
        )}
      </section>
    </>
  );
}

// Codec lives on the rAF-published HUD snapshot, not in the store. Poll
// while a video is bound (cheap, off the hot path); `null` when unbound.
function useDecoderCodec(bindingId: string | null): string | null {
  return usePolledSnapshot<string | null>(
    () => (bindingId === null ? null : (window.__drivelineVideoHud?.codec ?? null)),
    [bindingId],
  );
}
