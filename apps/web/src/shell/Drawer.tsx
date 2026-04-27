// Drawer host.
//
// Switches on `activeRailTab` and renders the corresponding drawer
// component. Phases 2-5 and 8 each replace one inline stub with a real
// `shell/drawers/<Name>Drawer.tsx`. Phases 2-5 wired the real Sources,
// Channels, Layout, and Panel drawers; only Events is still a stub.

import type { RailTab } from "../state/persist/ui";
import { useSession } from "../state/store";
import { SourcesDrawer } from "./drawers/SourcesDrawer";
import { ChannelsDrawer } from "./drawers/ChannelsDrawer";
import { LayoutDrawer } from "./drawers/LayoutDrawer";
import { PanelDrawer } from "./drawers/PanelDrawer";
import styles from "./Drawer.module.css";

interface StubProps {
  title: string;
  phase: number;
  what: string;
}

function DrawerStub({ title, phase, what }: StubProps) {
  const headingId = `drawer-${title.toLowerCase()}-h`;
  return (
    <aside
      className={styles.drawer}
      role="region"
      aria-labelledby={headingId}
      data-testid={`drawer-${title.toLowerCase()}`}
    >
      <div className={styles.heading}>
        <h3 id={headingId}>{title}</h3>
      </div>
      <p className={styles.placeholder}>
        {what} Lands in Phase {phase}.
      </p>
    </aside>
  );
}

const STUBS: Record<
  Exclude<RailTab, "sources" | "channels" | "layout" | "panel">,
  { title: string; phase: number; what: string }
> = {
  events: {
    title: "Events",
    phase: 8,
    what: "Bookmarks at points in time, with cursor jump.",
  },
};

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
  /** Forwarded to the Layout drawer's `Reset layout` row. */
  resetLayout: () => void;
}

export function Drawer({
  ensurePlotPanel,
  addVideoPanel,
  addPlotPanel,
  resetLayout,
}: DrawerProps) {
  const activeRailTab = useSession((s) => s.activeRailTab);
  if (activeRailTab === null) return null;
  if (activeRailTab === "sources") return <SourcesDrawer />;
  if (activeRailTab === "channels")
    return <ChannelsDrawer ensurePlotPanel={ensurePlotPanel} />;
  if (activeRailTab === "layout")
    return (
      <LayoutDrawer
        addVideoPanel={addVideoPanel}
        addPlotPanel={addPlotPanel}
        resetLayout={resetLayout}
      />
    );
  if (activeRailTab === "panel") return <PanelDrawer />;
  return <DrawerStub {...STUBS[activeRailTab]} />;
}
