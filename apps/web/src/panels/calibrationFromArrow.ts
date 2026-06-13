// Decode an Arrow IPC batch produced by `calibration_fetch_range` into the
// plain JS calibration list the point-cloud-on-video overlay consumes. The
// Rust core emits one row per camera (see `crates/data-core/src/calibration.rs`
// and `docs/13-camera-lidar-calibration.md`):
//
//   { name:         Utf8,
//     model:        Utf8,           // "pinhole" or "ftheta"
//     intrinsics:   List<Float32>,  // length 4 = [fx, fy, cx, cy] (px)
//     resolution:   List<Int32>,    // length 2 = [width, height] (px)
//     distortion:   List<Float32>,  // length 0 or 5 = [k1,k2,p1,p2,k3]
//     forward_poly: List<Float32>,  // length 0 (pinhole) or >=2 ftheta coeffs
//     translation:  List<Float32>,  // length 3 = [tx, ty, tz] (m)
//     quaternion:   List<Float32> } // length 4 = [qx, qy, qz, qw] scalar-LAST
//
// Calibration is config, not a time series: a single fetch returns *every*
// camera, so the decoder returns one `CameraCalibration` per row (not just the
// last row, as the box/point-cloud decoders do). Numeric values are copied out
// of the Arrow backing buffers into a plain object so callers can hold them
// without retaining the table.

import { tableFromIPC, type Table } from "apache-arrow";

/** Projection model. `pinhole` uses intrinsics + Brown–Conrady distortion;
 * `ftheta` uses the `forwardPoly` (angle→pixel-radius) fisheye polynomial. */
export type CameraModel = "pinhole" | "ftheta";

export interface CameraCalibration {
  name: string;
  // Projection model — selects how `cameraProjection.ts` maps a camera-frame
  // point to a pixel. `pinhole` (default) or `ftheta` (wide-FOV fisheye).
  model: CameraModel;
  intrinsics: {
    fx: number;
    fy: number;
    cx: number;
    cy: number;
    width: number;
    height: number;
  };
  // Distortion coefficients: `[]` (none) or 5 `[k1, k2, p1, p2, k3]`. Unused
  // when `model === "ftheta"`.
  distortion: number[];
  // f-theta forward polynomial `[c0, c1, …]`: `[]` for pinhole, else >=2 coeffs
  // mapping a ray's angle from the optical axis (radians) to a pixel radius.
  forwardPoly: number[];
  // Translation `[tx, ty, tz]` (metres), scene/LiDAR -> camera optical.
  translation: [number, number, number];
  // Orientation quaternion, scalar-LAST `[qx, qy, qz, qw]`.
  quaternion: [number, number, number, number];
}

export type CalibrationReason =
  | "empty" // zero rows — no cameras in the source
  | "missing-column" // a required column is absent
  | "dtype" // a column had an unexpected dtype/shape
  | "decode"; // unexpected failure reading the IPC buffer

export interface CalibrationError {
  reason: CalibrationReason;
  message: string;
}

export type CalibrationResult =
  | { ok: true; cameras: CameraCalibration[] }
  | ({ ok: false } & CalibrationError);

// Minimal structural view of an Arrow `List<T>` column's backing data — a
// single chunk with i32 value offsets and a numeric child values buffer.
// Mirrors the access pattern in `pointCloudFromArrow.ts` / `boxesFromArrow.ts`.
interface ListData {
  offset: number;
  valueOffsets: ArrayLike<number>;
  children: ReadonlyArray<{ values: ArrayLike<number> }>;
}
interface ListCol {
  data: ReadonlyArray<ListData>;
}

// Pull row `r`'s numeric slice out of a single-chunk List<Float32|Int32>
// column as a `Float32Array` or `Int32Array`. Returns null if the structure
// isn't the expected single chunk of the expected typed-array class.
function listRow<T extends Float32Array | Int32Array>(
  col: ListCol,
  r: number,
  Ctor: { new (): T } & Function,
): T | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const child = d.children?.[0]?.values;
  const offsets = d.valueOffsets;
  if (!child || !offsets) return null;
  const base = d.offset ?? 0;
  const start = Number(offsets[base + r]);
  const end = Number(offsets[base + r + 1]);
  if (!(child instanceof Ctor)) return null;
  return (child as T).subarray(start, end) as T;
}

