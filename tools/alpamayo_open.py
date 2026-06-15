#!/usr/bin/env python3
r"""Extract one NVIDIA Alpamayo clip into a drop-ready folder for Driveline.

Driveline reads the **raw** Alpamayo LiDAR parquet *natively* — the Draco-
compressed spins are decoded in the browser — so the LiDAR needs **no
conversion**. This tool just pulls the right per-clip files out of the dataset's
chunk zips so you can drag them onto the app.

By default it extracts only the LiDAR, using nothing but the Python standard
library (`zipfile`) — no `DracoPy`, no `pyarrow`. Add `--with-cameras` and/or
`--with-egomotion` to round out a clip; those read the camera timestamp parquet,
so they need `pyarrow` + `numpy`.

Examples (PowerShell):

    # LiDAR only, first clip of chunk 0 (zero dependencies):
    python tools\alpamayo_open.py --root C:\Users\you\alpamayo\data --clip 0 --out clip0

    # A specific clip id, with cameras + egomotion:
    python tools\alpamayo_open.py --root ...\data --clip 25cd4769 `
        --with-cameras --with-egomotion --out my_clip

Then drag the files in `--out` onto the Driveline window:
  * LiDAR  -> add a **Scene** panel and bind the point-cloud channel.
  * Cameras-> a **Video** panel each (the `.mp4` auto-pairs with its sidecar).
  * Egomotion opens via the tabular import dialog (time column `timestamp`,
    unit microseconds, mode Absolute).
"""
from __future__ import annotations

import argparse
import glob
import io
import os
import shutil
import sys
import zipfile

LIDAR_SENSOR = "lidar_top_360fov"


def _first_zip(folder: str, chunk: int) -> str | None:
    """The `*.chunk_{chunk}.zip` under `folder`, or the first `*.zip` if that
    exact chunk isn't present (the dataset may ship a single chunk)."""
    if not os.path.isdir(folder):
        return None
    base = os.path.basename(folder.rstrip(os.sep))
    exact = os.path.join(folder, f"{base}.chunk_{chunk:04d}.zip")
    if os.path.exists(exact):
        return exact
    zips = sorted(glob.glob(os.path.join(folder, "*.zip")))
    return zips[0] if zips else None


def _resolve_member(names: list[str], clip: str) -> str:
    """The LiDAR member for `clip` — a numeric index into the zip, or a clip-id
    substring."""
    if clip.isdigit():
        i = int(clip)
        if i >= len(names):
            sys.exit(f"clip index {i} out of range (zip has {len(names)} clips)")
        return names[i]
    for n in names:
        if clip in n:
            return n
    sys.exit(f"no clip matching {clip!r} in the LiDAR zip")


def _find_member(names: list[str], clip_id: str, suffix: str) -> str | None:
    for n in names:
        if clip_id in n and n.endswith(suffix):
            return n
    return None


def _copy_member(z: zipfile.ZipFile, member: str, dst: str) -> int:
    """Stream a zip entry to disk (so a ~290 MB clip never sits in memory
    twice); returns the byte size written."""
    with z.open(member) as src, open(dst, "wb") as out:
        shutil.copyfileobj(src, out)
    return os.path.getsize(dst)


def extract_lidar(root: str, chunk: int, clip: str, out: str) -> str:
    zp = _first_zip(os.path.join(root, "lidar", LIDAR_SENSOR), chunk)
    if zp is None:
        sys.exit(f"no LiDAR chunk zip under {os.path.join(root, 'lidar', LIDAR_SENSOR)}")
    z = zipfile.ZipFile(zp)
    member = _resolve_member(z.namelist(), clip)
    clip_id = member.split(".")[0]
    dst = os.path.join(out, f"{clip_id}.{LIDAR_SENSOR}.parquet")
    mb = _copy_member(z, member, dst) // (1024 * 1024)
    print(f"lidar:     {os.path.basename(dst)}  ({mb} MB)  [native - no conversion]")
    return clip_id


