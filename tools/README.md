# tools

Standalone helper scripts that sit *beside* the Driveline app (not part of the
build). Run them with your own Python — they're not wired into `pnpm`/`cargo`.

## `alpamayo_lidar_to_driveline.py`

Converts one LiDAR clip from NVIDIA's **PhysicalAI-Autonomous-Vehicles
(Alpamayo)** dataset into a **Driveline point-cloud Parquet** (`*.lidar.parquet`)
that drops straight onto the app and binds to a 3D **Scene** panel.

Alpamayo ships LiDAR as Draco-compressed point clouds packed in per-chunk zips
(`lidar_top_360fov.chunk_XXXX.zip`, one Parquet per clip, one row per ~10 Hz
spin). This script decodes the Draco blobs and re-emits the columns the
viewer's `PointCloudReader` expects:

| column        | type             | meaning                                |
| ------------- | ---------------- | -------------------------------------- |
| `t_ns`        | `int64`          | spin timestamp, absolute nanoseconds   |
| `positions`   | `list<float32>`  | flattened xyz, length `3·N` (metres)   |
| `intensities` | `list<uint8>`    | per-point intensity 0..255             |

Requires `DracoPy` + `pyarrow` (already in the Alpamayo dev-kit venv):

```powershell
C:\Users\david\alpamayo\.venv\Scripts\python.exe `
  tools\alpamayo_lidar_to_driveline.py `
  --zip C:\Users\david\alpamayo\data\lidar\lidar_top_360fov\lidar_top_360fov.chunk_0000.zip `
  --clip 0 --max-points 120000 --out my_clip.lidar.parquet
```

Flags: `--clip` (index into the zip or a clip-id substring), `--max-points`
(per-spin cap, uniform subsample; `0` keeps all ~250k), `--max-spins`,
`--sensor`, `--seed`. Snappy compression is used deliberately — the WASM
Parquet reader is built without the zstd codec (size budget).

Then drop the `.lidar.parquet` on the Driveline window and bind it to a Scene
panel from the Panel drawer. Points are coloured by intensity and step with the
cursor as you scrub or play.

## PCD files (`*.pcd`) — no conversion needed

Driveline opens **PCD** (Point Cloud Data, the PCL/ROS LiDAR interchange
format) files directly: just drop a `.pcd` on the window and bind it to a Scene
panel. A PCD holds a single cloud, so it loads as a one-frame point-cloud
source. `ascii`, `binary`, and `binary_compressed` (LZF) payloads are all
supported; `x`/`y`/`z` are required and an `intensity` field (when present)
drives the colour (otherwise points are coloured by range).

Public example clouds to try (the second is a real laser scan, ~460 k points,
`binary_compressed` with intensity):

```bash
# A real LMS400 laser scan of a table scene
curl -LO https://raw.githubusercontent.com/PointCloudLibrary/data/master/tutorials/table_scene_lms400.pcd
# A smaller ascii model (x/y/z only — coloured by range)
curl -LO https://raw.githubusercontent.com/PointCloudLibrary/data/master/tutorials/ism_train_cat.pcd
```

The `apps/e2e/tests/lidar-pcd.spec.ts` test generates a synthetic LiDAR-style
scene (ground plane + a vehicle box + poles) inline and renders it, doubling as
a runnable worked example — see `apps/e2e/tests/screenshots/lidar-pcd-scene.png`.
