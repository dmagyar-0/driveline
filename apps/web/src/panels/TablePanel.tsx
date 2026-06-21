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
// lives in component state; the cursor hot path only does a binary search
// and, when the active row leaves the viewport, one `scrollTop` write.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel } from "../state/store";
import { effectiveUnit } from "../state/units";
import { decodeSeries } from "./seriesFromArrow";
import { colorFor, MAX_PLOT_SERIES } from "./palette";
import { formatRelative } from "../timeline/formatTime";
import { buildTableModel, type TableModel } from "./tableModel";
import { formatValue } from "./shared/formatValue";
import { lastIndexAtOrBefore } from "./shared/cursorLookup";
import { usePanelChannels } from "./shared/usePanelChannels";
import { useChannelRanges } from "./shared/useChannelRanges";
import styles from "./TablePanel.module.css";

interface TablePanelProps {
  panelId: string;
}

const ROW_H = 28; // px — fixed row height keeps virtualisation math trivial.
const OVERSCAN = 6; // rows rendered beyond the viewport on each edge.

const EMPTY_MODEL: TableModel = { rowTsNs: [], columns: [], truncated: false };

const isScalar = (c: Channel) => c.kind === "scalar";

export function TablePanel({ panelId }: TablePanelProps) {
  const unitOverrides = useSession((s) => s.unitOverrides);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.tableBindings[panelId]);
  const setTableBinding = useSession((s) => s.setTableBinding);

  const { boundChannels } = usePanelChannels({
    panelId,
    bindings: storedBindings,
    isValid: isScalar,
    setBindings: setTableBinding,
  });

  // Abortable fetch — one batch per bound channel per range change. The merge
  // + decode below run only when the fetch settles, never on the cursor path.
  const load = useChannelRanges(boundChannels, globalRange, "TablePanel");

  // Decode + k-way merge into the row model (or a first decode error). Lives in
  // a memo keyed on the fetch result, so it rebuilds once per fetch/binding
  // change. A dtype mismatch surfaces as a visible error instead of a blank
  // table.
  const { model, error } = useMemo<{
    model: TableModel;
    error: string | null;
  }>(() => {
    if (load.status === "error")
      return { model: EMPTY_MODEL, error: load.error };
    if (load.status !== "ready") return { model: EMPTY_MODEL, error: null };
    const inputs = [];
    for (let i = 0; i < boundChannels.length; i++) {
      const res = decodeSeries(load.data[i]);
      if (!res.ok) return { model: EMPTY_MODEL, error: res.message };
      const c = boundChannels[i];
      inputs.push({
        channelId: c.id,
        name: c.name,
        unit: c.unit,
        series: res,
      });
    }
    return { model: buildTableModel(inputs), error: null };
    // boundChannels identity tracks the same fetch generation as `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const rowCount = model.rowTsNs.length;
  // Column layout is driven by the bound channels (always known), while
  // values come from the merged model looked up by channel id. Deriving
  // the header from the bindings keeps header/body column counts in
  // lockstep even before the async fetch lands or mid-rebind.
  const columnById = useMemo(() => {
    const m = new Map<string, (typeof model.columns)[number]>();
    for (const col of model.columns) m.set(col.channelId, col);
    return m;
  }, [model]);

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
  }, [model]);

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
    rowCount > 0 ? lastIndexAtOrBefore(model.rowTsNs, cursorNs) : -1;

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
  }, [cursorNs, activeRow, model, viewportH]);

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
            Bind scalar channels from the Panel drawer (up to {MAX_PLOT_SERIES})
            to browse their raw values over time.
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
                {effectiveUnit(col, unitOverrides) && (
                  <span className={styles.unit}>
                    {effectiveUnit(col, unitOverrides)}
                  </span>
                )}
              </span>
            ))}
          </div>

          {error !== null ? (
            <p className={styles.noRows} role="alert" data-testid="table-error">
              {error}
            </p>
          ) : rowCount === 0 ? (
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
                      isActive
                        ? `${styles.row} ${styles.activeRow}`
                        : styles.row
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
                          {v === null || v === undefined ? "—" : formatValue(v)}
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
