// Drawer host.
//
// Switches on `activeRailTab` and renders the corresponding drawer
// component. Phases 2-5 and 8 each replace one inline stub with a real
// `shell/drawers/<Name>Drawer.tsx`. Phase 2 wired the real Sources
// drawer; the other four are still stubs.

import type { RailTab } from "../state/persist/ui";
import { useSession } from "../state/store";
import { SourcesDrawer } from "./drawers/SourcesDrawer";
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
  Exclude<RailTab, "sources">,
  { title: string; phase: number; what: string }
> = {
  channels: {
    title: "Channels",
    phase: 3,
    what: "Per-source channel list with click-to-bind to the active panel.",
  },
  layout: {
    title: "Layout",
    phase: 4,
    what: "Saved layouts and the add-panel buttons.",
  },
  panel: {
    title: "Panel",
    phase: 5,
    what: "Settings for the currently selected panel.",
  },
  events: {
    title: "Events",
    phase: 8,
    what: "Bookmarks at points in time, with cursor jump.",
  },
};

export function Drawer() {
  const activeRailTab = useSession((s) => s.activeRailTab);
  if (activeRailTab === null) return null;
  if (activeRailTab === "sources") return <SourcesDrawer />;
  return <DrawerStub {...STUBS[activeRailTab]} />;
}
