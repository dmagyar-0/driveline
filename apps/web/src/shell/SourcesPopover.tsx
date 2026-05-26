// UX overhaul (issue #17) · Sources popover.
//
// Triggered from the topbar's "N sources" chip. Renders a compact list
// of loaded sources with a per-row type icon, name, and time range, so
// the user can see what's loaded without opening the Sources drawer.
//
// Open state is local (the topbar owns the disclosure trigger), but the
// data is read from the existing Zustand store via selectors. The store
// does not (today) expose a per-source unload action — Phase 1 only has
// `clear()` — so the popover surfaces a "Clear all" CTA plus a hint to
// open the full drawer for per-source operations.
//
// Closes on outside click, on Escape, on selecting an action, or when
// the trigger loses the `aria-expanded` toggle.

import { useEffect, useRef } from "react";
import { useSession } from "../state/store";
import type { SourceKind } from "../state/store";
import { colorFor } from "../panels/palette";
import { formatDuration } from "../timeline/formatTime";
import s from "./SourcesPopover.module.css";

function kindLabel(k: SourceKind): "MCAP" | "MF4" | "MP4" {
  if (k === "mcap") return "MCAP";
  if (k === "mf4") return "MF4";
  return "MP4";
}

interface IconProps {
  kind: SourceKind;
}

function KindIcon({ kind }: IconProps) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (kind === "mp4+sidecar") {
    return (
      <svg {...common}>
        <rect x="1.5" y="4" width="9" height="8" rx="1" />
        <path d="M10.5 7l4-2v6l-4-2z" />
      </svg>
    );
  }
  // MCAP / MF4 — generic signal icon.
  return (
    <svg {...common}>
      <path d="M1.5 11l3-4 3 2 3-5 4 6" />
      <path d="M1.5 13.5h13" />
    </svg>
  );
}

export interface SourcesPopoverProps {
  open: boolean;
  onClose: () => void;
  /** Used to position the popover relative to its trigger. */
  anchorId: string;
  /** Opens the Sources drawer so the user can do per-source operations
   *  that the popover does not (yet) support. */
  onOpenDrawer: () => void;
}

export function SourcesPopover({
  open,
  onClose,
  anchorId,
  onOpenDrawer,
}: SourcesPopoverProps) {
  const sources = useSession((st) => st.sources);
  const clear = useSession((st) => st.clear);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      // Ignore clicks on the trigger itself — its own onClick toggles state.
      const trigger = document.getElementById(anchorId);
      if (trigger && target && trigger.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorId]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      className={s.popover}
      role="dialog"
      aria-label="Loaded sources"
      data-testid="sources-popover"
    >
      <div className={s.header}>
        <h2 className={s.heading}>Sources</h2>
        <span className={s.count}>{sources.length}</span>
      </div>

      {sources.length === 0 ? (
        <p className={s.empty}>
          No sources loaded. Drop an .mcap, .mf4, or .mp4 to begin.
        </p>
      ) : (
        <ul className={s.list}>
          {sources.map((src) => {
            const durationNs = src.timeRange.endNs - src.timeRange.startNs;
            return (
              <li
                key={src.id}
                className={s.row}
                data-testid={`sources-popover-row-${src.id}`}
              >
                <span
                  className={s.swatch}
                  style={{ background: colorFor(src.id) }}
                  aria-hidden="true"
                />
                <span className={s.kindIcon}>
                  <KindIcon kind={src.kind} />
                </span>
                <span className={s.name} title={src.name}>
                  {src.name}
                </span>
                <span className={s.kind}>{kindLabel(src.kind)}</span>
                <span className={s.duration} title="Duration">
                  {formatDuration(durationNs)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div className={s.actions}>
        <button
          type="button"
          className={s.linkBtn}
          onClick={() => {
            onOpenDrawer();
            onClose();
          }}
          data-testid="sources-popover-open-drawer"
        >
          Open Sources panel
        </button>
        {sources.length > 0 ? (
          <button
            type="button"
            className={s.dangerBtn}
            onClick={async () => {
              await clear();
              onClose();
            }}
            data-testid="sources-popover-clear"
          >
            Clear all
          </button>
        ) : null}
      </div>
    </div>
  );
}
