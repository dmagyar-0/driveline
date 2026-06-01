// Persistent "Add panel" control for the drawer host.
//
// The Layout drawer already lists the six panel kinds, but adding a
// panel from anywhere else used to mean navigating to that tab first.
// This footer lives in `Drawer.tsx` below whichever drawer is open, so
// "add a new panel" is one click away no matter which side panel the
// user is in.
//
// The pop-up mirrors `ChannelPicker`'s mechanics — `position: fixed`
// anchored to the trigger, close on outside-click / Escape, measure then
// clamp into the viewport — but opens *above* the button by default
// because the footer sits at the bottom of the drawer.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import s from "./AddPanelMenu.module.css";

interface Props {
  /** Mint a new video panel. Owned by `App.tsx`'s `WorkspaceHandle`,
   *  forwarded through `Shell` → `Drawer`. */
  addVideoPanel: () => void;
  addPlotPanel: () => void;
  addScenePanel: () => void;
  addMapPanel: () => void;
  addTablePanel: () => void;
  addValuePanel: () => void;
  addEnumPanel: () => void;
}

interface PanelOption {
  label: string;
  testid: string;
  add: () => void;
}

export function AddPanelMenu({
  addVideoPanel,
  addPlotPanel,
  addScenePanel,
  addMapPanel,
  addTablePanel,
  addValuePanel,
  addEnumPanel,
}: Props) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  // Resolved on-screen position. `null` until measured so the first
  // paint doesn't flash the menu at an unclamped anchor point.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const options: readonly PanelOption[] = [
    { label: "Video", testid: "add-panel-video", add: addVideoPanel },
    { label: "Plot", testid: "add-panel-plot", add: addPlotPanel },
    { label: "3D scene", testid: "add-panel-scene", add: addScenePanel },
    { label: "Map", testid: "add-panel-map", add: addMapPanel },
    { label: "Table", testid: "add-panel-table", add: addTablePanel },
    { label: "Value", testid: "add-panel-value", add: addValuePanel },
    { label: "Enum", testid: "add-panel-enum", add: addEnumPanel },
  ];

  // Close on outside click and Escape while open. Escape returns focus
  // to the trigger so keyboard users don't lose their place.
  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!(e.target instanceof Node)) return;
      if (menuRef.current?.contains(e.target)) return;
      if (triggerRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Measure once open, then clamp into the viewport. Prefer opening
  // above the trigger (the footer hugs the drawer's bottom edge); flip
  // below only when there's no room above.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = triggerRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const margin = 8;
    const gap = 4;
    const el = menuRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;

    let left = anchor.left;
    left = Math.max(margin, Math.min(left, vw - w - margin));

    let top = anchor.top - gap - h;
    if (top < margin) {
      // No room above — open below the trigger instead.
      top = anchor.bottom + gap;
    }
    top = Math.max(margin, Math.min(top, vh - h - margin));

    setPos({ top, left });
  }, [open]);

  const choose = (add: () => void) => {
    add();
    setOpen(false);
  };

  return (
    <div className={s.host}>
      <button
        ref={triggerRef}
        type="button"
        className={s.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="drawer-add-panel"
      >
        + Add panel
      </button>
      {open && (
        <div
          ref={menuRef}
          className={s.menu}
          role="menu"
          aria-label="Add panel"
          data-testid="drawer-add-panel-menu"
          style={
            pos
              ? { position: "fixed", top: pos.top, left: pos.left }
              : { position: "fixed", visibility: "hidden" }
          }
        >
          {options.map((o) => (
            <button
              key={o.testid}
              type="button"
              role="menuitem"
              className={s.item}
              onClick={() => choose(o.add)}
              data-testid={o.testid}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
