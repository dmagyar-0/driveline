// UX overhaul (issue #17) · Sources popover.
//
// Triggered from the topbar's "N sources" chip. Renders a compact list
// of loaded sources with a per-row palette swatch, type icon, name,
// kind badge, channel count, time range, and a remove affordance — so
// the user can audit and prune the loaded session without opening the
// Sources drawer.
//
// iter2 #4:
//   - Each row gets a small × button on the right. The store today
//     only exposes `clear()` (no per-source remove); we surface the
//     × disabled with a tooltip pointing at the Sources drawer.
//     TODO: when the store grows a `removeSource(id)` action, wire
//     this button to it (and drop the `disabled` attribute).
//   - Each row prints a "N channels" count next to the kind badge.
//   - The colour swatch already uses `palette.colorFor(src.id)` so it
//     matches the per-source palette colour the plot panel uses.
//     Width bumped from 4 px to 6 px to be legible at a glance.
//   - Drag-reorder is deferred — would require a store-shape change.
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
            const channelCount = src.channels.length;
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
                <div className={s.text}>
                  <span className={s.name} title={src.name}>
                    {src.name}
                  </span>
                  <span className={s.meta}>
                    <span className={s.kind}>{kindLabel(src.kind)}</span>
                    <span
                      className={s.channels}
                      title={`${channelCount} channels in this source`}
                    >
                      {channelCount}{" "}
                      {channelCount === 1 ? "channel" : "channels"}
                    </span>
                    <span className={s.duration} title="Duration">
                      {formatDuration(durationNs)}
                    </span>
                  </span>
                </div>
                {/* iter2 #4 — per-row × placeholder. The store does
                 *  not (today) expose a per-source unload action;
                 *  only `clear()` exists. We render the button
                 *  disabled so the affordance is discoverable and
                 *  the tooltip points the user at the Sources
                 *  drawer (which has the same limitation but is the
                 *  natural home for a future remove action).
                 *  TODO(driveline#removeSource): swap `disabled` for
                 *  an `onClick` that calls the store's per-source
                 *  remove action once it lands. */}
                <button
                  type="button"
                  className={s.removeBtn}
                  data-testid={`sources-popover-remove-${src.id}`}
                  disabled
                  aria-label={`Remove ${src.name}`}
                  title="Per-source remove lives in the Sources panel (coming soon)."
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
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
