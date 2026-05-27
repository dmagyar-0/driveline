// Cursor-value legend strip rendered directly under the plot canvas
// (UX overhaul issue #4).
//
// The crosshair on its own was decorative: the user could see where the
// cursor was in time but not what value any of the plotted channels
// held there. This strip lists each bound series with its colour swatch
// and the sample value at `cursorNs`, formatted with the channel unit.
//
// Hot-path discipline: the parent computes the `entries` array (one
// binary search per bound channel) inside the same effect that already
// republishes the sync snapshot. The component itself is pure — given
// the same `entries` it renders the same DOM, with no per-frame work
// beyond what React's reconciler does for a list of ≤8 spans.

import { colorFor, colorForSource } from "./palette";
import styles from "./PlotPanel.module.css";

export interface CursorReadoutEntry {
  channelId: string;
  shortLabel: string;
  /** Pre-formatted value string. `null` means no sample resolves at or
   *  before the current cursor — render an em-dash placeholder. */
  value: string | null;
  unit: string | null;
  /** Optional source-disambiguation badge — same string the chip shows. */
  sourceBadge: string;
  /** Iter3 issue #2 — the source id powers the per-source colour
   *  ribbon. Optional so older call sites that omit it (e.g. legacy
   *  test fixtures) keep compiling; ribbon renders only when set. */
  sourceId?: string;
}

interface Props {
  entries: CursorReadoutEntry[];
}

export function CursorReadout({ entries }: Props) {
  if (entries.length === 0) return null;
  return (
    <div
      className={styles.cursorReadout}
      data-testid="plot-cursor-readout"
      role="status"
      aria-live="off"
    >
      {entries.map((e) => (
        <span
          key={e.channelId}
          className={styles.readoutItem}
          data-testid={`readout-${e.channelId}`}
        >
          {e.sourceId && (
            <span
              className={styles.readoutRibbon}
              style={{ background: colorForSource(e.sourceId) }}
              data-testid={`readout-ribbon-${e.channelId}`}
              aria-hidden
            />
          )}
          <span
            className={styles.readoutSwatch}
            style={{ background: colorFor(e.channelId) }}
            aria-hidden
          />
          <span className={styles.readoutLabel}>{e.shortLabel}</span>
          {e.sourceBadge && (
            <span className={styles.readoutBadge}>{e.sourceBadge}</span>
          )}
          <span className={`${styles.readoutValue} ${styles.numCell}`}>
            {e.value ?? "—"}
            {e.value !== null && e.unit ? (
              <span className={styles.readoutUnit}> {e.unit}</span>
            ) : null}
          </span>
        </span>
      ))}
    </div>
  );
}

/** Format a numeric value compactly enough to fit in the readout strip
 *  while keeping it precise enough to be useful. Picks notation by
 *  magnitude — fixed for typical engineering values, exponential for
 *  very large or very small ones. Public so unit tests can assert it. */
export function formatReadoutValue(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-3) return value.toExponential(2);
  // Three significant digits keeps `100.123` readable as `100` while
  // not flattening `0.012` to `0.0`.
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toFixed(3);
}
