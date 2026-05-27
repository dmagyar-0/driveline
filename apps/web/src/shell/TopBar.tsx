// UX overhaul (issues #15, #16, #17) · Top bar.
//
// Structure (post-iter5 #1):
//
//   [ brand | session-title (centre, grows) | status zone | divider | help ]
//
//   brand zone   — Driveline logo + wordmark. No version string,
//                  no hover treatment; it does not behave like a nav
//                  target. (iter2 #1 — version moved to About dialog.)
//   session zone — iter5 #1: filling the previously empty centre with a
//                  brief session identity:
//                    - 0 sources: hint "Drop a recording to begin".
//                    - 1 source: the file name and the duration (monospaced).
//                    - 2+ sources: "N sources" + the union duration.
//                  Centre-aligned, muted colour, truncates with ellipsis
//                  if the file name is long.
//   status zone  — sources chip (clickable — opens SourcesPopover),
//                  system status chip (semantic four-state, iter5 #2).
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
import { formatDurationCoarse } from "../timeline/formatTime";
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

// iter5 issue #2 — failure-mode status taxonomy.
//
// The status chip used to be a binary `ready` ↔ `initialising` flag.
// That communicated nothing on failure paths (decode crash, corrupt
// file, low-memory). We now derive a four-state semantic from existing
// store flags (no store-shape change):
//
//   loading   — workers booting, first sources still ingesting.
//   ready     — green; auto-hides 5 s after settling.
//   degraded  — open errors persist after at least one source loaded.
//   error     — open errors and no sources at all (load failed).
//
// `degraded` vs `error` is a soft heuristic: if any source DID load
// (so the user has something to look at) we show yellow `degraded`;
// if no source loaded but errors are pending, the session is in an
// `error` state. The chip surfaces an inline "Details" toggle that
// expands a small list of error names — wired to the same
// `lastOpenErrors` array the SourcesDrawer reads.
type DerivedStatus = "loading" | "ready" | "degraded" | "error";

function deriveStatus(
  ready: boolean,
  sourceCount: number,
  errorCount: number,
): DerivedStatus {
  if (!ready) return "loading";
  if (errorCount > 0) return sourceCount > 0 ? "degraded" : "error";
  return "ready";
}

const STATUS_WORD: Record<DerivedStatus, string> = {
  loading: "Initialising",
  ready: "Ready",
  degraded: "Degraded",
  error: "Error",
};

const STATUS_TITLE: Record<DerivedStatus, string> = {
  loading: "Workers initialising",
  ready: "All workers ready",
  degraded: "Some sources failed to load — session is partial",
  error: "Decode failed. No sources loaded.",
};

