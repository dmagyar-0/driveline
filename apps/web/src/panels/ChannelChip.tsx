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
import { colorFor } from "./palette";
import { fullChannelLabel, shortChannelLabel } from "./channelLabels";
import styles from "./PlotPanel.module.css";

interface Props {
  channel: Channel;
  /** Empty string disables the badge; non-empty renders the short stem. */
  sourceBadge: string;
  onRemove: (id: string) => void;
}

export function ChannelChip({ channel, sourceBadge, onRemove }: Props) {
  const full = fullChannelLabel(channel);
  const short = shortChannelLabel(channel);
  return (
    <span
      className={styles.chip}
      data-testid={`chip-${channel.id}`}
      title={sourceBadge ? `${full}  ·  ${sourceBadge}` : full}
    >
      <span
        className={styles.chipSwatch}
        style={{ background: colorFor(channel.id) }}
        aria-hidden
      />
      <span className={styles.chipLabel}>{short}</span>
      {channel.unit && <span className={styles.chipUnit}>{channel.unit}</span>}
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
        aria-label={`remove ${channel.name}`}
        onClick={() => onRemove(channel.id)}
        data-testid={`remove-${channel.id}`}
      >
        ×
      </button>
    </span>
  );
}
