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
import { colorFor, colorForSource } from "./palette";
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
      title={sourceBadge ? `${full}  ·  ${sourceBadge}` : full}
    >
      <span
        className={styles.chipRibbon}
        style={{ background: colorForSource(channel.sourceId) }}
        data-testid={`chip-ribbon-${channel.id}`}
        aria-hidden
      />
      <span className={styles.chipBody}>
        <span
          className={styles.chipSwatch}
          style={{ background: colorFor(channel.id) }}
          aria-hidden
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
