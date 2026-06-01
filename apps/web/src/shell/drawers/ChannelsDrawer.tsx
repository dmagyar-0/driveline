// Phase 3 · Channels drawer.
//
// Replaces the inline `channels` stub in `Drawer.tsx`. Reads `channels`,
// `sources`, `selectedPanelId`, and the binding maps from the store via
// discrete single-key selectors so a re-render only fires when one of
// those changes. Search query and per-source collapsed state are local
// `useState` (no store coupling).
//
// Click-binding rules (from `v1-shell-integration.md` § Phase 3):
//   - If a panel is selected and it is a plot, append the channel via
//     `addPlotChannel`.
//   - If a panel is selected and it is a video, set the binding via
//     `setVideoBinding` (single-channel).
//   - If no panel is selected, call `ensurePlotPanel()` (provided by
//     `App.tsx`) to mint one, mark it selected, then bind.
//
// Drag-and-drop and source-scoped filtering are explicitly deferred per
// the integration plan.
//
// Performance (10k+ channels): the visible rows are *windowed* — only the
// slice intersecting the scroll viewport (plus a small overscan) is
// mounted, so the DOM stays O(viewport) instead of O(channels). Grouping
// reads `SourceMeta.channels` directly rather than re-filtering the flat
// `channels` array per source, and the search query is run through
// `useDeferredValue` so typing never blocks on the filter pass.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useSession,
  type Channel,
  type SourceMeta,
} from "../../state/store";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
import { panelKindOf } from "../../layout/panelId";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./ChannelsDrawer.module.css";

const HEADING_ID = "drawer-channels-h";

// Fixed row geometry for the windowed list. These must match the heights
// the CSS forces on `.vitem` wrappers (see ChannelsDrawer.module.css) so
// the cumulative offsets line up with what the browser actually lays out.
const SOURCE_HEADER_H = 34;
const CHANNEL_ROW_H = 30;
// Extra rows rendered above/below the viewport so a fast scroll doesn't
// flash blank before the next frame fills in.
const OVERSCAN = 8;

type Row =
  | { type: "header"; src: SourceMeta; count: number }
  | { type: "row"; channel: Channel };

interface Props {
  /** Returns the id of an existing or newly-created plot panel, or
   *  `null` if no panel could be created (e.g. workspace not yet
   *  mounted). The drawer calls this when the user clicks a channel
   *  while no panel is selected. */
  ensurePlotPanel: () => string | null;
}

