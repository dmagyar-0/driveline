// Decode an Arrow IPC batch produced by `lidar_fetch_range` into the typed
// arrays the WebGL point-cloud renderer uploads. The Rust core emits one row
// per LiDAR spin (see `crates/data-core/src/pointcloud.rs`):
//
//   { ts: Timestamp(ns, UTC),
//     positions:   List<Float32>,   // flattened xyz, length 3*N (metres)
//     intensities: List<Float32> }  // length N, normalised 0..1
//
// The scene panel fetches exactly the spin active at the cursor (one row), so
// the decoder returns the *last* row's geometry — the newest spin if a window
// somehow returned more than one. Positions/intensities are returned as
// `subarray` views over the Arrow backing buffer (zero-copy); the view retains
// the underlying ArrayBuffer, so the table's storage stays alive for the
// renderer to upload. Treat them as read-only.

import { tableFromIPC, type Table } from "apache-arrow";

export interface PointCloudFrame {
  // Spin timestamp (ns). Null only for an empty batch.
  tsNs: bigint | null;
  // Flattened xyz, length 3 * count.
  positions: Float32Array;
  // Per-point intensity 0..1, length count.
  intensities: Float32Array;
  // Number of points.
  count: number;
}

export type PointCloudReason =
  | "empty" // zero rows — cursor before the first spin, or no data
  | "missing-column" // positions/intensities column absent
  | "dtype" // a column had an unexpected dtype/shape
  | "decode"; // unexpected failure reading the IPC buffer

export interface PointCloudError {
  reason: PointCloudReason;
  message: string;
}

export type PointCloudResult =
  | ({ ok: true } & PointCloudFrame)
  | ({ ok: false } & PointCloudError);

const EMPTY_FRAME: PointCloudFrame = {
  tsNs: null,
  positions: new Float32Array(),
  intensities: new Float32Array(),
  count: 0,
};

// Minimal structural view of an Arrow `List<Float32>` column's backing data —
// a single chunk with i32 value offsets and a Float32 child values buffer.
// Mirrors the `.data[0]` access pattern `seriesFromArrow.ts` already relies on.
interface ListData {
  offset: number;
  valueOffsets: ArrayLike<number>;
  children: ReadonlyArray<{ values: ArrayLike<number> }>;
}
interface ListCol {
  data: ReadonlyArray<ListData>;
}

// Pull row `r`'s Float32 slice out of a single-chunk List<Float32> column.
function listRowF32(col: ListCol, r: number): Float32Array | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const child = d.children?.[0]?.values;
  const offsets = d.valueOffsets;
  if (!child || !offsets) return null;
  const base = d.offset ?? 0;
  const start = Number(offsets[base + r]);
  const end = Number(offsets[base + r + 1]);
  const values = child as Float32Array;
  if (!(values instanceof Float32Array)) return null;
  return values.subarray(start, end);
}

export function decodePointCloud(bytes: Uint8Array): PointCloudResult {
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
  const rows = table.numRows;
  if (rows === 0) return { ok: true, ...EMPTY_FRAME };

  const posCol = table.getChild("positions") as ListCol | null;
  const intCol = table.getChild("intensities") as ListCol | null;
  if (!posCol || !intCol) {
    return {
      ok: false,
      reason: "missing-column",
      message: "Batch is missing a `positions` or `intensities` column.",
    };
  }

  // Newest spin = last row (the panel fetches exactly one).
  const r = rows - 1;
  const positions = listRowF32(posCol, r);
  const intensities = listRowF32(intCol, r);
  if (!positions || !intensities) {
    return {
      ok: false,
      reason: "dtype",
      message: "`positions`/`intensities` are not single-chunk List<Float32>.",
    };
  }
  const count = intensities.length;
  if (positions.length !== count * 3) {
    return {
      ok: false,
      reason: "dtype",
      message: `positions (${positions.length}) != 3 * intensities (${count}).`,
    };
  }

  let tsNs: bigint | null = null;
  const tsCol = table.getChild("ts") as {
    data: ReadonlyArray<{ values: ArrayLike<bigint> | BigInt64Array }>;
  } | null;
  if (tsCol && tsCol.data.length === 1) {
    const tsVals = tsCol.data[0].values;
    if (tsVals instanceof BigInt64Array && tsVals.length > r) {
      tsNs = tsVals[r];
    }
  }

  return { ok: true, tsNs, positions, intensities, count };
}
