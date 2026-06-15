# tools

Standalone helper scripts that sit *beside* the Driveline app (not part of the
build). Run them with your own Python — they're not wired into `pnpm`/`cargo`.

## NVIDIA Alpamayo (PhysicalAI-AV) dataset

**Driveline opens the dataset's raw LiDAR natively — no conversion.** Alpamayo
ships LiDAR as Draco-compressed point clouds packed in per-chunk zips
(`lidar_top_360fov.chunk_XXXX.zip`, one Parquet per clip, one row per ~10 Hz
spin: `spin_start_timestamp` µs + a `draco_encoded_pointcloud` blob). Driveline
content-sniffs that schema, decodes the Draco spins **in the browser** (Google's
reference decoder, loaded lazily), and renders them in a 3D **Scene** panel —
positions + intensity, stepping with the cursor. The file opens under any name
(`*.parquet` or `*.lidar.parquet`).

So all you need to do is get one clip's files out of the chunk zips.

### `alpamayo_open.py` — extract a drop-ready clip

Pulls one clip's files out of the dataset's chunk zips into a folder you drag
onto the app. **LiDAR extraction needs nothing but the Python standard library**
(no `DracoPy`, no `pyarrow` — the app does the Draco decode):

```powershell
# LiDAR only, first clip of chunk 0:
python tools\alpamayo_open.py --root C:\Users\you\alpamayo\data --clip 0 --out clip0

# A specific clip id, plus cameras + egomotion (these need pyarrow + numpy):
python tools\alpamayo_open.py --root ...\data --clip 25cd4769 `
  --with-cameras --with-egomotion --out my_clip
```

`--clip` is an index into the LiDAR chunk zip or a clip-id substring; `--chunk`
picks the chunk (default `0`). Then drag the `--out` folder's files onto the
window:

- **LiDAR** → add a **Scene** panel (Panel drawer) and bind the point-cloud
  channel. Coloured by intensity, steps with the cursor.
- **Cameras** → a **Video** panel each (the `.mp4` auto-pairs with the
  `.mp4.timestamps` sidecar the tool generated).
- **Egomotion** → opens via the tabular import dialog (time column `timestamp`,
  unit **microseconds**, mode **Absolute**).

Already have a single clip's `<clip>.lidar_top_360fov.parquet` extracted? Just
drop it — no tool needed.

### Driving it from an agent (headless)

The dataset is driveable end-to-end with no human clicking. File **bytes** enter
through the page's drop seam (file ingestion is intentionally off the
`window.__drivelineAgent` surface); everything after is `__drivelineAgent`:

1. Open the page with `?agent` to unlock the mutating ops (always unlocked in a
   dev build). `window.__drivelineAgent.getSkill()` prints the full guide.
2. Feed the LiDAR parquet to the page:
   - **dev build:** `window.__drivelineDevHooks.openFiles([{ name, bytes }])`
     (one call — what the e2e uses).
   - **packaged build (browser-automation agent):** drop the file on
     `[data-testid="drop-zone"]`, or use the Sources drawer's **Load** input
     (`[data-testid="sources-load-btn"]`).
3. Drive `__drivelineAgent`:

   ```js
   const a = window.__drivelineAgent;
   const cloud = a.listChannels().find((c) => c.kind === "point_cloud");
   const panel = a.createPanel("scene");
   a.setSceneBinding(panel, cloud.id);   // display the LiDAR
   a.setCursor("89971000");              // ns as a decimal STRING; play()/pause() to animate
   ```

`setSceneBinding(panelId, channelId)` (agent API v4+) is how a scene panel binds
a `point_cloud` / `bounding_box` / `trajectory` / `map_geometry` channel — it's
one-at-a-time, so it's a setter, not the list-oriented `bindChannels`. See
`docs/13-bring-your-own-agent.md`.

### `alpamayo_lidar_to_driveline.py` — optional offline conversion

You no longer need this to *view* a clip's LiDAR. It's still useful to
**subsample** (`--max-points`), batch-convert offline, or produce a slimmed,
hostable file. It decodes the Draco blobs into a **Driveline point-cloud
Parquet** (`*.lidar.parquet`) with the columns `PointCloudReader::open` expects:

| column        | type             | meaning                                |
| ------------- | ---------------- | -------------------------------------- |
| `t_ns`        | `int64`          | spin timestamp, absolute nanoseconds   |
| `positions`   | `list<float32>`  | flattened xyz, length `3·N` (metres)   |
| `intensities` | `list<uint8>`    | per-point intensity 0..255             |

Requires `DracoPy` + `pyarrow`:

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
