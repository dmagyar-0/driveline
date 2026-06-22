// Decode an Arrow IPC batch produced by `openlabel_fetch_range` into the
// plain JS box list the WebGL scene renderer uploads. The Rust core emits one
// row per labelled frame (see the OpenLABEL reader in `crates/data-core`):
//
//   { ts:        Timestamp(ns, UTC),
//     centers:   List<Float32>,  // flat [x,y,z,...]    length 3*N (metres)
//     sizes:     List<Float32>,  // flat [sx,sy,sz,...] length 3*N (FULL extents)
//     rotations: List<Float32>,  // flat [qx,qy,qz,qw,...] length 4*N (scalar-LAST)
//     labels:    List<Utf8> }    // length N, class string (e.g. "car")
//
// The scene panel fetches exactly the frame active at the cursor (one row), so
// the decoder returns the *last* row's boxes — the newest frame if a window
// somehow returned more than one. Numeric values are read out of the Arrow
// backing buffers into a flat `BoundingBox[]` so the renderer can build
// wireframe geometry without re-touching the table.

import { tableFromIPC, type Table } from "apache-arrow";
import {
  lastRowTsNs,
  listRowF32,
  listRowUtf8,
  type ListCol,
} from "./shared/arrowList";

export interface BoundingBox {
  // Box centre in the vehicle frame (metres, z-up: x-fwd, y-left, z-up).
  center: [number, number, number];
  // FULL extents (metres) along the box's local x/y/z.
  size: [number, number, number];
  // Orientation quaternion, scalar-LAST `[qx, qy, qz, qw]`.
  quat: [number, number, number, number];
  // Class string, e.g. "car".
  label: string;
}

export interface BoxesFrame {
  // Frame timestamp (ns). Null only for an empty batch.
  tsNs: bigint | null;
  boxes: BoundingBox[];
}

export type BoxesReason =
  | "empty" // zero rows — cursor before the first frame, or no data
  | "missing-column" // a required column is absent
  | "dtype" // a column had an unexpected dtype/shape
  | "decode"; // unexpected failure reading the IPC buffer

export interface BoxesError {
  reason: BoxesReason;
  message: string;
}

export type BoxesResult =
  | ({ ok: true } & BoxesFrame)
  | ({ ok: false } & BoxesError);

const EMPTY_FRAME: BoxesFrame = { tsNs: null, boxes: [] };

export function decodeBoxes(bytes: Uint8Array): BoxesResult {
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

  const centersCol = table.getChild("centers") as ListCol | null;
  const sizesCol = table.getChild("sizes") as ListCol | null;
  const rotsCol = table.getChild("rotations") as ListCol | null;
  const labelsCol = table.getChild("labels") as
    | Parameters<typeof listRowUtf8>[0]
    | null;
  if (!centersCol || !sizesCol || !rotsCol || !labelsCol) {
    return {
      ok: false,
      reason: "missing-column",
      message:
        "Batch is missing a `centers`, `sizes`, `rotations`, or `labels` column.",
    };
  }

  // Newest frame = last row (the panel fetches exactly one).
  const r = rows - 1;
  const centers = listRowF32(centersCol, r);
  const sizes = listRowF32(sizesCol, r);
  const rots = listRowF32(rotsCol, r);
  const labels = listRowUtf8(labelsCol, r);
  if (!centers || !sizes || !rots || !labels) {
    return {
      ok: false,
      reason: "dtype",
      message:
        "`centers`/`sizes`/`rotations` are not single-chunk List<Float32> or `labels` not List<Utf8>.",
    };
  }

  const n = labels.length;
  if (
    centers.length !== n * 3 ||
    sizes.length !== n * 3 ||
    rots.length !== n * 4
  ) {
    return {
      ok: false,
      reason: "dtype",
      message: `column lengths disagree: centers=${centers.length} sizes=${sizes.length} rotations=${rots.length} labels=${n}.`,
    };
  }

  const boxes: BoundingBox[] = [];
  for (let i = 0; i < n; i++) {
    boxes.push({
      center: [centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]],
      size: [sizes[i * 3], sizes[i * 3 + 1], sizes[i * 3 + 2]],
      quat: [rots[i * 4], rots[i * 4 + 1], rots[i * 4 + 2], rots[i * 4 + 3]],
      label: labels[i],
    });
  }

  const tsNs = lastRowTsNs(table, r);

  return { ok: true, tsNs, boxes };
}
