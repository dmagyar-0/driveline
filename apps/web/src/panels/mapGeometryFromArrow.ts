// Decode an Arrow IPC batch produced by `map_geometry_fetch_range` into the
// plain JS feature list the WebGL scene renderer uploads. The Rust core emits
// one row per frame of road-network geometry (see the map-geometry reader in
// `crates/data-core`):
//
//   { ts:           Timestamp(ns, UTC),
//     points:       List<Float32>,  // flat [x,y,z,...] all polylines concatenated
//     path_lengths: List<Int32>,    // POINTS per polyline (splits points)
//     types:        List<Utf8> }    // feature type per polyline
//
// Map geometry is STATIC: the source carries a single frame at ts=0, so the
// scene panel fetches exactly that one row. The decoder returns the *last*
// row's features — the newest if a window somehow returned more than one.
// `points` is split into individual polylines by the cumulative `path_lengths`,
// mirroring `trajectoriesFromArrow.ts`; the per-path feature type comes from the
// `types` List<Utf8> column instead of trajectory's `confidences` List<Float32>.

import { tableFromIPC, type Table } from "apache-arrow";

export interface MapFeature {
  // Polyline vertices in the world/vehicle frame (metres, z-up: x-fwd, y-left).
  points: [number, number, number][];
  // Feature type string (lowercase): "lane_boundary", "road_edge",
  // "centerline", "crosswalk", "stop_line", "driving", "other". Unknown source
  // strings are mapped to "other" by the reader; the decoder passes them
  // through verbatim and the renderer's colour LUT defaults unknowns to "other".
  type: string;
}

export interface MapGeometryFrame {
  // Frame timestamp (ns). Null only for an empty batch.
  tsNs: bigint | null;
  features: MapFeature[];
}

export type MapGeometryReason =
  | "empty" // zero rows — no data
  | "missing-column" // a required column is absent
  | "dtype" // a column had an unexpected dtype/shape
  | "decode"; // unexpected failure reading the IPC buffer

export interface MapGeometryError {
  reason: MapGeometryReason;
  message: string;
}

export type MapGeometryResult =
  | ({ ok: true } & MapGeometryFrame)
  | ({ ok: false } & MapGeometryError);

const EMPTY_FRAME: MapGeometryFrame = { tsNs: null, features: [] };

// Minimal structural view of an Arrow `List<Float32>`/`List<Int32>` column's
// backing data — a single chunk with i32 value offsets and a typed-array child
// values buffer. Mirrors the access pattern in `trajectoriesFromArrow.ts`.
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

// Pull row `r`'s Int32 slice out of a single-chunk List<Int32> column.
function listRowI32(col: ListCol, r: number): Int32Array | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const child = d.children?.[0]?.values;
  const offsets = d.valueOffsets;
  if (!child || !offsets) return null;
  const base = d.offset ?? 0;
  const start = Number(offsets[base + r]);
  const end = Number(offsets[base + r + 1]);
  const values = child as Int32Array;
  if (!(values instanceof Int32Array)) return null;
  return values.subarray(start, end);
}

export function decodeMapGeometry(bytes: Uint8Array): MapGeometryResult {
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

  const pointsCol = table.getChild("points") as ListCol | null;
  const lengthsCol = table.getChild("path_lengths") as ListCol | null;
  const typesCol = table.getChild("types");
  if (!pointsCol || !lengthsCol || !typesCol) {
    return {
      ok: false,
      reason: "missing-column",
      message: "Batch is missing a `points`, `path_lengths`, or `types` column.",
    };
  }

  // Newest frame = last row (the panel fetches exactly one).
  const r = rows - 1;
  const points = listRowF32(pointsCol, r);
  const lengths = listRowI32(lengthsCol, r);
  if (!points || !lengths) {
    return {
      ok: false,
      reason: "dtype",
      message:
        "`points` is not a single-chunk List<Float32> or `path_lengths` not List<Int32>.",
    };
  }

  // The `types` column is List<Utf8>: read the row via the public getter (the
  // Utf8 child is variable-width, so the typed-array shortcut above doesn't
  // apply). `get(r)` returns the list as an apache-arrow `Vector` whose elements
  // are reached with `.get(i)` (bracket indexing returns `undefined`). Default
  // null/empty entries to "other".
  const typesRow = (
    typesCol as unknown as {
      get(i: number): { length: number; get(i: number): unknown } | null;
    }
  ).get(r);
  const n = lengths.length;
  const types: string[] = [];
  if (typesRow && typeof typesRow.length === "number") {
    for (let i = 0; i < n; i++) {
      const v = typesRow.get(i);
      types.push(typeof v === "string" && v.length > 0 ? v : "other");
    }
  } else {
    for (let i = 0; i < n; i++) types.push("other");
  }

  if (types.length !== n) {
    return {
      ok: false,
      reason: "dtype",
      message: `column lengths disagree: path_lengths=${n} types=${types.length}.`,
    };
  }

  // Split the flat `points` xyz stream into one polyline per `path_lengths`.
  const features: MapFeature[] = [];
  let cursor = 0; // index into `points` (in floats)
  for (let i = 0; i < n; i++) {
    const count = lengths[i];
    const pts: [number, number, number][] = [];
    for (let j = 0; j < count; j++) {
      const o = cursor + j * 3;
      pts.push([points[o], points[o + 1], points[o + 2]]);
    }
    cursor += count * 3;
    features.push({ points: pts, type: types[i] });
  }

  // If the cumulative point counts overran the buffer, the geometry is corrupt.
  if (cursor !== points.length) {
    return {
      ok: false,
      reason: "dtype",
      message: `path_lengths sum (${cursor / 3} pts) disagrees with points buffer (${points.length / 3} pts).`,
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

  return { ok: true, tsNs, features };
}
