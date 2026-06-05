// Decode an Arrow IPC batch produced by `{mcap,mf4}_fetch_range` into the
// typed arrays uPlot / the strip panels consume. The Rust core emits one of
// three schemas depending on `ChannelKind` (see `crates/data-core/src/mcap.rs`):
//
//   scalar  → { ts: Timestamp(ns, UTC), value: Float64 }
//   enum    → { ts: Timestamp(ns, UTC), code:  Int32   }
//   vector  → { ts: Timestamp(ns, UTC), value: FixedSizeList<Float64> }
//
// uPlot's x-axis is numeric (seconds with `scales.x.time = true`), and the
// raw ns values exceed `Number.MAX_SAFE_INTEGER`, so we convert ns → seconds
// in a single pass while preserving the raw ns as BigInt64 for sync lookups.
//
// Robustness contract: rather than blindly casting `data[0].values` and
// silently rendering blank on a schema/dtype mismatch, we *validate* the
// Arrow field types and return a tagged result. A genuine mismatch (wrong
// dtype, dictionary-encoded value, an unsupported vector schema in a scalar
// panel) yields `{ ok: false, reason, message }` that callers surface as a
// panel-level error instead of an empty plot. Callers that want the old
// throwing ergonomics can use `seriesFromArrowOrThrow`.

import { tableFromIPC, Type, type Table } from "apache-arrow";

// Structural shape of an Arrow column as far as this decoder needs it: a
// dtype descriptor plus the chunked backing data. Avoids leaning on
// `ReturnType<typeof tableFromIPC>` (overloaded sync/async, so its inferred
// type is a `Table | Promise<Table>` union with no `getChild`).
interface ArrowCol {
  type: {
    typeId: number;
    bitWidth?: number;
    precision?: number;
  };
  data: ReadonlyArray<{ values: ArrayLike<number> | BigInt64Array }>;
}

// Which column carried the samples. `scalar` decodes the Float64 `value`
// column; `enum` decodes the Int32 `code` column. Both share the same xs/ys
// shape so existing scalar consumers keep working unchanged.
export type SeriesKind = "scalar" | "enum";

export interface PlotSeries {
  // What the decoder found in the batch — lets a panel tell a genuine enum
  // channel from a scalar one without re-reading the schema. Optional so
  // transform/merge helpers that synthesise a `PlotSeries` from existing
  // arrays don't have to thread it through; the decoder always sets it.
  kind?: SeriesKind;
  xs: Float64Array; // seconds since epoch
  ys: Float64Array; // scalar values, or enum codes widened to Float64
  // Original ns timestamps, preserved as BigInt64 so the cross-panel sync
  // snapshot can binary-search for "the sample whose ts ≤ cursorNs" without
  // losing precision through the ns→seconds Float64 conversion.
  rawTsNs: BigInt64Array;
}

// Why a decode failed. Callers can branch on this (e.g. show "unsupported in
// this panel" differently from "corrupt/mismatched data") or just render
// `message`.
export type SeriesErrorReason =
  | "empty" // zero rows — not an error, but no series to draw
  | "missing-ts" // no `ts` column
  | "missing-value" // neither `value` nor `code` column present
  | "ts-dtype" // `ts` is not a 64-bit integer / timestamp column
  | "value-dtype" // `value`/`code` present but the wrong dtype
  | "unsupported-vector" // vector (FixedSizeList) channel — not strip/plot data
  | "decode"; // unexpected failure while reading backing buffers

export interface SeriesError {
  reason: SeriesErrorReason;
  message: string;
}

export type SeriesResult =
  | ({ ok: true } & PlotSeries)
  | ({ ok: false } & SeriesError);

const EMPTY_SERIES: PlotSeries = {
  kind: "scalar",
  xs: new Float64Array(),
  ys: new Float64Array(),
  rawTsNs: new BigInt64Array(),
};

// An empty range is a valid, common case (cursor parked before any sample,
// or a gap with no data) — we return `ok: true` with a zero-length scalar
// series so callers render "no data in range" rather than an error banner.
const EMPTY_RESULT: SeriesResult = { ok: true, ...EMPTY_SERIES };

class SeriesDecodeError extends Error {
  readonly reason: SeriesErrorReason;
  constructor(reason: SeriesErrorReason, message: string) {
    super(message);
    this.name = "SeriesDecodeError";
    this.reason = reason;
  }
}

// `ts` must be a 64-bit integer-backed column: the Rust side emits
// Timestamp(ns), whose backing buffer is a BigInt64Array. We also accept a
// raw Int64 in case a reader emits one. Anything else (Int32 ts, Float ts)
// would silently mis-scale, so reject it.
function isTimestamp64(col: ArrowCol): boolean {
  const t = col.type;
  if (t.typeId === Type.Timestamp) return true;
  if (t.typeId === Type.Int && t.bitWidth === 64) return true;
  return false;
}

function isFloat64(col: ArrowCol): boolean {
  // Float precision: 0=half, 1=single (Float32), 2=double (Float64).
  return col.type.typeId === Type.Float && col.type.precision === 2;
}

function isInt32(col: ArrowCol): boolean {
  return col.type.typeId === Type.Int && col.type.bitWidth === 32;
}

/**
 * Decode an Arrow IPC batch into a typed series, validating the schema.
 *
 * Returns a discriminated result: `{ ok: true, ... }` with the decoded
 * series (and its `kind`), or `{ ok: false, reason, message }` on a genuine
 * schema/dtype mismatch. Never throws for data problems — only programmer
 * errors (e.g. a non-IPC buffer) propagate.
 */
