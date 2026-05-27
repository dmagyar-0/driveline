// Left icon rail · grouped, labelled buttons (icon stacked over label)
// in an 80 px column. Clicking the active button collapses the drawer
// (VS Code behaviour).

import type { ReactElement } from "react";
import { useSession } from "../state/store";
import type { RailTab } from "../state/persist/ui";
import { DRAWER_REGION_ID } from "./Drawer";
import styles from "./Rail.module.css";

interface RailItem {
  id: RailTab;
  label: string;
  hint: string;
  icon: ReactElement;
}

interface RailGroup {
  id: "data" | "layout" | "events";
  label: string;
  items: readonly RailItem[];
}

const ICON_PROPS = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const RAIL_GROUPS: readonly RailGroup[] = [
  {
    id: "data",
    label: "Data",
    items: [
      {
        id: "sources",
        label: "Sources",
        hint: "Loaded files (S)",
        icon: (
          <svg {...ICON_PROPS}>
            <path d="M7 7h7l3 3v8a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z" />
            <path d="M9 4h7l3 3v8" />
            <path d="M14 7v3h3" />
          </svg>
        ),
      },
      {
        id: "channels",
        label: "Channels",
        hint: "Signals from loaded sources",
        icon: (
          <svg {...ICON_PROPS}>
            <path d="M3 12h3l2-5 3 10 3-7 2 4h5" />
          </svg>
        ),
      },
    ],
  },
  {
    id: "layout",
    label: "Workspace",
    items: [
      {
        id: "layout",
        label: "Layout",
        hint: "Saved layouts, add panels",
        icon: (
          <svg {...ICON_PROPS}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
          </svg>
        ),
      },
      {
        id: "panel",
        label: "Panel",
        hint: "Settings for the selected panel",
        icon: (
          <svg {...ICON_PROPS}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 12h18M12 3v18" />
            <rect
              x="13"
              y="4"
              width="7"
              height="7"
              rx="1"
              fill="currentColor"
              fillOpacity="0.35"
              stroke="none"
            />
          </svg>
        ),
      },
    ],
  },
  {
    id: "events",
    label: "Annotations",
    items: [
      {
        id: "events",
        label: "Events",
        hint: "Bookmarks at cursor times",
        icon: (
          <svg {...ICON_PROPS}>
            <path d="M5 21V4" />
            <path d="M5 4h12l-3 4 3 4H5" />
          </svg>
        ),
      },
    ],
  },
];

export function Rail() {
  const activeRailTab = useSession((s) => s.activeRailTab);
  const railCollapsed = useSession((s) => s.railCollapsed);
  const setActiveRailTab = useSession((s) => s.setActiveRailTab);

  if (railCollapsed) return null;

  // Each button is a labelled toggle: `aria-label` matches the visible
  // label, `aria-pressed` toggles, `aria-expanded`+`aria-controls` wire
  // the drawer disclosure.
  return (
    <nav className={styles.rail} aria-label="Sections" data-testid="rail">
      {RAIL_GROUPS.map((group, groupIdx) => (
        <div
          key={group.id}
          className={styles.group}
          role="group"
          aria-label={group.label}
        >
          {groupIdx > 0 ? (
            <div className={styles.divider} aria-hidden="true" />
          ) : null}
          {group.items.map((item) => {
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
                title={`${item.label} — ${item.hint}`}
                data-testid={`rail-${item.id}`}
                onClick={() => setActiveRailTab(isActive ? null : item.id)}
              >
                <span className={styles.icon}>{item.icon}</span>
                <span className={styles.label}>{item.label}</span>
              </button>
            );
          })}
        </div>
      ))}
      <div className={styles.spacer} />
    </nav>
  );
}
