// Inline (agent-pushed) data source — pure main-thread storage + ranged Arrow
// IPC, the JS-only counterpart to the worker-backed readers (McapReader, …).
//
// Driveline's "Bring Your Own Agent" capability (docs/13) lets ANY external
// agent driving the live page push columnar channel data straight into the
// session through `window.__drivelineAgent.addDataSource`. There is no file, no
// URL fetch, and no Rust reader involved: the data is the agent's own bounded
// in-memory dataset, held here keyed by source id → native channel id, and
// served back the same way every panel already consumes data — as ranged Arrow
// IPC over `[startNs, endNs)`.
//
// The Arrow batches built here match the EXACT scalar/enum schema
// `seriesFromArrow.ts` (`decodeSeries`) validates, so an inline source is
// indistinguishable to the panels from an MCAP/MF4 one:
//
//   scalar → { ts: Timestamp(ns, UTC) [BigInt64], value: Float64 }
//   enum   → { ts: Timestamp(ns, UTC) [BigInt64], code:  Int32  }
//
// Contract rules:
//   - Timestamps are stored as `BigInt64Array` (the project-wide BigInt rule —
//     ns exceed 2^53 so they never live in a JS `number`).
//   - `fetchRange` returns only samples in `[startNs, endNs)`; with
//     `includePrev` it ALSO prepends the last sample with `ts < startNs`
//     (step-hold), matching the worker readers so a cursor parked mid-gap still
//     draws the held value.

import {
  Table,
  makeData,
  makeVector,
  tableToIPC,
  Float64,
  Int32,
  Timestamp,
  TimeUnit,
} from "apache-arrow";

export type InlineChannelKind = "scalar" | "enum";

/** One inline channel's columnar storage. `values` is `Float64Array` for a
 *  scalar channel and `Int32Array` for an enum channel; `tsNs` is always the
 *  BigInt64 timestamp column, non-decreasing and of equal length. */
export interface InlineChannelData {
  kind: InlineChannelKind;
  tsNs: BigInt64Array;
  values: Float64Array | Int32Array;
}

// sourceId → (nativeId → channel data). Module-scoped so it survives across
// store actions but is wiped by `reset()` (called from the store's `clear()`).
const store = new Map<string, Map<string, InlineChannelData>>();

/** Replace one source's channel set wholesale. Called once when a source is
 *  registered; inline sources are immutable after `addInlineSource`. */
export function setInlineSource(
  sourceId: string,
  channels: Map<string, InlineChannelData>,
): void {
  store.set(sourceId, channels);
}

/** Drop one inline source's stored data (used by `removeSource`). */
export function dropInlineSource(sourceId: string): void {
  store.delete(sourceId);
}

/** Wipe all inline storage. Called from the store's `clear()`. */
export function resetInlineSources(): void {
  store.clear();
}

/** Whether a given source id has inline storage (test/diagnostic seam). */
export function hasInlineSource(sourceId: string): boolean {
  return store.has(sourceId);
}

// Lower bound: first index `i` with `tsNs[i] >= target`. Standard binary search
// over the non-decreasing timestamp column.
function lowerBound(tsNs: BigInt64Array, target: bigint): number {
  let lo = 0;
  let hi = tsNs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tsNs[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A Timestamp(ns, UTC) Arrow vector over a BigInt64 buffer — the `ts` column
 *  shape `decodeSeries` validates. */
function tsVector(ts: BigInt64Array) {
  return makeVector(
    makeData({ type: new Timestamp(TimeUnit.NANOSECOND, "UTC"), data: ts }),
  );
}

/** Build the empty scalar batch — the shape `decodeSeries` reads as "no data
 *  in range" (zero rows). */
function emptyBatchBytes(): Uint8Array {
  const table = new Table({
    ts: tsVector(new BigInt64Array(0)),
    value: makeVector(
      makeData({ type: new Float64(), data: new Float64Array(0) }),
    ),
  });
  return tableToIPC(table, "stream");
}

/**
 * Serve `[startNs, endNs)` of one inline channel as Arrow IPC (stream format —
 * `tableFromIPC` accepts it). Returns only samples in the half-open window;
 * with `includePrev` ALSO prepends the last sample with `ts < startNs`
 * (step-hold). A degenerate window (`endNs <= startNs`) yields an empty batch.
 *
 * Returns `null` for an unknown source/channel so callers can branch.
 */
export function fetchRange(
  sourceId: string,
  nativeId: string,
  startNs: bigint,
  endNs: bigint,
  includePrev: boolean,
): Uint8Array | null {
  const channels = store.get(sourceId);
  if (!channels) return null;
  const ch = channels.get(nativeId);
  if (!ch) return null;

  // Clamp a degenerate / inverted window to empty rather than guessing intent.
  if (endNs <= startNs && !includePrev) return emptyBatchBytes();

  const ts = ch.tsNs;
  // First sample with ts >= startNs, and first with ts >= endNs: the in-window
  // half-open slice is [from, to).
  const from = lowerBound(ts, startNs);
  const to = endNs > startNs ? lowerBound(ts, endNs) : from;

  // Step-hold: prepend the last sample strictly before the window, if any.
  const prevIdx = includePrev && from > 0 ? from - 1 : -1;

  const indices: number[] = [];
  if (prevIdx >= 0) indices.push(prevIdx);
  for (let i = from; i < to; i++) indices.push(i);

  if (indices.length === 0) return emptyBatchBytes();

  const n = indices.length;
  const outTs = new BigInt64Array(n);
  for (let i = 0; i < n; i++) outTs[i] = ts[indices[i]];

  if (ch.kind === "enum") {
    const src = ch.values as Int32Array;
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++) out[i] = src[indices[i]];
    const table = new Table({
      ts: tsVector(outTs),
      code: makeVector(makeData({ type: new Int32(), data: out })),
    });
    return tableToIPC(table, "stream");
  }

  const src = ch.values as Float64Array;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = src[indices[i]];
  const table = new Table({
    ts: tsVector(outTs),
    value: makeVector(makeData({ type: new Float64(), data: out })),
  });
  return tableToIPC(table, "stream");
}
