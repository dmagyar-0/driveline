// TablePanel — raw signal values as a scrollable time series.
//
// Where the Value panel shows one number per channel at the cursor, this
// panel shows the *whole* raw series: every sample of every bound channel
// laid out as a spreadsheet (one row per distinct timestamp, one column
// per channel — see `tableModel.ts`). The row at-or-before the cursor is
// highlighted and kept on screen, so scrubbing walks the table the same
// way it walks the plot. Timestamps use the scrubber's own relative
// format (`formatRelative`) so the column reads exactly like the
// transport readout.
//
// The union of raw samples can run to hundreds of thousands of rows, so
// the body is hand-rolled virtualised (no component library, per the
// frontend skill): only the rows in (and just around) the viewport are in
// the DOM. The expensive merge happens once per fetch/binding change and
// lives in a ref; the cursor hot path only does a binary search and,
// when the active row leaves the viewport, one `scrollTop` write.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { seriesFromArrow } from "./seriesFromArrow";
import { colorFor, MAX_PLOT_SERIES } from "./palette";
import { formatRelative } from "../timeline/formatTime";
import {
  buildTableModel,
  lastRowAtOrBefore,
  type TableModel,
} from "./tableModel";
import styles from "./TablePanel.module.css";

interface TablePanelProps {
  panelId: string;
}

const EMPTY: readonly string[] = Object.freeze([]);
const ROW_H = 28; // px — fixed row height keeps virtualisation math trivial.
const OVERSCAN = 6; // rows rendered beyond the viewport on each edge.

const EMPTY_MODEL: TableModel = { rowTsNs: [], columns: [], truncated: false };

function findChannel(
  sources: SourceMeta[],
  channelId: string,
): Channel | null {
  for (const s of sources) {
    const hit = s.channels.find((c) => c.id === channelId);
    if (hit) return hit;
  }
  return null;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}