// Read row `r`'s string out of a single-chunk Utf8 column: a Uint8 byte buffer
// indexed by i32 value offsets. Returns null if the structure isn't expected.
function utf8Row(
  col: {
    data: ReadonlyArray<{
      offset?: number;
      valueOffsets: ArrayLike<number>;
      values: ArrayLike<number> | Uint8Array;
    }>;
  },
  r: number,
): string | null {
  if (col.data.length !== 1) return null;
  const d = col.data[0];
  const offsets = d.valueOffsets;
  const bytes = d.values;
  if (!offsets || !(bytes instanceof Uint8Array)) return null;
  const base = d.offset ?? 0;
  const start = Number(offsets[base + r]);
  const end = Number(offsets[base + r + 1]);
  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

export function decodeCalibration(bytes: Uint8Array): CalibrationResult {
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
  if (rows === 0) return { ok: true, cameras: [] };

  const nameCol = table.getChild("name") as
    | Parameters<typeof utf8Row>[0]
    | null;
  // `model` and `forward_poly` are additive (f-theta) columns. They are read
  // tolerantly — a calibration source without them decodes as `pinhole` with an
  // empty forward polynomial — so the decoder never throws on a missing column.
  const modelCol = table.getChild("model") as
    | Parameters<typeof utf8Row>[0]
    | null;
  const intrinsicsCol = table.getChild("intrinsics") as ListCol | null;
  const resolutionCol = table.getChild("resolution") as ListCol | null;
  const distortionCol = table.getChild("distortion") as ListCol | null;
  const forwardPolyCol = table.getChild("forward_poly") as ListCol | null;
  const translationCol = table.getChild("translation") as ListCol | null;
  const quaternionCol = table.getChild("quaternion") as ListCol | null;
  if (
    !nameCol ||
    !intrinsicsCol ||
    !resolutionCol ||
    !distortionCol ||
    !translationCol ||
    !quaternionCol
  ) {
    return {
      ok: false,
      reason: "missing-column",
      message:
        "Batch is missing a `name`, `intrinsics`, `resolution`, `distortion`, `translation`, or `quaternion` column.",
    };
  }

  const cameras: CameraCalibration[] = [];
  for (let r = 0; r < rows; r++) {
    const name = utf8Row(nameCol, r);
    const intrinsics = listRow(intrinsicsCol, r, Float32Array);
    const resolution = listRow(resolutionCol, r, Int32Array);
    const distortion = listRow(distortionCol, r, Float32Array);
    const translation = listRow(translationCol, r, Float32Array);
    const quaternion = listRow(quaternionCol, r, Float32Array);
    if (
      name === null ||
      !intrinsics ||
      !resolution ||
      !distortion ||
      !translation ||
      !quaternion
    ) {
      return {
        ok: false,
        reason: "dtype",
        message: `row ${r}: a column was not the expected single-chunk List/Utf8 type.`,
      };
    }
    // f-theta columns are tolerant: absent → pinhole / empty forward_poly.
    const modelStr = modelCol ? utf8Row(modelCol, r) : null;
    const model: CameraModel = modelStr === "ftheta" ? "ftheta" : "pinhole";
    const forwardPoly = forwardPolyCol
      ? listRow(forwardPolyCol, r, Float32Array)
      : null;
    if (
      intrinsics.length !== 4 ||
      resolution.length !== 2 ||
      (distortion.length !== 0 && distortion.length !== 5) ||
      (forwardPoly !== null &&
        forwardPoly.length !== 0 &&
        forwardPoly.length < 2) ||
      translation.length !== 3 ||
      quaternion.length !== 4
    ) {
      return {
        ok: false,
        reason: "dtype",
        message: `row ${r}: column lengths disagree (intrinsics=${intrinsics.length} resolution=${resolution.length} distortion=${distortion.length} forward_poly=${forwardPoly?.length ?? 0} translation=${translation.length} quaternion=${quaternion.length}).`,
      };
    }
    cameras.push({
      name,
      model,
      intrinsics: {
        fx: intrinsics[0],
        fy: intrinsics[1],
        cx: intrinsics[2],
        cy: intrinsics[3],
        width: resolution[0],
        height: resolution[1],
      },
      distortion: Array.from(distortion),
      forwardPoly: forwardPoly ? Array.from(forwardPoly) : [],
      translation: [translation[0], translation[1], translation[2]],
      quaternion: [quaternion[0], quaternion[1], quaternion[2], quaternion[3]],
    });
  }

  return { ok: true, cameras };
}
