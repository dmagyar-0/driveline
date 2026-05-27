// Chip overflow affordance — a `+N more` pill that opens a popover
// listing chips that didn't fit on screen. Only *hidden* chips move
// into the popover; the visible chip set stays as-is.
//
// Closes on outside click and Escape. The parent owns the open state
// so the popover can be torn down when the chip list changes
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
  /** Start index of the *first* hidden channel in the parent's
   *  bound-channel list, plus the total count — together they let
   *  each popover chip render its dash pattern consistent with the
   *  in-row chips. */
  hiddenStartIndex?: number;
  totalSeriesCount?: number;
  /** Per-channel L/R axis indicator for dual-axis plots. Optional;
   *  chips render without the badge when omitted. */
  axisSides?: Map<string, "" | "L" | "R">;
  /** Tint colour per channel for the L/R badge. */
  axisTints?: Map<string, string>;
}

export function ChipOverflow({
  hiddenChannels,
  badges,
  open,
  onToggle,
  onClose,
  onRemove,
  hiddenStartIndex,
  totalSeriesCount,
  axisSides,
  axisTints,
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
          {hiddenChannels.map((c, i) => (
            <ChannelChip
              key={c.id}
              channel={c}
              sourceBadge={badges.get(c.id) ?? ""}
              onRemove={onRemove}
              seriesIndex={
                typeof hiddenStartIndex === "number"
                  ? hiddenStartIndex + i
                  : undefined
              }
              seriesCount={totalSeriesCount}
              axisSide={axisSides?.get(c.id) ?? ""}
              axisTint={axisTints?.get(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
