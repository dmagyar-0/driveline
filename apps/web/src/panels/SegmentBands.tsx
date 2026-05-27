// Segment boundary indicator overlay for the Plot panel (iter2 issue #4).
//
// Multi-segment recordings load as multiple `SourceMeta` entries, each
// with its own `timeRange`. When two segments live on the same panel
// the user sees disconnected line fragments separated by empty x-axis
// stretches — visually identical to "this channel had a long gap"
// without any indication that the gap is actually a segment boundary.
//
// This overlay paints one subtly-coloured band per segment over the
// plot canvas, alternating tones, with a small "S<n>" label inside.
// The transport bar gets its own segment markers; both surfaces agree
// on numbering so the user can correlate them at a glance.
//
// Implementation notes:
//   - Pure component. Caller supplies the projected band geometries
//     (left % / width % inside the plot canvas bbox) and a flag-set so
//     this file owns no DOM measurement or store reads.
//   - When `bands` is empty the component returns `null`. The caller is
//     responsible for the "log a console warning when no segment
//     metadata is available" path; SegmentBands stays presentational.
//   - `pointer-events: none` so the bands never steal click/hover from
//     the canvas underneath.

import { useId } from "react";
import styles from "./PlotPanel.module.css";

export interface SegmentBand {
  /** Identifies the source/segment. Used as a React key. */
  id: string;
  /** Display label, e.g. `S1`, `S4`. Kept short — the band area is
   *  visually quiet by design. */
  label: string;
  /** Left edge as a fraction of the plot bbox width (0..1). */
  leftFrac: number;
  /** Width as a fraction of the plot bbox width (0..1). */
  widthFrac: number;
  /** Hover tooltip text — usually the source filename + time range. */
  title: string;
}

export interface SegmentBandsProps {
  bands: SegmentBand[];
  /** Plot canvas inner bbox, in CSS px relative to the parent
   *  `.plotArea` container. The component scales bands into this rect
   *  so the bands sit precisely over the drawn series. */
  bboxLeftPx: number;
  bboxTopPx: number;
  bboxWidthPx: number;
  bboxHeightPx: number;
}

export function SegmentBands({
  bands,
  bboxLeftPx,
  bboxTopPx,
  bboxWidthPx,
  bboxHeightPx,
}: SegmentBandsProps) {
  // useId only to satisfy the no-default-export ESM convention; React's
  // reconciler keys handle band-level uniqueness via `band.id`.
  void useId();
  if (bands.length === 0) return null;
  if (bboxWidthPx <= 0 || bboxHeightPx <= 0) return null;
  return (
    <div
      className={styles.segmentBands}
      data-testid="plot-segment-bands"
      aria-hidden
      style={{
        left: bboxLeftPx,
        top: bboxTopPx,
        width: bboxWidthPx,
        height: bboxHeightPx,
      }}
    >
      {bands.map((b, i) => {
        // Clip to [0,1] before scaling — guards against any
        // out-of-range projection (e.g. a segment that starts before
        // the global range).
        const leftFrac = Math.max(0, Math.min(1, b.leftFrac));
        const widthFrac = Math.max(0, Math.min(1 - leftFrac, b.widthFrac));
        const widthPx = widthFrac * bboxWidthPx;
        // Hide bands too narrow to label legibly (≤16 px).
        if (widthPx <= 1) return null;
        const labelVisible = widthPx >= 24;
        return (
          <div
            key={b.id}
            className={`${styles.segmentBand} ${i % 2 === 0 ? styles.segmentBandEven : styles.segmentBandOdd}`}
            data-testid={`segment-band-${b.id}`}
            data-segment-index={i}
            title={b.title}
            style={{
              left: `${leftFrac * 100}%`,
              width: `${widthFrac * 100}%`,
            }}
          >
            {labelVisible && (
              <span className={styles.segmentBandLabel}>{b.label}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Format a `bigint` nanosecond timestamp as `mm:ss.SSS` relative to the
 *  session origin. Exported so the panel can build segment titles and
 *  the cursor-tooltip's time line with one helper. */
export function formatSegmentTime(ns: bigint, originNs: bigint): string {
  const totalMs = Number((ns - originNs) / 1_000_000n);
  const negative = totalMs < 0;
  const abs = Math.abs(totalMs);
  const ms = abs % 1000;
  const totalSec = Math.floor(abs / 1000);
  const sec = totalSec % 60;
  const min = Math.floor(totalSec / 60);
  const stamp = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
  return negative ? `-${stamp}` : stamp;
}
