#!/usr/bin/env python3
"""Deterministic synthetic lidar + camera + calibration fixture.

Proves the point-cloud-on-video overlay lands on exact pixels: the camera MP4
is rendered by projecting the *same* known 3-D scene through the *same* camera
model that is written to the `.calib.json`. A correct overlay's dots must land
exactly on the rendered markers.

Emits (all under `sample-data/calib/`, all small + committable):

  calib/scene.lidar.parquet      driveline point-cloud Parquet (~30 spins @10Hz)
  calib/scene_cam_front.mp4      H.264 video, 1280x720, projected scene
  calib/scene_cam_front.mp4.timestamps   per-frame ns sidecar (matches lidar)
  calib/scene.calib.json         driveline.calibration/v1 (intrinsics+extrinsic)

Frame conventions (see docs/13-camera-lidar-calibration.md):
  - Scene / LiDAR frame: x-forward, y-left, z-up, metres (ISO-8855).
  - Camera optical frame: x-right, y-down, z-forward (OpenCV pinhole).
  - Quaternion scalar-last [qx,qy,qz,qw], active rotation.
  - Extrinsic (scene -> camera optical): p_cam = quatRotate(q, p_scene) + t.

Usage:
    python3 sample-data/generate_calib_scene.py            # generate
    python3 sample-data/generate_calib_scene.py --check    # verify hashes
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "calib"
HASHES_FILE = HERE / "EXPECTED_HASHES.txt"

# --- Timeline (reuse the project anchor convention from generate.py) ---------
START_NS = 1_704_067_200_000_000_000  # 2024-01-01T00:00:00Z
SPIN_HZ = 10
NUM_SPINS = 30
SPIN_NS = 1_000_000_000 // SPIN_HZ  # 100 ms

# --- Camera (KNOWN intrinsics + extrinsic, baked into the render) ------------
WIDTH = 1280
HEIGHT = 720
FX = 900.0
FY = 900.0
CX = 640.0
CY = 360.0

CAM_NAME = "CAM_FRONT"
# Scene -> camera optical rotation (x-fwd,y-left,z-up -> x-right,y-down,z-fwd).
# scene x(fwd)->cam +Z, scene y(left)->cam -X, scene z(up)->cam -Y.
R_SCENE_TO_CAM = np.array(
    [
        [0.0, -1.0, 0.0],
        [0.0, 0.0, -1.0],
        [1.0, 0.0, 0.0],
    ]
)
# This R as a scalar-last unit quaternion [qx,qy,qz,qw].
QUATERNION = np.array([0.5, -0.5, 0.5, 0.5])
# Camera mounted 1.5 m up at the scene origin (x=0,y=0,z=1.5).
CAM_ORIGIN_SCENE = np.array([0.0, 0.0, 1.5])
# t = -R @ cam_origin so the camera origin maps to 0 in the optical frame.
TRANSLATION = (-R_SCENE_TO_CAM @ CAM_ORIGIN_SCENE).astype(np.float64)  # [0,1.5,0]

POINTCLOUD_NAME = "lidar_top_360fov"


# --- Scene geometry (scene frame, metres) ------------------------------------
# Several vertical poles at distinct, known (x,y) in front of the camera.
# Each is a vertical line of points from z=0 to z=POLE_H. The pole *tops* are
# the distinctive features we draw markers on.
POLE_H = 3.0
# (x_forward, y_left, label) — spread left/right, 5..30 m forward.
POLES = [
    (5.0, 0.0),
    (10.0, 4.0),
    (10.0, -4.0),
    (18.0, 8.0),
    (18.0, -8.0),
    (30.0, 3.0),
    (30.0, -3.0),
]

# Distinctive filled marker colours (one per pole top), RGB.
MARKER_COLORS = [
    (220, 40, 40),
    (40, 200, 40),
    (60, 90, 230),
    (230, 200, 30),
    (220, 60, 200),
    (40, 210, 210),
    (250, 140, 30),
]
MARKER_RADIUS = 9
BG_COLOR = (32, 34, 40)


def quat_rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Active rotation of vector(s) `v` by scalar-last quaternion `q`.

    Matches `quatRotate()` in apps/web/src/.../pointCloudRenderer.ts.
    `v` may be (3,) or (N,3); returns the same shape.
    """
    x, y, z, w = q
    qv = np.array([x, y, z])
    single = v.ndim == 1
    pts = np.atleast_2d(v)
    t = 2.0 * np.cross(qv, pts)
    out = pts + w * t + np.cross(qv, t)
    return out[0] if single else out


