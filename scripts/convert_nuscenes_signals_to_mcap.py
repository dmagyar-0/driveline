#!/usr/bin/env python3
"""Derive ego-vehicle signals from one nuScenes scene and write them as MCAP.

The companion to `scripts/convert_nuscenes_to_driveline.py`: that script emits
the LiDAR / camera / calibration for the point-cloud-on-camera overlay; this one
turns the scene's `ego_pose` track into plottable scalar signals so a Driveline
Plot panel has real data alongside the dashcam and point cloud.

Output (default `/tmp/datasets/nuscenes_demo/nuscenes.signals.mcap`): the same
Foxglove JSON schema Driveline already recognises (`foxglove.Float64`):

  /ego/speed        foxglove.Float64   m/s     ground speed |dpos/dt|
  /ego/yaw_rate     foxglove.Float64   deg/s   d(yaw)/dt from the pose quaternion
  /ego/accel        foxglove.Float64   m/s^2   d(speed)/dt

Sampled at the LIDAR_TOP sample_data cadence (keyframes + sweeps, ~13 Hz), with
log_time = ego_pose timestamp (us -> ns) so the signals share the exact clock as
nuscenes.lidar.parquet and nuscenes_cam_front.mp4 (which use the same nuScenes
microsecond timestamps), and line up on Driveline's unified timeline.

Frames: nuScenes ego_pose is the ego body in the global map frame; speed is
frame-invariant, and yaw is taken from the pose quaternion's heading about z.
No devkit dependency — the JSON tables are parsed directly.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from mcap.writer import CompressionType, Writer

HERE = Path(__file__).resolve().parent
SCHEMAS = HERE.parent / "sample-data" / "schemas"

DEFAULT_DATASET_DIR = Path("/tmp/datasets/nuscenes-mini")
DEFAULT_OUT = Path("/tmp/datasets/nuscenes_demo/nuscenes.signals.mcap")
LIDAR_SENSOR = "LIDAR_TOP"


def load_table(tables_dir: Path, name: str) -> list[dict]:
    return json.loads((tables_dir / f"{name}.json").read_text())


def index_by_token(rows: list[dict]) -> dict[str, dict]:
    return {r["token"]: r for r in rows}


def yaw_from_quat_wxyz(q: list[float]) -> float:
    """Heading (rotation about the global z axis) of a scalar-first quaternion."""
    w, x, y, z = q
    siny_cosp = 2.0 * (w * z + x * y)
    cosy_cosp = 1.0 - 2.0 * (y * y + z * z)
    return math.atan2(siny_cosp, cosy_cosp)


def f64_payload(ts_ns: int, value: float) -> bytes:
    return json.dumps({
        "timestamp": {"sec": ts_ns // 1_000_000_000,
                      "nsec": ts_ns % 1_000_000_000},
        "value": float(value),
    }).encode("utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--scene-index", type=int, default=0)
    args = ap.parse_args()

    tables_dir = args.dataset_dir / "v1.0-mini"
    if not (tables_dir / "sample.json").exists():
        sys.exit(f"nuScenes tables not found under {tables_dir}; run "
                 f"convert_nuscenes_to_driveline.py first (it extracts them).")

    scenes = load_table(tables_dir, "scene")
    samples = load_table(tables_dir, "sample")
    sample_datas = load_table(tables_dir, "sample_data")
    calibrated_sensors = load_table(tables_dir, "calibrated_sensor")
    sensors = load_table(tables_dir, "sensor")
    ego_poses = load_table(tables_dir, "ego_pose")

    sample_by_token = index_by_token(samples)
    cs_by_token = index_by_token(calibrated_sensors)
    sensor_by_token = index_by_token(sensors)
    ego_by_token = index_by_token(ego_poses)

    if args.scene_index >= len(scenes):
        sys.exit(f"scene-index {args.scene_index} out of range ({len(scenes)} scenes)")
    scene = scenes[args.scene_index]
    print(f"scene {args.scene_index}: {scene['name']}  token={scene['token']}")

    # Sample tokens of the scene (walk the keyframe linked list).
    scene_sample_tokens: set[str] = set()
    tok = scene["first_sample_token"]
    while tok:
        scene_sample_tokens.add(tok)
        tok = sample_by_token[tok]["next"]

    def sd_channel(sd: dict) -> str:
        cs = cs_by_token[sd["calibrated_sensor_token"]]
        return sensor_by_token[cs["sensor_token"]]["channel"]

    # LIDAR_TOP sample_data of the scene give a dense (~13 Hz), regular ego
    # track over the whole scene window.
    lidar_sds = [
        sd for sd in sample_datas
        if sd["sample_token"] in scene_sample_tokens and sd_channel(sd) == LIDAR_SENSOR
    ]
    lidar_sds.sort(key=lambda sd: sd["timestamp"])
    if len(lidar_sds) < 3:
        sys.exit("not enough LIDAR_TOP sample_data to derive signals")

    t_ns = np.array([int(sd["timestamp"]) * 1000 for sd in lidar_sds], dtype=np.int64)
    poses = [ego_by_token[sd["ego_pose_token"]] for sd in lidar_sds]
    pos = np.array([p["translation"] for p in poses], dtype=np.float64)  # (N,3)
    yaw = np.unwrap(np.array([yaw_from_quat_wxyz(p["rotation"]) for p in poses]))

    t_s = (t_ns - t_ns[0]) / 1e9
    # Central differences for velocity / yaw-rate; speed from horizontal motion.
    vel = np.gradient(pos, t_s, axis=0)
    speed = np.linalg.norm(vel[:, :2], axis=1)               # m/s
    yaw_rate = np.degrees(np.gradient(yaw, t_s))             # deg/s
    accel = np.gradient(speed, t_s)                          # m/s^2

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "wb") as f:
        w = Writer(f, compression=CompressionType.ZSTD)
        w.start()
        f64 = w.register_schema(
            name="foxglove.Float64", encoding="jsonschema",
            data=(SCHEMAS / "foxglove.Float64.jsonschema").read_bytes(),
        )

        def reg(topic: str, unit: str) -> int:
            return w.register_channel(
                topic=topic, message_encoding="json",
                schema_id=f64, metadata={"unit": unit},
            )

        ch_speed = reg("/ego/speed", "m/s")
        ch_yaw = reg("/ego/yaw_rate", "deg/s")
        ch_accel = reg("/ego/accel", "m/s^2")

        for i in range(len(t_ns)):
            ts = int(t_ns[i])
            w.add_message(ch_speed, log_time=ts, publish_time=ts,
                          data=f64_payload(ts, speed[i]))
            w.add_message(ch_yaw, log_time=ts, publish_time=ts,
                          data=f64_payload(ts, yaw_rate[i]))
            w.add_message(ch_accel, log_time=ts, publish_time=ts,
                          data=f64_payload(ts, accel[i]))
        w.finish()

    print(f"wrote {args.out} ({args.out.stat().st_size} bytes)")
    print(f"  samples: {len(t_ns)}  window: {t_s[-1]:.2f} s")
    print(f"  speed    m/s   : min {speed.min():.2f}  max {speed.max():.2f}  "
          f"mean {speed.mean():.2f}")
    print(f"  yaw_rate deg/s : min {yaw_rate.min():.2f}  max {yaw_rate.max():.2f}")
    print(f"  accel    m/s^2 : min {accel.min():.2f}  max {accel.max():.2f}")


if __name__ == "__main__":
    main()
