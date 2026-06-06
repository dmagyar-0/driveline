#!/usr/bin/env python3
"""Convert one Alpamayo LiDAR clip into a Driveline point-cloud Parquet.

The NVIDIA PhysicalAI-AV dataset ships LiDAR as Draco-compressed point clouds
packed in per-chunk zips (`lidar_top_360fov.chunk_XXXX.zip`, ~100 clips each).
Each zip entry `<clip_id>.lidar_top_360fov.parquet` has one row per spin:

    spin_index:int64, spin_start_timestamp:int64, spin_end_timestamp:int64,
    draco_encoded_pointcloud:binary

`spin_*_timestamp` are MICROSECONDS relative to clip start (~10 Hz). Each Draco
blob decodes to ~250k points with attributes: position (xyz f32, metres),
`intensity` (u8 0..255), `timestamp` (per-point u32 us), `model_element`.

This tool decodes the spins and writes a **Driveline point-cloud Parquet**
(`<clip_id>.lidar.parquet` by default) that the viewer ingests natively:

    t_ns:int64                 spin timestamp, absolute nanoseconds (us * 1000)
    positions:list<float32>    flattened xyz, length 3*N
    intensities:list<uint8>    per-point intensity 0..255, length N

with schema metadata `driveline.format=pointcloud` and
`driveline.pointcloud.name=<sensor>`. Drop the result on the Driveline window
and bind it to a 3D scene panel.

Requires DracoPy + pyarrow (installed in the Alpamayo venv):
    C:\\Users\\david\\alpamayo\\.venv\\Scripts\\python.exe \\
      tools/alpamayo_lidar_to_driveline.py \\
      --zip C:\\Users\\david\\alpamayo\\data\\lidar\\lidar_top_360fov\\lidar_top_360fov.chunk_0000.zip \\
      --clip 0 --max-points 120000 --out my_clip.lidar.parquet
"""

from __future__ import annotations

import argparse
import io
import sys
import zipfile

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

try:
    import DracoPy
except ImportError:  # pragma: no cover - guidance only
    sys.exit(
        "DracoPy is required. Install it into the Alpamayo venv:\n"
        "  C:\\Users\\david\\alpamayo\\.venv\\Scripts\\python.exe -m pip install DracoPy"
    )

SENSOR_DEFAULT = "lidar_top_360fov"


def _intensity_array(pc) -> np.ndarray:
    """Pull the per-point intensity (u8) out of a decoded Draco cloud, falling
    back to zeros if the attribute is absent."""
    for attr in getattr(pc, "attributes", []):
        # DracoPy exposes each generic attribute as a dict with 'name'/'data'.
        name = attr.get("name") if isinstance(attr, dict) else None
        if name == "intensity":
            data = np.asarray(attr["data"]).reshape(-1)
            return np.clip(data, 0, 255).astype(np.uint8)
    n = np.asarray(pc.points).shape[0]
    return np.zeros(n, dtype=np.uint8)


def _subsample(n: int, max_points: int, rng: np.random.Generator) -> np.ndarray | None:
    """Indices to keep, or None to keep all. Uniform random keeps the spatial
    distribution better than striding by (laser-ordered) point index."""
    if max_points <= 0 or n <= max_points:
        return None
    idx = rng.choice(n, size=max_points, replace=False)
    idx.sort()
    return idx


