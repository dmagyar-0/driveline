// Decode an Arrow IPC batch produced by `trajectory_fetch_range` into the plain
// JS path list the WebGL scene renderer uploads. The Rust core emits one row
// per frame of predicted ego future trajectories (see the trajectory reader in
// `crates/data-core`):
//
//   { ts:           Timestamp(ns, UTC),
//     points:       List<Float32>,  // flat [x,y,z,...] all paths concatenated
//     path_lengths: List<Int32>,    // POINTS per candidate path (splits points)
//     confidences:  List<Float32> } // one per candidate path
//
// The scene panel fetches exactly the frame active at the cursor (one row), so
// the decoder returns the *last* row's paths — the newest frame if a window
// somehow returned more than one. `points` is split into individual paths by
// the cumulative `path_lengths`, mirroring `boxesFromArrow.ts`.

import { tableFromIPC, type Table } from "apache-arrow";
import {
  lastRowTsNs,
  listRowF32,
  listRowI32,
  type ListCol,
} from "./shared/arrowList";

export interface TrajectoryPath {
  // Waypoints in the vehicle frame (metres, z-up: x-fwd, y-left, z-up).
  points: [number, number, number][];
  // Model confidence for this candidate path, in [0, 1] (defaults to 1.0 when
  // the source omits it).
  confidence: number;
}

export interface TrajectoryFrame {
  // Frame timestamp (ns). Null only for an empty batch.
  tsNs: bigint | null;
  paths: TrajectoryPath[];
}

export type TrajectoriesReason =
  | "empty" // zero rows — cursor before the first frame, or no data
  | "missing-column" // a required column is absent
  | "dtype" // a column had an unexpected dtype/shape
  | "decode"; // unexpected failure reading the IPC buffer

export interface TrajectoriesError {
  reason: TrajectoriesReason;
  message: string;
}

export type TrajectoriesResult =
  | ({ ok: true } & TrajectoryFrame)
  | ({ ok: false } & TrajectoriesError);

const EMPTY_FRAME: TrajectoryFrame = { tsNs: null, paths: [] };

export function decodeTrajectories(bytes: Uint8Array): TrajectoriesResult {
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
  const confCol = table.getChild("confidences") as ListCol | null;
  if (!pointsCol || !lengthsCol || !confCol) {
    return {
      ok: false,
      reason: "missing-column",
      message:
        "Batch is missing a `points`, `path_lengths`, or `confidences` column.",
    };
  }

  // Newest frame = last row (the panel fetches exactly one).
  const r = rows - 1;
  const points = listRowF32(pointsCol, r);
  const lengths = listRowI32(lengthsCol, r);
  const confidences = listRowF32(confCol, r);
  if (!points || !lengths || !confidences) {
    return {
      ok: false,
      reason: "dtype",
      message:
        "`points`/`confidences` are not single-chunk List<Float32> or `path_lengths` not List<Int32>.",
    };
  }

  const n = lengths.length;
  if (confidences.length !== n) {
    return {
      ok: false,
      reason: "dtype",
      message: `column lengths disagree: path_lengths=${n} confidences=${confidences.length}.`,
    };
  }

  // Split the flat `points` xyz stream into one path per `path_lengths` entry.
  const paths: TrajectoryPath[] = [];
  let cursor = 0; // index into `points` (in floats)
  for (let i = 0; i < n; i++) {
    const count = lengths[i];
    const pts: [number, number, number][] = [];
    for (let j = 0; j < count; j++) {
      const o = cursor + j * 3;
      pts.push([points[o], points[o + 1], points[o + 2]]);
    }
    cursor += count * 3;
    paths.push({ points: pts, confidence: confidences[i] });
  }

  // If the cumulative point counts overran the buffer, the geometry is corrupt.
  if (cursor !== points.length) {
    return {
      ok: false,
      reason: "dtype",
      message: `path_lengths sum (${cursor / 3} pts) disagrees with points buffer (${points.length / 3} pts).`,
    };
  }

  const tsNs = lastRowTsNs(table, r);

  return { ok: true, tsNs, paths };
}
