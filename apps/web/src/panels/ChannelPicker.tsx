// T4.2 channel picker popover: tree of sources → scalar channels with
// checkboxes. Kept as a dumb presentational component — PlotPanel owns
// the selection state and positions the popover via `anchorRect`.
//
// Intentionally minimal: no keyboard navigation beyond `Escape`, no
// search. Both are post-MVP per docs/06-ui-and-panels.md:13-14.

import { useEffect, useMemo, useRef } from "react";
import type { Channel, SourceMeta } from "../state/store";
import { colorFor } from "./palette";
import styles from "./ChannelPicker.module.css";

interface Props {
  sources: SourceMeta[];
  selectedIds: string[];
  maxSelected: number;
  anchorRect: DOMRect | null;
  onToggle: (channelId: string) => void;
  onClose: () => void;
}

function labelFor(c: Channel): string {
  return c.unit ? `${c.name} (${c.unit})` : c.name;
}

export function ChannelPicker({
  sources,
  selectedIds,
  maxSelected,
  anchorRect,
  onToggle,
  onClose,
}: Props) {
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const atCap = selectedIds.length >= maxSelected;
  const rootRef = useRef<HTMLDivElement | null>(null);

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

  const style = anchorRect
    ? ({
        position: "fixed",
        top: anchorRect.bottom + 4,
        left: anchorRect.left,
      } as const)
    : undefined;

  const sourcesWithScalars = sources
    .map((s) => ({
      source: s,
      channels: s.channels.filter((c) => c.kind === "scalar"),
    }))
    .filter((g) => g.channels.length > 0);

  return (
    <div
      ref={rootRef}
      className={styles.popover}
      style={style}
      role="dialog"
      aria-label="Add channel"
      data-testid="plot-channel-picker"
    >
      {sourcesWithScalars.length === 0 ? (
        <p className={styles.empty}>No scalar channels loaded.</p>
      ) : (
        <div className={styles.tree}>
          {sourcesWithScalars.map(({ source, channels }) => (
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
                          {labelFor(c)}
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
