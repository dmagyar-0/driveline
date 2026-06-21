// Shared cursor → sample binary search.
//
// Several panels need the same primitive on the cursor hot path: given an
// ascending array of ns timestamps, find the last index whose timestamp is
// at-or-before the cursor (or -1 when the cursor precedes every sample).
// Previously each panel hand-rolled this (PlotPanel, ValuePanel, the inline
// EnumLane search, ScenePanel's `activeFrameIndex`, tableModel's
// `lastRowAtOrBefore`) — same loop, five copies. This is the single tested
// implementation they all call.
//
// Works over both `BigInt64Array` (the zero-copy Arrow backing buffer the
// decoders hand back) and plain `bigint[]` (the table model's row axis). The
// comparison stays in `bigint` end to end — never convert a ns timestamp to
// `Number` here (the project-wide BigInt rule).

// Anything we can index into and read a length from. Covers `BigInt64Array`
// and `bigint[]` (and `readonly bigint[]`) without copying or widening.
export interface BigIntSeq {
  readonly length: number;
  [index: number]: bigint;
}

/**
 * Largest index `i` with `tsNs[i] <= cursorNs`, or -1 if the cursor precedes
 * every sample. Assumes `tsNs` is ascending (the contract every caller relies
 * on — Arrow batches and the merged row axis are both emitted in time order).
 */
export function lastIndexAtOrBefore(tsNs: BigIntSeq, cursorNs: bigint): number {
  let lo = 0;
  let hi = tsNs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (tsNs[mid] <= cursorNs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
