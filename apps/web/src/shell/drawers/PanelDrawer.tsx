// Phase 5 · Panel drawer.
//
// Replaces the inline `panel` stub in `Drawer.tsx`. Body switches on the
// kind of the currently-selected panel:
//   - none  → "Select a panel to configure it" empty state
//   - plot  → bound channels (× to remove), `+ add channel…` popover
//             reusing the existing `<ChannelPicker>`
//   - video → decoder label, HUD overlay toggle (round-trips through
//             `setVideoHudOn` / `toggleVideoHudOn` in the store, so the
//             in-panel button + `h` keypress + this drawer all share one
//             bit), and the bound channel with × to clear.
//
// New panel kinds (Scene / Map / Table / Enum) land in Phase 6 — until
// `panelKindOf` returns those discriminators we just fall through to the
// empty state for unknown ids.
//
// The drawer reads everything from the store via single-key selectors
// and from the rAF-published `__drivelineVideoHud` snapshot for the
// codec label (which is not in the store — only the worker decoder
// owns it).

import { useEffect, useRef, useState } from "react";
import { useSession, type Channel, type SourceMeta } from "../../state/store";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
import { ChannelPicker } from "../../panels/ChannelPicker";
import {
  panelKindOf,
  panelNameFor,
  type PanelKind,
} from "../../layout/panelId";
import drawerStyles from "../Drawer.module.css";
import s from "./PanelDrawer.module.css";

const HEADING_ID = "drawer-panel-h";

export function PanelDrawer() {
  const selectedPanelId = useSession((st) => st.selectedPanelId);
  const layoutJson = useSession((st) => st.layoutJson);

  const kind: PanelKind | null =
    selectedPanelId === null ? null : panelKindOf(selectedPanelId);
  const panelName =
    selectedPanelId === null
      ? null
      : (panelNameFor(layoutJson, selectedPanelId) ?? selectedPanelId);

  return (
    <aside
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-panel"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Panel</h3>
        {kind !== null && (
          <span className={s.kindPill} data-testid="drawer-panel-kind">
            {kind === "plot" ? "PLOT" : "VIDEO"}
          </span>
        )}
      </div>

      {selectedPanelId === null ? (
        <Empty />
      ) : (
        <>
          <p className={s.subtitle} data-testid="drawer-panel-name">
            {panelName}
          </p>
          {kind === "plot" && <PlotBody panelId={selectedPanelId} />}
          {kind === "video" && <VideoBody panelId={selectedPanelId} />}
          {kind === null && <UnknownKind />}
        </>
      )}
    </aside>
  );
}

function Empty() {
  return (
    <p className={s.empty} data-testid="panel-drawer-empty">
      Select a panel to configure it. Click any panel in the workspace
      or use the Channels drawer.
    </p>
  );
}

function UnknownKind() {
  return (
    <p className={s.empty}>
      This panel kind doesn't have configurable settings yet (Phase 6).
    </p>
  );
}

interface BodyProps {
  panelId: string;
}

function PlotBody({ panelId }: BodyProps) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const ids = useSession((st) => st.plotBindings[panelId] ?? EMPTY);

  const addBtnRef = useRef<HTMLButtonElement | null>(null);
  const [pickerAnchor, setPickerAnchor] = useState<DOMRect | null>(null);

  const atCap = ids.length >= MAX_PLOT_SERIES;
  const bound = ids
    .map((id) => channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined);

  const onToggle = (channelId: string) => {
    const cur = useSession.getState().plotBindings[panelId] ?? [];
    if (cur.includes(channelId)) {
      useSession.getState().removePlotChannel(panelId, channelId);
    } else {
      useSession.getState().addPlotChannel(panelId, channelId);
    }
  };

  const onRemove = (channelId: string) =>
    useSession.getState().removePlotChannel(panelId, channelId);

  const openPicker = () => {
    if (!addBtnRef.current) return;
    setPickerAnchor(addBtnRef.current.getBoundingClientRect());
  };

  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h4 className={s.sectionTitle}>Channels in panel</h4>
        <span className={s.countPill} data-testid="panel-plot-count">
          {ids.length} / {MAX_PLOT_SERIES}
        </span>
      </div>
      {bound.length === 0 ? (
        <p className={s.empty}>No channels bound. Add one below.</p>
      ) : (
        <ul className={s.list} data-testid="panel-plot-list">
          {bound.map((c) => (
            <li key={c.id} className={s.rowItem}>
              <span className={s.row}>
                <span
                  className={s.swatch}
                  style={{ background: colorFor(c.id) }}
                  aria-hidden="true"
                />
                <span className={s.name} title={c.name}>
                  {labelFor(c)}
                </span>
              </span>
              <button
                type="button"
                className={s.removeBtn}
                onClick={() => onRemove(c.id)}
                aria-label={`Remove ${c.name}`}
                data-testid={`panel-plot-remove-${c.id}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={addBtnRef}
        type="button"
        className={s.addRow}
        aria-disabled={atCap || undefined}
        title={atCap ? `Plot full (${MAX_PLOT_SERIES})` : undefined}
        onClick={() => {
          if (atCap) return;
          openPicker();
        }}
        data-testid="panel-plot-add-channel"
      >
        + add channel…
      </button>
      {pickerAnchor !== null && (
        <ChannelPicker
          sources={sources}
          selectedIds={ids}
          maxSelected={MAX_PLOT_SERIES}
          anchorRect={pickerAnchor}
          onToggle={onToggle}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </section>
  );
}

function VideoBody({ panelId }: BodyProps) {
  const sources = useSession((st) => st.sources);
  const bindingId = useSession((st) => st.videoBindings[panelId] ?? null);
  const hudOn = useSession((st) => st.videoHudOn[panelId] ?? false);

  const codec = useDecoderCodec(bindingId);
  const boundChannel = bindingId
    ? findChannel(sources, bindingId)
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

const EMPTY: readonly string[] = Object.freeze([]);

function labelFor(c: Channel): string {
  return c.unit ? `${c.name} (${c.unit})` : c.name;
}

function findChannel(sources: SourceMeta[], channelId: string): Channel | null {
  for (const src of sources) {
    const hit = src.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

// Codec lives on the rAF-published HUD snapshot, not in the store.
// Poll at 250ms while a video is bound — cheap, doesn't churn the
// reconciler, and the codec field is set once per fixture load anyway.
function useDecoderCodec(bindingId: string | null): string | null {
  const [codec, setCodec] = useState<string | null>(null);
  useEffect(() => {
    if (bindingId === null) {
      setCodec(null);
      return;
    }
    setCodec(window.__drivelineVideoHud?.codec ?? null);
    const tick = () => {
      const next = window.__drivelineVideoHud?.codec ?? null;
      setCodec((prev) => (prev === next ? prev : next));
    };
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [bindingId]);
  return codec;
}
