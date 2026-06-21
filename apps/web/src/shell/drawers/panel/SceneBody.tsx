// 3D scene panel settings body, split out of `PanelDrawer.tsx`.

import { useRef, useState } from "react";
import {
  selectChannelsById,
  useSession,
  type ChannelKind,
} from "../../../state/store";
import { channelLabel } from "../../../state/units";
import { colorFor } from "../../../panels/palette";
import { ChannelPicker } from "../../../panels/ChannelPicker";
import type { BodyProps } from "./shared";
import s from "../PanelDrawer.module.css";

// Channel kinds a 3D scene can render. `point_cloud` is the dedicated
// per-frame LiDAR geometry kind the data core emits (a whole spin per
// sample); `bounding_box` is the per-frame OpenLABEL 3D box kind (wireframe
// boxes + labels); `vector` stays accepted as a fallback for 3D-vector
// channels. Scalars / enums / video can't describe a scene, so they're
// excluded.
const SCENE_CHANNEL_KINDS: readonly ChannelKind[] = [
  "point_cloud",
  "bounding_box",
  "trajectory",
  "map_geometry",
  "vector",
];

export function SceneBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const bindingId = useSession((st) => st.sceneBindings[panelId] ?? null);
  const setSceneBinding = useSession((st) => st.setSceneBinding);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  // Auto-detect the bindable channels: only those whose kind the scene can
  // actually render. Drives both the picker contents and the empty/disabled
  // states below, so the user is never offered a channel that can't bind.
  const compatibleCount = channels.filter((c) =>
    SCENE_CHANNEL_KINDS.includes(c.kind),
  ).length;
  const hasCompatible = compatibleCount > 0;
  const boundChannel = bindingId
    ? (selectChannelsById({ channels }).get(bindingId) ?? null)
    : null;

  const onToggle = (channelId: string) => {
    setSceneBinding(panelId, bindingId === channelId ? null : channelId);
    setPickerAnchor(null);
  };

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Status</h4>
        <p className={s.empty} data-testid="panel-scene-status">
          Renders a 3D scene — bind a point-cloud channel to orbit a LiDAR
          cloud, or a bounding-box channel to see labelled 3D boxes. Geometry
          steps with the cursor as you scrub or play.
        </p>
      </section>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Bound channel</h4>
        {boundChannel === null ? (
          <p className={s.empty}>No channel bound.</p>
        ) : (
          <ul className={s.list} data-testid="panel-scene-list">
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(boundChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={boundChannel.name}>
                  {channelLabel(boundChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => setSceneBinding(panelId, null)}
                aria-label={`Remove ${boundChannel.name}`}
                data-testid={`panel-scene-remove-${boundChannel.id}`}
              >
                ×
              </button>
            </li>
          </ul>
        )}
        <button
          ref={addBtnRef}
          type="button"
          className={s.addRow}
          aria-disabled={!hasCompatible || undefined}
          title={
            hasCompatible
              ? undefined
              : "No point-cloud-compatible channels loaded"
          }
          onClick={() => {
            if (!hasCompatible) return;
            openPicker();
          }}
          data-testid="panel-scene-add-channel"
        >
          + bind channel…
        </button>
        <p className={s.gapHelp} data-testid="panel-scene-detect">
          {hasCompatible
            ? `${compatibleCount} compatible channel${
                compatibleCount === 1 ? "" : "s"
              } detected — only point-cloud channels can bind here.`
            : "No point-cloud channels detected in the loaded sources yet."}
        </p>
        {pickerAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={bindingId ? [bindingId] : []}
            maxSelected={1}
            anchorRect={pickerAnchor}
            kinds={SCENE_CHANNEL_KINDS}
            onToggle={onToggle}
            onClose={() => setPickerAnchor(null)}
          />
        )}
      </section>
    </>
  );
}
