// Splitter handle for the left settings drawer.
//
// Lives as a flex sibling of the active drawer inside the `.host` wrapper
// (see `Drawer.tsx`). Dragging it widens / narrows the drawer; the host
// owns the live width so the drag is a local, churn-free preview and only
// the pointer-up (or a keyboard nudge) commits to the store.
//
// This is *not* the cursor hot path, but pointermove still fires fast, so
// the preview stays in React state on the host and the store write happens
// once per gesture — no localStorage thrash mid-drag.

import { useRef } from "react";
import { DRAWER_WIDTH_MIN, DRAWER_WIDTH_MAX } from "../state/persist/ui";
import styles from "./DrawerResizer.module.css";

const clamp = (px: number): number =>
  Math.round(Math.min(DRAWER_WIDTH_MAX, Math.max(DRAWER_WIDTH_MIN, px)));

// Keyboard nudge in px; Shift makes a coarser jump for fast travel.
const STEP = 16;
const STEP_COARSE = 48;

export interface DrawerResizerProps {
  /** Current (possibly mid-drag) drawer width in px. */
  width: number;
  /** Live width during a pointer drag — host reflects it without a store
   *  write. */
  onPreview: (px: number) => void;
  /** Final width to persist (pointer-up or a keyboard adjustment). */
  onCommit: (px: number) => void;
}

export function DrawerResizer({
  width,
  onPreview,
  onCommit,
}: DrawerResizerProps) {
  // Drag origin + the most recent previewed width. Refs (not state) so the
  // pointermove handler reads fresh values without re-binding listeners.
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const latestRef = useRef(width);
  latestRef.current = width;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore secondary buttons so a right-click doesn't start a drag.
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clamp(drag.startWidth + (e.clientX - drag.startX));
    onPreview(next);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    onCommit(latestRef.current);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? STEP_COARSE : STEP;
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
        next = clamp(width + step);
        break;
      case "ArrowLeft":
        next = clamp(width - step);
        break;
      case "Home":
        next = DRAWER_WIDTH_MIN;
        break;
      case "End":
        next = DRAWER_WIDTH_MAX;
        break;
      default:
        return;
    }
    e.preventDefault();
    onCommit(next);
  };

  return (
    <div
      className={styles.resizer}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize settings panel"
      aria-valuenow={width}
      aria-valuemin={DRAWER_WIDTH_MIN}
      aria-valuemax={DRAWER_WIDTH_MAX}
      tabIndex={0}
      data-testid="drawer-resizer"
      data-dragging={dragRef.current ? "true" : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    />
  );
}
