// Channels drawer.
//
// Renders the loaded channels as a collapsible tree, one tree per source.
// The hierarchy is derived in `channelTree.ts`:
//   - MCAP topics split on `/` into nested levels.
//   - MF4 channels nest under their channel-group label, then their name.
//
// Reads `channels`, `sources`, `selectedPanelId`, and the binding maps from
// the store via discrete single-key selectors so a re-render only fires when
// one of those changes. Search query and per-node collapsed state are local
// `useState` (no store coupling).
//
// Search matches the full tree path (so typing a message prefix or an MF4
// group name keeps the whole subtree) and force-expands every branch while a
// query is active.
//
// Click-binding rules (from `v1-shell-integration.md` § Phase 3):
//   - If a panel is selected and it is a plot, append the channel via
//     `addPlotChannel`.
//   - If a panel is selected and it is a video, set the binding via
//     `setVideoBinding` (single-channel).
//   - If no panel is selected, call `ensurePlotPanel()` (provided by
//     `App.tsx`) to mint one, mark it selected, then bind.
//
// Performance (10k+ channels): the visible tree is *flattened* into a single
// positioned list (collapse-aware) and then *windowed* — only the slice
// intersecting the scroll viewport (plus a small overscan) is mounted, so the
// DOM stays O(viewport) instead of O(channels). The search query runs through
// `useDeferredValue` so typing never blocks on the filter + rebuild pass.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useSession, type Channel, type SourceMeta } from "../../state/store";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
import { setChannelDragData } from "../../panels/channelDrag";
import { panelKindOf } from "../../layout/panelId";
import {
  buildChannelTree,
  channelMatchesQuery,
  type ChannelTreeNode,
} from "./channelTree";
import drawerStyles from "../Drawer.module.css";
import { DRAWER_REGION_ID } from "../Drawer";
import s from "./ChannelsDrawer.module.css";

const HEADING_ID = "drawer-channels-h";

// Fixed row geometry for the windowed list. These must match the heights
// the CSS forces on `.vitem` wrappers (see ChannelsDrawer.module.css) so
// the cumulative offsets line up with what the browser actually lays out.
const SOURCE_HEADER_H = 34;
const BRANCH_ROW_H = 30;
const CHANNEL_ROW_H = 30;
// Extra rows rendered above/below the viewport so a fast scroll doesn't
// flash blank before the next frame fills in.
const OVERSCAN = 8;

type Row =
  | { type: "header"; src: SourceMeta; count: number }
  | {
      type: "branch";
      sourceId: string;
      node: ChannelTreeNode;
      depth: number;
      expanded: boolean;
    }
  | { type: "leaf"; channel: Channel; label: string; depth: number };

interface Props {
  /** Returns the id of an existing or newly-created plot panel, or
   *  `null` if no panel could be created (e.g. workspace not yet
   *  mounted). The drawer calls this when the user clicks a channel
   *  while no panel is selected. */
  ensurePlotPanel: () => string | null;
}

