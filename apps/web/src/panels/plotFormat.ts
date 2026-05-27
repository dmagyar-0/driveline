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
