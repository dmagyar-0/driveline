// Shared formatting helpers for the Plot panel (iter3 issues #3 and #6).
//
// Engineers expect 24-hour time and decimal-aligned values; iter2 served
// up `6:08am` in axis labels alongside `06:04:30` in the cursor card,
// and used proportional digits everywhere so columns wobbled.
//
// This module hands every consumer (cursor gutter, cursor readout strip,
// uPlot X-axis, uPlot Y-axis tick formatter, segment titles) the same
// helpers so the panel cannot drift between surfaces.

/** Format an absolute nanosecond timestamp as 24-hour `HH:MM:SS`. The
 *  Plot panel uses this everywhere it would otherwise inherit uPlot's
 *  default 12-hour `h:mm:ssam` formatting (iter3 issue #6). */
export function formatTime24h(tsNs: bigint): string {
  const ms = Number(tsNs / 1_000_000n);
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Format a nanosecond timestamp relative to a session origin as 24-hour
 *  `HH:MM:SS`. The fractional component is dropped on purpose — the
 *  cursor gutter and tooltip already carry a separate `ms` line when
 *  sub-second precision matters. */
export function formatRelativeTime24h(ns: bigint, originNs: bigint): string {
  const totalSec = Number((ns - originNs) / 1_000_000_000n);
  const sign = totalSec < 0 ? "-" : "";
  const abs = Math.abs(totalSec);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  return `${sign}${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/** uPlot X-axis tick formatter — replaces the mixed-case default with a
 *  strictly 24-hour `HH:MM:SS` rendering. Receives seconds-since-epoch
 *  values from uPlot. */
export function formatAxisTime24h(secs: number): string {
  const d = new Date(secs * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Iter3 issue #3 — decimal-aligned value renderer. Picks a sensible
 *  fixed-decimal precision from the unit string so columns of values
 *  read clean. Always returns a string with the chosen decimals so
 *  `padStart`/`text-align: right` produces aligned numeric columns.
 *
 *  Heuristics, ordered:
 *    - angles (deg, °) → 1 dp
 *    - velocities (m/s, km/h, mph) → 2 dp
 *    - accelerations / rates (m/s^2, rad/s) → 3 dp
 *    - large pressures, RPM → 0 dp
 *    - currents/voltages (A, V) → 2 dp
 *    - default → 3 dp for sub-thousand, 0 dp for ≥1000
 */
export function decimalsForUnit(unit: string | null | undefined): number {
  if (!unit) return DEFAULT_DECIMALS;
  const u = unit.toLowerCase().trim();
  if (u === "deg" || u === "°") return 1;
  if (u === "rpm" || u === "hpa" || u === "kpa" || u === "bar" || u === "pa")
    return 0;
  if (u === "m/s" || u === "km/h" || u === "kmh" || u === "mph") return 2;
  if (u === "m/s^2" || u === "m/s²" || u === "rad/s" || u === "rad/s^2")
    return 3;
  if (u === "a" || u === "v" || u === "ma" || u === "mv") return 2;
  return DEFAULT_DECIMALS;
}

export const DEFAULT_DECIMALS = 2;

/** Format `value` to a fixed-decimal string keyed to `unit`. Returns
 *  the em-dash placeholder when the value is non-finite. */
export function formatFixedForUnit(
  value: number,
  unit: string | null | undefined,
): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(decimalsForUnit(unit));
}

/** uPlot `axis.values` formatter that always prints N decimals when
 *  the scale resolution is sub-integer (iter3 issue #4). uPlot's
 *  default trims trailing zeros, producing ladders like
 *  `33, 33.4, 33.6, 33.8` — `33` reads as missing a decimal next to
 *  its siblings. Force every tick to wear the same coat. */
export function makeAxisValueFormatter(
  decimalsHint?: number,
): (_self: unknown, splits: number[]) => string[] {
  return (_self, splits) => {
    if (splits.length === 0) return [];
    // Pick decimals: explicit hint wins, otherwise derive from the
    // smallest gap between consecutive splits. Sub-integer gaps lean
    // on the gap's log10; integer gaps print whole numbers.
    let decimals = decimalsHint ?? 0;
    if (decimalsHint === undefined) {
      let minGap = Infinity;
      for (let i = 1; i < splits.length; i++) {
        const g = Math.abs(splits[i] - splits[i - 1]);
        if (g > 0 && g < minGap) minGap = g;
      }
      if (Number.isFinite(minGap) && minGap < 1) {
        // gap 0.5 → 1 dp, 0.1 → 1 dp, 0.05 → 2 dp, 0.01 → 2 dp.
        decimals = Math.min(6, Math.max(1, Math.ceil(-Math.log10(minGap))));
      }
    }
    return splits.map((v) => v.toFixed(decimals));
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Iter5 issue #4 — format a duration in nanoseconds as a compact
 *  `m:ss` or `Hh Mm` string for the in-chart title delta marker. The
 *  output is intentionally short so the overlay sits inside the
 *  canvas's upper-left corner without competing with the data. */
export function formatDurationCompact(deltaNs: bigint): string {
  if (deltaNs < 0n) return "—";
  const totalSec = Number(deltaNs / 1_000_000_000n);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) {
    return sec === 0 ? `${totalMin}m` : `${totalMin}m ${sec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min === 0 ? `${hours}h` : `${hours}h ${min}m`;
}

/** Iter5 issue #3 — time-axis tick ladder.
 *
 *  The audit found only two labels (`06:04:00`, `06:04:30`) for a 30 s
 *  window — uPlot's auto-picker prefers fewer, well-spaced labels, but
 *  for engineers reading a screenshot the bare ladder gives no sense
 *  of intermediate timing. We replace the auto-picker with an
 *  explicit major/minor scheme:
 *
 *    - **majors** every 10 s by default (one labelled tick),
 *    - **minors** every 2 s in between (unlabelled — drawn as the
 *      lighter `axis.ticks` segments).
 *
 *  The numbers are picked from a 1/2/5/10 family scaled by the visible
 *  span so a 5-minute window snaps to majors every 60 s, a 30-second
 *  window to majors every 10 s, and a 3-second window to majors every
 *  1 s. The function returns *all* tick positions in seconds-since-
 *  epoch (uPlot's units for time scales) plus the major tick subset
 *  so the values-formatter can know which to label.
 *
 *  Exported so the axis-builder + unit tests share one source of truth. */
export interface TimeAxisTicks {
  /** All tick positions (major + minor), sorted ascending. */
  all: number[];
  /** Subset of `all` that should carry a label. */
  majors: Set<number>;
}

export function timeAxisTicks(
  minSec: number,
  maxSec: number,
): TimeAxisTicks {
  if (
    !Number.isFinite(minSec) ||
    !Number.isFinite(maxSec) ||
    maxSec <= minSec
  ) {
    return { all: [], majors: new Set() };
  }
  const span = maxSec - minSec;
  // Pick a "nice" major interval from the 1/2/5/10·10^n family so the
  // ladder always has 3–5 labelled ticks regardless of zoom level.
  const targetMajors = 5;
  const { majorInc, minorInc } = pickTimeIncrements(span, targetMajors);

  // Snap to nearest minor below start so the first tick falls on a
  // round-number boundary (06:04:00 rather than 06:04:03).
  const start = Math.ceil(minSec / minorInc) * minorInc;
  const all: number[] = [];
  const majors = new Set<number>();
  // Floating-point tolerance for the major check — at 1 µs the rounded
  // tick can drift below the modulo boundary.
  const eps = minorInc * 1e-6;
  for (let t = start; t <= maxSec + eps; t += minorInc) {
    // Snap to grid so `t / majorInc` doesn't drift by a smidge.
    const snapped = Math.round(t / minorInc) * minorInc;
    all.push(snapped);
    const ratio = snapped / majorInc;
    if (Math.abs(ratio - Math.round(ratio)) < 1e-6) {
      majors.add(snapped);
    }
  }
  return { all, majors };
}

/** Choose a `(major, minor)` pair from a fixed family so the major
 *  count lands near `targetMajors` and minor count is at most 5× the
 *  major count. Exported so the helper and tests share the picker. */
export function pickTimeIncrements(
  spanSec: number,
  targetMajors: number,
): { majorInc: number; minorInc: number } {
  // Candidate (major, minor) pairs in ascending order. The minor is
  // always a fraction of the major chosen so 5–10 minors fall within
  // each major step — enough texture without overwhelming.
  const pairs: Array<[number, number]> = [
    [0.1, 0.02],
    [0.2, 0.05],
    [0.5, 0.1],
    [1, 0.2],
    [2, 0.5],
    [5, 1],
    [10, 2],
    [20, 5],
    [30, 5],
    [60, 10],
    [120, 30],
    [300, 60],
    [600, 120],
    [1800, 300],
    [3600, 600],
  ];
  for (const [maj, min] of pairs) {
    // Use a strict `<= targetMajors` test (no 1.5× headroom) so the
    // ladder picks the smallest tested increment that still keeps the
    // visible major-tick count at or below the target. This matches
    // the audit's reference points: a 30 s window picks 10 s majors
    // (3 majors), a 5-minute window picks 60 s majors (5 majors), a
    // 3 s window picks 1 s majors (3 majors).
    if (spanSec / maj <= targetMajors) {
      return { majorInc: maj, minorInc: min };
    }
  }
  // Very long windows — fall back to hourly majors with 10-min minors.
  return { majorInc: 3600, minorInc: 600 };
}
