// ValuePanel — hand-rolled scalar value reader.
//
// The compact "value at the cursor" view: one row per bound channel
// showing the sample-at-or-before the cursor (mirrors the PlotPanel
// `sampleAtCursor` pattern). This was historically the "Table" panel,
// but with a single value per row the per-row timestamp column was just
// noise — every row resolves to (approximately) the cursor time — so the
// reader was renamed "Value" and the timestamp column dropped. The full
// raw time series now lives in the dedicated `TablePanel`.
//
// Capped at `MAX_PLOT_SERIES` (8) rows so virtualisation is unnecessary —
// the body is a plain flex column inside a scroll container. One worker
// fetch per channel per `globalRange` change; the cursor tick only
// re-runs the binary search, so no fetches fire on scrub.

import { useMemo } from "react";
import { useSession } from "../state/store";
import type { Channel } from "../state/store";
import { effectiveUnit } from "../state/units";
import { decodeSeries, type PlotSeries } from "./seriesFromArrow";
import { colorFor, MAX_PLOT_SERIES } from "./palette";
import { formatValue } from "./shared/formatValue";
import { lastIndexAtOrBefore } from "./shared/cursorLookup";
import { usePanelChannels } from "./shared/usePanelChannels";
import { useChannelRanges } from "./shared/useChannelRanges";
import styles from "./ValuePanel.module.css";

interface ValuePanelProps {
  panelId: string;
}

const isScalar = (c: Channel) => c.kind === "scalar";

export function ValuePanel({ panelId }: ValuePanelProps) {
  const unitOverrides = useSession((s) => s.unitOverrides);
  const globalRange = useSession((s) => s.globalRange);
  const cursorNs = useSession((s) => s.cursorNs);
  const storedBindings = useSession((s) => s.valueBindings[panelId]);
  const setValueBinding = useSession((s) => s.setValueBinding);

  const { boundChannels } = usePanelChannels({
    panelId,
    bindings: storedBindings,
    isValid: isScalar,
    setBindings: setValueBinding,
  });

  // Abortable fetch — one batch per bound channel per range change. Decoded
  // below so a per-channel dtype mismatch surfaces as a visible error rather
  // than a silently blank row.
  const load = useChannelRanges(boundChannels, globalRange, "ValuePanel");

  // Decode the batches into per-channel series (or a first error message).
  // Recomputed only when the fetch settles, never on the cursor hot path.
  const decoded = useMemo<{
    series: { channelId: string; series: PlotSeries }[];
    error: string | null;
  }>(() => {
    if (load.status !== "ready") return { series: [], error: null };
    const series: { channelId: string; series: PlotSeries }[] = [];
    for (let i = 0; i < boundChannels.length; i++) {
      const res = decodeSeries(load.data[i]);
      if (!res.ok) return { series: [], error: res.message };
      series.push({ channelId: boundChannels[i].id, series: res });
    }
    return { series, error: null };
    // boundChannels identity tracks the same fetch generation as `load`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Compute sample-at-cursor on every render (cheap binary search). The
  // decoded series come from React state, so the table refreshes when new
  // data lands without a hidden ref-bump.
  const rows = boundChannels.map((channel) => {
    const hit = decoded.series.find((d) => d.channelId === channel.id);
    if (!hit) return { channel, value: null };
    const idx = lastIndexAtOrBefore(hit.series.rawTsNs, cursorNs);
    if (idx < 0) return { channel, value: null };
    return { channel, value: hit.series.ys[idx] };
  });

  const isEmpty = boundChannels.length === 0;

  return (
    <section className={styles.panel} data-testid="value-panel">
      {isEmpty ? (
        <div className={styles.empty} data-testid="value-empty">
          <p className={styles.emptyTitle}>Value</p>
          <p className={styles.emptyBody}>
            Bind scalar channels from the Panel drawer (up to {MAX_PLOT_SERIES}
            ).
          </p>
        </div>
      ) : decoded.error !== null ? (
        <div className={styles.empty} role="alert" data-testid="value-error">
          <p className={styles.emptyTitle}>Value</p>
          <p className={styles.emptyBody}>{decoded.error}</p>
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
          </div>
          <ul className={styles.body} data-testid="value-body">
            {rows.map(({ channel, value }) => (
              <li
                key={channel.id}
                className={styles.row}
                role="row"
                data-testid={`value-row-${channel.id}`}
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
                  {effectiveUnit(channel, unitOverrides) && (
                    <span className={styles.unit}>
                      {effectiveUnit(channel, unitOverrides)}
                    </span>
                  )}
                </span>
                <span
                  className={styles.valueCell}
                  role="cell"
                  data-testid={`value-value-${channel.id}`}
                >
                  {value === null ? "—" : formatValue(value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