export function decodeSeries(bytes: Uint8Array): SeriesResult {
  // The `Uint8Array` overload of `tableFromIPC` is synchronous; annotate so
  // the inferred type isn't the `Table | Promise<Table>` overload union.
  let table: Table;
  try {
    table = tableFromIPC(bytes);
  } catch (err) {
    return {
      ok: false,
      reason: "decode",
      message: `Could not parse Arrow IPC: ${(err as Error).message}`,
    };
  }
  if (table.numRows === 0) return EMPTY_RESULT;

  // `getChild` returns the Arrow `Vector`; narrow to the structural `ArrowCol`
  // shape this decoder reads (dtype descriptor + chunked backing data).
  const col = (name: string): ArrowCol | null =>
    table.getChild(name) as ArrowCol | null;

  const tsCol = col("ts");
  if (!tsCol) {
    return {
      ok: false,
      reason: "missing-ts",
      message: "Batch has no `ts` column.",
    };
  }
  if (!isTimestamp64(tsCol)) {
    return {
      ok: false,
      reason: "ts-dtype",
      message: "`ts` column is not a 64-bit timestamp.",
    };
  }

  const valueCol = col("value");
  const codeCol = col("code");

  // Enum channels carry `code: Int32` instead of `value`.
  if (!valueCol && codeCol) {
    if (!isInt32(codeCol)) {
      return {
        ok: false,
        reason: "value-dtype",
        message: "`code` column is not Int32.",
      };
    }
    return readColumns(tsCol, codeCol, "enum");
  }

  if (!valueCol) {
    return {
      ok: false,
      reason: "missing-value",
      message: "Batch has neither a `value` nor a `code` column.",
    };
  }

  // A vector channel's `value` is a FixedSizeList<Float64>; it can't be
  // rendered as a scalar/enum strip. Detect it and say so rather than casting
  // the (struct/list) backing buffer to Float64Array and drawing garbage.
  if (valueCol.type.typeId === Type.FixedSizeList) {
    return {
      ok: false,
      reason: "unsupported-vector",
      message:
        "Vector (FixedSizeList) channels are not supported in this panel.",
    };
  }

  if (!isFloat64(valueCol)) {
    return {
      ok: false,
      reason: "value-dtype",
      message: `\`value\` column is not Float64 (typeId ${valueCol.type.typeId}).`,
    };
  }

  return readColumns(tsCol, valueCol, "scalar");
}

// Pull the raw backing buffers (per the T1.4 contract: `.get(i)` on a
// Timestamp drops sub-ms precision via Date semantics, and per-element
// iteration is ~10× slower than a typed-array copy). A single-chunk batch is
// the norm; we reject a chunked column rather than silently reading only the
// first chunk.
function readColumns(
  tsCol: ArrowCol,
  valCol: ArrowCol,
  kind: SeriesKind,
): SeriesResult {
  if (tsCol.data.length !== 1 || valCol.data.length !== 1) {
    return {
      ok: false,
      reason: "decode",
      message: "Expected a single Arrow chunk per column.",
    };
  }
  const rawTs = tsCol.data[0].values;
  const rawVal = valCol.data[0].values; // Float64Array | Int32Array
  if (!(rawTs instanceof BigInt64Array)) {
    return {
      ok: false,
      reason: "ts-dtype",
      message: "`ts` backing buffer is not BigInt64.",
    };
  }
  // dtype was validated above (Float64 / Int32) so the value buffer is a
  // numeric typed array; a BigInt64-backed value here would be a programmer
  // error, so reject rather than coerce.
  if (rawVal instanceof BigInt64Array) {
    return {
      ok: false,
      reason: "value-dtype",
      message: "Value backing buffer is unexpectedly BigInt64.",
    };
  }
  const n = Math.min(rawTs.length, rawVal.length);

  const xs = new Float64Array(n);
  for (let i = 0; i < n; i++) xs[i] = Number(rawTs[i]) / 1e9;
  // Copy ys into a fresh Float64Array so uPlot's retained reference never
  // aliases the Arrow buffer. For enum (Int32) this also widens to Float64.
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) ys[i] = rawVal[i];
  // `rawTsNs` aliases the Arrow backing buffer via `subarray` — zero-copy.
  // The returned typed array retains a reference to the underlying
  // ArrayBuffer, so the Arrow table's storage stays alive for its lifetime.
  // Callers must treat it as read-only.
  const rawTsNs = rawTs.subarray(0, n);
  return { ok: true, kind, xs, ys, rawTsNs };
}

/**
 * Back-compat / convenience wrapper that throws a typed `SeriesDecodeError`
 * on a genuine mismatch and returns the bare `PlotSeries` on success. An
 * empty batch returns an empty scalar series (not an error). Panels that
 * prefer try/catch over branching on a result object use this.
 */
export function seriesFromArrowOrThrow(bytes: Uint8Array): PlotSeries {
  const res = decodeSeries(bytes);
  if (res.ok) {
    const { kind, xs, ys, rawTsNs } = res;
    return { kind, xs, ys, rawTsNs };
  }
  throw new SeriesDecodeError(res.reason, res.message);
}

export { SeriesDecodeError };

/**
 * Legacy entry point. Preserves the original signature — returns a bare
 * `PlotSeries`, with an empty series for *both* empty batches and decode
 * failures — so existing scalar callers (PlotPanel, etc.) keep compiling.
 * New code that needs to surface errors should call `decodeSeries`.
 */
export function seriesFromArrow(bytes: Uint8Array): PlotSeries {
  const res = decodeSeries(bytes);
  if (res.ok) {
    const { kind, xs, ys, rawTsNs } = res;
    return { kind, xs, ys, rawTsNs };
  }
  return { ...EMPTY_SERIES };
}