// Largest index whose item *top* sits at or before `scrollTop`. `offsets`
// is a prefix-sum where `offsets[i]` is the top of item `i` and the final
// element is the total height, so this is a plain binary search.
function firstVisibleIndex(offsets: number[], scrollTop: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= scrollTop) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function ChannelsDrawer({ ensurePlotPanel }: Props) {
  const channels = useSession((st) => st.channels);
  const sources = useSession((st) => st.sources);
  const selectedPanelId = useSession((st) => st.selectedPanelId);
  const plotBindings = useSession((st) => st.plotBindings);
  const videoBindings = useSession((st) => st.videoBindings);

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // The input stays responsive (it tracks `query`), while the expensive
  // filter/window work below keys off the deferred value so a burst of
  // keystrokes doesn't queue a render per character.
  const deferredQuery = useDeferredValue(query);
  const q = deferredQuery.trim().toLowerCase();

  // Group by source straight off `SourceMeta.channels` — it already holds
  // the per-source list, so there's no need to scan the flat `channels`
  // array once per source (that was O(sources × channels)).
  const groups = useMemo(() => {
    const out: { src: SourceMeta; rows: Channel[] }[] = [];
    for (const src of sources) {
      const rows =
        q === ""
          ? src.channels
          : src.channels.filter((c) => c.name.toLowerCase().includes(q));
      if (rows.length > 0) out.push({ src, rows });
    }
    return out;
  }, [sources, q]);

  const filteredCount = useMemo(
    () => groups.reduce((n, g) => n + g.rows.length, 0),
    [groups],
  );

  // Flatten the visible (non-collapsed) tree into a single positioned list
  // plus a prefix-sum of tops. Both are O(visible rows) and only recompute
  // when the groups or collapsed set change — not on scroll.
  const { items, offsets, totalHeight } = useMemo(() => {
    const items: Row[] = [];
    const offsets: number[] = [0];
    let top = 0;
    for (const { src, rows } of groups) {
      items.push({ type: "header", src, count: rows.length });
      top += SOURCE_HEADER_H;
      offsets.push(top);
      if (collapsed[src.id] !== true) {
        for (const channel of rows) {
          items.push({ type: "row", channel });
          top += CHANNEL_ROW_H;
          offsets.push(top);
        }
      }
    }
    return { items, offsets, totalHeight: top };
  }, [groups, collapsed]);

  const selectedKind =
    selectedPanelId === null ? null : panelKindOf(selectedPanelId);
  const plotFull =
    selectedKind === "plot" &&
    selectedPanelId !== null &&
    (plotBindings[selectedPanelId]?.length ?? 0) >= MAX_PLOT_SERIES;

  const isBound = (channelId: string) => {
    if (selectedPanelId === null) return false;
    if (selectedKind === "plot") {
      return plotBindings[selectedPanelId]?.includes(channelId) ?? false;
    }
    if (selectedKind === "video") {
      return videoBindings[selectedPanelId] === channelId;
    }
    return false;
  };

  const onPick = (channelId: string) => {
    let panelId = selectedPanelId;
    if (panelId === null) {
      panelId = ensurePlotPanel();
      if (panelId === null) return;
      useSession.getState().setSelectedPanelId(panelId);
    }
    const kind = panelKindOf(panelId);
    if (kind === "plot") {
      useSession.getState().addPlotChannel(panelId, channelId);
    } else if (kind === "video") {
      useSession.getState().setVideoBinding(panelId, channelId);
    }
  };

  const toggleCollapse = (sourceId: string) =>
    setCollapsed((prev) => ({ ...prev, [sourceId]: !prev[sourceId] }));

  // --- Windowing: track the scroll container's scrollTop + height. ---
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    setViewportH(el.clientHeight);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    // Coalesce scroll → state to ≤1 per frame; a raw scroll handler can
    // fire many times per frame on a trackpad.
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (el !== null) setScrollTop(el.scrollTop);
    });
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // A new search collapses the list to a different shape; jump back to the
  // top so the user sees the first matches rather than a stale offset.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = 0;
    setScrollTop(0);
  }, [q]);

  let start = 0;
  let end = 0;
  if (viewportH > 0 && items.length > 0) {
    start = Math.max(0, firstVisibleIndex(offsets, scrollTop) - OVERSCAN);
    const bottom = scrollTop + viewportH;
    end = start;
    while (end < items.length && offsets[end] < bottom) end++;
    end = Math.min(items.length, end + OVERSCAN);
  }
  const visible = items.slice(start, end);

  return (
    <aside
      id={DRAWER_REGION_ID}
      className={drawerStyles.drawer}
      role="region"
      aria-labelledby={HEADING_ID}
      data-testid="drawer-channels"
    >
      <div className={drawerStyles.heading}>
        <h3 id={HEADING_ID}>Channels</h3>
        <span className={s.pill} data-testid="channels-count-pill">
          {filteredCount}
        </span>
      </div>

      <input
        type="search"
        className={s.search}
        placeholder="Filter channels…"
        aria-label="Filter channels by name"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="channels-search"
      />

      {channels.length === 0 ? (
        <p className={s.empty}>No channels loaded</p>
      ) : items.length === 0 ? (
        <p className={s.empty}>No channels match “{query}”</p>
      ) : (
        <div
          ref={scrollRef}
          className={s.scrollArea}
          onScroll={onScroll}
          data-testid="channels-groups"
        >
          <div
            className={s.spacer}
            style={{ height: totalHeight }}
            role="list"
          >
            {visible.map((item, i) => {
              const index = start + i;
              const top = offsets[index];
              if (item.type === "header") {
                const { src, count } = item;
                const listId = `drawer-channels-list-${src.id}`;
                const isCollapsed = collapsed[src.id] === true;
                return (
                  <div
                    key={`h-${src.id}`}
                    className={s.vitem}
                    style={{ top, height: SOURCE_HEADER_H }}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className={s.groupHeader}
                      aria-expanded={!isCollapsed}
                      aria-controls={listId}
                      onClick={() => toggleCollapse(src.id)}
                      data-testid={`channels-group-${src.id}`}
                    >
                      <span className={s.chevron} aria-hidden="true">
                        {isCollapsed ? "▸" : "▾"}
                      </span>
                      <span className={s.groupName} title={src.name}>
                        {src.name}
                      </span>
                      <span className={s.groupCount}>{count}</span>
                    </button>
                  </div>
                );
              }

              const { channel } = item;
              const bound = isBound(channel.id);
              const disabled =
                plotFull && selectedKind === "plot" && !bound;
              return (
                <div
                  key={channel.id}
                  className={s.vitem}
                  style={{ top, height: CHANNEL_ROW_H }}
                  role="listitem"
                >
                  <button
                    type="button"
                    className={`${s.row} ${bound ? s.rowActive : ""}`}
                    aria-pressed={bound}
                    aria-disabled={disabled || undefined}
                    title={
                      bound
                        ? "Already bound to this panel"
                        : disabled
                          ? `Plot full (${MAX_PLOT_SERIES})`
                          : undefined
                    }
                    onClick={() => {
                      if (disabled) return;
                      onPick(channel.id);
                    }}
                    data-testid={`channel-row-${channel.id}`}
                  >
                    <span
                      className={s.swatch}
                      style={{ background: colorFor(channel.id) }}
                      aria-hidden="true"
                    />
                    <span className={s.name} title={channel.name}>
                      {channel.name}
                    </span>
                    {channel.dtype !== null && (
                      <span className={s.kind}>{channel.dtype}</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </aside>
  );
}
