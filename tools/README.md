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
