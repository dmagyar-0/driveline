// Shared modal-dialog primitive (SHELL-02). Consolidates the scrim +
// `role="dialog"` / `aria-modal` envelope, Escape-to-close, optional
// scrim-click-to-close, and a real focus-trap that were previously
// copy-pasted across ~6 dialogs/overlays — none of which trapped focus.
//
// Each dialog still renders its own card (a `<div>` or `<form>`) as children
// and keeps its own CSS Module styles; `Dialog` only owns the surrounding
// scrim element and the focus/keyboard mechanics. CSS Modules only — the
// scrim styling lives in `Dialog.module.css` (identical to the per-dialog
// `.scrim` rules it replaces).
//
// Accessibility, preserved + improved:
//   - `role="dialog"` + `aria-modal="true"` (unchanged).
//   - Escape closes (via `useEscape`), suppressible with `escapeEnabled`
//     for in-flight runs (mirrors the old `!busy && !escapeLocked` guards).
//   - NEW: Tab/Shift+Tab are trapped within the dialog, and focus is restored
//     to the previously-focused element on unmount.
//   - Initial focus lands on `initialFocusRef` if given, else the first
//     focusable element in the dialog (so each dialog's existing focus target
//     is preserved).

import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import { useEscape } from "./useEscape";
import styles from "./Dialog.module.css";

export interface DialogProps {
  children: ReactNode;
  /** Fired on Escape and (if `closeOnScrimClick`) a scrim click. */
  onClose: () => void;
  /** When `false`, Escape does not close (e.g. an in-flight run). Default true. */
  escapeEnabled?: boolean;
  /** Close when the backdrop (outside the card) is clicked. Default false. */
  closeOnScrimClick?: boolean;
  /** Accessible name as a literal string (`aria-label`). */
  ariaLabel?: string;
  /** Accessible name by id reference (`aria-labelledby`). */
  ariaLabelledBy?: string;
  /** Where to land focus on mount; falls back to the first focusable element. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /**
   * When `false`, `Dialog` does NOT move focus on mount — the caller owns
   * initial focus (e.g. a dialog whose focus target depends on local state).
   * Focus restoration on unmount and the Tab focus-trap still apply. Default
   * `true`.
   */
  manageInitialFocus?: boolean;
  /** Test seam on the scrim element (the previous dialogs' `data-testid`). */
  "data-testid"?: string;
  /** Extra class on the scrim element (e.g. a higher z-index variant). */
  scrimClassName?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisible(el: HTMLElement): boolean {
  // Skip elements removed from layout (`display: none`) or hidden — they can't
  // take focus in a browser. Computed-style is used (rather than
  // `offsetParent`) so the check also holds under jsdom, which never lays out.
  if (el.hidden) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(isVisible);
}

export function Dialog({
  children,
  onClose,
  escapeEnabled = true,
  closeOnScrimClick = false,
  ariaLabel,
  ariaLabelledBy,
  initialFocusRef,
  manageInitialFocus = true,
  "data-testid": dataTestId,
  scrimClassName,
}: DialogProps) {
  const scrimRef = useRef<HTMLDivElement | null>(null);

  useEscape(onClose, escapeEnabled);

  // Initial focus + focus restoration. Runs once on mount: land focus on the
  // requested target (or the first focusable element) unless the caller owns
  // initial focus, then restore focus to whatever was focused before the
  // dialog opened when it unmounts.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (manageInitialFocus) {
      const target =
        initialFocusRef?.current ??
        (scrimRef.current ? focusableWithin(scrimRef.current)[0] : undefined);
      target?.focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
    // Mount-once: the dialogs remount (via `key`) when their identity changes,
    // so we deliberately do not re-run on ref churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trap Tab / Shift+Tab inside the dialog so keyboard focus can't escape to
  // the page behind the scrim.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const root = scrimRef.current;
    if (!root) return;
    const focusables = focusableWithin(root);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !root.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !root.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={scrimRef}
      className={
        scrimClassName ? `${styles.scrim} ${scrimClassName}` : styles.scrim
      }
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      data-testid={dataTestId}
      onClick={closeOnScrimClick ? onClose : undefined}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
