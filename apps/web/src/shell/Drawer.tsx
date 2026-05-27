// Drawer host · switches on `activeRailTab`. The default branch is an
// exhaustiveness check — every rail tab has a real drawer.

import { useSession } from "../state/store";
import { SourcesDrawer } from "./drawers/SourcesDrawer";
import { ChannelsDrawer } from "./drawers/ChannelsDrawer";
import { LayoutDrawer } from "./drawers/LayoutDrawer";
import { PanelDrawer } from "./drawers/PanelDrawer";
import { EventsDrawer } from "./drawers/EventsDrawer";

// Shared id for the active drawer's <section role="region">. Drawers
// render mutually exclusively, so one id is unambiguous; rail buttons
// reference it via aria-controls.
export const DRAWER_REGION_ID = "shell-drawer-region";

export interface DrawerProps {
  /** Mints (or returns) a plot panel id when the Channels drawer's
   *  click-to-bind path needs a target and none is selected. App owns
   *  the `WorkspaceHandle` ref; Shell/Drawer only forward. */
  ensurePlotPanel: () => string | null;
  addVideoPanel: () => void;
  addPlotPanel: () => void;
  addScenePanel: () => void;
  addMapPanel: () => void;
  addTablePanel: () => void;
  addEnumPanel: () => void;
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
