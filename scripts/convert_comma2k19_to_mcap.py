#!/usr/bin/env python3
"""Convert one comma2k19 segment from the Hugging Face demo parquet into MCAP.

Source dataset: https://huggingface.co/datasets/commaai/comma2k19
Demo parquet:   data/demo-00000-of-00003.parquet  (~81 MB, 22 segments).

The output MCAP uses the same Foxglove JSON schemas Driveline already
recognises (foxglove.Float64, foxglove.Vector3, driveline.ControlMode),
so it loads directly with no reader changes.

Channels emitted:
  /vehicle/speed              foxglove.Float64   ~80 Hz
  /vehicle/steering_angle     foxglove.Float64   ~80 Hz   (deg)
  /vehicle/wheel_speed_fl     foxglove.Float64   ~80 Hz
  /vehicle/wheel_speed_fr     foxglove.Float64   ~80 Hz
  /vehicle/wheel_speed_rl     foxglove.Float64   ~80 Hz
  /vehicle/wheel_speed_rr     foxglove.Float64   ~80 Hz
  /imu/accel                  foxglove.Vector3  ~110 Hz
  /imu/gyro                   foxglove.Vector3   ~20 Hz
  /gnss/ublox                 foxglove.Vector3   ~10 Hz   (lat, lon, alt)
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from mcap.writer import Writer, CompressionType

HERE = Path(__file__).resolve().parent
SCHEMAS = HERE.parent / "sample-data" / "schemas"


def load_schema(name: str) -> bytes:
    return (SCHEMAS / f"{name}.jsonschema").read_bytes()


def parse_segment_start_ns(segment_id: str) -> int:
    """`b0c9d2329ad1606b|2018-07-27--06-03-57/10` -> ns since epoch UTC."""
    _, rhs = segment_id.split("|", 1)
    stamp, _ = rhs.split("/", 1)
    dt = datetime.strptime(stamp, "%Y-%m-%d--%H-%M-%S").replace(
        tzinfo=timezone.utc
    )
    return int(dt.timestamp() * 1_000_000_000)


def f64_payload(ts_ns: int, value: float) -> bytes:
    return json.dumps({
        "timestamp": {"sec": ts_ns // 1_000_000_000,
                      "nsec": ts_ns % 1_000_000_000},
        "value": float(value),
    }).encode("utf-8")


def vec3_payload(ts_ns: int, x: float, y: float, z: float) -> bytes:
    return json.dumps({
        "timestamp": {"sec": ts_ns // 1_000_000_000,
                      "nsec": ts_ns % 1_000_000_000},
        "x": float(x), "y": float(y), "z": float(z),
    }).encode("utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="/tmp/datasets/comma2k19_demo.parquet")
    ap.add_argument("--segment-index", type=int, default=0)
    ap.add_argument("--out", default="sample-data/realworld/comma2k19.mcap")
    ap.add_argument("--compression", default="zstd",
                    choices=["zstd", "none"])
    args = ap.parse_args()

    parquet = Path(args.parquet)
    if not parquet.exists():
        sys.exit(f"missing parquet: {parquet}")

    pf = pq.ParquetFile(parquet)
    rg = pf.read_row_group(0)
    seg_ids = rg["segment_id"].to_pylist()
    if args.segment_index >= len(seg_ids):
        sys.exit(f"segment_index {args.segment_index} out of range "
                 f"(have {len(seg_ids)} in row group 0)")

    seg_id = seg_ids[args.segment_index]
    log = rg["log"][args.segment_index].as_py()
    start_ns = parse_segment_start_ns(seg_id)
    print(f"segment {args.segment_index}: {seg_id}")
    print(f"  recording start ns: {start_ns}  "
          f"({datetime.fromtimestamp(start_ns/1e9, tz=timezone.utc).isoformat()})")

    # comma2k19 'processed_log' times are seconds since system boot, not
    # since segment start. Anchor everything to the smallest observed `t`
    # so the output MCAP starts at `recording start`.
    t_lists = [v for k, v in log.items() if k.endswith("__t") and v]
    t_min = min(min(v) for v in t_lists if v and not np.isnan(v[0]))

    def to_abs_ns(t_rel_s: float) -> int:
        return start_ns + int((t_rel_s - t_min) * 1_000_000_000)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    compression = (CompressionType.ZSTD if args.compression == "zstd"
                   else CompressionType.NONE)

    with open(out, "wb") as f:
        w = Writer(f, compression=compression)
        w.start()

        f64_schema = w.register_schema(
            name="foxglove.Float64", encoding="jsonschema",
            data=load_schema("foxglove.Float64"),
        )
        vec3_schema = w.register_schema(
            name="foxglove.Vector3", encoding="jsonschema",
            data=load_schema("foxglove.Vector3"),
        )

        def reg_f64(topic: str, unit: str = "") -> int:
            md = {"unit": unit} if unit else {}
            return w.register_channel(
                topic=topic, message_encoding="json",
                schema_id=f64_schema, metadata=md,
            )

        def reg_vec3(topic: str, unit: str = "") -> int:
            md = {"unit": unit} if unit else {}
            return w.register_channel(
                topic=topic, message_encoding="json",
                schema_id=vec3_schema, metadata=md,
            )

        ch_speed = reg_f64("/vehicle/speed", "m/s")
        ch_steer = reg_f64("/vehicle/steering_angle", "deg")
        ch_wheel_fl = reg_f64("/vehicle/wheel_speed_fl", "m/s")
        ch_wheel_fr = reg_f64("/vehicle/wheel_speed_fr", "m/s")
        ch_wheel_rl = reg_f64("/vehicle/wheel_speed_rl", "m/s")
        ch_wheel_rr = reg_f64("/vehicle/wheel_speed_rr", "m/s")
        ch_accel = reg_vec3("/imu/accel", "m/s^2")
        ch_gyro = reg_vec3("/imu/gyro", "rad/s")
        ch_gnss = reg_vec3("/gnss/ublox", "deg,deg,m")

        entries: list[tuple[int, int, bytes]] = []

        # Speed (one element per sample).
        for t, v in zip(log["processed_log__CAN__speed__t"],
                        log["processed_log__CAN__speed__value"]):
            ts = to_abs_ns(t)
            entries.append((ts, ch_speed, f64_payload(ts, v[0])))

        # Steering angle (scalar per sample).
        for t, v in zip(log["processed_log__CAN__steering_angle__t"],
                        log["processed_log__CAN__steering_angle__value"]):
            ts = to_abs_ns(t)
            entries.append((ts, ch_steer, f64_payload(ts, v)))

        # Wheel speeds: 3-element vector per sample (FL, FR, RL).
        # comma2k19 stores three of the four wheels — we re-broadcast the
        # rear-left as rear-right so the panel still has four traces.
        for t, vec in zip(log["processed_log__CAN__wheel_speed__t"],
                          log["processed_log__CAN__wheel_speed__value"]):
            if len(vec) < 3:
                continue
            ts = to_abs_ns(t)
            fl, fr, rl = vec[0], vec[1], vec[2]
            rr = vec[3] if len(vec) >= 4 else rl
            entries.append((ts, ch_wheel_fl, f64_payload(ts, fl)))
            entries.append((ts, ch_wheel_fr, f64_payload(ts, fr)))
            entries.append((ts, ch_wheel_rl, f64_payload(ts, rl)))
            entries.append((ts, ch_wheel_rr, f64_payload(ts, rr)))

        # IMU accel.
        for t, vec in zip(log["processed_log__IMU__accelerometer__t"],
                          log["processed_log__IMU__accelerometer__value"]):
            if len(vec) < 3:
                continue
            ts = to_abs_ns(t)
            entries.append((ts, ch_accel, vec3_payload(ts, *vec[:3])))

        # IMU gyro.
        for t, vec in zip(log["processed_log__IMU__gyro__t"],
                          log["processed_log__IMU__gyro__value"]):
            if len(vec) < 3:
                continue
            ts = to_abs_ns(t)
            entries.append((ts, ch_gyro, vec3_payload(ts, *vec[:3])))

        # GNSS (lat, lon, alt) — drop NaN samples.
        for t, vec in zip(log["processed_log__GNSS__live_gnss_ublox__t"],
                          log["processed_log__GNSS__live_gnss_ublox__value"]):
            if len(vec) < 3 or any(np.isnan(x) for x in vec[:3]):
                continue
            ts = to_abs_ns(t)
            entries.append((ts, ch_gnss, vec3_payload(ts, *vec[:3])))

        entries.sort(key=lambda e: (e[0], e[1]))
        seq: dict[int, int] = {}
        for ts, ch, data in entries:
            s = seq.get(ch, 0)
            w.add_message(channel_id=ch, log_time=ts, publish_time=ts,
                          sequence=s, data=data)
            seq[ch] = s + 1

        w.finish()

    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"wrote {out} ({size_mb:.2f} MB, {len(entries):,} messages)")


if __name__ == "__main__":
    main()
