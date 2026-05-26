#!/usr/bin/env python3
"""Convert one comma2k19 segment from the HF demo parquet into MF4.

Companion to `scripts/convert_comma2k19_to_mcap.py`. Emits the
secondary signals (wheel speeds, IMU components, GNSS lat/lon/alt)
as ASAM MDF4 scalar channels so Driveline's MF4 reader picks them
up alongside an MCAP from the same segment — letting a single
session plot signals coming from both formats.

Channels emitted (per group, master = relative time in seconds):

  Wheels   ~80 Hz   WheelSpeedFL/FR/RL/RR    m/s
  IMU_Accel ~110 Hz IMU_Accel_X/Y/Z          m/s^2
  IMU_Gyro  ~20 Hz  IMU_Gyro_X/Y/Z           rad/s
  GNSS      ~10 Hz  GNSS_Lat / GNSS_Lon      deg
                    GNSS_Alt                 m

The MF4 `start_time` is set to the same segment-start UTC the MCAP
converter uses (`parse_segment_start_ns`), so both files line up on
Driveline's unified time axis.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
from asammdf import MDF, Signal


def parse_segment_start_dt(segment_id: str) -> datetime:
    """`b0c9d2329ad1606b|2018-07-27--06-03-57/10` -> UTC datetime."""
    _, rhs = segment_id.split("|", 1)
    stamp, _ = rhs.split("/", 1)
    return datetime.strptime(stamp, "%Y-%m-%d--%H-%M-%S").replace(
        tzinfo=timezone.utc
    )


def finite_min(arrs: list[np.ndarray]) -> float:
    """Smallest finite value across a list of 1-D arrays."""
    mins: list[float] = []
    for a in arrs:
        a = a[~np.isnan(a)]
        if a.size:
            mins.append(float(a.min()))
    if not mins:
        sys.exit("no finite timestamps in any __t array")
    return min(mins)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--parquet", default="/tmp/datasets/comma2k19_demo.parquet"
    )
    ap.add_argument("--segment-index", type=int, default=0)
    ap.add_argument("--out", default="sample-data/realworld/comma2k19.mf4")
    ap.add_argument(
        "--segment-offset-seconds",
        type=float,
        default=0.0,
        help=(
            "Shift the HD-block `start_time` by this many seconds so "
            "multiple segments from one drive land at distinct wall-clock "
            "positions on Driveline's timeline (segment N -> N*60). "
            "Defaults to 0."
        ),
    )
    args = ap.parse_args()

    parquet = Path(args.parquet)
    if not parquet.exists():
        sys.exit(f"missing parquet: {parquet}")

    pf = pq.ParquetFile(parquet)
    rg = pf.read_row_group(0)
    seg_ids = rg["segment_id"].to_pylist()
    if args.segment_index >= len(seg_ids):
        sys.exit(
            f"segment_index {args.segment_index} out of range "
            f"(have {len(seg_ids)} in row group 0)"
        )

    seg_id = seg_ids[args.segment_index]
    log = rg["log"][args.segment_index].as_py()
    start_dt = parse_segment_start_dt(seg_id) + timedelta(
        seconds=args.segment_offset_seconds
    )
    print(f"segment {args.segment_index}: {seg_id}")
    print(f"  start: {start_dt.isoformat()}")

    # Anchor the same way the MCAP converter does so the two files
    # share a clock — `processed_log` times are seconds since system
    # boot, so subtract the smallest finite t in the segment.
    t_lists = [np.asarray(v, dtype=np.float64)
               for k, v in log.items() if k.endswith("__t") and v]
    t_min = finite_min(t_lists)

    def rel_t(raw: list[float]) -> np.ndarray:
        return np.asarray(raw, dtype=np.float64) - t_min

    def vec_col(raw: list[list[float]], i: int) -> np.ndarray:
        return np.asarray([row[i] for row in raw], dtype=np.float64)

    # --- Wheels (one Vec4 sample at each timestamp). asammdf wants
    #     each Signal aligned on the same timestamps inside a group.
    wheel_t = rel_t(log["processed_log__CAN__wheel_speed__t"])
    wheel_v = log["processed_log__CAN__wheel_speed__value"]
    # Filter rows that are missing wheels; assume the demo parquet's
    # 4-wheel layout (the MCAP converter prints a warning if it isn't).
    keep4 = np.fromiter((len(r) >= 4 for r in wheel_v), dtype=bool)
    wheel_t = wheel_t[keep4]
    wheel_v = [wheel_v[i] for i in np.flatnonzero(keep4)]
    wheels = {
        name: np.asarray([r[i] for r in wheel_v], dtype=np.float64)
        for i, name in enumerate(
            ["WheelSpeedFL", "WheelSpeedFR",
             "WheelSpeedRL", "WheelSpeedRR"]
        )
    }

    # --- IMU accel and gyro: each (t, [x, y, z]) row.
    accel_t = rel_t(log["processed_log__IMU__accelerometer__t"])
    accel_vals = log["processed_log__IMU__accelerometer__value"]
    keep3a = np.fromiter((len(r) >= 3 for r in accel_vals), dtype=bool)
    accel_t = accel_t[keep3a]
    accel_idx = np.flatnonzero(keep3a)
    accel = {
        f"IMU_Accel_{axis}": np.asarray(
            [accel_vals[i][k] for i in accel_idx], dtype=np.float64
        )
        for k, axis in enumerate("XYZ")
    }

    gyro_t = rel_t(log["processed_log__IMU__gyro__t"])
    gyro_vals = log["processed_log__IMU__gyro__value"]
    keep3g = np.fromiter((len(r) >= 3 for r in gyro_vals), dtype=bool)
    gyro_t = gyro_t[keep3g]
    gyro_idx = np.flatnonzero(keep3g)
    gyro = {
        f"IMU_Gyro_{axis}": np.asarray(
            [gyro_vals[i][k] for i in gyro_idx], dtype=np.float64
        )
        for k, axis in enumerate("XYZ")
    }

    # --- GNSS (lat, lon, alt). Drop rows with any NaN so the polyline
    #     in MapPanel doesn't get pinned to (0, 0).
    gnss_t_raw = rel_t(log["processed_log__GNSS__live_gnss_ublox__t"])
    gnss_vals = log["processed_log__GNSS__live_gnss_ublox__value"]
    keep_gnss = np.fromiter(
        (len(r) >= 3 and not any(np.isnan(x) for x in r[:3])
         for r in gnss_vals),
        dtype=bool,
    )
    gnss_t = gnss_t_raw[keep_gnss]
    gnss_idx = np.flatnonzero(keep_gnss)
    gnss = {
        "GNSS_Lat": np.asarray(
            [gnss_vals[i][0] for i in gnss_idx], dtype=np.float64
        ),
        "GNSS_Lon": np.asarray(
            [gnss_vals[i][1] for i in gnss_idx], dtype=np.float64
        ),
        "GNSS_Alt": np.asarray(
            [gnss_vals[i][2] for i in gnss_idx], dtype=np.float64
        ),
    }

    def signals(names_to_values: dict[str, np.ndarray],
                t: np.ndarray, unit: str) -> list[Signal]:
        return [
            Signal(samples=vals, timestamps=t, name=n, unit=unit)
            for n, vals in names_to_values.items()
        ]

    mdf = MDF(version="4.10")
    # asammdf's `start_time` is the HD block timestamp; Driveline's
    # MF4 reader pulls it out via `idx.start_time_ns` and adds it to
    # each sample's relative seconds.
    mdf.start_time = start_dt
    mdf.append(signals(wheels, wheel_t, "m/s"),
               comment="Wheel speeds")
    mdf.append(signals(accel, accel_t, "m/s^2"),
               comment="IMU accelerometer")
    mdf.append(signals(gyro, gyro_t, "rad/s"),
               comment="IMU gyroscope")
    # Lat/lon are in degrees but altitude is in metres — keep them in
    # one CG anyway since they share the GNSS cadence; the MF4 schema
    # carries unit per channel, not per group.
    gnss_signals = signals(
        {"GNSS_Lat": gnss["GNSS_Lat"]}, gnss_t, "deg"
    ) + signals(
        {"GNSS_Lon": gnss["GNSS_Lon"]}, gnss_t, "deg"
    ) + signals(
        {"GNSS_Alt": gnss["GNSS_Alt"]}, gnss_t, "m"
    )
    mdf.append(gnss_signals, comment="GNSS u-blox")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    mdf.save(out, overwrite=True)
    size_mb = out.stat().st_size / (1024 * 1024)
    n = (len(wheel_t) * 4 + len(accel_t) * 3
         + len(gyro_t) * 3 + len(gnss_t) * 3)
    print(f"wrote {out} ({size_mb:.2f} MB, {n:,} samples across "
          f"4 channel groups)")


if __name__ == "__main__":
    main()
