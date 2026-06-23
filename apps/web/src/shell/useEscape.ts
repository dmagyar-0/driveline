// `useEscape` — window-level Escape-to-close, shared across the modal
// dialogs/overlays (SHELL-02). Consolidates the keydown listener that was
// copy-pasted into ~6 dialogs. Pass `enabled: false` to suspend the binding
// while a dialog is busy (e.g. a BYOK run in flight) without unmounting.

import { useEffect } from "react";

/**
 * Call `onEscape` when the user presses Escape. The listener is bound to
 * `window` (so it fires regardless of focus, matching the previous per-dialog
 * behaviour) and is removed on unmount. When `enabled` is `false` the listener
 * is not bound at all.
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onEscape, enabled]);
}
