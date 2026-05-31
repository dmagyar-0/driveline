// Keyboard-shortcuts overlay, toggled from the TopBar. A full-window
// scrim listing the transport shortcuts; click the scrim, press the
// Close button, or hit Escape to dismiss. Chrome-only (no store reads).

import { useEffect } from "react";
import styles from "./ShortcutsOverlay.module.css";

export interface ShortcutsOverlayProps {
  onClose: () => void;
}

const SHORTCUTS: ReadonlyArray<{ keys: readonly string[]; label: string }> = [
  { keys: ["Space"], label: "Play / pause" },
  { keys: ["←", "→"], label: "Step ∓1 second" },
  { keys: ["Home", "End"], label: "Jump to start / end" },
];

export function ShortcutsOverlay({ onClose }: ShortcutsOverlayProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className={styles.scrim}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
      data-testid="shortcuts-overlay"
    >
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.title}>Keyboard shortcuts</h2>
        <dl className={styles.list}>
          {SHORTCUTS.map((s) => (
            <div key={s.label} className={styles.row}>
              <dt className={styles.keys}>
                {s.keys.map((k) => (
                  <kbd key={k} className={styles.kbd}>
                    {k}
                  </kbd>
                ))}
              </dt>
              <dd className={styles.desc}>{s.label}</dd>
            </div>
          ))}
        </dl>
        <button type="button" className={styles.dismiss} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
