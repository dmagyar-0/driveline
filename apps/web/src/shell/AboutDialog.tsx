// UX overhaul iter2 (issue #1) · About dialog.
//
// The "v0.1" version string used to sit in the top bar's brand zone,
// which made the production chrome look like a debug build. We moved
// the version into this small About modal. The dialog is opened from
// the small info button now adjacent to the wordmark (the topbar owns
// the trigger; this component is purely the modal surface).
//
// Plain non-portal dialog so it stays inside the topbar's stacking
// context. Closes on outside click, Escape, or the explicit close
// button.

import { useEffect, useRef } from "react";
import s from "./AboutDialog.module.css";

// Version string. Bumped alongside the package.json version when we
// cut a release. Kept here (not pulled from package.json) so the
// bundle doesn't drag in a JSON loader for a single string.
export const APP_VERSION = "v0.1";

interface Props {
  onClose: () => void;
  /** Optional: opens the keyboard-shortcuts overlay when clicked.
   *  Wired only when the topbar's `?` button is also wired. */
  onOpenShortcuts?: () => void;
}

export function AboutDialog({ onClose, onOpenShortcuts }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus the card on open so Escape and AT anchor inside the dialog.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={s.backdrop}
      data-testid="about-dialog"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={s.card}
        role="dialog"
        aria-label="About Driveline"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className={s.header}>
          <span className={s.title}>Driveline</span>
          <button
            type="button"
            className={s.closeBtn}
            data-testid="about-close"
            onClick={onClose}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        <dl className={s.meta}>
          <div className={s.metaRow}>
            <dt>Version</dt>
            <dd data-testid="about-version">{APP_VERSION}</dd>
          </div>
          <div className={s.metaRow}>
            <dt>Build</dt>
            <dd>Browser-first multimodal log viewer</dd>
          </div>
        </dl>

        <ul className={s.links}>
          <li>
            <a
              href="https://github.com/commaai/driveline#readme"
              target="_blank"
              rel="noopener noreferrer"
              className={s.link}
            >
              Documentation &amp; README
            </a>
          </li>
          {onOpenShortcuts ? (
            <li>
              <button
                type="button"
                className={s.linkBtn}
                data-testid="about-open-shortcuts"
                onClick={() => {
                  onOpenShortcuts();
                  onClose();
                }}
              >
                Keyboard shortcuts
              </button>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
