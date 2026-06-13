// Pure camera projection for the point-cloud-on-video overlay (docs/13).
//
// Takes a scene/LiDAR-frame point (metres, x-forward/y-left/z-up, ISO-8855),
// applies the scene -> camera-optical extrinsic
//
//   p_cam = quatRotate(quaternion, p_scene) + translation
//
// (scalar-last quaternion, identical formula to `quatRotate()` in
// `pointCloudRenderer.ts`), then the OpenCV pinhole intrinsic with optional
// Brown-Conrady radial-tangential distortion. A point is visible iff its
// camera-frame Z > 0 (in front of the lens) and the projected pixel lands
// inside the image rectangle.
//
// `projectPoint` is the readable single-point reference the unit tests pin to
// the synthetic fixture's oracle. `projectPointsInto` is the batch helper the
// VideoPanel overlay calls every spin: it writes into caller-owned output
// buffers so the hot path allocates nothing per point.

import type { CameraCalibration } from "./calibrationFromArrow";

export interface ProjectedPoint {
  /** Pixel column in the camera image (px). */
  u: number;
  /** Pixel row in the camera image (px). */
  v: number;
  /** Camera-frame Z (metres). Positive = in front of the lens. */
  depth: number;
  /** True iff `depth > 0` and `(u, v)` is inside `[0,width) x [0,height)`. */
  visible: boolean;
}

// Rotate vector `v` by scalar-last unit quaternion `q = [x, y, z, w]`. Active
// rotation. This is the exact same arithmetic as `quatRotate()` in
// `pointCloudRenderer.ts` — kept inline (rather than imported from the WebGL
// renderer module) so this stays a dependency-free pure module the projection
// tests can import without dragging in a GL context.
function quatRotate(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
  vx: number,
  vy: number,
  vz: number,
  out: [number, number, number],
): void {
  // t = 2 * cross(q_xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w*t + cross(q_xyz, t)
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
}

// Apply the pinhole + optional Brown-Conrady distortion to a normalised
// image-plane point (x = X/Z, y = Y/Z). Returns the pixel `[u, v]`. `dist` is
// `[]` (no distortion) or `[k1, k2, p1, p2, k3]`.
function projectNormalised(
  x: number,
  y: number,
  fx: number,
  fy: number,
  cx: number,
  cy: number,
  dist: number[],
  out: [number, number],
): void {
  let xd = x;
  let yd = y;
  if (dist.length === 5) {
    const [k1, k2, p1, p2, k3] = dist;
    const r2 = x * x + y * y;
    const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
  }
  out[0] = fx * xd + cx;
  out[1] = fy * yd + cy;
}

/**
 * Project a single scene/LiDAR-frame point through `calib`. Returns the pixel
 * `(u, v)`, the camera-frame depth, and a `visible` flag (Z > 0 AND inside the
 * image rectangle). Implements docs/13 exactly.
 */
export function projectPoint(
  calib: CameraCalibration,
  pScene: [number, number, number],
): ProjectedPoint {
  const [qx, qy, qz, qw] = calib.quaternion;
  const cam: [number, number, number] = [0, 0, 0];
  quatRotate(qx, qy, qz, qw, pScene[0], pScene[1], pScene[2], cam);
  const X = cam[0] + calib.translation[0];
  const Y = cam[1] + calib.translation[1];
  const Z = cam[2] + calib.translation[2];
  if (Z <= 0) {
    return { u: NaN, v: NaN, depth: Z, visible: false };
  }
  const { fx, fy, cx, cy, width, height } = calib.intrinsics;
  const px: [number, number] = [0, 0];
  projectNormalised(X / Z, Y / Z, fx, fy, cx, cy, calib.distortion, px);
  const [u, v] = px;
  const visible = u >= 0 && u < width && v >= 0 && v < height;
  return { u, v, depth: Z, visible };
}

/**
 * Output buffers for `projectPointsInto`. The caller owns and reuses them
 * across spins so the overlay's hot path never allocates per point. Length
 * conventions (for `count` points):
 *   - `us`, `vs`, `depths`: length >= count
 *   - `visible`: length >= count (1 = visible, 0 = culled)
 */
export interface ProjectionBuffers {
  us: Float32Array;
  vs: Float32Array;
  depths: Float32Array;
  visible: Uint8Array;
}

/** Allocate a fresh `ProjectionBuffers` sized for `count` points. */
export function makeProjectionBuffers(count: number): ProjectionBuffers {
  return {
    us: new Float32Array(count),
    vs: new Float32Array(count),
    depths: new Float32Array(count),
    visible: new Uint8Array(count),
  };
}

/**
 * Batch-project a flat `Float32Array` of scene-frame xyz (length 3*count) into
 * caller-owned output buffers. No per-point allocation: the rotation and
 * projection scratch is hoisted, and results are written by index. Returns the
 * number of visible points (those with Z > 0 inside the image rectangle).
 *
 * `out` buffers must each hold at least `count` entries — use
 * `makeProjectionBuffers(count)` (and grow it when the spin's point count
 * increases). Culled points get `visible[i] = 0`; their `us`/`vs` are left as
 * NaN for a behind-camera point and as the (out-of-rect) projected pixel
 * otherwise, but callers should gate on `visible[i]` rather than the pixel.
 */
export function projectPointsInto(
  calib: CameraCalibration,
  xyz: Float32Array,
  count: number,
  out: ProjectionBuffers,
): number {
  const [qx, qy, qz, qw] = calib.quaternion;
  const [tx, ty, tz] = calib.translation;
  const { fx, fy, cx, cy, width, height } = calib.intrinsics;
  const dist = calib.distortion;
  const hasDist = dist.length === 5;
  const k1 = hasDist ? dist[0] : 0;
  const k2 = hasDist ? dist[1] : 0;
  const p1 = hasDist ? dist[2] : 0;
  const p2 = hasDist ? dist[3] : 0;
  const k3 = hasDist ? dist[4] : 0;

  const cam: [number, number, number] = [0, 0, 0];
  let visibleCount = 0;
  for (let i = 0; i < count; i++) {
    const base = i * 3;
    quatRotate(qx, qy, qz, qw, xyz[base], xyz[base + 1], xyz[base + 2], cam);
    const X = cam[0] + tx;
    const Y = cam[1] + ty;
    const Z = cam[2] + tz;
    out.depths[i] = Z;
    if (Z <= 0) {
      out.us[i] = NaN;
      out.vs[i] = NaN;
      out.visible[i] = 0;
      continue;
    }
    let x = X / Z;
    let y = Y / Z;
    if (hasDist) {
      const r2 = x * x + y * y;
      const radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
      const xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x);
      const yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y;
      x = xd;
      y = yd;
    }
    const u = fx * x + cx;
    const v = fy * y + cy;
    out.us[i] = u;
    out.vs[i] = v;
    const vis = u >= 0 && u < width && v >= 0 && v < height ? 1 : 0;
    out.visible[i] = vis;
    visibleCount += vis;
  }
  return visibleCount;
}
