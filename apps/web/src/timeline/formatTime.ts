// Transport-bar time formatting. Arithmetic stays in `bigint` until the
// final ms → components split, so sub-second precision is preserved even
// for nanosecond inputs beyond `Number.MAX_SAFE_INTEGER`.
//
// Issue #6 (UX overhaul) — formatters here are the single source of
// truth for time in the app. The Transport reads `timeMode` from the
// store and renders the right helper; PlotPanel reads the same flag
// and asks for `uPlotAxisValues(timeMode, startNs)` so X-axis ticks
// match the readout above. There is exactly one knob.

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

/** `MM:SS.mmm`, prefixed with `HH:` past the hour boundary. */
export function formatDuration(ns: bigint): string {
  const nonNeg = ns < 0n ? 0n : ns;
  const totalMs = nonNeg / 1_000_000n;
  const ms = Number(totalMs % 1000n);
  const totalSec = totalMs / 1000n;
  const s = Number(totalSec % 60n);
  const totalMin = totalSec / 60n;
  const m = Number(totalMin % 60n);
  const h = Number(totalMin / 60n);

  const core = `${pad2(m)}:${pad2(s)}.${pad3(ms)}`;
  return h > 0 ? `${pad2(h)}:${core}` : core;
}

/** Like `formatDuration`, but no fractional seconds — used by axis ticks
 *  where every minor tick already prints `.000` and the noise is wasted
 *  ink. */
export function formatDurationCoarse(ns: bigint): string {
  const nonNeg = ns < 0n ? 0n : ns;
  const totalSec = nonNeg / 1_000_000_000n;
  const s = Number(totalSec % 60n);
  const totalMin = totalSec / 60n;
  const m = Number(totalMin % 60n);
  const h = Number(totalMin / 60n);
  return h > 0 ? `${pad2(h)}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
}

export function formatRelative(ns: bigint, startNs: bigint): string {
  return formatDuration(ns >= startNs ? ns - startNs : 0n);
}

// Wall-clock absolute readout; `YYYY-MM-DD HH:MM:SS.mmm`. Split the
// millisecond component off in bigint space so we don't round through
// `Date` — then format the date part from the integer ms value.
export function formatAbsolute(ns: bigint): string {
  const totalMs = ns / 1_000_000n;
  const d = new Date(Number(totalMs));
  const yyyy = d.getUTCFullYear().toString().padStart(4, "0");
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  const ms = pad3(d.getUTCMilliseconds());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

/** Compact wall-clock for axis ticks (no date, no ms). Example: `06:08:42`. */
export function formatAbsoluteClock(ns: bigint): string {
  const totalMs = ns / 1_000_000n;
  const d = new Date(Number(totalMs));
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(
    d.getUTCSeconds(),
  )}`;
}

/** YYYY-MM-DD prefix only — used as a footer beneath the relative-axis
 *  ticks so users still know *which day* the data is from. */
export function formatDate(ns: bigint): string {
  const totalMs = ns / 1_000_000n;
  const d = new Date(Number(totalMs));
  return (
    `${d.getUTCFullYear().toString().padStart(4, "0")}-` +
    `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
  );
}

/** Iteration 3 (issue #1) — canonical playhead format.
 *
 * The transport bar previously stacked TWO readouts on the playhead
 * (e.g. `00:03.999` over `00:00:03`), which the designer flagged as
 * redundant. Pick ONE canonical format and rely on the hover tooltip
 * to surface the alternate convention.
 *
 * Rule:
 *   - relative mode: always `formatDuration` (HH:MM:SS.mmm ≥1h, else MM:SS.mmm).
 *   - absolute mode: always wall-clock with millis (HH:MM:SS.mmm).
 *
 * Both branches now include the millis so the readout never drops
 * precision mid-scrub — a major usability win when comparing two
 * playheads or matching a video frame.
 */
export function formatPlayheadPrimary(
  ns: bigint,
  startNs: bigint,
  mode: "relative" | "absolute",
): string {
  if (mode === "relative") return formatRelative(ns, startNs);
  // Wall-clock with millis (24h). Mirrors formatAbsolute but no date.
  const totalMs = ns / 1_000_000n;
  const d = new Date(Number(totalMs));
  return (
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:` +
    `${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`
  );
}

/** The *other* convention from `formatPlayheadPrimary`, used by the
 *  hover tooltip's sub-line so a hovering user can still read time in
 *  whichever frame they aren't currently anchored on. */
export function formatPlayheadSecondary(
  ns: bigint,
  startNs: bigint,
  mode: "relative" | "absolute",
): string {
  return mode === "relative"
    ? formatPlayheadPrimary(ns, startNs, "absolute")
    : formatPlayheadPrimary(ns, startNs, "relative");
}

export type TimeMode = "relative" | "absolute";

/**
 * Build a uPlot `axis.values` callback that formats X-axis ticks
 * according to `mode`. uPlot passes a Float64Array of tick values in
 * Unix seconds; we convert to bigint ns and dispatch to the matching
 * formatter. `startSec` is only used in `"relative"` mode as the
 * zero-anchor of the session.
 *
 * Shared by every Plot panel so two plots on the same dataset cannot
 * end up showing different conventions (Issue #6 — UX overhaul).
 *
 * Returns a `splits => string[]` callable; uPlot's type signature for
 * `axis.values` is `(self, splits, axisIdx, foundSpace, foundIncr) =>
 * string[]`, but we ignore everything except `splits`.
 */
export function uPlotAxisValues(
  mode: TimeMode,
  startSec: number,
): (splits: number[]) => string[] {
  if (mode === "absolute") {
    return (splits) =>
      splits.map((sec) => {
        // Seconds-since-epoch from the merged session is well within
        // Number.MAX_SAFE_INTEGER even for 2106; safe to multiply.
        const ns = BigInt(Math.round(sec * 1_000_000_000));
        return formatAbsoluteClock(ns);
      });
  }
  return (splits) =>
    splits.map((sec) => {
      const offsetSec = sec - startSec;
      const ns = BigInt(Math.round(offsetSec * 1_000_000_000));
      return formatDurationCoarse(ns);
    });
}
