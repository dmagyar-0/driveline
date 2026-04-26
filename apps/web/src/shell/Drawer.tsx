// Phase 1 · Drawer host.
//
// Switches on `activeRailTab` and renders one of 5 inline stub bodies.
// Phases 2-5 and 8 each replace one stub with a real
// `shell/drawers/<Name>Drawer.tsx` file. Phase 1 keeps them inline so
// follow-up phases can add a single file and swap one branch of the
// switch rather than fight an existing scaffold.

import type { RailTab } from "../state/persist/ui";
import { useSession } from "../state/store";
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

const STUBS: Record<RailTab, { title: string; phase: number; what: string }> =
  {
    sources: {
      title: "Sources",
      phase: 2,
      what: "List of loaded files with kind badges and the global range.",
    },
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
  const stub = STUBS[activeRailTab];
  return <DrawerStub {...stub} />;
}
