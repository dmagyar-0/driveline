# Camera ↔ LiDAR calibration & point-cloud-on-video overlay

> **Status:** in development on `claude/pointcloud-camera-calibration-i8rvz0`.
> This document is the **cross-cutting data contract** for the feature. Rust
> (`data-core`/`wasm-bindings`), the frontend (`apps/web`), the fixture
> generators (`sample-data/`, `scripts/`), and the e2e specs all build against
> the definitions here. If a field/convention changes, change it here first.

## Goal

Overlay a LiDAR point cloud onto the camera image it was captured alongside,
by introducing an explicit **camera calibration** that ties a 2-D camera
(a `Video` channel) to the 3-D scene/LiDAR frame. Calibration is expressed as a
**translation + quaternion** extrinsic plus a pinhole **intrinsic**.

## Coordinate frames & conventions

- **Scene / LiDAR frame** (a.k.a. ego frame): metres, **x-forward, y-left,
  z-up** (ISO-8855). This is the frame point clouds (`pointcloud.rs`) and
  OpenLABEL boxes already live in, and what the Scene panel renders natively.
- **Camera optical frame**: **x-right, y-down, z-forward** (OpenCV pinhole).
  +Z points out of the lens; only points with `Z > 0` are in front of the
  camera and projectable.
- **Quaternion**: unit quaternion, **scalar-last `[qx, qy, qz, qw]`** — the same
  wire convention as OpenLABEL cuboids and `quatRotate()` in
  `pointCloudRenderer.ts`. Active rotation of a vector.

### The extrinsic

The extrinsic is the rigid transform that takes a point **from the scene/LiDAR
frame into the camera optical frame**:

```
p_cam = quatRotate(quaternion, p_scene) + translation
```

- `translation = [tx, ty, tz]` in metres.
- `quaternion = [qx, qy, qz, qw]`, scalar-last, unit length.

The ~90° rotation between ISO-8855 (z-up) and OpenCV (z-forward) optical axes is
**baked into this quaternion** — there is no separate axis-convention flag.

### The intrinsic (pinhole) + distortion

`intrinsics = [fx, fy, cx, cy]` in pixels; `resolution = [width, height]` in
pixels. Projection of a camera-frame point `(X, Y, Z)` with `Z > 0`:

```
x = X / Z ;  y = Y / Z                       # normalised image plane
# optional radial-tangential (Brown–Conrady) distortion, coeffs [k1,k2,p1,p2,k3]:
r2 = x*x + y*y
radial = 1 + k1*r2 + k2*r2*r2 + k3*r2*r2*r2
x_d = x*radial + 2*p1*x*y + p2*(r2 + 2*x*x)
y_d = y*radial + p1*(r2 + 2*y*y) + 2*p2*x*y
u = fx * x_d + cx
v = fy * y_d + cy
```

`distortion` is `[]` (no distortion, e.g. nuScenes — images are pre-undistorted)
or exactly 5 floats `[k1, k2, p1, p2, k3]`. A point is **visible** iff `Z > 0`
and `0 ≤ u < width` and `0 ≤ v < height`.

## Wire contract: Arrow IPC

A new channel kind carries calibration. It is **config, not a time series** —
one fetch returns all cameras (one row per camera).

- Rust: `ChannelKind::CameraCalibration`, `SourceKind::Calibration`.
- Reader: `crates/data-core/src/calibration.rs` parsing a JSON file (below).
- Arrow IPC schema (one **row per camera**), all columns **non-nullable**,
  every vector field a `List<Float32>` / `List<Int32>` to match the OpenLABEL
  precedent (uniform, simple JS decode):

| column        | Arrow type        | meaning                                   |
| ------------- | ----------------- | ----------------------------------------- |
| `name`        | `Utf8`            | camera name, e.g. `CAM_FRONT`             |
| `intrinsics`  | `List<Float32>`   | length 4 = `[fx, fy, cx, cy]` (px)        |
| `resolution`  | `List<Int32>`     | length 2 = `[width, height]` (px)         |
| `distortion`  | `List<Float32>`   | length 0 or 5 = `[k1,k2,p1,p2,k3]`        |
| `translation` | `List<Float32>`   | length 3 = `[tx, ty, tz]` (m)             |
| `quaternion`  | `List<Float32>`   | length 4 = `[qx, qy, qz, qw]` scalar-last |

