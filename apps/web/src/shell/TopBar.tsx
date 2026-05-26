// UX overhaul (issues #15, #16, #17) · Top bar.
//
// Structure:
//
//   [ brand zone | center spacer | status zone ]
//
//   brand zone   — Driveline logo + wordmark + version. No hover
//                  treatment; it does not behave like a nav target.
//   status zone  — labelled cursor readout, sources chip (clickable —
//                  opens SourcesPopover), system status chip.
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
  const sourcesTriggerId = useId();

  // Coalesce the visible status to a single semantic word; the hidden
  // sibling keeps the load-bearing e2e text.
  const statusWord = ready ? "Ready" : "Initialising";

  return (
    <header className={styles.bar} data-testid="topbar">
      {/* Brand zone (issue #15) — own bounded region, no hover state. */}
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
        <span className={styles.version} aria-hidden="true">
          v0.1
        </span>
      </div>

      {/* Status zone (issue #16) — three clearly-labelled controls. */}
      <div className={styles.status}>
        <div className={styles.cursor} title="Cursor (relative time)">
          <span className={styles.cursorLabel}>Cursor</span>
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

      <SourcesPopover
        open={sourcesOpen}
        anchorId={sourcesTriggerId}
        onClose={() => setSourcesOpen(false)}
        onOpenDrawer={onOpenSourcesDrawer}
      />
    </header>
  );
}
