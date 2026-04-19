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
