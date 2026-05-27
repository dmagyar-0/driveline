// Right-side cursor-value gutter for the Plot panel.
//
// Fixed ~180 px column pinned to the right of `.plotArea` so the
// readout never overlaps the traces (a floating tooltip occluded
// 25–30% of the upper-right quadrant). Each row shows a source-coloured
// ribbon, the live value (dominant — engineers read the number every
// second, the name is only confirmation), and the channel label /
// optional source badge underneath.
//
// Pure-presentational: receives an `entries` array and a time label.
// The parent computes both once per cursor tick in the same effect
// that updates the snapshot — no extra work on the hot path.

import { colorFor, colorForSource } from "./palette";
import type { CursorReadoutEntry } from "./CursorReadout";
import { formatFixedForUnit } from "./plotFormat";
import styles from "./PlotPanel.module.css";

export interface CursorGutterEntry extends CursorReadoutEntry {
  /** Source id used to pick the per-source ribbon colour. Distinct from
   *  the swatch — the swatch colours the line, the ribbon colours the
   *  source. */
  sourceId: string;
  /** Raw numeric value at the cursor. `null` when no sample resolves at
   *  or before the cursor — rendered as the em-dash placeholder. The
   *  gutter formats values itself via `formatFixedForUnit` so columns
   *  align by decimal point. */
  rawValue: number | null;
}

export interface CursorGutterProps {
  /** Pre-formatted time header, e.g. `09:14:07`. `null` hides it. */
  timeLabel: string | null;
  entries: CursorGutterEntry[];
}

export function CursorGutter({ timeLabel, entries }: CursorGutterProps) {
  if (entries.length === 0) return null;
  return (
    <aside
      className={styles.cursorGutter}
      data-testid="plot-cursor-gutter"
      aria-label="Cursor values"
    >
      {timeLabel && (
        <div
          className={styles.cursorGutterTime}
          data-testid="plot-cursor-gutter-time"
        >
          {timeLabel}
        </div>
      )}
      <ul className={styles.cursorGutterList}>
        {entries.map((e) => {
          const valueText =
            e.rawValue !== null && Number.isFinite(e.rawValue)
              ? formatFixedForUnit(e.rawValue, e.unit)
              : "—";
          const accent = colorFor(e.channelId);
          return (
            <li
              key={e.channelId}
              className={styles.cursorGutterRow}
              data-testid={`gutter-row-${e.channelId}`}
              title={
                e.sourceBadge
                  ? `${e.shortLabel} · ${e.sourceBadge}`
                  : e.shortLabel
              }
            >
              <span
                className={styles.cursorGutterRibbon}
                style={{ background: colorForSource(e.sourceId) }}
                data-testid={`gutter-ribbon-${e.channelId}`}
                aria-hidden
              />
              {/* Live value is the dominant line — value first (~16 px,
                  mono semi-bold, accent colour) and the label
                  underneath. */}
              <span
                className={`${styles.cursorGutterValue} ${styles.numCell}`}
                style={{ color: accent }}
                data-testid={`gutter-value-${e.channelId}`}
              >
                {/* Per-channel swatch beside the numeric value so the
                    user can trace colour → number → label in one
                    saccade. The source ribbon keys the row by source;
                    this swatch keys the value by channel. */}
                <span
                  className={styles.cursorGutterValueSwatch}
                  style={{ background: accent }}
                  data-testid={`gutter-value-swatch-${e.channelId}`}
                  aria-hidden
                />
                <span className={styles.cursorGutterValueNum}>{valueText}</span>
                {valueText !== "—" && e.unit ? (
                  <span className={styles.cursorGutterUnit}> {e.unit}</span>
                ) : null}
              </span>
              <span className={styles.cursorGutterLabelRow}>
                <span className={styles.cursorGutterLabel}>{e.shortLabel}</span>
                {e.sourceBadge && (
                  <span
                    className={styles.cursorGutterBadge}
                    data-testid={`gutter-badge-${e.channelId}`}
                  >
                    {e.sourceBadge}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
