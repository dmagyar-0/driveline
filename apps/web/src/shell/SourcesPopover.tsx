// UX overhaul (issue #17) · Sources popover.
//
// Triggered from the topbar's "N sources" chip. Renders a compact list
// of loaded sources with a per-row palette swatch, type icon, name,
// kind badge, channel count, time range, and a remove affordance — so
// the user can audit and prune the loaded session without opening the
// Sources drawer.
//
// iter3 #1 — popover scales beyond two sources:
//   - Text input at the top filters the list by name (case-insensitive
//     substring match). Filtering preserves the active sort.
//   - Sort toggle (Name / Type / Duration) — three small pill buttons,
//     default Name. Sort is local state (no store touch).
//   - When ≥3 sources are loaded AND the type mix is heterogeneous,
//     rows are grouped under small subheading rows (MCAP / MF4 / MP4)
//     within each section, sorted internally by the active sort.
//   - Filter-empty state: "No sources match \"<query>\"".
//   - "Clear all" demoted to a small secondary-text affordance so the
//     "Open Sources panel" link reads as the primary navigation target.
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
//
// Closes on outside click, on Escape, on selecting an action, or when
// the trigger loses the `aria-expanded` toggle.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { SourceKind, SourceMeta } from "../state/store";
import { colorFor } from "../panels/palette";
import { formatDuration } from "../timeline/formatTime";
import s from "./SourcesPopover.module.css";

type SortKey = "name" | "type" | "duration";

function kindLabel(k: SourceKind): "MCAP" | "MF4" | "MP4" {
  if (k === "mcap") return "MCAP";
  if (k === "mf4") return "MF4";
  return "MP4";
}

// Order used both for the "Type" sort and for the order in which type
// subheadings render when grouping is active. Keeps MCAP/MF4 signal
// formats above MP4 video sources.
const KIND_ORDER: readonly SourceKind[] = ["mcap", "mf4", "mp4+sidecar"];

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

function sortSources(list: SourceMeta[], key: SortKey): SourceMeta[] {
  const copy = list.slice();
  if (key === "name") {
    copy.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  } else if (key === "type") {
    copy.sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a.kind);
      const bi = KIND_ORDER.indexOf(b.kind);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  } else {
    // duration — longest first; users usually scan for the "main"
    // session, which is the longest source in mixed loads.
    copy.sort((a, b) => {
      const ad = a.timeRange.endNs - a.timeRange.startNs;
      const bd = b.timeRange.endNs - b.timeRange.startNs;
      if (bd > ad) return 1;
      if (bd < ad) return -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }
  return copy;
}

interface Row {
  type: "row";
  src: SourceMeta;
}
interface Heading {
  type: "heading";
  kind: SourceKind;
  count: number;
}
type Item = Row | Heading;

/** Turn the filtered/sorted list into the flat render items. Inserts
 *  per-kind subheadings when the list has ≥3 sources AND the type mix
 *  is heterogeneous. With a single kind, headings would be visual
 *  noise so we skip them. */
function withGroupHeadings(list: SourceMeta[]): Item[] {
  if (list.length < 3) return list.map((src) => ({ type: "row", src }) as Row);
  const kinds = new Set(list.map((s) => s.kind));
  if (kinds.size < 2) {
    return list.map((src) => ({ type: "row", src }) as Row);
  }
  // Bucket per kind, in canonical KIND_ORDER, preserving the within-
  // bucket order the caller already produced (so the active sort still
  // works inside each group).
  const out: Item[] = [];
  for (const kind of KIND_ORDER) {
    const bucket = list.filter((s) => s.kind === kind);
    if (bucket.length === 0) continue;
    out.push({ type: "heading", kind, count: bucket.length });
    for (const src of bucket) out.push({ type: "row", src });
  }
  return out;
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

  // Search + sort are popover-local — no store touch. Both reset
  // implicitly when the popover unmounts (open === false).
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");

  // Clear the query when the popover (re)opens so it doesn't surprise
  // the user with a stale filter from a previous session.
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

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

  const trimmed = query.trim().toLowerCase();
  const filteredSorted = useMemo(() => {
    const filtered =
      trimmed.length === 0
        ? sources
        : sources.filter((src) => src.name.toLowerCase().includes(trimmed));
    return sortSources(filtered, sortKey);
  }, [sources, trimmed, sortKey]);

  const items = useMemo(
    () => withGroupHeadings(filteredSorted),
    [filteredSorted],
  );

  if (!open) return null;

  const sortButtons: { key: SortKey; label: string }[] = [
    { key: "name", label: "Name" },
    { key: "type", label: "Type" },
    { key: "duration", label: "Duration" },
  ];

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

      {/* Search + sort live above the list. We always render them when
       *  there is at least one source so the controls don't pop in
       *  after a filter zeroes the list. They stay hidden when no
       *  sources are loaded at all to avoid a confusing empty UI. */}
      {sources.length > 0 ? (
        <div className={s.controls}>
          <div className={s.searchWrap}>
            <svg
              className={s.searchIcon}
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5l3 3" />
            </svg>
            <input
              type="text"
              className={s.searchInput}
              placeholder="Filter sources"
              aria-label="Filter sources by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              data-testid="sources-popover-search"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className={s.sortGroup} role="group" aria-label="Sort sources">
            {sortButtons.map((b) => {
              const active = sortKey === b.key;
              return (
                <button
                  key={b.key}
                  type="button"
                  className={`${s.sortBtn} ${active ? s.sortBtnActive : ""}`}
                  aria-pressed={active}
                  onClick={() => setSortKey(b.key)}
                  data-testid={`sources-popover-sort-${b.key}`}
                  title={`Sort by ${b.label}`}
                >
                  {b.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {sources.length === 0 ? (
        <p className={s.empty}>
          No sources loaded. Drop an .mcap, .mf4, or .mp4 to begin.
        </p>
      ) : filteredSorted.length === 0 ? (
        <p className={s.empty} data-testid="sources-popover-filter-empty">
          No sources match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <ul className={s.list}>
          {items.map((item) => {
            if (item.type === "heading") {
              return (
                <li
                  key={`heading-${item.kind}`}
                  className={s.groupHeading}
                  role="presentation"
                  data-testid={`sources-popover-group-${item.kind}`}
                >
                  <span className={s.groupHeadingLabel}>
                    {kindLabel(item.kind)}
                  </span>
                  <span className={s.groupHeadingCount}>{item.count}</span>
                </li>
              );
            }
            const src = item.src;
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
          // iter3 #1 — demoted to a small secondary-coloured text
          // button so it doesn't read as equal weight to the primary
          // "Open Sources panel" link above.
          <button
            type="button"
            className={s.clearBtn}
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
