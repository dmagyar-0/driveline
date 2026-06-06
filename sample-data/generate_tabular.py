#!/usr/bin/env python3
"""Tabular (CSV/Parquet) fixture generator for the TabularReader feature.

Emits deterministic, small synthetic signal logs exercising both time
bases the TabularReader must support:

  * ABSOLUTE epoch microseconds (a "normal" tabular log, and an
    Alpamayo-egomotion-style parquet).
  * RELATIVE-to-clip-start microseconds (an Alpamayo-camera-style frame
    index table).

Outputs (all under test-fixtures/tabular/, with drag-and-drop demo
copies under sample-data/tabular/):

  signals_abs.csv        t_us,speed_mps,steering_deg,rpm   (t_us ABSOLUTE)
  signals_abs.parquet    same schema/data as signals_abs.csv
  camera_frames_rel.csv  frame_index,timestamp_us          (RELATIVE)
  egomotion_abs.parquet  timestamp,vx,vy,yaw_rate          (timestamp ABSOLUTE)

Everything is computed with the Python stdlib + pyarrow only (no numpy),
using fixed constants and integer/float arithmetic so re-running yields
byte-identical files. Parquet is written with statistics and embedded
schema metadata disabled and a pinned format version so that
`make fixtures-check` does not flake.

Usage:
    python3 sample-data/generate_tabular.py            # generate
    python3 sample-data/generate_tabular.py --check     # verify in place
"""

from __future__ import annotations

import argparse
import csv
import filecmp
import math
import shutil
import sys
import tempfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
FIXTURES = REPO / "test-fixtures" / "tabular"
DEMO = HERE / "tabular"

# Shared time basis. Matches sample-data/generate.py's START_NS exactly so
# the tabular logs line up with the video corpus on a 2024-01-01 epoch.
#   START_NS = 1_704_067_200_000_000_000 ns  (2024-01-01T00:00:00Z)
START_US = 1_704_067_200_000_000          # same instant in microseconds
N_ROWS = 30                               # ~30 samples, a few seconds of data

# Signal log cadence: 10 Hz -> 100_000 us between rows (~3 s for 30 rows).
SIGNAL_DT_US = 100_000

# Camera cadence: ~30 fps -> 33_333 us between frames (Alpamayo-style,
# truncated like the video FRAME_NS so the units stay honest).
FRAME_DT_US = 33_333

# Egomotion cadence: 50 Hz -> 20_000 us (typical Alpamayo egomotion rate).
EGO_DT_US = 20_000


def synth_signals(i: int) -> tuple[float, float, float]:
    """Smooth, bounded, deterministic (speed_mps, steering_deg, rpm)."""
    t = i / 10.0  # seconds (10 Hz)
    # Speed ramps up then eases: 0 -> ~15 m/s over the window.
    speed = round(15.0 * (1.0 - math.cos(math.pi * i / (N_ROWS - 1))) / 2.0, 6)
    # Steering: gentle sine, +/-12 deg, period 2 s.
    steering = round(12.0 * math.sin(2.0 * math.pi * t / 2.0), 6)
    # RPM correlated with speed (idle 800 + gearing factor).
    rpm = round(800.0 + speed * 180.0, 6)
    return speed, steering, rpm


def synth_egomotion(i: int) -> tuple[float, float, float]:
    """Deterministic (vx, vy, yaw_rate) for egomotion @50Hz."""
    t = i / 50.0  # seconds
    vx = round(12.0 + 3.0 * math.sin(2.0 * math.pi * t / 3.0), 6)
    vy = round(0.5 * math.sin(2.0 * math.pi * t / 1.5), 6)
    yaw_rate = round(0.10 * math.cos(2.0 * math.pi * t / 2.0), 6)
    return vx, vy, yaw_rate


def write_csv(path: Path, header: list[str], rows: list[tuple]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" + explicit "\n" -> stable LF line endings on every OS.
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        for r in rows:
            w.writerow(r)


def write_parquet(path: Path, table: pa.Table) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        table,
        path,
        compression="snappy",
        version="2.6",            # pinned format version
        write_statistics=False,   # min/max stats vary in encoding; drop them
        store_schema=False,       # no embedded arrow schema blob
        use_dictionary=False,     # deterministic plain encoding
        data_page_version="2.0",
    )