// Disclosure chevron for source-header and branch rows. The glyph points
// right when collapsed and the CSS rotates it to point down when the parent
// button reports `aria-expanded="true"` (see ChannelsDrawer.module.css).
// Driving orientation off the button's aria state keeps a single source of
// truth and lets the rotation animate as a cheap `transform`. Stroked SVG
// (matching the icon convention in `Rail.tsx`) reads far more clearly at this
// size than the Unicode triangle glyphs it replaces.
function Chevron() {
  return (
    <svg
      className={s.chevron}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
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
  // Collapsed keys. Branches default to expanded, so we only track the keys
  // the user has explicitly collapsed. Source rows key on `src.id`; tree
  // branches key on `${src.id}::${node.key}`.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  // The input stays responsive (it tracks `query`), while the expensive
  // filter/tree/window work below keys off the deferred value so a burst of
  // keystrokes doesn't queue a render per character.
  const deferredQuery = useDeferredValue(query);
  const q = deferredQuery.trim().toLowerCase();
  const queryActive = q !== "";

  const isExpanded = useCallback(
    (key: string) => queryActive || !collapsed.has(key),
    [queryActive, collapsed],
  );

  // Per source: the filtered channel set and its tree. Filtering matches the
  // full tree path (topic segments + MF4 group), so a group/message name
  // keeps its whole subtree.
  const groups = useMemo(() => {
    const out: { src: SourceMeta; tree: ChannelTreeNode[]; count: number }[] =
      [];
    for (const src of sources) {
      const rows = queryActive
        ? src.channels.filter((c) => channelMatchesQuery(c, deferredQuery))
        : src.channels;
      if (rows.length > 0) {
        out.push({ src, tree: buildChannelTree(rows), count: rows.length });
      }
    }
    return out;
  }, [sources, deferredQuery, queryActive]);

  const filteredCount = useMemo(
    () => groups.reduce((n, g) => n + g.count, 0),
    [groups],
  );

  // Flatten the visible (collapse-aware) tree into a single positioned list
  // plus a prefix-sum of tops. Both are O(visible rows) and only recompute
  // when the groups, collapsed set, or search state change — not on scroll.
  const { items, offsets, totalHeight } = useMemo(() => {
    const items: Row[] = [];
    const offsets: number[] = [0];
    let top = 0;
    const push = (row: Row, h: number) => {
      items.push(row);
      top += h;
      offsets.push(top);
    };

    const walk = (sourceId: string, nodes: ChannelTreeNode[], depth: number) => {
      for (const node of nodes) {
        if (node.children.length === 0 && node.channel !== null) {
          push(
            { type: "leaf", channel: node.channel, label: node.label, depth },
            CHANNEL_ROW_H,
          );
          continue;
        }
        const expanded = isExpanded(`${sourceId}::${node.key}`);
        push({ type: "branch", sourceId, node, depth, expanded }, BRANCH_ROW_H);
        if (expanded) {
          // A branch that is itself a bound channel (a topic that is also a
          // prefix of deeper topics) renders its own row first.
          if (node.channel !== null) {
            push(
              {
                type: "leaf",
                channel: node.channel,
                label: node.label,
                depth: depth + 1,
              },
              CHANNEL_ROW_H,
            );
          }
          walk(sourceId, node.children, depth + 1);
        }
      }
    };

    for (const { src, tree, count } of groups) {
      push({ type: "header", src, count }, SOURCE_HEADER_H);
      if (isExpanded(src.id)) walk(src.id, tree, 0);
    }
    return { items, offsets, totalHeight: top };
  }, [groups, isExpanded]);

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

  // Drag a channel onto a plot panel to bind it there. Only scalar channels
  // can land on a plot (the sole drop target today), so only scalar rows are
  // `draggable`; this guard is belt-and-braces for anything that slips
  // through. The drop side (PlotPanel) re-validates against the live store.
  const onDragStartChannel = (
    e: React.DragEvent<HTMLButtonElement>,
    channel: Channel,
  ) => {
    if (channel.kind !== "scalar") {
      e.preventDefault();
      return;
    }
    setChannelDragData(e.dataTransfer, channel.id);
  };

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

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
        aria-label="Filter channels by name or group"
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
          <div className={s.spacer} style={{ height: totalHeight }} role="list">
            {visible.map((item, i) => {
              const index = start + i;
              const top = offsets[index];

              if (item.type === "header") {
                const { src, count } = item;
                const listId = `drawer-channels-list-${src.id}`;
                const expanded = isExpanded(src.id);
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
                      aria-expanded={expanded}
                      aria-controls={listId}
                      onClick={() => toggleCollapse(src.id)}
                      data-testid={`channels-group-${src.id}`}
                    >
                      <Chevron />
                      <span className={s.groupName} title={src.name}>
                        {src.name}
                      </span>
                      <span className={s.groupCount}>{count}</span>
                    </button>
                  </div>
                );
              }

              if (item.type === "branch") {
                const { sourceId, node, depth, expanded } = item;
                const branchKey = `${sourceId}::${node.key}`;
                return (
                  <div
                    key={`b-${branchKey}`}
                    className={s.vitem}
                    style={{ top, height: BRANCH_ROW_H }}
                    role="listitem"
                  >
                    <button
                      type="button"
                      className={s.branch}
                      style={{ "--depth": depth } as CSSProperties}
                      aria-expanded={expanded}
                      onClick={() => toggleCollapse(branchKey)}
                      data-testid={`channels-branch-${branchKey}`}
                    >
                      <Chevron />
                      <span className={s.branchName} title={node.key}>
                        {node.label}
                      </span>
                      <span className={s.branchCount}>{node.leafCount}</span>
                    </button>
                  </div>
                );
              }

              const { channel, label, depth } = item;
              const bound = isBound(channel.id);
              const disabled = plotFull && selectedKind === "plot" && !bound;
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
                    style={{ "--depth": depth } as CSSProperties}
                    aria-pressed={bound}
                    aria-disabled={disabled || undefined}
                    draggable={channel.kind === "scalar"}
                    onDragStart={(e) => onDragStartChannel(e, channel)}
                    title={
                      bound
                        ? "Already bound to this panel"
                        : disabled
                          ? `Plot full (${MAX_PLOT_SERIES})`
                          : channel.name
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
                    <span className={s.name}>{label}</span>
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