- Fixture: `test-fixtures/arrow_calibration.ipc` + generator
  `arrow_calibration_ipc()` in `crates/data-core/src/fixtures.rs`.
- Contract tests assert this schema on **both** sides
  (`crates/data-core/tests/arrow_contract.rs` and the JS Arrow contract test).
- wasm-bindings exposes a fetch returning the IPC bytes for a calibration
  channel; the worker surfaces it as `calibrationFetch(channelId)`.

## Source JSON format (`*.calib.json`, `driveline.calibration/v1`)

```jsonc
{
  "schema": "driveline.calibration/v1",
  "cameras": [
    {
      "name": "CAM_FRONT",
      "intrinsics": { "fx": 1266.4, "fy": 1266.4, "cx": 816.3, "cy": 491.5,
                      "width": 1600, "height": 900 },
      "distortion": [0, 0, 0, 0, 0],            // optional; omit or [] = none
      "extrinsic": {                            // scene/LiDAR -> camera optical
        "translation": [0.0, 0.0, 0.0],
        "quaternion":  [-0.5, 0.5, -0.5, 0.5]   // [qx,qy,qz,qw], scalar-last
      },
      "target_frame": "lidar"                   // informational only
    }
  ]
}
```

## Frontend contract

- `calibrationFromArrow.ts` decodes the IPC bytes to:
  ```ts
  interface CameraCalibration {
    name: string;
    intrinsics: { fx: number; fy: number; cx: number; cy: number;
                  width: number; height: number };
    distortion: number[];                       // [] or 5
    translation: [number, number, number];
    quaternion: [number, number, number, number]; // scalar-last
  }
  ```
- `cameraProjection.ts` — pure, unit-tested:
  `projectPoint(calib, p_scene): { u, v, depth, visible }` implementing the math
  above. Reuses the scalar-last quaternion rotation already in the renderer.
- State (`store.ts`): a per-video-panel overlay binding
  ```ts
  interface PointCloudOverlayBinding {
    calibrationChannelId: string;
    cameraName: string;        // which camera in the calibration source
    pointcloudChannelId: string;
  }
  // pointCloudOverlays: Record<videoPanelId, PointCloudOverlayBinding | null>
  ```
  plus a cache of decoded calibrations. Persist in the layout shard, following
  the `videoTimestampBinding.ts` precedent.
- `VideoPanel` draws the overlay on a second absolutely-positioned `<canvas>`
  sized to the **letterboxed** video content rect (`object-fit: contain`),
  inside the existing rAF blit loop, for the LiDAR spin nearest the
  currently-blitted frame PTS. Points coloured by depth. Must honour the
  canvas zoom/pan transform.
- Dev/agent hooks expose projected-point count + overlay state for Playwright.

## Datasets

1. **Synthetic** (`sample-data/`, deterministic): a known 3-D structure
   (ground grid + poles/markers) + a known forward-looking camera. The camera
   MP4 is rendered by projecting the *same* known scene, so overlay dots must
   land exactly on rendered markers — ground-truth correctness check. Emits
   LiDAR Parquet + MP4 + `.mp4.timestamps` + `.calib.json`.
2. **nuScenes v1.0-mini** (`scripts/convert_nuscenes_to_driveline.py`, real):
   one scene, `LIDAR_TOP` + `CAM_FRONT`. LiDAR `.pcd.bin` → Parquet, camera
   JPGs → MP4 + sidecar, `calibrated_sensor` (translation + quaternion, scalar
   FIRST in nuScenes → converted to scalar-last here) composed to a direct
   scene→camera extrinsic, `camera_intrinsic` → intrinsics. CC BY-NC-SA:
   downloaded to `/tmp`, converted output **gitignored**, hashes pinned.

   nuScenes gives `T_ego_from_sensor` per sensor. The direct LiDAR→camera
   extrinsic for a keyframe is `T_cam_from_lidar = inv(T_ego_from_cam) ∘
   T_ego_from_lidar`, i.e. `R = R_cam⁻¹ R_lidar`, `t = R_cam⁻¹ (t_lidar − t_cam)`.