export function TablePanel({ panelId }: TablePanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.tableBindings[panelId]);
  const setTableBinding = useSession((s) => s.setTableBinding);

  const boundIds = useMemo(() => storedBindings ?? EMPTY, [storedBindings]);

  const boundChannels = useMemo(
    () =>
      boundIds
        .map((id) => findChannel(sources, id))
        .filter((c): c is Channel => c !== null),
    [boundIds, sources],
  );

  // Drop stale / non-scalar bindings once a source exists (same guard as
  // the other panels: don't wipe persisted bindings before first load).
  useEffect(() => {
    if (sources.length === 0) return;
    const filtered = boundIds.filter((id) => {
      const c = findChannel(sources, id);
      return c !== null && c.kind === "scalar";
    });
    if (filtered.length !== boundIds.length) {
      setTableBinding(panelId, filtered);
    }
  }, [boundIds, sources, panelId, setTableBinding]);

  // The merged row model lives in a ref so cursor ticks don't rebuild it;
  // `renderTick` threads completion of the async fetch into render.
  const modelRef = useRef<TableModel>(EMPTY_MODEL);
  const [renderTick, setRenderTick] = useState(0);

  const fetchKey = boundIds.join("|");
  useEffect(() => {
    if (!globalRange || boundChannels.length === 0) {
      modelRef.current = EMPTY_MODEL;
      setRenderTick((n) => n + 1);
      return;
    }
    let aborted = false;
    void (async () => {
      try {
        const store = useSession.getState();
        const batches = await Promise.all(
          boundChannels.map((c) =>
            store.fetchChannelRange(
              c.id,
              globalRange.startNs,
              globalRange.endNs,
              false,
            ),
          ),
        );
        if (aborted) return;
        modelRef.current = buildTableModel(
          boundChannels.map((c, i) => ({
            channelId: c.id,
            name: c.name,
            unit: c.unit,
            series: seriesFromArrow(batches[i]),
          })),
        );
        setRenderTick((n) => n + 1);
      } catch (err) {
        if (!aborted) console.error("TablePanel fetch failed", err);
      }
    })();
    return () => {
      aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchKey, globalRange]);

  void renderTick;
  const model = modelRef.current;
  const rowCount = model.rowTsNs.length;
  // Column layout is driven by the bound channels (always known), while
  // values come from the merged model looked up by channel id. Deriving
  // the header from the bindings keeps header/body column counts in
  // lockstep even before the async fetch lands or mid-rebind.
  const columnById = useMemo(() => {
    const m = new Map<string, (typeof model.columns)[number]>();
    for (const col of model.columns) m.set(col.channelId, col);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderTick]);

  // --- virtualisation state -------------------------------------------
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const headerHRef = useRef<number>(ROW_H);
  const rafRef = useRef<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Track the scroll container's height so the visible window is sized
  // to what's actually on screen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const sync = () => {
      setViewportH(el.clientHeight);
      if (headerRef.current) {
        headerHRef.current = headerRef.current.offsetHeight || ROW_H;
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [renderTick]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setScrollTop(el.scrollTop);
    });
  };

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const activeRow =
    rowCount > 0 ? lastRowAtOrBefore(model.rowTsNs, cursorNs) : -1;

  // Keep the cursor row on screen. Only scrolls when the active row has
  // actually left the visible area, so manual scrolling near the cursor
  // isn't fought. `scrollTop` writes flow back through `onScroll`.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || activeRow < 0) return;
    const headerH = headerHRef.current;
    const rowDocTop = headerH + activeRow * ROW_H;
    const visibleTop = el.scrollTop + headerH;
    const visibleBottom = el.scrollTop + el.clientHeight;
    if (rowDocTop < visibleTop || rowDocTop + ROW_H > visibleBottom) {
      const belowHeader = el.clientHeight - headerH;
      const target = rowDocTop - headerH - belowHeader / 2 + ROW_H / 2;
      const maxScroll = el.scrollHeight - el.clientHeight;
      el.scrollTop = Math.max(0, Math.min(target, maxScroll));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursorNs, activeRow, renderTick, viewportH]);

  const isEmpty = boundChannels.length === 0;

  // Visible window. Row i occupies scroll-content rows
  // [headerH + i*ROW_H, headerH + (i+1)*ROW_H]; subtract the header
  // offset so the sticky header doesn't shift the window.
  const headerH = headerHRef.current;
  const first = Math.max(
    0,
    Math.floor((scrollTop - headerH) / ROW_H) - OVERSCAN,
  );
  const last = Math.min(
    rowCount - 1,
    Math.ceil((scrollTop + viewportH - headerH) / ROW_H) + OVERSCAN,
  );
  const visible: number[] = [];
  for (let i = first; i <= last; i++) visible.push(i);

  const gridTemplate = `var(--table-time-col) repeat(${Math.max(
    1,
    boundChannels.length,
  )}, minmax(72px, 1fr))`;

  return (
    <section className={styles.panel} data-testid="table-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="table-empty">
          <p className={styles.emptyTitle}>Table</p>
          <p className={styles.emptyBody}>
            Bind scalar channels from the Panel drawer (up to{" "}
            {MAX_PLOT_SERIES}) to browse their raw values over time.
          </p>
        </div>
      ) : (
        <div
          className={styles.scroll}
          ref={scrollRef}
          onScroll={onScroll}
          role="table"
          aria-label="Raw channel values over time"
          aria-rowcount={rowCount}
        >
          <div
            className={styles.headerRow}
            ref={headerRef}
            role="row"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <span className={styles.headerCell} role="columnheader">
              Time
            </span>
            {boundChannels.map((col) => (
              <span
                key={col.id}
                className={styles.headerCellRight}
                role="columnheader"
                data-testid={`table-col-${col.id}`}
                title={col.name}
              >
                <span
                  className={styles.swatch}
                  style={{ background: colorFor(col.id) }}
                  aria-hidden="true"
                />
                <span className={styles.headerName}>{col.name}</span>
                {col.unit && <span className={styles.unit}>{col.unit}</span>}
              </span>
            ))}
          </div>

          {rowCount === 0 ? (
            <p className={styles.noRows} data-testid="table-no-rows">
              No samples in range.
            </p>
          ) : (
            <div
              className={styles.rowsViewport}
              style={{ height: rowCount * ROW_H }}
              data-testid="table-body"
            >
              {visible.map((i) => {
                const isActive = i === activeRow;
                return (
                  <div
                    key={i}
                    className={
                      isActive ? `${styles.row} ${styles.activeRow}` : styles.row
                    }
                    role="row"
                    aria-rowindex={i + 1}
                    aria-selected={isActive || undefined}
                    data-testid={isActive ? "table-active-row" : undefined}
                    style={{
                      top: i * ROW_H,
                      height: ROW_H,
                      gridTemplateColumns: gridTemplate,
                    }}
                  >
                    <span className={styles.timeCell} role="cell">
                      {globalRange
                        ? formatRelative(model.rowTsNs[i], globalRange.startNs)
                        : "—"}
                    </span>
                    {boundChannels.map((ch) => {
                      const col = columnById.get(ch.id);
                      const v = col ? col.values[i] : null;
                      const exact = col ? col.exact[i] : false;
                      return (
                        <span
                          key={ch.id}
                          className={
                            exact
                              ? styles.valueCell
                              : `${styles.valueCell} ${styles.carried}`
                          }
                          role="cell"
                          data-testid={
                            isActive ? `table-active-${ch.id}` : undefined
                          }
                        >
                          {v === null || v === undefined
                            ? "—"
                            : formatValue(v)}
                        </span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}

          {model.truncated && (
            <p className={styles.truncated} data-testid="table-truncated">
              Showing the first {rowCount.toLocaleString()} rows.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
