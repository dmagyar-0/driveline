// Map panel settings body (lat/lon two-channel binding), split out of
// `PanelDrawer.tsx`.

import { useRef, useState } from "react";
import { selectChannelsById, useSession } from "../../../state/store";
import { channelLabel } from "../../../state/units";
import { colorFor } from "../../../panels/palette";
import { ChannelPicker } from "../../../panels/ChannelPicker";
import type { BodyProps } from "./shared";
import s from "../PanelDrawer.module.css";

export function MapBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const unitOverrides = useSession((st) => st.unitOverrides);
  const binding = useSession((st) => st.mapBindings[panelId] ?? null);
  const setMapBinding = useSession((st) => st.setMapBinding);

  // The store's MapBinding is all-or-nothing (both axes required), but the
  // two pickers are filled one at a time. Hold a freshly-picked axis here
  // until its partner is chosen, then commit the complete pair. Without
  // this, the first pick was written straight back as `null` (a half pair
  // can't be persisted), so the map could never be bound from the drawer.
  // The instance is keyed by panelId (see PanelBody) so these reset when a
  // different map panel is selected.
  const [pendingLat, setPendingLat] = useState<string | null>(null);
  const [pendingLon, setPendingLon] = useState<string | null>(null);

  const latBtnRef = useRef<HTMLButtonElement | null>(null);
  const lonBtnRef = useRef<HTMLButtonElement | null>(null);
  const [latAnchor, setLatAnchor] = useState<DOMRect | null>(null);
  const [lonAnchor, setLonAnchor] = useState<DOMRect | null>(null);

  // Effective selection: a half-pick (pending) overrides the committed
  // binding so the drawer reflects the click immediately, before its
  // partner lands.
  const latId = pendingLat ?? binding?.latChannelId ?? null;
  const lonId = pendingLon ?? binding?.lonChannelId ?? null;

  const byId = selectChannelsById({ channels });
  const latChannel = latId === null ? null : (byId.get(latId) ?? null);
  const lonChannel = lonId === null ? null : (byId.get(lonId) ?? null);

  const onPickLat = (channelId: string) => {
    if (lonId !== null) {
      // Partner already chosen → commit the full pair; the store now holds
      // the truth, so drop the local half-picks.
      setMapBinding(panelId, { latChannelId: channelId, lonChannelId: lonId });
      setPendingLat(null);
      setPendingLon(null);
    } else {
      setPendingLat(channelId);
    }
    setLatAnchor(null);
  };

  const onPickLon = (channelId: string) => {
    if (latId !== null) {
      setMapBinding(panelId, { latChannelId: latId, lonChannelId: channelId });
      setPendingLat(null);
      setPendingLon(null);
    } else {
      setPendingLon(channelId);
    }
    setLonAnchor(null);
  };

  // Removing either axis clears the whole pair (the binding is a pair) and
  // any in-flight half-pick.
  const clearBinding = () => {
    setPendingLat(null);
    setPendingLon(null);
    setMapBinding(panelId, null);
  };

  return (
    <>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Latitude</h4>
        {latChannel !== null ? (
          <ul className={s.list}>
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(latChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={latChannel.name}>
                  {channelLabel(latChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={clearBinding}
                aria-label={`Remove ${latChannel.name}`}
                data-testid="panel-map-remove-lat"
              >
                ×
              </button>
            </li>
          </ul>
        ) : (
          <p className={s.empty}>No latitude channel bound.</p>
        )}
        <button
          ref={latBtnRef}
          type="button"
          className={s.addRow}
          onClick={() =>
            setLatAnchor(latBtnRef.current?.getBoundingClientRect() ?? null)
          }
          data-testid="panel-map-pick-lat"
        >
          + pick lat channel…
        </button>
        {latAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={latId ? [latId] : []}
            maxSelected={1}
            anchorRect={latAnchor}
            onToggle={onPickLat}
            onClose={() => setLatAnchor(null)}
          />
        )}
      </section>
      <section className={s.section}>
        <h4 className={s.sectionTitle}>Longitude</h4>
        {lonChannel !== null ? (
          <ul className={s.list}>
            <li className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(lonChannel.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={lonChannel.name}>
                  {channelLabel(lonChannel, unitOverrides)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={clearBinding}
                aria-label={`Remove ${lonChannel.name}`}
                data-testid="panel-map-remove-lon"
              >
                ×
              </button>
            </li>
          </ul>
        ) : (
          <p className={s.empty}>No longitude channel bound.</p>
        )}
        <button
          ref={lonBtnRef}
          type="button"
          className={s.addRow}
          onClick={() =>
            setLonAnchor(lonBtnRef.current?.getBoundingClientRect() ?? null)
          }
          data-testid="panel-map-pick-lon"
        >
          + pick lon channel…
        </button>
        {lonAnchor !== null && (
          <ChannelPicker
            sources={sources}
            selectedIds={lonId ? [lonId] : []}
            maxSelected={1}
            anchorRect={lonAnchor}
            onToggle={onPickLon}
            onClose={() => setLonAnchor(null)}
          />
        )}
      </section>
    </>
  );
}
