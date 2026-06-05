// Transient toast for drop/open ingest errors.
//
// `lastOpenErrors` only renders inside the Sources drawer, which is
// closed by default — so dropping an all-invalid batch (a lone `.mp4`
// with no `.mp4.timestamps` sidecar, an unknown extension, a malformed
// MCAP/MF4) gives ZERO visible feedback. This toast surfaces those
// errors in the main UI: it pops when `lastOpenErrors` becomes non-empty,
// summarises the failures, links to the Sources drawer for per-file
// detail, is dismissable, and auto-clears after a timeout.
//
// State comes from the one Zustand store via discrete selectors (no
// Context). The Sources-drawer detail view stays as the authoritative
// breakdown — this is the at-a-glance alert that points at it.

import { useEffect, useRef, useState } from "react";
import { useSession } from "../state/store";
import s from "./OpenErrorToast.module.css";

/** How long the toast stays up before auto-clearing the errors. */
export const OPEN_ERROR_TOAST_MS = 8000;

export function OpenErrorToast() {
  const errors = useSession((st) => st.lastOpenErrors);
  const dismissOpenErrors = useSession((st) => st.dismissOpenErrors);
  const setActiveRailTab = useSession((st) => st.setActiveRailTab);

  // Track which error batch we've already shown so re-renders that don't
  // change the errors don't restart the auto-clear timer. `lastOpenErrors`
  // is replaced wholesale per `openFiles`, so identity is a stable batch key.
  const shownRef = useRef<unknown>(null);
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (errors.length === 0) {
      // Errors cleared elsewhere (dismiss / new clean open) — hide.
      setVisible(false);
      shownRef.current = null;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }
    if (shownRef.current === errors) return; // same batch, timer already armed
    shownRef.current = errors;
    setVisible(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      // Auto-clear the store errors; the drawer detail view clears with it.
      dismissOpenErrors();
    }, OPEN_ERROR_TOAST_MS);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [errors, dismissOpenErrors]);

  if (!visible || errors.length === 0) return null;

  const count = errors.length;
  const summary =
    count === 1
      ? `Couldn't load ${errors[0].name}`
      : `Couldn't load ${count} files`;

  const onViewDetails = () => {
    // Open the Sources drawer where the per-file breakdown lives, but
    // leave the errors in place so the user can read them there.
    setActiveRailTab("sources");
    setVisible(false);
  };

  const onDismiss = () => {
    setVisible(false);
    dismissOpenErrors();
  };

  return (
    <div
      className={s.toast}
      role="alert"
      aria-live="assertive"
      data-testid="open-error-toast"
    >
      <div className={s.body}>
        <span className={s.title} data-testid="open-error-toast-summary">
          {summary}
        </span>
        <span className={s.detail} title={errors[0].reason}>
          {count === 1
            ? errors[0].reason
            : `${errors[0].name}: ${errors[0].reason}${
                count > 1 ? ` (+${count - 1} more)` : ""
              }`}
        </span>
      </div>
      <div className={s.actions}>
        <button
          type="button"
          className={s.detailsBtn}
          onClick={onViewDetails}
          data-testid="open-error-toast-details"
        >
          View details
        </button>
        <button
          type="button"
          className={s.dismissBtn}
          onClick={onDismiss}
          aria-label="Dismiss"
          data-testid="open-error-toast-dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
