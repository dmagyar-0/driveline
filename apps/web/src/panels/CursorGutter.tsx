// Right-side cursor-value gutter for the Plot panel (iter3 issue #1).
//
// Iter2 anchored a floating tooltip to the playhead. The designer audit
// found it occluded 25–30% of the plotted data in the upper-right
// quadrant — the user scrubs to see a value, the tooltip flips on top
// of it. Iter3 moves the cursor-value readout into a fixed gutter
// column on the right side of the panel. The plot canvas shrinks to
// accommodate; the gutter never overlaps the traces, and the column
// position stays stable as the cursor moves.
//
// Iter5 issue #1 — promote the live value. The audit found the iter4
// hierarchy backwards: the channel name was the largest text in each
// row, and the live value (`30.58 m/s`) sat on a second line in a
// smaller, dimmer font. Engineers read the *number* every second; the
// name is only confirmation. The new hierarchy is:
//   - **Live value** — first line, largest (~16 px), monospaced semi-
//     bold, in the channel's accent colour. This is what the eye hits
//     first.
//   - **Channel name** — second line, ~13 px, secondary fg.
//   - **Source badge** — tertiary 10 px, dimmed. Optional; only shown
//     when binding-set disambiguation requires it.
//
// Layout shape:
//   - one column ~180 px wide pinned to the right of `.plotArea`;
//   - one row per bound channel, in binding order;
//   - each row shows:
//       * a 4 px coloured source ribbon (per-source palette colour,
//         iter3 issue #2 — coordinates with `palette.colorForSource`);
//       * the live value (dominant text), with its unit;
//       * the channel's short label + optional badge underneath.
//   - a time header above the rows (iter3 issue #6 — 24h `HH:MM:SS`).
//
// Pure-presentational: receives an `entries` array and a time label.
// The parent already computes both once per cursor tick in the same
// effect that updates the snapshot — no extra work on the hot path.

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
              {/* Iter5 issue #1 — live value is the dominant line.
                  Engineers read the number every second; the channel
                  name and source qualifier are only used to confirm
                  *what* they're reading. We render value first (~16 px,
                  mono semi-bold, accent colour) and the label
                  underneath at 13 px secondary fg. */}
              <span
                className={`${styles.cursorGutterValue} ${styles.numCell}`}
                style={{ color: accent }}
                data-testid={`gutter-value-${e.channelId}`}
              >
                {/* Iter4 alignment item #6 — a tiny per-channel swatch
                    sits adjacent to the numeric value so the user can
                    trace colour → number → label in one saccade. The
                    source ribbon at the row's left edge already keys
                    the row by source; this swatch keys the value by
                    channel, mirroring the line's stroke colour. */}
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
