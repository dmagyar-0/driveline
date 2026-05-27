// Compact, source-aware channel chip for the Plot panel header.
// Renders a bound channel as a pill: swatch · short label · unit ·
// optional source badge · remove button. The chip is a span (not a
// button) so the remove control's click target is unambiguous and the
// chip itself can carry a `title` tooltip with the full path.

import type { Channel } from "../state/store";
import { colorFor, colorForSource, dashForIndex } from "./palette";
import { fullChannelLabel, shortChannelLabel } from "./channelLabels";
import styles from "./PlotPanel.module.css";

interface Props {
  channel: Channel;
  /** Empty string disables the badge; non-empty renders the short stem. */
  sourceBadge: string;
  onRemove: (id: string) => void;
  /** When the chip overflow detector pushes this chip out of the
   *  visible row, mark it hidden so `<ChipOverflow />` can list it
   *  in the popover. The DOM element stays in place so the
   *  ResizeObserver measurements remain consistent. */
  hidden?: boolean;
  /** Index within the bound-channel list — drives the dash pattern. */
  seriesIndex?: number;
  /** Total bound-channel count — gates whether the dash pattern kicks
   *  in (no dashes below DASH_THRESHOLD). */
  seriesCount?: number;
  /** `L` or `R` for the axis the channel belongs to in a dual-axis
   *  plot. Empty string suppresses the badge. */
  axisSide?: "" | "L" | "R";
  /** Tint for the L/R badge so it shares the axis's identity colour
   *  from `axisGroups`. Falls back to fg-2 when undefined. */
  axisTint?: string;
}

export function ChannelChip({
  channel,
  sourceBadge,
  onRemove,
  hidden,
  seriesIndex,
  seriesCount,
  axisSide,
  axisTint,
}: Props) {
  const full = fullChannelLabel(channel);
  const short = shortChannelLabel(channel);
  // Leading source-coloured ribbon makes the source unmistakable even
  // when the text badge is hidden or invisible at small panel widths.
  // Always rendered so single-source layouts also gain a visual anchor.
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
        {/* Chip swatch renders the trace's dash pattern (when active)
            so the chip reads exactly like the plotted line. Below the
            dash threshold (4 traces) it falls back to a solid line. */}
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
        {/* Per-series L/R axis badge in dual-axis plots. Single-axis
            plots omit the badge so a one-chip panel doesn't read as
            cluttered. */}
        {axisSide && (
          <span
            className={styles.chipAxisBadge}
            data-axis-side={axisSide}
            data-testid={`chip-axis-${channel.id}`}
            style={axisTint ? { color: axisTint } : undefined}
            aria-label={`Axis ${axisSide === "L" ? "left" : "right"}`}
            title={`Plotted against ${axisSide === "L" ? "left" : "right"} axis`}
          >
            {axisSide}
          </span>
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

/** Chip swatch that mirrors the trace's stroke pattern. 10×10 SVG with
 *  a single horizontal stroke; `dash` is the uPlot-style `[on, off, …]`
 *  pixel array (empty array → solid). */
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
