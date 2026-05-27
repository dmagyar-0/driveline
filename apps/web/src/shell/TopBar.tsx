// UX overhaul (issues #15, #16, #17) · Top bar.
//
// Structure:
//
//   [ brand zone | center spacer | status zone | help cluster ]
//
//   brand zone   — Driveline logo + wordmark. No version string,
//                  no hover treatment; it does not behave like a nav
//                  target. (iter2 #1 — version moved to About dialog.)
//   status zone  — cursor readout (humanised, with clock icon),
//                  sources chip (clickable — opens SourcesPopover),
//                  system status chip.
//   help cluster — small "i" (About) and "?" (Keyboard shortcuts)
//                  buttons. The "?" is the rightmost top-bar item.
//
// E2e contract: a hidden element with `data-testid="worker-status"` and
// the literal text `workers ready` MUST exist when `ready === true` —
// ~14 specs assert on it. The visible status chip uses a semantic dot +
// short label ("Ready" / "Initialising"); the literal "workers ready"
// string survives as a screen-reader-only sibling.

import { useId, useState } from "react";
import { useSession } from "../state/store";
import { formatRelative } from "../timeline/formatTime";
import { SourcesPopover } from "./SourcesPopover";
import { AboutDialog } from "./AboutDialog";
import { ShortcutsOverlay } from "../timeline/ShortcutsOverlay";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  ready: boolean;
  /** Opens the Sources drawer (issue #17 — popover's "open drawer"
   *  link). Owned by the Shell so it can flip the rail state. */
  onOpenSourcesDrawer: () => void;
}

export function TopBar({ ready, onOpenSourcesDrawer }: TopBarProps) {
  // Single-key selectors only (frontend skill). cursorNs ticks every
  // rAF during playback — keep its subscriber narrow.
  const cursorNs = useSession((s) => s.cursorNs);
  const startNs = useSession((s) => s.globalRange?.startNs ?? null);
  const sourceCount = useSession((s) => s.sources.length);

  const elapsed = formatRelative(cursorNs, startNs ?? 0n);
  const sourceLabel = `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const sourcesTriggerId = useId();

  // Coalesce the visible status to a single semantic word; the hidden
  // sibling keeps the load-bearing e2e text.
  const statusWord = ready ? "Ready" : "Initialising";

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

      {/* Status zone (issue #16) — three clearly-labelled controls. */}
      <div className={styles.status}>
        {/* iter2 #3: dropped the uppercase "CURSOR" micro-cap label.
         *  Now a clock glyph + a humanised time value with an "Time"
         *  accessible label. `role="status"` + `aria-live="off"` means
         *  AT can read it on demand but does NOT announce every rAF
         *  tick during playback — which would be a screen-reader DOS. */}
        <div
          className={styles.cursor}
          role="status"
          aria-live="off"
          aria-label={`Time ${elapsed}`}
          title="Cursor time (relative)"
        >
          <svg
            className={styles.cursorIcon}
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
            <circle cx="8" cy="8" r="6" />
            <path d="M8 4.5V8l2.2 1.6" />
          </svg>
          <span
            className={`${styles.cursorValue} tabular`}
            data-testid="cursor-readout"
          >
            {elapsed}
          </span>
        </div>

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

        <div
          className={`${styles.statusChip} ${
            ready ? styles.statusReady : styles.statusBusy
          }`}
          role="status"
          aria-live="polite"
          title={ready ? "All workers ready" : "Workers initialising"}
        >
          <span
            className={`${styles.statusDot} ${
              ready ? styles.dotReady : styles.dotBusy
            }`}
            aria-hidden="true"
          />
          <span className={styles.statusWord}>{statusWord}</span>
          {/* Screen-reader / e2e sentinel — preserves the literal text
           *  ~14 Playwright specs assert against. Visually hidden. */}
          <span className={styles.srOnly} data-testid="worker-status">
            {ready ? "workers ready" : "workers initialising"}
          </span>
        </div>
      </div>

      {/* Help cluster (iter2 #1, #5) — About + Keyboard shortcuts. The
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
