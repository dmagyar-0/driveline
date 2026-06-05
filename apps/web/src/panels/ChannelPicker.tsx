// T4.2 channel picker popover: tree of sources → scalar channels with
// checkboxes. Kept as a dumb presentational component — PlotPanel owns
// the selection state and positions the popover via `anchorRect`.
//
// Intentionally minimal: no keyboard navigation beyond `Escape`, no
// search. Both are post-MVP per docs/06-ui-and-panels.md:13-14.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChannelKind, SourceMeta } from "../state/store";
import { useSession } from "../state/store";
import { channelLabel } from "../state/units";
import { colorFor } from "./palette";
import styles from "./ChannelPicker.module.css";

// Default to scalar-only so existing callers (PlotPanel, Table/Value/Scene/Map
// drawers) keep their behaviour. Panels that admit other kinds — EnumPanel,
// which renders genuine `enum`-kind code series — pass an explicit set.
const DEFAULT_KINDS: readonly ChannelKind[] = ["scalar"];

interface Props {
  sources: SourceMeta[];
  selectedIds: string[];
  maxSelected: number;
  anchorRect: DOMRect | null;
  onToggle: (channelId: string) => void;
  onClose: () => void;
  // Which channel kinds the picker offers. Defaults to `["scalar"]`.
  kinds?: readonly ChannelKind[];
}

export function ChannelPicker({
  sources,
  selectedIds,
  maxSelected,
  anchorRect,
  onToggle,
  onClose,
  kinds = DEFAULT_KINDS,
}: Props) {
  const unitOverrides = useSession((st) => st.unitOverrides);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const atCap = selectedIds.length >= maxSelected;
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Resolved on-screen position. `null` until measured so the first paint
  // doesn't flash the popover at an off-screen anchor position.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Close on outside click and Escape. Listeners scoped to document so
  // the popover doesn't need to capture every click that falls inside
  // the panel.
  useEffect(() => {
    const onDocDown = (e: MouseEvent) => {
      const root = rootRef.current;
      if (!root) return;
      if (e.target instanceof Node && !root.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp the popover into the viewport once it's measured. The add
  // button often sits at the right edge of a right-docked panel, so a
  // naive `left: anchorRect.left` ran the popover off-screen (its
  // min-width is 18rem). Prefer opening below-and-left-aligned to the
  // button, but flip to right-aligned / above when that would overflow,
  // then hard-clamp with an 8px viewport margin as a final guard.
  useLayoutEffect(() => {
    if (!anchorRect) {
      setPos(null);
      return;
    }
    const margin = 8;
    const gap = 4;
    const el = rootRef.current;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el?.offsetWidth ?? 0;
    const h = el?.offsetHeight ?? 0;

    let left = anchorRect.left;
    if (left + w > vw - margin) {
      // Right-align to the button so it grows back toward screen centre.
      left = anchorRect.right - w;
    }
    left = Math.max(margin, Math.min(left, vw - w - margin));

    let top = anchorRect.bottom + gap;
    if (top + h > vh - margin && anchorRect.top - gap - h >= margin) {
      // Not enough room below — flip above the button.
      top = anchorRect.top - gap - h;
    }
    top = Math.max(margin, Math.min(top, vh - h - margin));

    setPos({ top, left });
  }, [anchorRect, sources]);

  const style = anchorRect
    ? ({
        position: "fixed",
        // Before measurement, keep it invisible at the raw anchor point so
        // its natural size can be read without a visible mispositioned flash.
        top: pos?.top ?? anchorRect.bottom + 4,
        left: pos?.left ?? anchorRect.left,
        visibility: pos ? "visible" : "hidden",
      } as const)
    : undefined;

  const kindSet = useMemo(() => new Set(kinds), [kinds]);
  const sourcesWithChannels = sources
    .map((s) => ({
      source: s,
      channels: s.channels.filter((c) => kindSet.has(c.kind)),
    }))
    .filter((g) => g.channels.length > 0);
  // Label the empty state for what the picker actually offers.
  const kindLabel = kinds.length === 1 ? `${kinds[0]} ` : "";

  return (
    <div
      ref={rootRef}
      className={styles.popover}
      style={style}
      role="dialog"
      aria-label="Add channel"
      data-testid="plot-channel-picker"
    >
      {sourcesWithChannels.length === 0 ? (
        <p className={styles.empty}>No {kindLabel}channels loaded.</p>
      ) : (
        <div className={styles.tree}>
          {sourcesWithChannels.map(({ source, channels }) => (
            <details key={source.id} open className={styles.group}>
              <summary className={styles.groupHeader}>
                <span className={styles.sourceName}>{source.name}</span>
                <span className={styles.sourceKind}>{source.kind}</span>
              </summary>
              <ul className={styles.channelList}>
                {channels.map((c) => {
                  const checked = selected.has(c.id);
                  const disabled = !checked && atCap;
                  return (
                    <li key={c.id}>
                      <label
                        className={`${styles.channelRow} ${
                          disabled ? styles.rowDisabled : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => onToggle(c.id)}
                          data-testid={`pick-${c.id}`}
                        />
                        <span
                          className={styles.swatch}
                          style={{ background: colorFor(c.id) }}
                          aria-hidden
                        />
                        <span className={styles.channelName}>
                          {channelLabel(c, unitOverrides)}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      )}
      <footer className={styles.footer} data-testid="picker-count">
        {selectedIds.length} / {maxSelected} selected
      </footer>
    </div>
  );
}
