// Decode an Arrow IPC scalar batch produced by `{mcap,mf4}_fetch_range` into
// the two Float64 arrays uPlot consumes. The Rust side emits
// `{ ts: Timestamp(ns, UTC), value: Float64 }`; uPlot's x-axis is numeric
// (seconds with `scales.x.time = true`), and the raw ns values exceed
// `Number.MAX_SAFE_INTEGER`, so we convert ns → seconds in a single pass.

import { tableFromIPC } from "apache-arrow";

export interface PlotSeries {
  xs: Float64Array; // seconds since epoch
  ys: Float64Array;
  // Original ns timestamps, preserved as BigInt64 so the T6.1 cross-panel
  // sync snapshot can binary-search for "the sample whose ts ≤ cursorNs"
  // without losing precision through the ns→seconds Float64 conversion.
  rawTsNs: BigInt64Array;
}

const EMPTY: PlotSeries = {
  xs: new Float64Array(),
  ys: new Float64Array(),
  rawTsNs: new BigInt64Array(),
};

export function seriesFromArrow(bytes: Uint8Array): PlotSeries {
  const table = tableFromIPC(bytes);
  if (table.numRows === 0) return EMPTY;

  const tsCol = table.getChild("ts");
  const valueCol = table.getChild("value");
  if (!tsCol || !valueCol) return EMPTY;

  // Access the raw backing buffers directly (per the T1.4 contract test):
  // `.get(i)` on a Timestamp column drops sub-ms precision via Date
  // semantics, and iterating `valueCol.get(i)` is one order of magnitude
  // slower than a typed-array copy.
  const rawTs = tsCol.data[0].values as BigInt64Array;
  const rawY = valueCol.data[0].values as Float64Array;
  const n = Math.min(rawTs.length, rawY.length);

  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = Number(rawTs[i]) / 1e9;
  // Copy ys so uPlot's retained reference never aliases the Arrow buffer.
  const ys = new Float64Array(rawY.subarray(0, n));
  // `rawTsNs` aliases the Arrow backing buffer via `subarray` — zero-copy.
  // The returned typed array retains a reference to the underlying
  // ArrayBuffer, so the Arrow table's storage stays alive for its
  // lifetime. Callers must treat it as read-only.
  const rawTsNs = rawTs.subarray(0, n);
  return { xs, ys, rawTsNs };
}
