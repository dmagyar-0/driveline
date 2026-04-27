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

import { useState } from "react";
import { useSession, type Channel } from "../../state/store";
import { colorFor, MAX_PLOT_SERIES } from "../../panels/palette";
import { panelKindOf } from "../../layout/panelId";
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
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const matches = (c: Channel) =>
    q === "" || c.name.toLowerCase().includes(q);

  const filteredCount = channels.reduce(
    (n, c) => (matches(c) ? n + 1 : n),
    0,
  );

  // Hide groups whose every channel is filtered out so the user isn't
  // scrolling past empty headers under a non-matching search.
  const grouped = sources
    .map((src) => ({
      src,
      rows: channels.filter((c) => c.sourceId === src.id && matches(c)),
    }))
    .filter((g) => g.rows.length > 0);

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
      ) : grouped.length === 0 ? (
        <p className={s.empty}>No channels match “{query}”</p>
      ) : (
        <ul className={s.groupList} data-testid="channels-groups">
          {grouped.map(({ src, rows }) => {
            const listId = `drawer-channels-list-${src.id}`;
            const isCollapsed = collapsed[src.id] === true;
            return (
              <li key={src.id} className={s.group}>
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
                  <span className={s.groupCount}>{rows.length}</span>
                </button>
                {!isCollapsed && (
                  <ul
                    id={listId}
                    className={s.list}
                    data-testid={`channels-list-${src.id}`}
                  >
                    {rows.map((channel) => {
                      const bound = isBound(channel.id);
                      const disabled =
                        plotFull && selectedKind === "plot" && !bound;
                      return (
                        <li key={channel.id}>
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
                        </li>
                      );
                    })}
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