def convert(
    zip_path: str,
    clip: str,
    out_path: str,
    sensor: str,
    max_points: int,
    max_spins: int,
    seed: int,
) -> None:
    rng = np.random.default_rng(seed)
    zf = zipfile.ZipFile(zip_path)
    names = zf.namelist()

    # Resolve the clip: a numeric index into the zip, or a clip-id substring.
    member: str | None = None
    if clip.isdigit():
        i = int(clip)
        if i >= len(names):
            sys.exit(f"clip index {i} out of range (zip has {len(names)} clips)")
        member = names[i]
    else:
        for n in names:
            if clip in n:
                member = n
                break
        if member is None:
            sys.exit(f"no clip matching {clip!r} in {zip_path}")
    clip_id = member.split(".")[0]
    print(f"clip {clip_id}  ({member})", flush=True)

    pf = pq.ParquetFile(io.BytesIO(zf.read(member)))
    total_spins = pf.metadata.num_rows
    n_spins = total_spins if max_spins <= 0 else min(max_spins, total_spins)
    print(f"{total_spins} spins; converting {n_spins}", flush=True)

    t_ns_list: list[int] = []
    pos_list: list[np.ndarray] = []
    int_list: list[np.ndarray] = []

    # One row group per spin in the source — read them one at a time so we never
    # hold the whole (~290 MB) clip decoded in memory at once.
    for rg in range(n_spins):
        tbl = pf.read_row_group(rg)
        ts_us = int(tbl["spin_start_timestamp"][0].as_py())
        blob = tbl["draco_encoded_pointcloud"][0].as_py()
        pc = DracoPy.decode(blob)
        pts = np.asarray(pc.points, dtype=np.float32)  # (N, 3) metres
        inten = _intensity_array(pc)  # (N,) u8
        n = pts.shape[0]
        keep = _subsample(n, max_points, rng)
        if keep is not None:
            pts = pts[keep]
            inten = inten[keep]
        t_ns_list.append(ts_us * 1000)  # us -> ns (absolute on the clip timeline)
        pos_list.append(pts.reshape(-1))  # flattened xyz
        int_list.append(inten)
        if (rg + 1) % 20 == 0 or rg + 1 == n_spins:
            print(f"  spin {rg + 1}/{n_spins}  ({pts.shape[0]} pts)", flush=True)

    schema = pa.schema(
        [
            pa.field("t_ns", pa.int64(), nullable=False),
            pa.field("positions", pa.list_(pa.float32()), nullable=False),
            pa.field("intensities", pa.list_(pa.uint8()), nullable=False),
        ],
        metadata={
            "driveline.format": "pointcloud",
            "driveline.pointcloud.name": sensor,
            "driveline.pointcloud.source_clip": clip_id,
        },
    )
    table = pa.table(
        {
            "t_ns": pa.array(t_ns_list, type=pa.int64()),
            "positions": pa.array(pos_list, type=pa.list_(pa.float32())),
            "intensities": pa.array(int_list, type=pa.list_(pa.uint8())),
        },
        schema=schema,
    )
    # Small row groups keep per-array list offsets well within int32 range.
    # Snappy (not zstd): the Driveline WASM parquet reader is built with the
    # `snap`/`flate2` codecs only — zstd is disabled to stay within the WASM
    # size budget, and a zstd file fails to open with a misleading footer error.
    pq.write_table(table, out_path, row_group_size=16, compression="snappy")
    total_pts = sum(len(a) for a in int_list)
    print(
        f"wrote {out_path}: {n_spins} spins, {total_pts} points total "
        f"(~{total_pts // max(1, n_spins)} pts/spin)",
        flush=True,
    )


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--zip", required=True, help="lidar chunk zip path")
    ap.add_argument(
        "--clip",
        default="0",
        help="clip index into the zip (e.g. 0) or a clip-id substring",
    )
    ap.add_argument("--out", default=None, help="output .lidar.parquet path")
    ap.add_argument("--sensor", default=SENSOR_DEFAULT, help="channel name")
    ap.add_argument(
        "--max-points",
        type=int,
        default=120000,
        help="cap points/spin (0 = keep all ~250k); subsampled uniformly",
    )
    ap.add_argument(
        "--max-spins",
        type=int,
        default=0,
        help="cap number of spins converted (0 = all, ~199)",
    )
    ap.add_argument("--seed", type=int, default=0, help="subsample RNG seed")
    args = ap.parse_args()

    out = args.out
    if out is None:
        # Derive <clip_id>.lidar.parquet — resolved inside convert() prints it.
        out = "out.lidar.parquet"
    convert(
        args.zip,
        args.clip,
        out,
        args.sensor,
        args.max_points,
        args.max_spins,
        args.seed,
    )


if __name__ == "__main__":
    main()
