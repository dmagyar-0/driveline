# Real-world ADAS / robotics datasets for Driveline

Driveline ingests **MCAP** (Foxglove-style schemas: H.264
`CompressedVideo`, `Float64`, `Vector3`, enum-coded state) and **MF4**
(ASAM MDF4) files. Any dataset whose CAN/IMU/GPS/video traces can be
expressed in those shapes will load with no reader changes.

This file lists seven public datasets that fit the tool, with links,
licences, and conversion notes. One of them (comma2k19) is wired up
end-to-end — see [`scripts/convert_comma2k19_to_mcap.py`](../../scripts/convert_comma2k19_to_mcap.py)
and the e2e proof in [`apps/e2e/tests/realworld-comma2k19.spec.ts`](../../apps/e2e/tests/realworld-comma2k19.spec.ts).

| # | Dataset | Domain | Format on disk | Conversion path | Licence |
|---|---------|--------|----------------|-----------------|---------|
| 1 | [comma2k19](https://github.com/commaai/comma2k19) (also [HF mirror](https://huggingface.co/datasets/commaai/comma2k19)) | ADAS, 33 h CA-280 highway, CAN + GNSS + IMU + dashcam | rlog (capnp) + HEVC / parquet on HF | `scripts/convert_comma2k19_to_mcap.py` (HF parquet → MCAP) | MIT |
| 2 | [nuScenes](https://www.nuscenes.org/nuscenes) (Motional) | ADAS, 1 000 urban scenes, 6 cams + 5 radars + LiDAR | custom JSON + JPG + LiDAR `.pcd.bin` | [`foxglove/nuscenes2mcap`](https://github.com/foxglove/nuscenes2mcap) (Docker, registration) | CC BY-NC-SA 4.0 |
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

The `_demo-*` prefix keeps the spec out of the default CI run — it
needs the three large fixtures above, which aren't checked in.

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
