// Phase 5 · Panel drawer. Phase 6 added bodies for the four new panel
// kinds (scene / map / table / enum); each binds via the existing
// `<ChannelPicker>` (filtered to scalar channels) so we don't introduce
// a parallel picker per kind.
//
// Replaces the inline `panel` stub in `Drawer.tsx`. Body switches on the
// kind of the currently-selected panel:
//   - none   → "Select a panel to configure it" empty state
//   - plot   → bound channels (× to remove), `+ add channel…` popover
//              reusing the existing `<ChannelPicker>`
//   - video  → decoder label, HUD overlay toggle (round-trips through
//              `setVideoHudOn` / `toggleVideoHudOn` in the store, so the
//              in-panel button + `h` keypress + this drawer all share
//              one bit), and the bound channel with × to clear.
//   - scene  → single-channel binding filtered to vector (point-cloud)
//              channels; auto-detects compatible signals and offers only
//              those. No rendering yet (pending the data-core format).
//   - map    → lat/lon two-channel binding via two pickers
//   - table  → multi-channel scalar binding (raw time-series table)
//   - value  → multi-channel scalar binding (sample-at-cursor reader)
//   - enum   → multi-channel scalar binding (one state strip per channel)
//
// The drawer reads everything from the store via single-key selectors
// and from the rAF-published `__drivelineVideoHud` snapshot for the
// codec label (which is not in the store — only the worker decoder
// owns it). The per-kind bodies and shared section/hooks live under
// `./panel/`; this file keeps only the drawer shell + kind dispatch.

import { useSession } from "../../state/store";
import {
  kindLabel,
  panelKindOf,
  panelNameFor,
  type PanelKind,
} from "../../layout/panelId";
import {
  PANEL_KINDS,
  PanelKindIcon,
  panelKindBlurb,
  panelKindName,
} from "../../layout/PanelKindIcon";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import { PlotBody } from "./panel/PlotBody";
import { VideoBody } from "./panel/VideoBody";
import { SceneBody } from "./panel/SceneBody";
import { MapBody } from "./panel/MapBody";
import { TableBody, ValueBody, EnumBody } from "./panel/TableBody";
import s from "./PanelDrawer.module.css";

const HEADING_ID = "drawer-panel-h";

export function PanelDrawer() {
  // `selectedPanelId` is typed `string | null`, but the store can be written
  // from untyped JS (the dev hooks run via page.evaluate). Anything
  // non-string reads as "nothing selected" here — the `=== null` branches
  // below are the only guards between a bad id and a render crash.
  const selectedPanelId = useSession((st) =>
    typeof st.selectedPanelId === "string" ? st.selectedPanelId : null,
  );
  const layoutJson = useSession((st) => st.layoutJson);

  const kind: PanelKind | null =
    selectedPanelId === null ? null : panelKindOf(selectedPanelId);
  const panelName =
    selectedPanelId === null
      ? null
      : (panelNameFor(layoutJson, selectedPanelId) ?? selectedPanelId);

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-panel"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Panel</h3>
      </div>

      {selectedPanelId === null ? (
        <Empty />
      ) : kind === null ? (
        <>
          <p className={s.subtitle} data-testid="drawer-panel-name">
            {panelName}
          </p>
          <UnknownKind />
        </>
      ) : (
        <>
          <KindCard kind={kind} panelName={panelName} />
          <PanelBody kind={kind} panelId={selectedPanelId} />
        </>
      )}
    </aside>
  );
}

/**
 * Identity card for the selected panel: kind glyph, the panel's own
 * name, the kind badge, and a one-line "what this panel shows" blurb.
 * Gives each settings page a visual anchor so the kind is readable at
 * a glance instead of from a lone text pill.
 */
function KindCard({
  kind,
  panelName,
}: {
  kind: PanelKind;
  panelName: string | null;
}) {
  return (
    <header className={s.kindCard} data-testid="drawer-panel-card">
      <span className={s.kindIcon}>
        <PanelKindIcon kind={kind} size={22} />
      </span>
      <div className={s.kindHead}>
        <div className={s.kindTitleRow}>
          <span
            className={s.kindName}
            data-testid="drawer-panel-name"
            title={panelName ?? undefined}
          >
            {panelName}
          </span>
          <span className={s.kindPill} data-testid="drawer-panel-kind">
            {kindLabel(kind)}
          </span>
        </div>
        <p className={s.kindBlurb}>{panelKindBlurb(kind)}</p>
      </div>
    </header>
  );
}

function PanelBody({
  kind,
  panelId,
}: {
  kind: PanelKind | null;
  panelId: string;
}) {
  switch (kind) {
    case "plot":
      return <PlotBody panelId={panelId} />;
    case "video":
      return <VideoBody panelId={panelId} />;
    case "scene":
      return <SceneBody panelId={panelId} />;
    case "map":
      // Keyed by panelId so the half-pick local state in MapBody resets
      // when a different map panel is selected (same-kind switches reuse
      // the instance otherwise, leaking a pending lat/lon across panels).
      return <MapBody key={panelId} panelId={panelId} />;
    case "table":
      return <TableBody panelId={panelId} />;
    case "value":
      return <ValueBody panelId={panelId} />;
    case "enum":
      return <EnumBody panelId={panelId} />;
    case null:
      return <UnknownKind />;
  }
}

function Empty() {
  return (
    <>
      <p className={s.empty} data-testid="panel-drawer-empty">
        Select a panel to configure it. Click any panel in the workspace or use
        the Channels drawer.
      </p>
      {/* Kind legend: doubles as the "what do these panel types mean"
          reference while nothing is selected. */}
      <section className={s.section} aria-label="Panel types">
        <div className={s.sectionHeader}>
          <h4 className={s.sectionTitle}>Panel types</h4>
        </div>
        <ul className={s.legend}>
          {PANEL_KINDS.map((k) => (
            <li key={k} className={s.legendRow}>
              <span className={s.legendIcon}>
                <PanelKindIcon kind={k} size={17} />
              </span>
              <span className={s.legendText}>
                <span className={s.legendName}>{panelKindName(k)}</span>
                <span className={s.legendBlurb}>{panelKindBlurb(k)}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function UnknownKind() {
  return (
    <p className={s.empty} data-testid="panel-drawer-unknown">
      Unknown panel kind. The id prefix doesn't match any registered panel.
    </p>
  );
}
