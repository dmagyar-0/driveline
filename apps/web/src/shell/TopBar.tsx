// Top bar layout: [brand | session-title (centre) | status | divider | help].
//
// E2e contract: a hidden element with `data-testid="worker-status"` and
// the literal text `workers ready` MUST exist when `ready === true` —
// ~14 specs assert on it. The sentinel stays mounted unconditionally
// (visually-hidden) so the auto-hide of the visible chip cannot break
// the contract.

import { useEffect, useId, useRef, useState } from "react";
import { useSession } from "../state/store";
import { SourcesPopover } from "./SourcesPopover";
import { AboutDialog } from "./AboutDialog";
import { ShortcutsOverlay } from "../timeline/ShortcutsOverlay";
import { formatDurationCoarse } from "../timeline/formatTime";
import styles from "./TopBar.module.css";

// Ready chip fades after this idle window. Any new activity (load, error,
// re-init) re-shows it.
const READY_CHIP_IDLE_TIMEOUT_MS = 5_000;

export interface TopBarProps {
  ready: boolean;
  /** Unused by the rendered tree; kept optional so Shell's wiring
   *  compiles untouched. Remove in a follow-up sweep. */
  onOpenSourcesDrawer?: () => void;
}

// `degraded` = at least one source loaded but `lastOpenErrors` is non-empty
// (partial-but-usable). `error` = errors pending with zero sources loaded.
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

export function TopBar({ ready }: TopBarProps) {
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

  const errorCount = lastOpenErrors.length;
  const status = deriveStatus(ready, sourceCount, errorCount);
  const statusWord = STATUS_WORD[status];

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

  // Only `ready` auto-hides; loading/degraded/error stay sticky so failure
  // modes are not missed. The hidden e2e sentinel below is unaffected.
  const [statusVisible, setStatusVisible] = useState(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setStatusVisible(true);
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

        {/* Failure-state flyout: outside-click + Escape do NOT dismiss —
         *  the toggle button is the only way to collapse it. */}
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

        {/* E2e sentinel — ~14 Playwright specs assert on this literal text.
         *  Lives OUTSIDE the auto-hiding chip so the contract holds even
         *  after the visible chip fades. */}
        <span className={styles.srOnly} data-testid="worker-status">
          {ready ? "workers ready" : "workers initialising"}
        </span>
      </div>

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
