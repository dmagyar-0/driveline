// Phase 1 · Top bar — brand + session identity + right-aligned meta.
//
// Redesign (claude.ai/design handoff): a 48px instrument bar with the
// brand mark + wordmark, a session block (source count + source-kind
// chips) that appears once files are loaded, and a right cluster with
// the live cursor clock, a worker-status dot, and a keyboard-shortcuts
// button.
//
// The `data-testid="worker-status"` span text is load-bearing for 8 e2e
// specs (smoke, sourcesDrawer, videoSeek, …) — it must read exactly
// `workers ready` / `workers initialising`. Don't rename or retext it.

import { useState } from "react";
import { useSession } from "../state/store";
import type { SourceKind } from "../state/store";
import { formatRelative } from "../timeline/formatTime";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import styles from "./TopBar.module.css";

export interface TopBarProps {
  ready: boolean;
}

function kindLabel(k: SourceKind): "MCAP" | "MF4" | "MP4+TS" {
  if (k === "mcap") return "MCAP";
  if (k === "mf4") return "MF4";
  return "MP4+TS";
}

export function TopBar({ ready }: TopBarProps) {
  // Single-key selectors only (frontend skill). cursorNs ticks every
  // rAF during playback — keep its subscriber narrow.
  const cursorNs = useSession((s) => s.cursorNs);
  const startNs = useSession((s) => s.globalRange?.startNs ?? null);
  const sources = useSession((s) => s.sources);
  const [showShortcuts, setShowShortcuts] = useState(false);

  const sourceCount = sources.length;
  const hasSession = sourceCount > 0;

  // Distinct source kinds, first-seen order, for the chip row.
  const kinds: SourceKind[] = [];
  for (const src of sources) if (!kinds.includes(src.kind)) kinds.push(src.kind);

  return (
    <header className={styles.bar}>
      <div className={styles.brand}>
        <img
          className={styles.logo}
          src="/brand/logo.svg"
          width={24}
          height={24}
          alt=""
          aria-hidden="true"
        />
        <span className={styles.wordmark}>driveline</span>
      </div>

      {hasSession && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <div className={styles.session} data-testid="topbar-session">
            <span className={styles.sessionCount}>
              {sourceCount} source{sourceCount === 1 ? "" : "s"} loaded
            </span>
            <span className={styles.chips}>
              {kinds.map((k) => (
                <span key={k} className={styles.kindChip}>
                  {kindLabel(k)}
                </span>
              ))}
            </span>
          </div>
        </>
      )}

      <div className={styles.spacer} />

      <div className={styles.meta}>
        {startNs !== null && (
          <span
            className={`${styles.clock} tabular`}
            data-testid="topbar-clock"
          >
            {formatRelative(cursorNs, startNs)}
          </span>
        )}
        <span className={styles.status}>
          <span
            className={styles.statusDot}
            data-ok={ready ? "true" : "false"}
            aria-hidden="true"
          />
          <span className={styles.workerStatus} data-testid="worker-status">
            {ready ? "workers ready" : "workers initialising"}
          </span>
        </span>
      </div>

      <button
        type="button"
        className={styles.iconBtn}
        onClick={() => setShowShortcuts(true)}
        aria-label="Keyboard shortcuts"
        title="Keyboard shortcuts"
        data-testid="topbar-shortcuts"
      >
        <KeyboardIcon />
      </button>

      {showShortcuts && (
        <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
      )}
    </header>
  );
}

function KeyboardIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    </svg>
  );
}