def build() -> dict[str, Path]:
    """Generate all four fixtures. Returns {name: path}."""
    # --- signals_abs: absolute epoch microseconds -----------------------
    sig_rows: list[tuple] = []
    for i in range(N_ROWS):
        t_us = START_US + i * SIGNAL_DT_US
        speed, steering, rpm = synth_signals(i)
        sig_rows.append((t_us, speed, steering, rpm))

    sig_header = ["t_us", "speed_mps", "steering_deg", "rpm"]
    write_csv(FIXTURES / "signals_abs.csv", sig_header, sig_rows)

    sig_table = pa.table(
        {
            "t_us": pa.array([r[0] for r in sig_rows], type=pa.int64()),
            "speed_mps": pa.array([r[1] for r in sig_rows], type=pa.float64()),
            "steering_deg": pa.array([r[2] for r in sig_rows], type=pa.float64()),
            "rpm": pa.array([r[3] for r in sig_rows], type=pa.float64()),
        }
    )
    write_parquet(FIXTURES / "signals_abs.parquet", sig_table)

    # --- camera_frames_rel: relative-to-clip-start microseconds ---------
    cam_rows = [(i, i * FRAME_DT_US) for i in range(N_ROWS)]
    write_csv(
        FIXTURES / "camera_frames_rel.csv",
        ["frame_index", "timestamp_us"],
        cam_rows,
    )

    # --- egomotion_abs: absolute epoch microseconds ---------------------
    ego_rows: list[tuple] = []
    for i in range(N_ROWS):
        ts = START_US + i * EGO_DT_US
        vx, vy, yaw_rate = synth_egomotion(i)
        ego_rows.append((ts, vx, vy, yaw_rate))

    ego_table = pa.table(
        {
            "timestamp": pa.array([r[0] for r in ego_rows], type=pa.int64()),
            "vx": pa.array([r[1] for r in ego_rows], type=pa.float64()),
            "vy": pa.array([r[2] for r in ego_rows], type=pa.float64()),
            "yaw_rate": pa.array([r[3] for r in ego_rows], type=pa.float64()),
        }
    )
    write_parquet(FIXTURES / "egomotion_abs.parquet", ego_table)

    return {
        "signals_abs.csv": FIXTURES / "signals_abs.csv",
        "signals_abs.parquet": FIXTURES / "signals_abs.parquet",
        "camera_frames_rel.csv": FIXTURES / "camera_frames_rel.csv",
        "egomotion_abs.parquet": FIXTURES / "egomotion_abs.parquet",
    }


def copy_demo(generated: dict[str, Path]) -> None:
    """Drop drag-and-drop demo copies under sample-data/tabular/."""
    DEMO.mkdir(parents=True, exist_ok=True)
    for name, src in generated.items():
        shutil.copyfile(src, DEMO / name)


def check() -> int:
    """Regenerate into a temp dir and byte-compare against committed files."""
    if not FIXTURES.exists():
        print("test-fixtures/tabular missing — run without --check first",
              file=sys.stderr)
        return 1

    # Stash the committed files, regenerate, compare, restore.
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        names = [
            "signals_abs.csv",
            "signals_abs.parquet",
            "camera_frames_rel.csv",
            "egomotion_abs.parquet",
        ]
        # Snapshot existing fixtures.
        for n in names:
            src = FIXTURES / n
            if not src.exists():
                print(f"missing fixture {n} — run without --check first",
                      file=sys.stderr)
                return 1
            shutil.copyfile(src, tmpdir / n)

        # Regenerate in place.
        build()

        ok = True
        for n in names:
            if not filecmp.cmp(tmpdir / n, FIXTURES / n, shallow=False):
                print(f"DRIFT: {n} differs after regeneration")
                ok = False
            else:
                print(f"OK: {n}")
        return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="regenerate and verify byte-identical output")
    args = ap.parse_args()

    if args.check:
        sys.exit(check())

    generated = build()
    copy_demo(generated)
    for name, path in generated.items():
        print(f"{name}: {path.stat().st_size:,} bytes -> {path}")
    print(f"demo copies -> {DEMO}")


if __name__ == "__main__":
    main()
