// About dialog · plain non-portal modal so it stays inside the topbar's
// stacking context. Closes on outside click, Escape, or close button.

import { useEffect, useRef } from "react";
import s from "./AboutDialog.module.css";

// Inlined (not read from package.json) to avoid pulling a JSON loader
// into the bundle for one string. Bump alongside `package.json`.
export const APP_VERSION = "v0.1";

interface Props {
  onClose: () => void;
  onOpenShortcuts?: () => void;
}

export function AboutDialog({ onClose, onOpenShortcuts }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus the card so Escape and AT anchor inside the dialog.
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
