// Drawer host.
//
// Switches on `activeRailTab` and renders the corresponding drawer
// component. Phases 2-5 and 8 each replaced one inline stub with a
// real `shell/drawers/<Name>Drawer.tsx`. As of Phase 8 every rail tab
// has a real drawer — the stub fallthrough has been removed and the
// final branch is an exhaustiveness check.

import { useSession } from "../state/store";
import { SourcesDrawer } from "./drawers/SourcesDrawer";
import { ChannelsDrawer } from "./drawers/ChannelsDrawer";
import { LayoutDrawer } from "./drawers/LayoutDrawer";
import { PanelDrawer } from "./drawers/PanelDrawer";
import { EventsDrawer } from "./drawers/EventsDrawer";
import { AddPanelMenu } from "./AddPanelMenu";
import styles from "./Drawer.module.css";
import type { RailTab } from "../state/persist/ui";

// Shared id for the active drawer's <section role="region">. Drawers render
// mutually exclusively so a single id is unambiguous; rail buttons reference
// it via aria-controls so AT can announce the rail/drawer relationship.
export const DRAWER_REGION_ID = "shell-drawer-region";

export interface DrawerProps {
  /** Mints (or returns) a plot panel id when the Channels drawer's
   *  click-to-bind path needs a target and none is selected. Owned by
   *  `App.tsx`, which has the `WorkspaceHandle` ref. */
  ensurePlotPanel: () => string | null;
  /** Forwarded to the Layout drawer's `+ video` row. App owns the
   *  FlexLayout `WorkspaceHandle`; Drawer/Shell only forward. */
  addVideoPanel: () => void;
  /** Forwarded to the Layout drawer's `+ plot` row. */
  addPlotPanel: () => void;
  /** Phase 6 · forwarded to the Layout drawer's `+ 3D scene` row. */
  addScenePanel: () => void;
  /** Phase 6 · forwarded to the Layout drawer's `+ map` row. */
  addMapPanel: () => void;
  /** Phase 6 · forwarded to the Layout drawer's `+ table` row. */
  addTablePanel: () => void;
  /** Phase 6 · forwarded to the Layout drawer's `+ enum` row. */
  addEnumPanel: () => void;
  /** Forwarded to the Layout drawer's `Reset layout` row. */
  resetLayout: () => void;
}

export function Drawer({
  ensurePlotPanel,
  addVideoPanel,
  addPlotPanel,
  addScenePanel,
  addMapPanel,
  addTablePanel,
  addEnumPanel,
  resetLayout,
}: DrawerProps) {
  const activeRailTab = useSession((s) => s.activeRailTab);
  if (activeRailTab === null) return null;
  return (
    <div className={styles.host} data-testid="drawer-host">
      <DrawerBody
        activeRailTab={activeRailTab}
        ensurePlotPanel={ensurePlotPanel}
        addVideoPanel={addVideoPanel}
        addPlotPanel={addPlotPanel}
        addScenePanel={addScenePanel}
        addMapPanel={addMapPanel}
        addTablePanel={addTablePanel}
        addEnumPanel={addEnumPanel}
        resetLayout={resetLayout}
      />
      {/* Persistent shortcut: add a panel from whichever drawer is open,
          not just the Layout tab. */}
      <AddPanelMenu
        addVideoPanel={addVideoPanel}
        addPlotPanel={addPlotPanel}
        addScenePanel={addScenePanel}
        addMapPanel={addMapPanel}
        addTablePanel={addTablePanel}
        addEnumPanel={addEnumPanel}
      />
    </div>
  );
}

function DrawerBody({
  activeRailTab,
  ensurePlotPanel,
  addVideoPanel,
  addPlotPanel,
  addScenePanel,
  addMapPanel,
  addTablePanel,
  addEnumPanel,
  resetLayout,
}: DrawerProps & { activeRailTab: RailTab }) {
  switch (activeRailTab) {
    case "sources":
      return <SourcesDrawer />;
    case "channels":
      return <ChannelsDrawer ensurePlotPanel={ensurePlotPanel} />;
    case "layout":
      return (
        <LayoutDrawer
          addVideoPanel={addVideoPanel}
          addPlotPanel={addPlotPanel}
          addScenePanel={addScenePanel}
          addMapPanel={addMapPanel}
          addTablePanel={addTablePanel}
          addEnumPanel={addEnumPanel}
          resetLayout={resetLayout}
        />
      );
    case "panel":
      return <PanelDrawer />;
    case "events":
      return <EventsDrawer />;
    default: {
      const _exhaustive: never = activeRailTab;
      void _exhaustive;
      return null;
    }
  }
}
