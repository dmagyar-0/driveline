// Floating cursor-value tooltip for the Plot panel (iter2 issue #1).
//
// The under-plot strip (`CursorReadout`) survives as a persistent
// secondary readout — useful for at-a-glance reference when the panel
// is wide. The audit found it insufficient on its own: when the user
// scrubs the playhead they look at the orange crosshair, not at the
// strip below the canvas. A tooltip anchored to the playhead puts the
// answer where the eye is already pointed.
//
// Positioning rules:
//   - Anchored to the cursor X (in CSS pixels relative to the plot
//     container). The vertical offset stays near the top of the plot
//     area so the tooltip never overlaps the readout strip below or
//     the panel-chrome above.
//   - If anchoring on the right would push the tooltip past the panel
//     edge, flip it to the left of the cursor. Symmetric flip when the
//     cursor is on the far left.
//   - When the cursor falls outside the rendered range the tooltip is
//     omitted entirely (caller passes `x = null`).
//
// Hot-path discipline: this is a pure-presentational component; it
// receives a memoized `entries` array (already used by the strip) and
// a numeric `x`. No DOM measurement at render time — the flip decision
// uses the container width supplied by the parent's ResizeObserver. A
// re-render happens at most once per cursor tick (≤1 per rAF in the
// panel's hot path).

import { colorFor } from "./palette";
import type { CursorReadoutEntry } from "./CursorReadout";
import styles from "./PlotPanel.module.css";

export interface CursorTooltipProps {
  /** Cursor pixel offset inside the plot container (CSS px from the
   *  container's left edge), or `null` to hide the tooltip. */
  xPx: number | null;
  /** Container width in CSS px — used to decide whether to flip the
   *  tooltip to the cursor's left. */
  containerWidthPx: number;
  /** Time stamp at the cursor, pre-formatted. `null` hides the header. */
  timeLabel: string | null;
  /** Per-bound-channel readout entries, same shape as the strip. */
  entries: CursorReadoutEntry[];
}

// Empirical tooltip width (matches the CSS `max-width`). The flip
// decision needs a number; we pick the upper bound rather than measure
// because measuring forces synchronous layout and the tooltip is
// recreated every cursor tick.
const TOOLTIP_MAX_WIDTH_PX = 240;
// Gap between the cursor line and the tooltip's near edge.
const ANCHOR_GAP_PX = 8;
// Vertical offset from the top of the plot area. Sits below the
// panel-chrome and chip row without touching the canvas baseline.
const TOOLTIP_TOP_PX = 6;

export function CursorTooltip({
  xPx,
  containerWidthPx,
  timeLabel,
  entries,
}: CursorTooltipProps) {
  if (xPx === null || entries.length === 0) return null;

  // Decide which side to anchor on. Prefer the right (`left: x + gap`)
  // so values appear ahead of the cursor in left-to-right scan order.
  // If that would clip the panel, flip.
  const rightAnchorLeft = xPx + ANCHOR_GAP_PX;
  const rightAnchorFits =
    rightAnchorLeft + TOOLTIP_MAX_WIDTH_PX <= containerWidthPx;
  const left = rightAnchorFits
    ? rightAnchorLeft
    : Math.max(0, xPx - ANCHOR_GAP_PX - TOOLTIP_MAX_WIDTH_PX);

  return (
    <div
      className={styles.cursorTooltip}
      data-testid="plot-cursor-tooltip"
      style={{ left, top: TOOLTIP_TOP_PX }}
      role="tooltip"
      aria-live="off"
    >
      {timeLabel && (
        <div className={styles.cursorTooltipTime}>{timeLabel}</div>
      )}
      <ul className={styles.cursorTooltipList}>
        {entries.map((e) => (
          <li
            key={e.channelId}
            className={styles.cursorTooltipRow}
            data-testid={`tooltip-row-${e.channelId}`}
          >
            <span
              className={styles.cursorTooltipSwatch}
              style={{ background: colorFor(e.channelId) }}
              aria-hidden
            />
            <span className={styles.cursorTooltipLabel}>
              {e.shortLabel}
              {e.sourceBadge && (
                <span
                  className={styles.cursorTooltipBadge}
                  data-testid={`tooltip-badge-${e.channelId}`}
                >
                  {e.sourceBadge}
                </span>
              )}
            </span>
            <span className={styles.cursorTooltipValue}>
              {e.value ?? "—"}
              {e.value !== null && e.unit ? (
                <span className={styles.cursorTooltipUnit}> {e.unit}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Decide where to anchor the tooltip. Exported for unit tests so we
 *  can exercise both branches without rendering the component. */
export function tooltipLeft(
  xPx: number,
  containerWidthPx: number,
  tooltipWidthPx: number = TOOLTIP_MAX_WIDTH_PX,
  gapPx: number = ANCHOR_GAP_PX,
): number {
  const rightAnchorLeft = xPx + gapPx;
  if (rightAnchorLeft + tooltipWidthPx <= containerWidthPx) {
    return rightAnchorLeft;
  }
  return Math.max(0, xPx - gapPx - tooltipWidthPx);
}
