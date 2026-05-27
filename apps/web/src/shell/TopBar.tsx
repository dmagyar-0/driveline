// UX overhaul (issues #15, #16, #17) · Top bar.
//
// Structure:
//
//   [ brand zone | center spacer | status zone | divider | help cluster ]
//
//   brand zone   — Driveline logo + wordmark. No version string,
//                  no hover treatment; it does not behave like a nav
//                  target. (iter2 #1 — version moved to About dialog.)
//   status zone  — sources chip (clickable — opens SourcesPopover),
//                  system status chip (only while transient).
//   help cluster — small "i" (About) and "?" (Keyboard shortcuts)
//                  buttons, separated from the status zone by a vertical
//                  divider. The "?" is the rightmost top-bar item.
//
// iter3 #2 changes:
//   - Dropped the topbar cursor readout. The transport bar carries the
//     load-bearing cursor display; duplicating it here added typographic
//     noise (mixed casing, mixed chip shapes).
//   - The sources chip and status chip now use the same pill shape so
//     they read as one cluster.
//   - The "Ready" status chip auto-hides after 5 s of steady-state
//     readiness. The DOM-only e2e sentinel (`worker-status`) stays
//     mounted regardless so the ~14 specs that assert on it keep
//     working.
//   - A vertical divider sits between the status zone and the help
//     cluster so the two visually separate.
//
// E2e contract: a hidden element with `data-testid="worker-status"` and
// the literal text `workers ready` MUST exist when `ready === true` —
// ~14 specs assert on it. We keep that sentinel mounted unconditionally
// (just visually-hidden) so the auto-hide of the visible chip cannot
// break the contract.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import { SourcesPopover } from "./SourcesPopover";
import { AboutDialog } from "./AboutDialog";
import { ShortcutsOverlay } from "../timeline/ShortcutsOverlay";
import styles from "./TopBar.module.css";

// How long the "Ready" chip stays visible after we transition to ready.
// After this it fades out so it doesn't shout at the user during normal
// use. Any new activity (load, error, re-init) re-shows it.
const READY_CHIP_IDLE_TIMEOUT_MS = 5_000;

export interface TopBarProps {
  ready: boolean;
  /** Opens the Sources drawer (issue #17 — popover's "open drawer"
   *  link). Owned by the Shell so it can flip the rail state. */
  onOpenSourcesDrawer: () => void;
}

export function TopBar({ ready, onOpenSourcesDrawer }: TopBarProps) {
  // Single-key selectors only (frontend skill).
  const sourceCount = useSession((s) => s.sources.length);

  const sourceLabel = `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const sourcesTriggerId = useId();

  // Coalesce the visible status to a single semantic word; the hidden
  // sibling keeps the load-bearing e2e text.
  const statusWord = ready ? "Ready" : "Initialising";

  // iter3 #2 — the visible status chip auto-hides 5 s after we settle
  // into the ready state. Any change (ready ↔ busy) re-shows it.
  // The hidden e2e sentinel below is unaffected.
  const [statusVisible, setStatusVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Always show the chip immediately on a state change.
    setStatusVisible(true);
    if (ready) {
      timerRef.current = setTimeout(() => {
        setStatusVisible(false);
        timerRef.current = null;
      }, READY_CHIP_IDLE_TIMEOUT_MS);
    }
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [ready]);

  return (
    <header className={styles.bar} data-testid="topbar">
      {/* Brand zone (issue #15) — own bounded region, no hover state.
       *  iter2 #1: version string removed from production chrome —
       *  it lives in the About dialog now. */}
      <div className={styles.brand} aria-label="Driveline">
        <img
          className={styles.logo}
          src="/brand/logo.svg"
          width={22}
          height={22}
          alt=""
          aria-hidden="true"
        />
        <span className={styles.wordmark}>driveline</span>
      </div>

      {/* Status zone (issue #16, iter3 #2) — sources + status chips
       *  share one pill shape and one baseline. The topbar cursor
       *  readout is gone: the transport bar carries the load-bearing
       *  cursor display. */}
      <div className={styles.status}>
        <button
          type="button"
          id={sourcesTriggerId}
          className={`${styles.chip} ${sourcesOpen ? styles.chipActive : ""}`}
          aria-haspopup="dialog"
          aria-expanded={sourcesOpen}
          aria-controls="sources-popover"
          onClick={() => setSourcesOpen((v) => !v)}
          data-testid="sources-chip"
          title={
            sourceCount === 0
              ? "No sources loaded"
              : `${sourceLabel} — click to view`
          }
        >
          <svg
            className={styles.chipIcon}
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 5.5V5a1.3 1.3 0 0 0-1.3-1.3H8L6.7 2.5H3.3A1.3 1.3 0 0 0 2 3.8v8.4A1.3 1.3 0 0 0 3.3 13.5h9.4a1.3 1.3 0 0 0 1.3-1.3v-.7" />
            <path d="M2 9h12" />
          </svg>
          <span className={styles.chipCount}>{sourceCount}</span>
          <span className={styles.chipLabel}>
            {sourceCount === 1 ? "source" : "sources"}
          </span>
        </button>

        {/* The visible status chip auto-hides after ready-idle (iter3 #2).
         *  We keep it mounted-but-hidden via a CSS modifier so AT users
         *  with assistive focus already on it don't lose context. */}
        <div
          className={`${styles.statusChip} ${
            ready ? styles.statusReady : styles.statusBusy
          } ${statusVisible ? "" : styles.statusHidden}`}
          role="status"
          aria-live="polite"
          aria-hidden={statusVisible ? undefined : true}
          title={ready ? "All workers ready" : "Workers initialising"}
          data-testid="status-chip"
        >
          <span
            className={`${styles.statusDot} ${
              ready ? styles.dotReady : styles.dotBusy
            }`}
            aria-hidden="true"
          />
          <span className={styles.statusWord}>{statusWord}</span>
        </div>

        {/* Screen-reader / e2e sentinel — preserves the literal text
         *  ~14 Playwright specs assert against. Visually hidden.
         *  Lives OUTSIDE the auto-hiding chip so the contract holds
         *  even after the chip fades. */}
        <span className={styles.srOnly} data-testid="worker-status">
          {ready ? "workers ready" : "workers initialising"}
        </span>
      </div>

      {/* Help cluster (iter2 #1, #5; iter3 #2) — About + Keyboard
       *  shortcuts, separated from the status zone by a vertical
       *  divider so the two clusters read as distinct concerns. The
       *  "?" button is the rightmost item in the top bar. */}
      <div className={styles.help}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setAboutOpen(true)}
          aria-label="About Driveline"
          data-testid="topbar-about"
          title="About Driveline"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="8" cy="8" r="6.5" />
            <path d="M8 7.5v3.5" />
            <circle cx="8" cy="5.4" r="0.4" fill="currentColor" stroke="none" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setShortcutsOpen(true)}
          aria-label="Keyboard shortcuts"
          data-testid="topbar-shortcuts"
          title="Keyboard shortcuts (?)"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5.5 6a2.5 2.5 0 1 1 3.6 2.25c-.7.35-1.1.85-1.1 1.6V10" />
            <circle cx="8" cy="12.4" r="0.5" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </div>

      <SourcesPopover
        open={sourcesOpen}
        anchorId={sourcesTriggerId}
        onClose={() => setSourcesOpen(false)}
        onOpenDrawer={onOpenSourcesDrawer}
      />

      {aboutOpen ? (
        <AboutDialog
          onClose={() => setAboutOpen(false)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
        />
      ) : null}

      {shortcutsOpen ? (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      ) : null}
    </header>
  );
}
