// Compact, source-aware channel chip for the Plot panel header (UX
// overhaul issues #1, #2, #7).
//
// Renders a single bound channel as a pill containing:
//   - a colour swatch (exact line stroke colour from `palette.colorFor`)
//   - a short label (last `/`-delimited segment by default — full name
//     and unit available on hover)
//   - an optional source badge so users can disambiguate chips that
//     share a name across files / segments
//   - a remove button (`×`)
//
// The chip is a span (not a button) so the remove control's click target
// is unambiguous and the chip itself can carry a `title` tooltip with
// the full path. Width is bounded by CSS so a long topic name does not
// take over the panel header.

import type { Channel } from "../state/store";
import { colorFor, colorForSource, dashForIndex } from "./palette";
import { fullChannelLabel, shortChannelLabel } from "./channelLabels";
import styles from "./PlotPanel.module.css";

interface Props {
  channel: Channel;
  /** Empty string disables the badge; non-empty renders the short stem. */
  sourceBadge: string;
  onRemove: (id: string) => void;
  /** Iter4 alignment item #5 — when the chip overflow detector pushes
   *  this chip out of the visible row, mark it hidden so the wrapping
   *  `<ChipOverflow />` can list it in the popover instead. The DOM
   *  element stays in place so ResizeObserver-driven measurements
   *  remain consistent. */
  hidden?: boolean;
  /** Iter5 issue #7 — index within the bound-channel list, used to
   *  render the dash pattern in the chip swatch. */
  seriesIndex?: number;
  /** Iter5 issue #7 — total bound-channel count, gates whether the
   *  dash pattern kicks in (no dashes below DASH_THRESHOLD). */
  seriesCount?: number;
}

export function ChannelChip({
  channel,
  sourceBadge,
  onRemove,
  hidden,
  seriesIndex,
  seriesCount,
}: Props) {
  const full = fullChannelLabel(channel);
  const short = shortChannelLabel(channel);
  // Iter3 issue #2 — the chip splits into a leading source-coloured
  // ribbon (`.chipRibbon`) and the existing pill body (`.chipBody`).
  // The ribbon makes the source unmistakable at a glance even when the
  // text badge is hidden (single-source view) or invisible at small
  // panel widths. Ribbon is rendered even without a badge so the same
  // colour signal exists in single-source layouts too — but in a more
  // muted way (the ribbon doubles as a visual anchor).
  return (
    <span
      className={styles.chip}
      data-testid={`chip-${channel.id}`}
      data-chip="1"
      data-overflow-hidden={hidden ? "1" : "0"}
      style={hidden ? { display: "none" } : undefined}
      title={sourceBadge ? `${full}  ·  ${sourceBadge}` : full}
    >
      <span
        className={styles.chipRibbon}
        style={{ background: colorForSource(channel.sourceId) }}
        data-testid={`chip-ribbon-${channel.id}`}
        aria-hidden
      />
      <span className={styles.chipBody}>
        {/* Iter5 issue #7 — chip swatch now renders the trace's dash
            pattern (when active) so the chip reads exactly like the
            plotted line. The swatch is an SVG line with the same colour
            + dash array as the uPlot series. Below the dash threshold
            (4 traces) it falls back to a solid colour line, matching
            the trace. */}
        <ChipSwatch
          color={colorFor(channel.id)}
          dash={
            typeof seriesIndex === "number" && typeof seriesCount === "number"
              ? dashForIndex(seriesIndex, seriesCount)
              : []
          }
          data-testid={`chip-swatch-${channel.id}`}
        />
        <span className={styles.chipLabel}>{short}</span>
        {channel.unit && (
          <span className={styles.chipUnit}>{channel.unit}</span>
        )}
        {sourceBadge && (
          <span
            className={styles.chipBadge}
            data-testid={`chip-badge-${channel.id}`}
          >
            {sourceBadge}
          </span>
        )}
        <button
          type="button"
          className={styles.chipRemove}
          aria-label={`Remove channel ${channel.name}`}
          title={`Remove ${short}`}
          onClick={() => onRemove(channel.id)}
          data-testid={`remove-${channel.id}`}
        >
          ×
        </button>
      </span>
    </span>
  );
}

/** Iter5 issue #7 — chip swatch that mirrors the trace's stroke
 *  pattern. Renders as a 10×10 SVG with a single horizontal stroke
 *  through the middle; `dash` is the uPlot-style `[on, off, …]`
 *  pixel array (empty array → solid). The colour matches the trace
 *  exactly so the chip and the line agree on both hue *and* texture.
 *
 *  Kept inline in this file because it's the only consumer; promoting
 *  it would force a separate test file for what is effectively one
 *  SVG path. */
interface ChipSwatchProps {
  color: string;
  dash: readonly number[];
  "data-testid"?: string;
}
function ChipSwatch({
  color,
  dash,
  "data-testid": testId,
}: ChipSwatchProps) {
  const dashAttr = dash.length > 0 ? dash.join(" ") : undefined;
  return (
    <svg
      className={styles.chipSwatch}
      viewBox="0 0 10 10"
      aria-hidden
      data-testid={testId}
      data-dash={dashAttr ?? ""}
    >
      <line
        x1={0}
        y1={5}
        x2={10}
        y2={5}
        stroke={color}
        strokeWidth={2.5}
        strokeDasharray={dashAttr}
        strokeLinecap="butt"
      />
    </svg>
  );
}
