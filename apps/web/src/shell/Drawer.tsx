// Drawer host.
//
// Switches on `activeRailTab` and renders the corresponding drawer
// component. Phases 2-5 and 8 each replaced one inline stub with a
// real `shell/drawers/<Name>Drawer.tsx`. As of Phase 8 every rail tab
// has a real drawer — the stub fallthrough has been removed and the
// final branch is an exhaustiveness check.

import { useState } from "react";
import { useSession } from "../state/store";
import { SourcesDrawer } from "./drawers/SourcesDrawer";
import { ChannelsDrawer } from "./drawers/ChannelsDrawer";
import { LayoutDrawer } from "./drawers/LayoutDrawer";
import { PanelDrawer } from "./drawers/PanelDrawer";
import { EventsDrawer } from "./drawers/EventsDrawer";
import { FormatsDrawer } from "./drawers/FormatsDrawer";
import { AddPanelMenu } from "./AddPanelMenu";
import { DrawerResizer } from "./DrawerResizer";
import styles from "./Drawer.module.css";
import type { RailTab } from "../state/persist/ui";

// Shared id for the active drawer's <section role="region">. Drawers render
// mutually exclusively so a single id is unambiguous; rail buttons reference
// it via aria-controls so AT can announce the rail/drawer relationship.
export const DRAWER_REGION_ID = "shell-drawer-region";

export function Drawer() {
  const activeRailTab = useSession((s) => s.activeRailTab);
  const storedWidth = useSession((s) => s.drawerWidth);
  const setDrawerWidth = useSession((s) => s.setDrawerWidth);
  // Live width during a splitter drag. Kept local so pointermove doesn't
  // hammer the store (and its localStorage subscriber) — the gesture
  // commits once on pointer-up. `null` means "not dragging, use the store".
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  if (activeRailTab === null) return null;

  const width = dragWidth ?? storedWidth;

  return (
    <div
      className={styles.host}
      data-testid="drawer-host"
      style={{ width: `${width}px` }}
    >
      <DrawerBody activeRailTab={activeRailTab} />
      {/* Persistent shortcut: add a panel from whichever drawer is open,
          not just the Layout tab. Reaches FlexLayout via `workspaceBridge`. */}
      <AddPanelMenu />
      {/* Drag handle on the drawer's right edge. Absolutely positioned so
          it spans the full height without disturbing the column stack. */}
      <DrawerResizer
        width={width}
        onPreview={setDragWidth}
        onCommit={(px) => {
          setDragWidth(null);
          setDrawerWidth(px);
        }}
      />
    </div>
  );
}

function DrawerBody({ activeRailTab }: { activeRailTab: RailTab }) {
  switch (activeRailTab) {
    case "sources":
      return <SourcesDrawer />;
    case "channels":
      return <ChannelsDrawer />;
    case "layout":
      return <LayoutDrawer />;
    case "panel":
      return <PanelDrawer />;
    case "events":
      return <EventsDrawer />;
    case "formats":
      return <FormatsDrawer />;
    default: {
      const _exhaustive: never = activeRailTab;
      void _exhaustive;
      return null;
    }
  }
}
