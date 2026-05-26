// Phase 1 · Left icon rail (5 buttons in a labelled column).
//
// UX overhaul (issue #14): every rail button is a labelled item with
// a visible icon, an inline text label that fades in on hover/focus
// (or on a keyboard focus inside the rail) and a clear active state
// (accent bar + filled background). Icons remain 24 px hit targets;
// labels never wrap. Items are grouped:
//
//   group 1 — data:    Sources, Channels
//   group 2 — layout:  Layout, Panel
//   group 3 — events:  Events
//
// Clicking the active rail button still collapses the drawer (VS Code
// behaviour, integration plan §Phase 1.5).

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
            <path d="M21 8V7a2 2 0 0 0-2-2h-7l-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-1" />
            <path d="M3 13h18" />
          </svg>
        ),
      },
      {
        id: "channels",
        label: "Channels",
        hint: "Signals from loaded sources",
        icon: (
          <svg {...ICON_PROPS}>
            <path d="M3 6h13M3 12h18M3 18h10" />
            <circle cx="20" cy="6" r="1.5" fill="currentColor" />
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
            <path d="M3 12h18M12 3v18" />
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
            <path d="M3 8h18" />
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
            <path d="M5 21V4a1 1 0 0 1 1-1h11l-2 5 2 5H6" />
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

  // a11y decision (Agent E carryover): the rail expands 48 → 168 px
  // on hover / focus-within to reveal text labels. We deliberately do
  // NOT put `aria-expanded` on the <nav> itself because:
  //   1. The hover expansion is purely visual progressive disclosure
  //      of *labels that are already in the accessible name*. Every
  //      button carries `aria-label="<Label>"`, so AT announces the
  //      label whether the rail is collapsed or not.
  //   2. The expansion does not change what is focusable, what is
  //      announced, nor what region content the rail discloses — the
  //      drawer disclosure (`aria-expanded` on the active button) is
  //      a separate concept.
  // Putting `aria-expanded` on the rail itself would falsely imply
  // that focus into the rail toggles a disclosure widget, which is
  // not what happens.
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
