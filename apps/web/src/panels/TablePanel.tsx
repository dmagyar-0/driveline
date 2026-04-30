// Phase 6 · TablePanel — hand-rolled scalar value table.
//
// Subscribes to `tableBindings[panelId]` and renders a row per bound
// channel showing the sample-at-or-before the cursor (mirrors the
// PlotPanel `sampleAtCursor` pattern). Capped at `MAX_PLOT_SERIES` (8)
// rows so virtualisation is unnecessary at v1 — the body is a plain
// flex column inside a scroll container. Frontend-skill ban on new
// component libraries means no `react-virtuoso`; the integration plan
// (`docs/design/v1-shell-integration.md` §6.6) explicitly favours a
// hand-rolled list at this size.
//
// One worker fetch per channel per `globalRange` change. The cursor
// tick only re-runs the binary search; no fetches fire on scrub. Each
// row updates in O(log n) per cursor change.

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../state/store";
import type { Channel, SourceMeta } from "../state/store";
import { seriesFromArrow, type PlotSeries } from "./seriesFromArrow";
import { colorFor, MAX_PLOT_SERIES } from "./palette";
import styles from "./TablePanel.module.css";

interface TablePanelProps {
  panelId: string;
}

const EMPTY: readonly string[] = Object.freeze([]);

function lastIndexAtOrBefore(
  tsNs: BigInt64Array,
  cursorNs: bigint,
): number {
  let lo = 0;
  let hi = tsNs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tsNs[mid] <= cursorNs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

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

export function TablePanel({ panelId }: TablePanelProps) {
  const sources = useSession((s) => s.sources);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.tableBindings[panelId]);
  const setTableBinding = useSession((s) => s.setTableBinding);

  const boundIds = useMemo(() => storedBindings ?? EMPTY, [storedBindings]);

  // Resolve binding ids to live Channel records. Drop any that no
  // longer exist (defence against stale persisted ids — same pattern
  // PlotPanel uses).
  const boundChannels = useMemo(
    () =>
      boundIds
        .map((id) => findChannel(sources, id))
        .filter((c): c is Channel => c !== null),
    [boundIds, sources],
  );

  // Skip the cull until at least one source is loaded so a fresh
  // hydrate doesn't wipe every persisted binding before the user has
  // dropped a file.
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

  // Decoded series cache keyed in bound order. One fetch per bound
  // channel per `globalRange` change.
  const decodedRef = useRef<{ channelId: string; series: PlotSeries }[]>(
    [],
  );
  const [renderTick, setRenderTick] = useState(0);

  const fetchKey = boundIds.join("|");
  useEffect(() => {
    if (!globalRange || boundChannels.length === 0) {
      decodedRef.current = [];
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
        decodedRef.current = boundChannels.map((c, i) => ({
          channelId: c.id,
          series: seriesFromArrow(batches[i]),
        }));
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

  // Compute sample-at-cursor on every render (cheap binary search).
  // `renderTick` is a hidden dependency that bumps on fetch completion
  // so the table refreshes when new data lands without a useEffect.
  void renderTick;
  const rows = boundChannels.map((channel) => {
    const decoded = decodedRef.current.find((d) => d.channelId === channel.id);
    if (!decoded) return { channel, value: null, tsNs: null };
    const idx = lastIndexAtOrBefore(decoded.series.rawTsNs, cursorNs);
    if (idx < 0) return { channel, value: null, tsNs: null };
    return {
      channel,
      value: decoded.series.ys[idx],
      tsNs: decoded.series.rawTsNs[idx],
    };
  });

  const isEmpty = boundChannels.length === 0;

  return (
    <section className={styles.panel} data-testid="table-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="table-empty">
          <p className={styles.emptyTitle}>Table</p>
          <p className={styles.emptyBody}>
            Bind scalar channels from the Panel drawer (up to{" "}
            {MAX_PLOT_SERIES}).
          </p>
        </div>
      ) : (
        <div
          className={styles.scroll}
          role="table"
          aria-label="Channel values at cursor"
        >
          <div className={styles.headerRow} role="row">
            <span className={styles.headerCell} role="columnheader">
              Channel
            </span>
            <span className={styles.headerCellRight} role="columnheader">
              Value
            </span>
            <span className={styles.headerCellRight} role="columnheader">
              ts (s)
            </span>
          </div>
          <ul className={styles.body} data-testid="table-body">
            {rows.map(({ channel, value, tsNs }) => (
              <li
                key={channel.id}
                className={styles.row}
                role="row"
                data-testid={`table-row-${channel.id}`}
              >
                <span className={styles.nameCell} role="cell">
                  <span
                    className={styles.swatch}
                    style={{ background: colorFor(channel.id) }}
                    aria-hidden="true"
                  />
                  <span className={styles.name} title={channel.name}>
                    {channel.name}
                  </span>
                  {channel.unit && (
                    <span className={styles.unit}>{channel.unit}</span>
                  )}
                </span>
                <span
                  className={styles.valueCell}
                  role="cell"
                  data-testid={`table-value-${channel.id}`}
                >
                  {value === null ? "—" : formatValue(value)}
                </span>
                <span className={styles.tsCell} role="cell">
                  {tsNs === null ? "—" : formatSeconds(tsNs)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  // Compact 4 sig-fig rendering — enough to read the value without
  // dominating the row width on a narrow drawer.
  const abs = Math.abs(v);
  if (abs >= 1000 || (abs > 0 && abs < 0.01)) return v.toExponential(3);
  return v.toFixed(3);
}

function formatSeconds(tsNs: bigint): string {
  // Convert ns → ms (integer divide, keeps magnitude inside Float64
  // exact range up to ~285 years) → seconds with millisecond
  // resolution. Sub-ms is intentionally truncated to keep the column
  // narrow; the table is a peek-the-cursor view, not a microsecond
  // forensic tool.
  const secs = Number(tsNs / 1_000_000n) / 1000;
  return secs.toFixed(3);
}
