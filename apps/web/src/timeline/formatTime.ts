// Transport-bar time formatting. Arithmetic stays in `bigint` until the
// final ms → components split, so sub-second precision is preserved even
// for nanosecond inputs beyond `Number.MAX_SAFE_INTEGER`.

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function pad3(n: number): string {
  return n.toString().padStart(3, "0");
}

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

export function formatRelative(ns: bigint, startNs: bigint): string {
  return formatDuration(ns >= startNs ? ns - startNs : 0n);
}

// Shared relative/absolute toggle. Owned by the store so the Transport
// readout and the PlotPanel x-axis stay in lockstep — both format their
// labels with the helpers in this module under the same mode.
export type TimeMode = "relative" | "absolute";

// Format a uPlot x-axis tick to match the Transport readout. uPlot hands
// us tick positions in x-scale units — epoch seconds (possibly
// fractional), since the plot's x data is `Number(ns) / 1e9`. We round to
// the millisecond and rebuild a `bigint` ns so the same `formatDuration` /
// `formatAbsolute` helpers drive both surfaces. `startSec` is the session
// start in epoch seconds (the relative origin); ignored in absolute mode.
export function formatAxisTick(
  tickSec: number,
  startSec: number,
  mode: TimeMode,
): string {
  if (mode === "absolute") {
    // Build ns from ms (`tickSec * 1000` stays inside Number's
    // safe-integer range) so we keep wall-clock precision without
    // pushing `epochSec * 1e9` past 2^53.
    const ns = BigInt(Math.round(tickSec * 1000)) * 1_000_000n;
    return formatAbsolute(ns);
  }
  const relMs = Math.max(0, Math.round((tickSec - startSec) * 1000));
  return formatDuration(BigInt(relMs) * 1_000_000n);
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
