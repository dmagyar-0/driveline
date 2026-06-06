// Pure helper for Feature 2 — per-source time offset, applied at the
// `fetchChannelRange` boundary only (never on the cursor/video hot path).
//
// A signal source can carry a `timeOffsetNs` offset `O`: the reader is queried
// with a window shifted back by `O` (`[start - O, end - O]`), and every sample
// timestamp it returns is shifted forward by `O` before it reaches a panel, so
// the source's clock lines up with the session timeline. The window maths is a
// pair of `bigint` subtractions (see `shiftFetchWindow`); the returned-sample
// shift rewrites the Arrow `ts` column in place (see `shiftRangeArrowTs`).
//
// Everything here is a cheap `bigint` add — no `Number` narrowing of a ns
// timestamp ever happens, so full precision (~1.7e18) survives.

import { tableFromIPC, tableToIPC } from "apache-arrow";

/**
 * Shift the fetch window back by `offsetNs` so a source whose samples will be
 * pushed forward by `offsetNs` is queried for the range that, once shifted,
 * covers `[startNs, endNs)`. A zero offset returns the input window unchanged.
 */
export function shiftFetchWindow(
  startNs: bigint,
  endNs: bigint,
  offsetNs: bigint,
): { startNs: bigint; endNs: bigint } {
  if (offsetNs === 0n) return { startNs, endNs };
  return { startNs: startNs - offsetNs, endNs: endNs - offsetNs };
}

/**
 * Add `offsetNs` to every value of the Arrow batch's `ts` column and return the
 * re-encoded IPC bytes. A zero offset returns the input bytes unchanged (no
 * decode/re-encode). The shift mutates the decoded table's `ts` backing buffer
 * (a `BigInt64Array`) in place — a fresh table is parsed from `bytes` each
 * call, so this never touches a buffer a panel already holds.
 *
 * Tolerant by design: a batch with no `ts` column, an empty batch, or a `ts`
 * column whose backing buffer isn't `BigInt64` is returned unchanged rather
 * than throwing — the offset is a best-effort alignment, not a hard contract,
 * and `decodeSeries` already reports genuinely malformed batches downstream.
 */
export function shiftRangeArrowTs(
  bytes: Uint8Array,
  offsetNs: bigint,
): Uint8Array {
  if (offsetNs === 0n || bytes.length === 0) return bytes;
  const table = tableFromIPC(bytes);
  if (table.numRows === 0) return bytes;
  const tsCol = table.getChild("ts");
  if (!tsCol) return bytes;
  let shifted = false;
  // A ranged batch is normally a single chunk, but handle multi-chunk too so
  // the offset is applied uniformly regardless of how the reader batched it.
  for (const chunk of tsCol.data) {
    const values: unknown = chunk.values;
    if (values instanceof BigInt64Array) {
      for (let i = 0; i < values.length; i++) values[i] += offsetNs;
      shifted = true;
    }
  }
  if (!shifted) return bytes;
  return tableToIPC(table);
}
