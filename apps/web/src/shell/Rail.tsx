// Phase 1 · Left icon rail (5 buttons, 40 px column).
//
// Icons are inlined verbatim from
// `docs/design/wireframe-bundle/project/wf-parts.jsx:RailIcons`.
// Clicking the active rail button collapses the drawer (VS Code
// behaviour, integration plan §Phase 1.5).

import type { ReactElement } from "react";
import { useSession } from "../state/store";
import type { RailTab } from "../state/persist/ui";
import { DRAWER_REGION_ID } from "./Drawer";
import styles from "./Rail.module.css";

interface RailItem {
  id: RailTab;
  label: string;
  icon: ReactElement;
}

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const RAIL_ITEMS: readonly RailItem[] = [
  {
    id: "sources",
    label: "Sources",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M21 8V7a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" />
        <path d="M3 13h18" />
      </svg>
    ),
  },
  {
    id: "channels",
    label: "Channels",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M3 6h13M3 12h18M3 18h10" />
        <circle cx="20" cy="6" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "layout",
    label: "Layout",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 12h18M12 3v18" />
      </svg>
    ),
  },
  {
    id: "panel",
    label: "Panel",
    icon: (
      <svg {...ICON_PROPS}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 8h18" />
      </svg>
    ),
  },
  {
    id: "events",
    label: "Event tags",
    icon: (
      <svg {...ICON_PROPS}>
        <path d="M4 22V4M4 4h13l-2 5 2 5H4" />
      </svg>
    ),
  },
];

export function Rail() {
  const activeRailTab = useSession((s) => s.activeRailTab);
  const railCollapsed = useSession((s) => s.railCollapsed);
  const setActiveRailTab = useSession((s) => s.setActiveRailTab);

  if (railCollapsed) return null;

  return (
    <nav
      className={styles.rail}
      aria-label="Sections"
      data-testid="rail"
    >
      {RAIL_ITEMS.map((item) => {
        const isActive = activeRailTab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`${styles.btn} ${isActive ? styles.active : ""}`}
            aria-label={item.label}
            aria-pressed={isActive}
            aria-expanded={isActive}
            aria-controls={DRAWER_REGION_ID}
            title={item.label}
            data-testid={`rail-${item.id}`}
            onClick={() => setActiveRailTab(isActive ? null : item.id)}
          >
            {item.icon}
          </button>
        );
      })}
      <div className={styles.spacer} />
    </nav>
  );
}
