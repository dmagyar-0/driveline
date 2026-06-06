#!/usr/bin/env python3
"""Convert one KITTI raw "sync" drive's OXTS stream into ASAM MF4.

Companion to convert_kitti_to_mcap.py. Emits scalar MF4 channels so
Driveline's MF4 reader picks them up alongside the KITTI MCAP from the
same drive, letting one session plot signals from both formats.

Channel groups (master = relative seconds from first OXTS timestamp):
  Vehicle   Speed (vf, m/s), YawRate (wz, rad/s)
  IMU_Accel IMU_Accel_X/Y/Z (m/s^2)
  IMU_Gyro  IMU_Gyro_X/Y/Z  (rad/s)
  GNSS      GNSS_Lat / GNSS_Lon (deg), GNSS_Alt (m)

start_time is set to the first OXTS timestamp UTC, the same anchor the
MCAP converter uses, so both files line up on Driveline's unified axis.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal


def parse_dt(line: str) -> datetime:
    date_part, _, frac = line.strip().partition(".")
    dt = datetime.strptime(date_part, "%Y-%m-%d %H:%M:%S").replace(
        tzinfo=timezone.utc
    )
    micros = int((frac.ljust(6, "0")[:6])) if frac else 0
    return dt.replace(microsecond=micros)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--drive", required=True)
    ap.add_argument("--out", default="sample-data/realworld/kitti.mf4")
    args = ap.parse_args()

    drive = Path(args.drive)
    oxts_dir = drive / "oxts" / "data"
    ts_file = drive / "oxts" / "timestamps.txt"
    if not oxts_dir.is_dir() or not ts_file.exists():
        sys.exit(f"missing oxts data under {drive}")

    lines = [l for l in ts_file.read_text().splitlines() if l.strip()]
    dts = [parse_dt(l) for l in lines]
    files = sorted(oxts_dir.glob("*.txt"))
    if len(files) != len(dts):
        sys.exit(f"oxts files ({len(files)}) != timestamps ({len(dts)})")

    rows = np.array(
        [[float(x) for x in f.read_text().split()] for f in files],
        dtype=np.float64,
    )
    t0 = dts[0]
    t = np.array([(d - t0).total_seconds() for d in dts], dtype=np.float64)

    vehicle = [
        Signal(samples=rows[:, 8], timestamps=t, name="Speed", unit="m/s"),
        Signal(samples=rows[:, 19], timestamps=t, name="YawRate", unit="rad/s"),
    ]
    accel = [
        Signal(samples=rows[:, 11], timestamps=t, name="IMU_Accel_X", unit="m/s^2"),
        Signal(samples=rows[:, 12], timestamps=t, name="IMU_Accel_Y", unit="m/s^2"),
        Signal(samples=rows[:, 13], timestamps=t, name="IMU_Accel_Z", unit="m/s^2"),
    ]
    gyro = [
        Signal(samples=rows[:, 17], timestamps=t, name="IMU_Gyro_X", unit="rad/s"),
        Signal(samples=rows[:, 18], timestamps=t, name="IMU_Gyro_Y", unit="rad/s"),
        Signal(samples=rows[:, 19], timestamps=t, name="IMU_Gyro_Z", unit="rad/s"),
    ]
    gnss = [
        Signal(samples=rows[:, 0], timestamps=t, name="GNSS_Lat", unit="deg"),
        Signal(samples=rows[:, 1], timestamps=t, name="GNSS_Lon", unit="deg"),
        Signal(samples=rows[:, 2], timestamps=t, name="GNSS_Alt", unit="m"),
    ]

    mdf = MDF(version="4.10")
    mdf.start_time = t0
    mdf.append(vehicle, comment="Vehicle motion")
    mdf.append(accel, comment="IMU accelerometer")
    mdf.append(gyro, comment="IMU gyroscope")
    mdf.append(gnss, comment="OXTS GNSS")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    mdf.save(out, overwrite=True)
    mb = out.stat().st_size / (1024 * 1024)
    print(f"wrote {out} ({mb:.2f} MB, {len(t) * 11:,} samples, "
          f"4 groups, start={t0.isoformat()})")


if __name__ == "__main__":
    main()
