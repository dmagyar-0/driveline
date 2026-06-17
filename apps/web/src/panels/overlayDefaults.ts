// Default-binding helpers for the point-cloud-on-video overlay (docs/13).
//
// When the user clicks "LiDAR overlay", the panel commits a binding without
// making them work the three pickers. Picking the *right* defaults matters for
// multi-sensor rigs (Alpamayo ships 7 cameras + a LiDAR and a radar cloud in
// one bundle): a naive "first camera / first cloud" default binds, say,
// `camera_cross_left_120fov` onto the front-wide video and projects the spin
// through the wrong extrinsic — points land nowhere sensible and the overlay
// looks broken. These helpers are pure so the matching is unit-tested.

import type { CameraCalibration } from "./calibrationFromArrow";

/** Strip a single trailing file extension and lower-case. `camera_front.mp4`
 *  -> `camera_front`. The mp4 *channel* name is a generic `track_0`, so the
 *  source filename is the only reliable link to a calibration camera name. */
function sourceStem(name: string): string {
  return name.replace(/\.[^./\\]+$/, "").toLowerCase();
}

/**
 * Choose the calibration camera that best matches the video shown in this
 * panel, identified by its source filename (e.g. `camera_front_wide_120fov.mp4`).
 * Alpamayo names each per-camera mp4 after the calibration camera, so we match
 * the camera `name` against the filename stem:
 *
 *   1. exact stem match (`camera_front_wide_120fov` === `camera_front_wide_120fov`)
 *   2. either contains the other (handles prefixes/suffixes like `scene_cam_front`)
 *   3. fall back to the first camera — correct for single-camera sources
 *      (synthetic / nuScenes fixtures) where the names need not align.
 *
 * Returns `undefined` only when there are no cameras at all.
 */
export function pickOverlayCamera(
  cameras: readonly CameraCalibration[],
  videoSourceName: string | null | undefined,
): string | undefined {
  if (cameras.length === 0) return undefined;
  if (videoSourceName) {
    const stem = sourceStem(videoSourceName);
    const exact = cameras.find((c) => c.name.toLowerCase() === stem);
    if (exact) return exact.name;
    const partial = cameras.find((c) => {
      const n = c.name.toLowerCase();
      return n.length > 0 && (stem.includes(n) || n.includes(stem));
    });
    if (partial) return partial.name;
  }
  return cameras[0].name;
}

/**
 * Choose the default point-cloud channel to project. Prefer a LiDAR cloud over
 * a radar (or other) cloud — an Alpamayo bundle exposes both, and a sparse
 * radar return makes a poor default overlay. Matches a `lidar` token in the
 * channel name, else falls back to the first channel.
 *
 * Returns `undefined` only when there are no point-cloud channels.
 */
export function pickOverlayPointCloud<T extends { id: string; name: string }>(
  channels: readonly T[],
): string | undefined {
  if (channels.length === 0) return undefined;
  const lidar = channels.find((c) => /lidar/i.test(c.name));
  return (lidar ?? channels[0]).id;
}
