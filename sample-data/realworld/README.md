# Real-world ADAS / robotics datasets for Driveline

Driveline ingests **MCAP** (Foxglove-style schemas: H.264
`CompressedVideo`, `Float64`, `Vector3`, enum-coded state) and **MF4**
(ASAM MDF4) files. Any dataset whose CAN/IMU/GPS/video traces can be
expressed in those shapes will load with no reader changes.

This file lists seven public datasets that fit the tool, with links,
licences, and conversion notes. Two of them are wired up end-to-end:
**comma2k19** (CAN/IMU/GNSS + dashcam → MCAP/MF4 + mp4) — see
[`scripts/convert_comma2k19_to_mcap.py`](../../scripts/convert_comma2k19_to_mcap.py)
and the e2e proof in [`apps/e2e/tests/realworld-comma2k19.spec.ts`](../../apps/e2e/tests/realworld-comma2k19.spec.ts) —
and **nuScenes** (LiDAR + camera + calibration for the point-cloud-on-camera
overlay) via
[`scripts/convert_nuscenes_to_driveline.py`](../../scripts/convert_nuscenes_to_driveline.py)
(see the [nuScenes section](#nuscenes-point-cloud-on-camera-lidar--camera--calibration) below).

| # | Dataset | Domain | Format on disk | Conversion path | Licence |
|---|---------|--------|----------------|-----------------|---------|
| 1 | [comma2k19](https://github.com/commaai/comma2k19) (also [HF mirror](https://huggingface.co/datasets/commaai/comma2k19)) | ADAS, 33 h CA-280 highway, CAN + GNSS + IMU + dashcam | rlog (capnp) + HEVC / parquet on HF | `scripts/convert_comma2k19_to_mcap.py` (HF parquet → MCAP) | MIT |
| 2 | [nuScenes](https://www.nuscenes.org/nuscenes) (Motional) | ADAS, 1 000 urban scenes, 6 cams + 5 radars + LiDAR | custom JSON + JPG + LiDAR `.pcd.bin` | `scripts/convert_nuscenes_to_driveline.py` (v1.0-mini → point-cloud Parquet + mp4/sidecar + calibration; see below) | CC BY-NC-SA 4.0 |
| 3 | [Waymo Open Dataset](https://waymo.com/open/) | ADAS, perception + motion | TFRecord (protobuf) | [`waymo_open_dataset` → MCAP](https://foxglove.dev/blog/converting-the-waymo-open-dataset-to-mcap) | Waymo Dataset Licence |
| 4 | [Argoverse 2](https://www.argoverse.org/av2.html) (Argo AI) | ADAS, motion forecasting + sensor + LiDAR | feather + JPG + LiDAR `.feather` | [`av2 → MCAP`](https://foxglove.dev/blog/converting-the-argoverse-2-dataset-to-mcap) | CC BY-NC-SA 4.0 |
| 5 | [KITTI raw](https://www.cvlibs.net/datasets/kitti/raw_data.php) | ADAS, Karlsruhe drive sequences, OXTS GPS/IMU + grayscale + colour stereo + Velodyne | per-folder text/PNG/bin | [`kitti2bag`](https://github.com/tomas789/kitti2bag) → `mcap convert` | CC BY-NC-SA 3.0 |
| 6 | [EuRoC MAV](https://projects.asl.ethz.ch/datasets/doku.php?id=kmavvisualinertialdatasets) (ETH Zürich) | Robotics, micro-drone visual-inertial + ground truth | rosbag + ASL CSV | `rosbag → mcap convert` (or CSV → small Python writer using foxglove.Vector3) | CC BY 3.0 |
| 7 | [CSS Electronics CANedge sample MF4](https://www.csselectronics.com/pages/mf4-mdf4-measurement-data-format) | Real J1939 / OBD2 truck CAN logs | `.MF4` | drop directly into Driveline (the MF4 reader already handles them) | Free for use |

## End-to-end demo

The repository ships a working pipeline for #1 (comma2k19). To
reproduce locally:

```sh
# 1. Pull a chunk of the public demo parquet (~81 MB, 22 segments).
mkdir -p /tmp/datasets
curl -L -o /tmp/datasets/comma2k19_demo.parquet \
  https://huggingface.co/datasets/commaai/comma2k19/resolve/main/data/demo-00000-of-00003.parquet

# 1b. (optional) verify the parquet against the SHA256 pinned in
#     sample-data/EXPECTED_HASHES.txt. The converter does the same
#     check on read.
grep comma2k19_demo.parquet sample-data/EXPECTED_HASHES.txt \
  | (cd /tmp/datasets && sha256sum -c -)

# 2. Convert one segment to MCAP using the foxglove.* schemas Driveline
#    already understands. Output is sample-data/realworld/comma2k19.mcap.
#    Versions are constrained for reproducibility — newer majors may
#    move the parquet/MCAP APIs the converter relies on.
pip install 'mcap>=1.2,<2' 'pyarrow>=14,<20' 'numpy>=1.24,<3'
python3 scripts/convert_comma2k19_to_mcap.py

# 3. Open it in the dev server. Drop the file into the browser at
#    http://localhost:5173, or run the e2e spec for the same flow:
pnpm wasm:build
pnpm --filter e2e exec playwright test realworld-comma2k19.spec.ts
```

The spec asserts that:
- the file opens through the existing MCAP adapter,
- 9 channels are inferred (`/vehicle/speed` etc. as scalar,
  `/imu/accel` etc. as vector),
- a single PlotPanel bound to `/vehicle/speed` and
  `/vehicle/steering_angle` simultaneously produces real per-series
  stats with plausible bounds (speed 25–35 m/s, steering ±90°) —
  i.e., Highway 280 driving from 2018-07-27.

Screenshot: `apps/e2e/tests/screenshots/comma2k19-multi-channel.png`
shows both signals plotted on the same panel with the time axis at
the actual recording wall-clock (`7/27/18, 6:04 am`).

### Adding the dashcam video (video + signals demo)

The HF demo parquet ships only CAN/IMU/GNSS — the dashcam HEVC for
the same segment lives in the `compression_challenge/` directory
alongside it. Pairing it with the converted MCAP gives the
"camera + signals" visualisation in
`apps/e2e/tests/screenshots/comma2k19-video-plus-signals.png`.

```sh
SEG="b0c9d2329ad1606b%7C2018-07-27--06-03-57/10"
OUT=sample-data/realworld

# 1. Pull the 37 MB HEVC clip for segment 10.
curl -sL -o /tmp/datasets/video_seg10.hevc \
  "https://huggingface.co/datasets/commaai/comma2k19/resolve/main/compression_challenge/${SEG}/video.hevc"

# 2. Transcode HEVC → H.264 MP4 at 20 fps. WebCodecs in Driveline is
#    avc1.* only; HEVC isn't supported. GOP 20 keeps seeks snappy.
ffmpeg -framerate 20 -i /tmp/datasets/video_seg10.hevc \
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
  -g 20 -keyint_min 20 -movflags +faststart -an \
  "$OUT/comma2k19_seg10.mp4"

# 3. Generate the `.mp4.timestamps` sidecar. Anchor frame 0 to the
#    same segment-start wall-clock the converter uses for the MCAP
#    (parse_segment_start_ns) so video PTS and signal timestamps share
#    a clock — otherwise the video would slide off the scrubber.
python3 - <<'PY'
from datetime import datetime, timezone
start_ns = int(datetime.strptime(
    "2018-07-27--06-03-57", "%Y-%m-%d--%H-%M-%S"
).replace(tzinfo=timezone.utc).timestamp() * 1_000_000_000)
with open("sample-data/realworld/comma2k19_seg10.mp4.timestamps", "w") as f:
    for i in range(1200):                # 60 s × 20 fps
        f.write(f"{i}\t{start_ns + i * 50_000_000}\n")
PY

# 4. Drop comma2k19.mcap + comma2k19_seg10.mp4 + the sidecar onto the
#    browser at http://localhost:5173, or run the visualisation spec:
pnpm --filter e2e exec playwright test _demo-comma2k19-video.spec.ts
```

> ⚠️ **Use the zero-offset signal files with the dashcam.** The dashcam
> (`comma2k19_seg10.mp4`) is anchored at the drive root (06:03:57, the
> true segment-10 start). Pair it with `comma2k19.mcap` /
> `comma2k19.mf4`, which share that anchor, so video and signals line up.
> Do **not** pair it with the `comma2k19_seg10_at600s.*` files — those are
> the multi-segment-demo variants shifted +600 s (see the next section),
> so their signals sit 10 minutes *after* the video on the unified
> timeline. Dropping the `_at600s` files next to the dashcam is exactly
> what produces a long stretch of timeline where the video panel reads
> "no video at this time" while the plots show data elsewhere — the files
> are individually correct, just not meant to be combined.

The `_demo-*` prefix keeps the spec out of the default CI run — it
needs the three large fixtures above, which aren't checked in.

## nuScenes: point cloud on camera (lidar + camera + calibration)

[`scripts/convert_nuscenes_to_driveline.py`](../../scripts/convert_nuscenes_to_driveline.py)
wires up dataset #2 (nuScenes v1.0-mini) end-to-end for the
**point-cloud-on-camera overlay** — the real-world companion to the
synthetic calibration fixture. It converts one scene's `LIDAR_TOP` +
`CAM_FRONT` into the three Driveline formats the overlay needs:

- `nuscenes.lidar.parquet` — Driveline point-cloud schema
  (see [`crates/data-core/src/pointcloud.rs`](../../crates/data-core/src/pointcloud.rs)):
  one row per LIDAR_TOP sample_data (keyframes **and** sweeps), points in
  the LIDAR_TOP sensor frame, `t_ns` from the nuScenes µs timestamp.
- `nuscenes_cam_front.mp4` + `.mp4.timestamps` — the CAM_FRONT JPGs encoded
  to H.264 (avc1, what WebCodecs needs) with one real per-frame ns timestamp
  in the sidecar (see [`crates/data-core/src/mp4_sidecar.rs`](../../crates/data-core/src/mp4_sidecar.rs)).
- `nuscenes_cam_front.calib.json` — `driveline.calibration/v1`
  (see [`docs/13-camera-lidar-calibration.md`](../../docs/13-camera-lidar-calibration.md)):
  CAM_FRONT pinhole intrinsics from `camera_intrinsic`, distortion `[]`
  (nuScenes images are pre-undistorted), and the **LIDAR_TOP → CAM_FRONT**
  optical extrinsic (translation + scalar-last quaternion).

> nuScenes is **CC BY-NC-SA 4.0 (non-commercial)**. The 4.16 GB archive is
> downloaded to `/tmp`, the converted output lands in
> `/tmp/datasets/nuscenes_demo/`, and **none of those bytes are committed** —
> the script + this doc + the pinned `v1.0-mini.tgz` SHA256 in
> [`sample-data/EXPECTED_HASHES.txt`](../EXPECTED_HASHES.txt) are the only
> tracked artefacts.

```sh
# 1. Tooling: ffmpeg (avc1 encode) + the same pyarrow/numpy the converter uses.
#    The converter parses the nuScenes JSON tables directly — no devkit needed.
sudo apt-get install -y ffmpeg          # or your platform's package manager
pip install 'pyarrow>=14,<20' 'numpy>=1.24,<3'

# 2. Convert. The script downloads v1.0-mini.tgz to /tmp (resumable curl -C -),
#    verifies its size + SHA256 against EXPECTED_HASHES.txt, extracts it, picks
#    scene index 0 (scene-0061), and emits the four files into
#    /tmp/datasets/nuscenes_demo/. Re-runs are idempotent: an already-extracted
#    tree is reused. Use --skip-download if you extracted it yourself.
python3 scripts/convert_nuscenes_to_driveline.py

# 3. Open it in the dev server. Drop the four files
#    (nuscenes.lidar.parquet, nuscenes_cam_front.mp4,
#     nuscenes_cam_front.mp4.timestamps, nuscenes_cam_front.calib.json)
#    onto http://localhost:5173 together. The .mp4 + .timestamps pair as one
#    video source; bind the point-cloud overlay on the video panel to the
#    LIDAR_TOP channel via the CAM_FRONT calibration.
pnpm wasm:build && pnpm dev
```

The converter ends with a self-check it prints: the Parquet schema + row
count + a sample point, the mp4 frame count vs sidecar line count (must
match exactly or `Mp4SidecarReader` rejects the pair), finite intrinsics +
extrinsic, and a **reprojection sanity check** — it transforms one keyframe's
LIDAR_TOP spin by the extrinsic + intrinsics and reports the fraction of
points that land in front of the camera (`Z>0`) and inside the 1600×900
image. For scene-0061 that's ~34 % in front (a 360° LiDAR vs a forward
camera) and ~8 % inside the frame, with a point 10 m straight ahead landing
within a pixel of the principal point — the overlay is geometrically aligned.

Representative scene-0061 calibration (what the converter prints):

```text
intrinsics: fx=1266.417 fy=1266.417 cx=816.267 cy=491.507  1600x900
extrinsic translation: [0.0119, -0.3250, -0.7590]
extrinsic quaternion (xyzw): [0.70050, 0.00364, 0.00113, 0.71364]
```

#### Recording the fusion demo video

`apps/e2e/tests/_demo-nuscenes-fusion.spec.ts` records a shareable demo video
of the full camera + LiDAR capability set this data unlocks, in one continuous
replay with a persistent attribution/licence banner. There is **no** opening
title card — the finished video opens straight on the live dashboard playing
(the point-cloud load + panel wiring that happen before playback are trimmed
off in post-processing using the play-start marker the spec logs):

- **left** — CAM_FRONT dashcam with the LiDAR point cloud projected onto it
  (point-cloud-on-camera overlay),
- **top-right** — the same spin in the 3D Scene panel,
- **bottom-right** — a Plot of the ego signals (speed + yaw-rate) derived from
  the scene's `ego_pose` track by `convert_nuscenes_signals_to_mcap.py`.

> There is exactly **one** video panel by design: two video panels bound to the
> *same* mp4 contend for that source's single decoder and the second lags it by
> seconds (a stuck/desynced-looking camera). Two camera feeds need two separate
> files — see the comma2k19 dashboard-record spec's hflipped second mp4.

```sh
# 1. Convert geometry + derive signals, then copy all five outputs into
#    sample-data/realworld/ (gitignored except README.md, never committed):
pip install 'mcap>=1.2,<2' 'pyarrow>=14,<20' 'numpy>=1.24,<3'   # + ffmpeg
python3 scripts/convert_nuscenes_to_driveline.py
python3 scripts/convert_nuscenes_signals_to_mcap.py
cp /tmp/datasets/nuscenes_demo/nuscenes.lidar.parquet \
   /tmp/datasets/nuscenes_demo/nuscenes_cam_front.mp4 \
   /tmp/datasets/nuscenes_demo/nuscenes_cam_front.mp4.timestamps \
   /tmp/datasets/nuscenes_demo/nuscenes_cam_front.calib.json \
   /tmp/datasets/nuscenes_demo/nuscenes.signals.mcap \
   sample-data/realworld/

# 2. Record (Playwright writes a .webm under apps/e2e/test-results/):
pnpm wasm:build
pnpm --filter e2e exec playwright test _demo-nuscenes-fusion.spec.ts --timeout=240000

# 3. Post-process the .webm into a shareable .mp4 that shows ONLY the scene
#    playing. The spec logs a trim window line, e.g.:
#      [demo] TRIM_WINDOW play_start_ms=13101 play_end_ms=25760 hold_end_ms=27386
#    Those offsets are measured from `recordStart` (just before the file open),
#    while the .webm clock starts at page creation, so add the small lead-in
#    offset = webm_duration - hold_end_ms. Trim the .webm from that play-start
#    to the end (the final hero hold) — no load, no setup, no card:
WEBM=$(find apps/e2e/test-results -name '*.webm' | head -1)
WEBM_DUR=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$WEBM")
HOLD_END_MS=27386     # from the TRIM_WINDOW log line above
PLAY_START_MS=13101   # from the TRIM_WINDOW log line above
# webm time of play-start = play_start + (webm_duration*1000 - hold_end_ms)
START=$(python3 -c "print((${PLAY_START_MS} + ${WEBM_DUR}*1000 - ${HOLD_END_MS})/1000)")
ffmpeg -y -ss "$START" -i "$WEBM" -an \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  driveline-nuscenes-fusion.mp4
# sanity: first/last frame should be the live dashboard + the hero fusion frame
#   ffmpeg -i driveline-nuscenes-fusion.mp4 -frames:v 1 /tmp/first.png -y
#   ffmpeg -sseof -0.3 -i driveline-nuscenes-fusion.mp4 -frames:v 1 /tmp/last.png -y
```

> **GPU vs. headless.** Playback is decode-aware: it holds the cursor while the
> video decoder catches up. With **GPU-accelerated WebCodecs + WebGL** the
> decoder keeps up and the scene plays at full **1×** — so the title-card load
> is short and the replay is a smooth single take. In a headless / GPU-less box
> (no `/dev/dri`, software decode + SwiftShader) the gate engages often and
> playback runs under 1×, so the load is longer and ~16 s of wall time covers
> only part of the scene. On a GPU machine, raise the play window in the spec
> (`page.waitForTimeout(16000)`) to ~**20000** ms to cover the whole ~19 s scene
> in one pass.

> ⚠️ **Licence.** The recording is a derivative of nuScenes, so it inherits
> **CC BY-NC-SA 4.0**: attribute Motional, keep it **non-commercial**, and
> share it **under the same licence**. The spec bakes the attribution banner
> into the video for this reason. The video itself is **not** committed (it's
> NC-licensed and multi-MB). For an unrestricted demo, record the MIT-licensed
> comma2k19 path instead (the `_demo-comma2k19-*-record.spec.ts` specs).

### Splitting signals across MCAP and MF4

`scripts/convert_comma2k19_to_mf4.py` emits a second copy of the
secondary signals (wheel speeds, IMU components, GNSS lat/lon/alt)
as an MF4 file with `start_time` anchored to the same segment-start
wall-clock the MCAP converter uses. Driveline opens both together,
and a single plot panel can carry one channel from each. Demoed in
`apps/e2e/tests/screenshots/comma2k19-mcap-plus-mf4.png`.

```sh
pip install asammdf 'pyarrow>=14,<20' 'numpy>=1.24,<3'
python3 scripts/convert_comma2k19_to_mf4.py
#   -> sample-data/realworld/comma2k19.mf4 (~0.45 MB, 13 scalars)
```

The second test in `_demo-comma2k19-video.spec.ts` drops the mp4 +
sidecar + mcap + mf4 in one go, binds the plot panel to
`/vehicle/speed` (from the MCAP) and `WheelSpeedFL` (from the MF4),
and asserts the per-series stats land for both channel ids. The
status line reads "3 sources" — the mp4 + sidecar pair counts as
one, the mcap as a second, the mf4 as a third.

### Multiple MCAPs + multiple MF4s on two panels

Both converters take `--segment-offset-seconds N` so several segments
of the same drive can land at distinct wall-clock positions on
Driveline's timeline (each comma2k19 segment is 60 s, so segment N
belongs at `N*60`). Generate per-segment MCAP + MF4 pairs for
segments 4, 7, 10 of the 2018-07-27--06-03-57 drive:

```sh
for entry in 0:10:600 1:4:240 2:7:420; do
  IFS=: read -r idx seg off <<<"$entry"
  # The `_at${off}s` suffix records the offset in the filename so these
  # multi-segment files are never mistaken for the zero-offset
  # comma2k19.mcap/.mf4 that align with the dashcam (see warning below).
  python3 scripts/convert_comma2k19_to_mcap.py \
    --segment-index "$idx" --segment-offset-seconds "$off" \
    --out "sample-data/realworld/comma2k19_seg${seg}_at${off}s.mcap"
  python3 scripts/convert_comma2k19_to_mf4.py \
    --segment-index "$idx" --segment-offset-seconds "$off" \
    --out "sample-data/realworld/comma2k19_seg${seg}_at${off}s.mf4"
done
```

The third test (`plots 3 MCAPs and 3 MF4s across two side-by-side
panels`) drops the six files, installs a custom layout with two
plot tabs, and binds:

- `plot-1` to `/vehicle/speed` (MCAP) and `WheelSpeedFL` (MF4) for
  each of the three segments — six series, all m/s.
- `plot-2` to `/vehicle/steering_angle` (MCAP, deg) and `IMU_Gyro_Z`
  (MF4, rad/s) for each segment — six series, two y-axes.

Status line reads "6 sources" and the time axis spans 06:07–06:14
with one 60 s data block per segment. Screenshot at
`apps/e2e/tests/screenshots/comma2k19-multi-segment-multi-panel.png`.

### Splitting one segment across multiple files

Each comma2k19 segment carries ~15 distinct signal groups (CAN
speed/steering/wheels, IMU accel/gyro, GNSS u-blox/qcom, …). Both
converters take `--only NAME[,NAME]` to emit a subset, so a single
segment can be fanned out into several topic-specific files without
touching the parquet more than once. The known groups are:

- MCAP: `speed`, `steering_angle`, `wheel_speed`, `accel`, `gyro`, `gnss`
- MF4: `wheels`, `accel`, `gyro`, `gnss`

Generate the four-file split used by the fourth demo test:

```sh
python3 scripts/convert_comma2k19_to_mcap.py --only speed,steering_angle \
  --out sample-data/realworld/comma2k19_chassis.mcap
python3 scripts/convert_comma2k19_to_mcap.py --only wheel_speed \
  --out sample-data/realworld/comma2k19_wheels.mcap
python3 scripts/convert_comma2k19_to_mf4.py --only accel,gyro \
  --out sample-data/realworld/comma2k19_imu.mf4
python3 scripts/convert_comma2k19_to_mf4.py --only gnss \
  --out sample-data/realworld/comma2k19_gnss.mf4
```

The fourth test (`splits one segment across 4 files and plots them on
2 panels`) drops the four files, installs the same two-plot layout,
and binds:

- `plot-1` — `/vehicle/speed` (chassis.mcap), four wheel speeds
  (wheels.mcap), three IMU accel axes (imu.mf4) — 8 chips, the
  panel's max, pulling from three files.
- `plot-2` — `/vehicle/steering_angle` (chassis.mcap), three IMU
  gyro axes (imu.mf4), `GNSS_Alt` (gnss.mf4) — 5 chips, also from
  three files. `GNSS_Lat` / `GNSS_Lon` are deliberately omitted —
  on the CA-280 segment those values sit at ~40 and ~-120 and
  would squash every other series on the shared y-axis.

Status line reads "4 sources" and both panels render a full 60 s of
data with no gaps. Screenshot at
`apps/e2e/tests/screenshots/comma2k19-split-by-topic.png`.

The fifth test (`splits one segment + dashcam video across 3 panels`)
drops the same four signal files plus the mp4 + sidecar pair, and
uses a nested-row layout (`row[tabset(video), row[tabset(plot-1),
tabset(plot-2)]]`) so the dashcam takes the left 40 % and the two
plots stack on the right 60 %. Status line reads "5 sources".
Screenshot at
`apps/e2e/tests/screenshots/comma2k19-split-by-topic-with-video.png`.

> Bug history: this dataset originally hit a PlotPanel bug where
> binding two CAN channels with non-coincident timestamps produced
> two invisible traces. `mergeSeries` correctly emits `null` at every
> union timestamp where the other channel has a sample, but the
> uPlot series were configured with `spanGaps:false`, so each trace
> collapsed to isolated 1-pixel dots. Fixed in PlotPanel by
> spanning gaps per-series, which also matches the step-hold
> rendering documented in `docs/03-data-model.md`.

## Why these seven

- **Format coverage.** #1, #5, #6 cover the MCAP path with H.264 video
  + scalar CAN + vector IMU. #7 is the only one that hits the MF4
  path directly without conversion.
- **Domain coverage.** #2 / #3 / #4 are the canonical large-scale
  perception datasets; #5 and #1 are the canonical mid-size driving
  datasets; #6 covers aerial / robotics; #7 covers heavy-duty truck
  CAN telemetry.
- **Reliability.** Each source has a stable institutional sponsor
  (Motional, Waymo, Argo, KITTI/Karlsruhe, ETHZ ASL, comma.ai, CSS
  Electronics) and a published licence — none are mirror-only or
  hobbyist uploads.
- **Reachable from a fresh clone.** #1, #5, #7 require no account
  registration; #2, #3, #4 require a one-time research-licence
  click-through; #6's rosbags / CSVs are open download.