def project(p_scene: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Project scene points to pixels. Returns (uv (N,2), depth (N,)).

    Pinhole, no distortion (distortion == []). Caller filters Z>0 / in-bounds.
    """
    pts = np.atleast_2d(p_scene).astype(np.float64)
    p_cam = quat_rotate(QUATERNION, pts) + TRANSLATION
    z = p_cam[:, 2]
    safe = np.where(z != 0, z, 1e-9)
    u = FX * (p_cam[:, 0] / safe) + CX
    v = FY * (p_cam[:, 1] / safe) + CY
    return np.stack([u, v], axis=1), z


def build_scene_points() -> tuple[np.ndarray, np.ndarray]:
    """Build the static scene cloud: ground grid + vertical poles.

    Returns (positions (N,3) float32, intensities (N,) uint8).
    """
    pts = []
    inten = []

    # Flat ground grid: 20m x 20m lattice on z=0, in front of the camera.
    # x in [2,22] forward, y in [-10,10] left/right, 1 m spacing.
    gx = np.arange(2.0, 22.0 + 0.5, 1.0)
    gy = np.arange(-10.0, 10.0 + 0.5, 1.0)
    for x in gx:
        for y in gy:
            pts.append((x, y, 0.0))
            inten.append(40)

    # Vertical poles: a column of points up to POLE_H every 0.15 m.
    pole_z = np.arange(0.0, POLE_H + 1e-6, 0.15)
    for px, py in POLES:
        for z in pole_z:
            pts.append((px, py, float(z)))
            # Brighter than ground so poles stand out in the cloud too.
            inten.append(220)

    positions = np.array(pts, dtype=np.float32)
    intensities = np.array(inten, dtype=np.uint8)
    return positions, intensities


def pole_tops() -> np.ndarray:
    """The distinctive feature points: the top of each pole (z=POLE_H)."""
    return np.array([(px, py, POLE_H) for px, py in POLES], dtype=np.float64)


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kw)


def require_libx264() -> None:
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True
    )
    if "libx264" not in r.stdout:
        sys.exit(
            "ERROR: ffmpeg build does not include libx264; install a build "
            "with --enable-libx264 (ubuntu: `apt install ffmpeg`)."
        )


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def write_parquet(out: Path, positions: np.ndarray, intensities: np.ndarray) -> None:
    """Write ~30 spins of the (static) scene cloud as a driveline Parquet."""
    pos_flat = positions.reshape(-1).tolist()  # flattened xyz
    int_list = intensities.tolist()

    t_ns_col = [START_NS + i * SPIN_NS for i in range(NUM_SPINS)]
    pos_col = [pos_flat for _ in range(NUM_SPINS)]
    int_col = [int_list for _ in range(NUM_SPINS)]

    schema = pa.schema(
        [
            pa.field("t_ns", pa.int64(), nullable=False),
            pa.field("positions", pa.list_(pa.float32()), nullable=False),
            pa.field("intensities", pa.list_(pa.uint8()), nullable=False),
        ],
        metadata={
            b"driveline.format": b"pointcloud",
            b"driveline.pointcloud.name": POINTCLOUD_NAME.encode("utf-8"),
        },
    )
    table = pa.table(
        {
            "t_ns": pa.array(t_ns_col, type=pa.int64()),
            "positions": pa.array(pos_col, type=pa.list_(pa.float32())),
            "intensities": pa.array(int_col, type=pa.list_(pa.uint8())),
        },
        schema=schema,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, out, row_group_size=8, compression="snappy")


def render_frames(frames_dir: Path) -> list[Path]:
    """Render one PNG per spin by projecting the pole tops with the camera."""
    frames_dir.mkdir(parents=True, exist_ok=True)
    tops = pole_tops()
    uv, depth = project(tops)
    paths = []
    for i in range(NUM_SPINS):
        img = Image.new("RGB", (WIDTH, HEIGHT), BG_COLOR)
        draw = ImageDraw.Draw(img)
        for j, ((u, v), z) in enumerate(zip(uv, depth)):
            if z <= 0 or not (0 <= u < WIDTH and 0 <= v < HEIGHT):
                continue
            color = MARKER_COLORS[j % len(MARKER_COLORS)]
            r = MARKER_RADIUS
            draw.ellipse([u - r, v - r, u + r, v + r], fill=color, outline=(255, 255, 255))
        p = frames_dir / f"f_{i:04d}.png"
        img.save(p)
        paths.append(p)
    return paths


def encode_mp4(frames_dir: Path, mp4: Path, sidecar: Path) -> None:
    """Encode the PNG frames to a deterministic H.264 MP4 + ns sidecar."""
    run(
        [
            "ffmpeg",
            "-y",
            "-bitexact",
            "-framerate",
            str(SPIN_HZ),
            "-i",
            str(frames_dir / "f_%04d.png"),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-tune",
            "stillimage",
            "-x264-params",
            (
                f"keyint={SPIN_HZ}:min-keyint={SPIN_HZ}:scenecut=0:bframes=0:"
                "ref=1:threads=1:sliced-threads=0:aud=1:repeat-headers=1"
            ),
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
            str(mp4),
        ]
    )
    # Sidecar: per-frame ns, identical to the lidar spin timestamps.
    with open(sidecar, "w", encoding="utf-8", newline="\n") as f:
        for i in range(NUM_SPINS):
            f.write(f"{i}\t{START_NS + i * SPIN_NS}\n")


def write_calib(out: Path) -> None:
    calib = {
        "schema": "driveline.calibration/v1",
        "cameras": [
            {
                "name": CAM_NAME,
                "intrinsics": {
                    "fx": FX,
                    "fy": FY,
                    "cx": CX,
                    "cy": CY,
                    "width": WIDTH,
                    "height": HEIGHT,
                },
                "distortion": [],
                "extrinsic": {
                    "translation": [round(float(x), 6) for x in TRANSLATION],
                    "quaternion": [round(float(x), 6) for x in QUATERNION],
                },
                "target_frame": "lidar",
            }
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(calib, indent=2) + "\n", encoding="utf-8")


# Outputs whose bytes are pinned. The MP4 is deterministic given a fixed
# libx264; the Parquet and JSON are pure-Python deterministic.
HASH_OUTPUTS = [
    "calib/scene.lidar.parquet",
    "calib/scene_cam_front.mp4",
    "calib/scene_cam_front.mp4.timestamps",
    "calib/scene.calib.json",
]
HASH_MARKER = "calib fixture"


def write_hashes() -> None:
    lines = HASHES_FILE.read_text().splitlines() if HASHES_FILE.exists() else []
    # Strip any previous calib block (marker line + following hash lines).
    kept: list[str] = []
    skip = False
    for ln in lines:
        if HASH_MARKER in ln:
            skip = True
            continue
        if skip:
            if ln.strip() == "" or ln.startswith("#"):
                skip = False
            else:
                continue
        kept.append(ln)
    block = [f"# {HASH_MARKER} (sample-data/generate_calib_scene.py)"]
    for rel in HASH_OUTPUTS:
        block.append(f"{sha256_of(HERE / rel)}  {rel}")
    text = "\n".join(kept).rstrip("\n") + "\n\n" + "\n".join(block) + "\n"
    HASHES_FILE.write_text(text)


def check_hashes() -> bool:
    if not HASHES_FILE.exists():
        print("no EXPECTED_HASHES.txt — run without --check first", file=sys.stderr)
        return False
    want: dict[str, str] = {}
    for ln in HASHES_FILE.read_text().splitlines():
        ln = ln.strip()
        if not ln or ln.startswith("#"):
            continue
        parts = ln.split(maxsplit=1)
        if len(parts) == 2 and parts[1] in HASH_OUTPUTS:
            want[parts[1]] = parts[0]
    ok = True
    for rel in HASH_OUTPUTS:
        if rel not in want:
            print(f"MISSING hash for {rel}")
            ok = False
            continue
        actual = sha256_of(HERE / rel)
        match = actual == want[rel]
        print(f"{rel}: {'MATCH' if match else 'MISMATCH'}")
        if not match:
            print(f"  expected {want[rel]}")
            print(f"  actual   {actual}")
            ok = False
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify pinned hashes")
    args = ap.parse_args()

    parquet = OUT_DIR / "scene.lidar.parquet"

    if args.check:
        sys.exit(0 if check_hashes() else 1)

    require_libx264()

    positions, intensities = build_scene_points()
    print(f"scene: {len(positions):,} points "
          f"(grid + {len(POLES)} poles)")

    write_parquet(parquet, positions, intensities)
    print(f"parquet: {parquet.stat().st_size:,} bytes, {NUM_SPINS} spins")

    frames_dir = OUT_DIR / "_frames"
    render_frames(frames_dir)

    mp4 = OUT_DIR / "scene_cam_front.mp4"
    sidecar = OUT_DIR / "scene_cam_front.mp4.timestamps"
    encode_mp4(frames_dir, mp4, sidecar)
    print(f"mp4: {mp4.stat().st_size:,} bytes")
    print(f"sidecar: {sidecar.stat().st_size:,} bytes")

    # Clean up the intermediate PNGs — only the encoded MP4 is committed.
    for p in frames_dir.glob("*.png"):
        p.unlink()
    frames_dir.rmdir()

    calib = OUT_DIR / "scene.calib.json"
    write_calib(calib)
    print(f"calib: {calib.stat().st_size:,} bytes")

    write_hashes()
    print(f"hashes written to {HASHES_FILE}")

    # Self-consistency: re-project the pole tops and report pixels.
    uv, depth = project(pole_tops())
    print("\npole-top reprojection (scene xyz -> pixel u,v, depth):")
    for (px, py), (u, v), z in zip(POLES, uv, depth):
        print(f"  ({px:5.1f}, {py:5.1f}, {POLE_H}) -> "
              f"u={u:7.2f} v={v:7.2f}  depth={z:.3f}")


if __name__ == "__main__":
    main()