def extract_cameras(
    root: str, chunk: int, clip_id: str, out: str, cams: list[str] | None
) -> None:
    try:
        import numpy as np
        import pyarrow.parquet as pq
    except ImportError:
        print("cameras:   SKIPPED — needs `pip install pyarrow numpy`")
        return
    cam_root = os.path.join(root, "camera")
    if not os.path.isdir(cam_root):
        print("cameras:   SKIPPED — no camera/ dir")
        return
    names = cams if cams else sorted(os.listdir(cam_root))
    for cam in names:
        zp = _first_zip(os.path.join(cam_root, cam), chunk)
        if zp is None:
            print(f"  ! {cam}: no zip")
            continue
        z = zipfile.ZipFile(zp)
        mp4m = _find_member(z.namelist(), clip_id, ".mp4")
        tsm = _find_member(z.namelist(), clip_id, "timestamps.parquet")
        if not mp4m or not tsm:
            print(f"  ! {cam}: clip member missing")
            continue
        _copy_member(z, mp4m, os.path.join(out, f"{cam}.mp4"))
        # Alpamayo per-frame stamps are MICROSECONDS relative to clip start; the
        # Driveline sidecar is one `frame<TAB>timestamp_ns` line per frame.
        tt = pq.read_table(io.BytesIO(z.read(tsm)))
        order = np.argsort(np.array(tt["frame_index"]))
        ts_us = np.array(tt["timestamp"])[order]
        lines = "".join(f"{i}\t{int(ts_us[i]) * 1000}\n" for i in range(len(ts_us)))
        with open(os.path.join(out, f"{cam}.mp4.timestamps"), "w", encoding="utf-8") as f:
            f.write(lines)
        print(f"  camera:  {cam}.mp4 (+ .mp4.timestamps, {len(ts_us)} frames)")


def extract_egomotion(root: str, chunk: int, clip_id: str, out: str) -> None:
    zp = _first_zip(os.path.join(root, "labels", "egomotion"), chunk)
    if zp is None:
        print("egomotion: SKIPPED — no labels/egomotion zip")
        return
    z = zipfile.ZipFile(zp)
    m = _find_member(z.namelist(), clip_id, ".egomotion.parquet") or _find_member(
        z.namelist(), clip_id, ".parquet"
    )
    if not m:
        print("egomotion: clip member missing")
        return
    _copy_member(z, m, os.path.join(out, "egomotion.parquet"))
    print("egomotion: egomotion.parquet  (tabular import: time `timestamp`, us, Absolute)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--root", required=True, help="dataset root (the `data` dir)")
    ap.add_argument(
        "--clip",
        default="0",
        help="clip index into the LiDAR chunk zip (e.g. 0) or a clip-id substring",
    )
    ap.add_argument("--chunk", type=int, default=0, help="chunk number (default 0)")
    ap.add_argument("--out", required=True, help="output folder (created if absent)")
    ap.add_argument(
        "--with-cameras", action="store_true", help="also extract camera mp4 + sidecars"
    )
    ap.add_argument(
        "--cameras", default=None, help="comma list of camera names (default: all)"
    )
    ap.add_argument(
        "--with-egomotion", action="store_true", help="also copy egomotion.parquet"
    )
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    print(f"=== Alpamayo clip -> {args.out}")
    clip_id = extract_lidar(args.root, args.chunk, args.clip, args.out)
    print(f"clip_id:   {clip_id}")
    if args.with_cameras:
        cams = args.cameras.split(",") if args.cameras else None
        extract_cameras(args.root, args.chunk, clip_id, args.out, cams)
    if args.with_egomotion:
        extract_egomotion(args.root, args.chunk, clip_id, args.out)
    print("=== done - drag the folder's files onto the Driveline window")
    print("    LiDAR -> add a Scene panel and bind the point-cloud channel")


if __name__ == "__main__":
    main()
