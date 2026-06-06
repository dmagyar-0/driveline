#!/usr/bin/env python3
"""Convert one KITTI raw "sync" drive's OXTS stream into Driveline MCAP.

Real-world source: KITTI raw recordings (Geiger et al., KIT/Toyota
Technological Institute). Each `*_sync` drive ships one OXTS GPS/IMU
text file per camera frame (~10 Hz) plus per-frame timestamps. We emit
the same Foxglove JSON schemas Driveline already recognises
(foxglove.Float64, foxglove.Vector3) so it loads with no reader changes
— a genuinely different real-world dataset from comma2k19.

Channels emitted (~10 Hz, anchored to the first OXTS timestamp UTC):
  /vehicle/speed      foxglove.Float64   m/s     (vf, forward velocity)
  /vehicle/yaw_rate   foxglove.Float64   rad/s   (wz, yaw rate)
  /imu/accel          foxglove.Vector3   m/s^2   (ax, ay, az)
  /imu/gyro           foxglove.Vector3   rad/s   (wx, wy, wz)
  /gnss/oxts          foxglove.Vector3   deg,deg,m (lat, lon, alt)

OXTS column indices (see KITTI oxts/dataformat.txt):
  lat=0 lon=1 alt=2 ... vf=8 ... ax=11 ay=12 az=13 ... wx=17 wy=18 wz=19
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCHEMAS = HERE.parent / "sample-data" / "schemas"

from mcap.writer import Writer, CompressionType  # noqa: E402


def load_schema(name: str) -> bytes:
    return (SCHEMAS / f"{name}.jsonschema").read_bytes()


def parse_ns(line: str) -> int:
    """`2011-09-26 13:02:25.964389445` -> ns since epoch (UTC-treated)."""
    date_part, _, frac = line.strip().partition(".")
    dt = datetime.strptime(date_part, "%Y-%m-%d %H:%M:%S").replace(
        tzinfo=timezone.utc
    )
    frac_ns = int(frac.ljust(9, "0")[:9]) if frac else 0
    return int(dt.timestamp()) * 1_000_000_000 + frac_ns


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
    ap.add_argument("--drive", required=True,
                    help="path to the *_sync drive dir")
    ap.add_argument("--out", default="sample-data/realworld/kitti.mcap")
    ap.add_argument("--compression", default="zstd",
                    choices=["zstd", "none"])
    args = ap.parse_args()

    drive = Path(args.drive)
    oxts_dir = drive / "oxts" / "data"
    ts_file = drive / "oxts" / "timestamps.txt"
    if not oxts_dir.is_dir() or not ts_file.exists():
        sys.exit(f"missing oxts data under {drive}")

    stamps = [parse_ns(l) for l in ts_file.read_text().splitlines() if l.strip()]
    files = sorted(oxts_dir.glob("*.txt"))
    if len(files) != len(stamps):
        sys.exit(f"oxts files ({len(files)}) != timestamps ({len(stamps)})")

    rows = [[float(x) for x in f.read_text().split()] for f in files]

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    compression = (CompressionType.ZSTD if args.compression == "zstd"
                   else CompressionType.NONE)

    with open(out, "wb") as fh:
        w = Writer(fh, compression=compression)
        w.start()
        f64 = w.register_schema(name="foxglove.Float64",
                                encoding="jsonschema",
                                data=load_schema("foxglove.Float64"))
        vec3 = w.register_schema(name="foxglove.Vector3",
                                 encoding="jsonschema",
                                 data=load_schema("foxglove.Vector3"))

        def reg(topic, schema, unit):
            return w.register_channel(topic=topic, message_encoding="json",
                                      schema_id=schema,
                                      metadata={"unit": unit} if unit else {})

        ch_speed = reg("/vehicle/speed", f64, "m/s")
        ch_yaw = reg("/vehicle/yaw_rate", f64, "rad/s")
        ch_accel = reg("/imu/accel", vec3, "m/s^2")
        ch_gyro = reg("/imu/gyro", vec3, "rad/s")
        ch_gnss = reg("/gnss/oxts", vec3, "deg,deg,m")

        entries: list[tuple[int, int, bytes]] = []
        for ts, r in zip(stamps, rows):
            entries.append((ts, ch_speed, f64_payload(ts, r[8])))
            entries.append((ts, ch_yaw, f64_payload(ts, r[19])))
            entries.append((ts, ch_accel, vec3_payload(ts, r[11], r[12], r[13])))
            entries.append((ts, ch_gyro, vec3_payload(ts, r[17], r[18], r[19])))
            entries.append((ts, ch_gnss, vec3_payload(ts, r[0], r[1], r[2])))

        entries.sort(key=lambda e: (e[0], e[1]))
        seq: dict[int, int] = {}
        for ts, ch, data in entries:
            s = seq.get(ch, 0)
            w.add_message(channel_id=ch, log_time=ts, publish_time=ts,
                          sequence=s, data=data)
            seq[ch] = s + 1
        w.finish()

    mb = out.stat().st_size / (1024 * 1024)
    print(f"wrote {out} ({mb:.2f} MB, {len(entries):,} messages, "
          f"{len(stamps)} samples)")


if __name__ == "__main__":
    main()
