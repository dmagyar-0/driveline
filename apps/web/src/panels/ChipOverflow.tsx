// Iter4 alignment item #5 — chip overflow affordance.
//
// Iter3 capped the `.chips` row at 48 px (≈2 rows) with `overflow-y:
// auto`, so additional chips silently disappeared below the visible
// frame — the audit's "bottom row clips with no +N more affordance"
// finding. This component renders a compact pill that opens a popover
// listing the chips that didn't fit on screen. The visible chip set
// stays as-is; only the *hidden* chips move into the popover so the
// user can see, scan, and remove them on demand.
//
// Layout shape:
//   - the pill (`+N more`) sits at the end of the chip row, same
//     vertical alignment as the chips themselves;
//   - clicking the pill toggles a popover anchored below it;
//   - the popover renders a vertical list of the hidden chips so they
//     can be scanned end-to-end without a horizontal scrollbar.
//
// Closes on outside click and on Escape. The parent owns the open
// state so the popover can be torn down when the chip list changes
// (e.g. the user removed a chip via the popover).

import { useEffect, useRef } from "react";
import { ChannelChip } from "./ChannelChip";
import type { Channel } from "../state/store";
import styles from "./PlotPanel.module.css";

export interface ChipOverflowProps {
  hiddenChannels: Channel[];
  badges: Map<string, string>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onRemove: (id: string) => void;
}

export function ChipOverflow({
  hiddenChannels,
  badges,
  open,
  onToggle,
  onClose,
  onRemove,
}: ChipOverflowProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on outside click + Escape. Mirrors the ChannelPicker
  // dismissal pattern so the panel surfaces feel consistent.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!wrapRef.current || !target) return;
      if (!wrapRef.current.contains(target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (hiddenChannels.length === 0) return null;

  return (
    <div ref={wrapRef} className={styles.chipOverflowWrap}>
      <button
        type="button"
        className={styles.chipOverflowPill}
        onClick={onToggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="plot-chips-overflow"
        title={`${hiddenChannels.length} more channel${
          hiddenChannels.length === 1 ? "" : "s"
        } in the bound set`}
      >
        +{hiddenChannels.length} more
      </button>
      {open && (
        <div
          className={styles.chipOverflowPopover}
          role="dialog"
          aria-label="Additional bound channels"
          data-testid="plot-chips-overflow-popover"
        >
          {hiddenChannels.map((c) => (
            <ChannelChip
              key={c.id}
              channel={c}
              sourceBadge={badges.get(c.id) ?? ""}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
