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

### Camera models

A camera carries a `model` selecting how a camera-frame point projects to a
pixel. Two are supported:

| `model`   | intrinsics used                 | typical source                |
| --------- | ------------------------------- | ----------------------------- |
| `pinhole` | `intrinsics` + `distortion`     | nuScenes, the synthetic scene |
| `ftheta`  | `forward_poly` (+ `cx`,`cy`)    | Alpamayo / NVIDIA AV stacks   |

`model` is **optional in the JSON** and defaults to `pinhole`.

### The pinhole intrinsic + distortion

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
or exactly 5 floats `[k1, k2, p1, p2, k3]`.

### The f-theta (polynomial fisheye) intrinsic

Wide-FOV cameras (Alpamayo's 120° cameras, most NVIDIA AV rigs) follow an
**f-theta** model that a pinhole `fx`/`fy` cannot represent — at the rim of a
120° lens the pinhole `f·tan θ` is ~70% larger than the true radius, so points
slide off objects. Instead a `forward_poly` maps the ray's angle from the
optical axis to a pixel radius from the principal point. Projection of a
camera-frame point `(X, Y, Z)` with `Z > 0`:

```
θ   = atan2(hypot(X, Y), Z)        # angle of the ray from the +Z optical axis
ρ   = Σ forward_poly[i] · θ^i      # pixel radius from the principal point (Horner)
s   = ρ / hypot(X, Y)              # (on-axis hypot==0 → u=cx, v=cy)
u   = cx + X · s
v   = cy + Y · s
```

`forward_poly` is `[]` for `pinhole`, else ≥2 coefficients `[c0, c1, …]`
(`c0 ≈ 0`, `c1 ≈` the focal length). `distortion` is unused for `ftheta`; the
lens curvature lives entirely in the polynomial. `intrinsics.fx`/`fy` still
carry the linear-term approximation (`c1`) so a pinhole-only consumer degrades
gracefully, while `cx`/`cy` stay exact. Rays past the polynomial's first
turning point (where it stops increasing) are culled to avoid fold-over.

A point is **visible** (either model) iff `Z > 0` and `0 ≤ u < width` and
`0 ≤ v < height`.

## Wire contract: Arrow IPC

A new channel kind carries calibration. It is **config, not a time series** —
one fetch returns all cameras (one row per camera).

- Rust: `ChannelKind::CameraCalibration`, `SourceKind::Calibration`.
- Reader: `crates/data-core/src/calibration.rs` parsing a JSON file (below).
- Arrow IPC schema (one **row per camera**), all columns **non-nullable**,
  every vector field a `List<Float32>` / `List<Int32>` to match the OpenLABEL
  precedent (uniform, simple JS decode):

| column         | Arrow type      | meaning                                    |
| -------------- | --------------- | ------------------------------------------ |
| `name`         | `Utf8`          | camera name, e.g. `CAM_FRONT`              |
| `model`        | `Utf8`          | `"pinhole"` or `"ftheta"`                  |
| `intrinsics`   | `List<Float32>` | length 4 = `[fx, fy, cx, cy]` (px)         |
| `resolution`   | `List<Int32>`   | length 2 = `[width, height]` (px)          |
| `distortion`   | `List<Float32>` | length 0 or 5 = `[k1,k2,p1,p2,k3]`         |
| `forward_poly` | `List<Float32>` | length 0 (pinhole) or ≥2 ftheta coeffs     |
| `translation`  | `List<Float32>` | length 3 = `[tx, ty, tz]` (m)              |
| `quaternion`   | `List<Float32>` | length 4 = `[qx, qy, qz, qw]` scalar-last  |

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
      "model": "pinhole",                       // optional; "pinhole" (default) | "ftheta"
      "intrinsics": { "fx": 1266.4, "fy": 1266.4, "cx": 816.3, "cy": 491.5,
                      "width": 1600, "height": 900 },
      "distortion": [0, 0, 0, 0, 0],            // optional; omit or [] = none (pinhole only)
      "extrinsic": {                            // scene/LiDAR -> camera optical
        "translation": [0.0, 0.0, 0.0],
        "quaternion":  [-0.5, 0.5, -0.5, 0.5]   // [qx,qy,qz,qw], scalar-last
      },
      "target_frame": "lidar"                   // informational only
    },
    {
      "name": "CAM_FISHEYE",
      "model": "ftheta",
      "intrinsics": { "fx": 926.1, "fy": 926.1, "cx": 960.0, "cy": 540.0,
                      "width": 1920, "height": 1080 },  // fx/fy = forward_poly[1] approx
      "forward_poly": [0, 926.1, -3.2, -19.3, 3.7],     // required for "ftheta"
      "extrinsic": {
        "translation": [0.0, 0.0, 0.0],
        "quaternion":  [-0.5, 0.5, -0.5, 0.5]
      },
      "target_frame": "lidar"
    }
  ]
}
```

## Frontend contract

- `calibrationFromArrow.ts` decodes the IPC bytes to:
  ```ts
  interface CameraCalibration {
    name: string;
    model: "pinhole" | "ftheta";
    intrinsics: { fx: number; fy: number; cx: number; cy: number;
                  width: number; height: number };
    distortion: number[];                       // [] or 5 (pinhole)
    forwardPoly: number[];                      // [] (pinhole) or >=2 (ftheta)
    translation: [number, number, number];
    quaternion: [number, number, number, number]; // scalar-last
  }
  ```
- `cameraProjection.ts` — pure, unit-tested:
  `projectPoint(calib, p_scene): { u, v, depth, visible }` branching on
  `calib.model` (pinhole or f-theta) per the math above. Reuses the scalar-last
  quaternion rotation already in the renderer.
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

3. **Alpamayo** (NVIDIA PhysicalAI-AV, real, `model: "ftheta"`): the external
   `build_bundle.py` converter emits a `<clip>.calib.json` from the dataset's
   `camera_intrinsics` (the `fw_poly_*` f-theta coefficients → `forward_poly`,
   `cx`/`cy` exact) and `sensor_extrinsics` (per-sensor → ego), composing the
   same `R_cam⁻¹ R_lidar` / `R_cam⁻¹ (t_lidar − t_cam)` LiDAR→camera extrinsic as
   nuScenes. The LiDAR cloud stays in the `lidar_top_360fov` sensor frame, so the
   extrinsic targets that frame. License forbids redistribution → local only.