export function TopBar({ ready, onOpenSourcesDrawer }: TopBarProps) {
  // Single-key selectors only (frontend skill).
  const sourceCount = useSession((s) => s.sources.length);
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const lastOpenErrors = useSession((s) => s.lastOpenErrors);

  const sourceLabel = `${sourceCount} source${sourceCount === 1 ? "" : "s"}`;

  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const sourcesTriggerId = useId();

  // Derived status from the ready flag + any persistent open errors.
  // Kept as a single selector boundary so we don't widen the slice.
  const errorCount = lastOpenErrors.length;
  const status = deriveStatus(ready, sourceCount, errorCount);

  // Coalesce the visible status to a single semantic word; the hidden
  // sibling keeps the load-bearing e2e text.
  const statusWord = STATUS_WORD[status];

  // iter5 issue #1 — session-title summary. The text shown in the
  // top-bar centre is purely derived from `sources` + `globalRange`.
  // 0 sources → hint copy; 1 source → file name + duration; 2+ →
  // `N sources · duration`. Duration uses the coarse formatter
  // (HH:MM:SS), monospaced, so the eye latches onto it.
  let sessionPrimary = "";
  let sessionDuration = "";
  if (sourceCount === 1) {
    sessionPrimary = sources[0].name;
  } else if (sourceCount > 1) {
    sessionPrimary = `${sourceCount} sources`;
  }
  if (globalRange !== null) {
    sessionDuration = formatDurationCoarse(
      globalRange.endNs - globalRange.startNs,
    );
  }
  const sessionHint = sourceCount === 0 ? "Drop a recording to begin" : "";

  // iter3 #2 / iter5 #2 — the visible status chip auto-hides 5 s after
  // we settle into the *ready* state. Any other state (loading,
  // degraded, error) stays sticky — failure modes are the whole point
  // of the chip and the user needs to see them. The hidden e2e
  // sentinel below is unaffected.
  const [statusVisible, setStatusVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Always show the chip immediately on a state change.
    setStatusVisible(true);
    // Collapse any open error-detail panel when we leave the
    // degraded/error states so it doesn't dangle.
    if (status !== "degraded" && status !== "error") {
      setErrorDetailsOpen(false);
    }
    if (status === "ready") {
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
  }, [status]);

  // iter5 #2 — map derived status → CSS modifier so we don't ship four
  // boolean class twiddles in JSX.
  const statusClass =
    status === "ready"
      ? styles.statusReady
      : status === "loading"
        ? styles.statusBusy
        : status === "degraded"
          ? styles.statusDegraded
          : styles.statusError;
  const dotClass =
    status === "ready"
      ? styles.dotReady
      : status === "loading"
        ? styles.dotBusy
        : status === "degraded"
          ? styles.dotDegraded
          : styles.dotError;

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

      {/* Session zone (iter5 #1) — fills the previously empty centre with
       *  the current session identity. Pure-derived from `sources` +
       *  `globalRange`; no state changes. Truncates with ellipsis so a
       *  long filename never crowds the help cluster. */}
      <div
        className={styles.session}
        data-testid="topbar-session-title"
        aria-live="polite"
      >
        {sessionPrimary !== "" ? (
          <>
            <span
              className={styles.sessionPrimary}
              title={sessionPrimary}
              data-testid="topbar-session-primary"
            >
              {sessionPrimary}
            </span>
            {sessionDuration !== "" ? (
              <span
                className={styles.sessionDuration}
                data-testid="topbar-session-duration"
              >
                {sessionDuration}
              </span>
            ) : null}
          </>
        ) : (
          <span
            className={styles.sessionHint}
            data-testid="topbar-session-hint"
          >
            {sessionHint}
          </span>
        )}
      </div>

      {/* Status zone (issue #16, iter3 #2, iter5 #2) — sources + status
       *  chips share one pill shape and one baseline. The topbar cursor
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

        {/* The visible status chip (iter5 #2): four states share the same
         *  pill chrome with a colour-coded dot + word. Only `ready`
         *  auto-hides — loading / degraded / error are sticky because
         *  surfacing failures is the whole point. The error state adds
         *  a "Details" toggle that expands a list of recent error names. */}
        <div
          className={`${styles.statusChip} ${statusClass} ${statusVisible ? "" : styles.statusHidden}`}
          role="status"
          aria-live="polite"
          aria-hidden={statusVisible ? undefined : true}
          title={STATUS_TITLE[status]}
          data-testid="status-chip"
          data-status={status}
        >
          <span
            className={`${styles.statusDot} ${dotClass}`}
            aria-hidden="true"
          />
          <span className={styles.statusWord}>{statusWord}</span>
          {(status === "error" || status === "degraded") &&
          errorCount > 0 ? (
            <button
              type="button"
              className={styles.statusDetailsBtn}
              aria-expanded={errorDetailsOpen}
              aria-controls="status-details"
              onClick={() => setErrorDetailsOpen((v) => !v)}
              data-testid="status-details-toggle"
              title={`${errorCount} error${errorCount === 1 ? "" : "s"} — click to ${
                errorDetailsOpen ? "hide" : "show"
              } details`}
            >
              {errorDetailsOpen ? "Hide" : "Details"}
            </button>
          ) : null}
        </div>

        {/* Inline details flyout for the failure states. Anchored beneath
         *  the chip; outside-click and Escape do not dismiss it — the
         *  same toggle button collapses it. Wired to `lastOpenErrors` so
         *  it stays useful even before a richer per-channel decoder
         *  status lands in the store. */}
        {errorDetailsOpen &&
        (status === "error" || status === "degraded") &&
        lastOpenErrors.length > 0 ? (
          <div
            id="status-details"
            className={styles.statusDetails}
            role="region"
            aria-label="Recent open errors"
            data-testid="status-details"
          >
            <ul className={styles.statusDetailsList}>
              {lastOpenErrors.slice(0, 5).map((err, i) => (
                <li
                  key={`${err.name}-${i}`}
                  className={styles.statusDetailsRow}
                >
                  <span
                    className={styles.statusDetailsName}
                    title={err.name}
                  >
                    {err.name}
                  </span>
                  <span
                    className={styles.statusDetailsReason}
                    title={err.reason}
                  >
                    {err.reason}
                  </span>
                </li>
              ))}
              {lastOpenErrors.length > 5 ? (
                <li className={styles.statusDetailsMore}>
                  +{lastOpenErrors.length - 5} more in the Sources panel
                </li>
              ) : null}
            </ul>
          </div>
        ) : null}

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
