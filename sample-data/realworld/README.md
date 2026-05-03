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

# 2. Convert one segment to MCAP using the foxglove.* schemas Driveline
#    already understands. Output is sample-data/realworld/comma2k19.mcap.
pip install mcap pyarrow numpy
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
