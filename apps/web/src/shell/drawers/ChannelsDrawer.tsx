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

import { useState } from "react";
import type { CSSProperties } from "react";
import { useSession } from "../../state/store";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
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

interface Props {
  /** Returns the id of an existing or newly-created plot panel, or
   *  `null` if no panel could be created (e.g. workspace not yet
   *  mounted). The drawer calls this when the user clicks a channel
   *  while no panel is selected. */
  ensurePlotPanel: () => string | null;
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

  const queryActive = query.trim() !== "";

  const filteredCount = channels.reduce(
    (n, c) => (channelMatchesQuery(c, query) ? n + 1 : n),
    0,
  );

  // Hide groups whose every channel is filtered out so the user isn't
  // scrolling past empty headers under a non-matching search.
  const grouped = sources
    .map((src) => {
      const rows = channels.filter(
        (c) => c.sourceId === src.id && channelMatchesQuery(c, query),
      );
      return { src, tree: buildChannelTree(rows), count: rows.length };
    })
    .filter((g) => g.count > 0);

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

  const isExpanded = (key: string) => queryActive || !collapsed.has(key);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Renders a single channel row (a tree leaf, or the "self" row of a branch
  // that is itself a bound channel). Preserves the `channel-row-${id}` test
  // id and binding behaviour the flat list had.
  const renderLeaf = (
    label: string,
    channelId: string,
    fullName: string,
    dtype: string | null,
    depth: number,
  ) => {
    const bound = isBound(channelId);
    const disabled = plotFull && selectedKind === "plot" && !bound;
    return (
      <button
        type="button"
        className={`${s.row} ${bound ? s.rowActive : ""}`}
        style={{ "--depth": depth } as CSSProperties}
        aria-pressed={bound}
        aria-disabled={disabled || undefined}
        title={
          bound
            ? "Already bound to this panel"
            : disabled
              ? `Plot full (${MAX_PLOT_SERIES})`
              : fullName
        }
        onClick={() => {
          if (disabled) return;
          onPick(channelId);
        }}
        data-testid={`channel-row-${channelId}`}
      >
        <span
          className={s.swatch}
          style={{ background: colorFor(channelId) }}
          aria-hidden="true"
        />
        <span className={s.name}>{label}</span>
        {dtype !== null && <span className={s.kind}>{dtype}</span>}
      </button>
    );
  };

  const renderNode = (
    sourceId: string,
    node: ChannelTreeNode,
    depth: number,
  ) => {
    const isLeafOnly = node.children.length === 0 && node.channel !== null;
    if (isLeafOnly && node.channel) {
      return (
        <li key={node.key} role="treeitem">
          {renderLeaf(
            node.label,
            node.channel.id,
            node.channel.name,
            node.channel.dtype,
            depth,
          )}
        </li>
      );
    }

    const branchKey = `${sourceId}::${node.key}`;
    const expanded = isExpanded(branchKey);
    const childListId = `drawer-channels-node-${branchKey}`;
    return (
      <li key={node.key} role="treeitem" aria-expanded={expanded}>
        <button
          type="button"
          className={s.branch}
          style={{ "--depth": depth } as CSSProperties}
          aria-expanded={expanded}
          aria-controls={childListId}
          onClick={() => toggleCollapse(branchKey)}
          data-testid={`channels-branch-${branchKey}`}
        >
          <span className={s.chevron} aria-hidden="true">
            {expanded ? "▾" : "▸"}
          </span>
          <span className={s.branchName} title={node.key}>
            {node.label}
          </span>
          <span className={s.branchCount}>{node.leafCount}</span>
        </button>
        {expanded && (
          <ul id={childListId} className={s.subtree} role="group">
            {node.channel && (
              <li role="treeitem">
                {renderLeaf(
                  node.label,
                  node.channel.id,
                  node.channel.name,
                  node.channel.dtype,
                  depth + 1,
                )}
              </li>
            )}
            {node.children.map((child) =>
              renderNode(sourceId, child, depth + 1),
            )}
          </ul>
        )}
      </li>
    );
  };

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
      ) : grouped.length === 0 ? (
        <p className={s.empty}>No channels match “{query}”</p>
      ) : (
        <ul className={s.groupList} data-testid="channels-groups">
          {grouped.map(({ src, tree, count }) => {
            const listId = `drawer-channels-list-${src.id}`;
            const expanded = isExpanded(src.id);
            return (
              <li key={src.id} className={s.group}>
                <button
                  type="button"
                  className={s.groupHeader}
                  aria-expanded={expanded}
                  aria-controls={listId}
                  onClick={() => toggleCollapse(src.id)}
                  data-testid={`channels-group-${src.id}`}
                >
                  <span className={s.chevron} aria-hidden="true">
                    {expanded ? "▾" : "▸"}
                  </span>
                  <span className={s.groupName} title={src.name}>
                    {src.name}
                  </span>
                  <span className={s.groupCount}>{count}</span>
                </button>
                {expanded && (
                  <ul
                    id={listId}
                    className={s.tree}
                    role="tree"
                    aria-label={`${src.name} channels`}
                    data-testid={`channels-list-${src.id}`}
                  >
                    {tree.map((node) => renderNode(src.id, node, 0))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
