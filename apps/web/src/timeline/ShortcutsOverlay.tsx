// Transport · Keyboard shortcuts help overlay.
//
// Plain non-portal dialog so the overlay stays scoped to the bar's
// stacking context (no escaped Tab order). Purely presentational —
// the global keydown handler in Transport.tsx is the single source
// of truth for what each key does. If you add a binding there, add
// a row here.

import { useEffect, useRef } from "react";
import s from "./ShortcutsOverlay.module.css";

interface Shortcut {
  keys: string[];
  label: string;
}

const SHORTCUTS: readonly Shortcut[] = [
  { keys: ["Space", "K"], label: "Play / pause" },
  { keys: ["J"], label: "Step back 1 s (VLC)" },
  { keys: ["L"], label: "Step forward 1 s (VLC)" },
  { keys: ["←"], label: "Step back 1 s" },
  { keys: ["→"], label: "Step forward 1 s" },
  { keys: ["Home"], label: "Jump to start" },
  { keys: ["End"], label: "Jump to end" },
  { keys: ["?"], label: "Toggle this help" },
] as const;

interface Props {
  onClose: () => void;
}

export function ShortcutsOverlay({ onClose }: Props) {
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Focus the card on open so Escape (and screen-readers) anchor in
  // the dialog.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  // Escape closes the overlay. Bound here (not in Transport) so a
  // stale closure can't fire after unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
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
      data-testid="transport-shortcuts-overlay"
      onClick={(e) => {
        // Click outside the card closes. Inside-card clicks bubble
        // here but with currentTarget !== target.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={cardRef}
        className={s.card}
        role="dialog"
        aria-label="Transport keyboard shortcuts"
        aria-modal="true"
        tabIndex={-1}
      >
        <div className={s.header}>
          <span className={s.title}>Keyboard shortcuts</span>
          <button
            type="button"
            className={s.closeBtn}
            data-testid="transport-shortcuts-close"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            ×
          </button>
        </div>
        <ul className={s.list}>
          {SHORTCUTS.map((sc) => (
            <li key={sc.label} className={s.row}>
              <span className={s.keys}>
                {sc.keys.map((k, i) => (
                  <span key={k} className={s.kbd}>
                    {i > 0 ? <span className={s.or}>or</span> : null}
                    <kbd className={s.key}>{k}</kbd>
                  </span>
                ))}
              </span>
              <span className={s.label}>{sc.label}</span>
            </li>
          ))}
        </ul>
        <p className={s.hint}>
          Shortcuts are ignored while typing in an input or text area.
        </p>
      </div>
    </div>
  );
}
