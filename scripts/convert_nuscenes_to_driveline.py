#!/usr/bin/env python3
"""Convert one nuScenes v1.0-mini scene into Driveline-compatible files.

Source dataset: https://www.nuscenes.org/nuscenes  (v1.0-mini, ~4.16 GB tgz,
CC BY-NC-SA 4.0 — non-commercial). Public, no auth required to download.

This is the real-world "try it out" companion to the synthetic calibration
fixture: it materialises a LiDAR point cloud, the matching front-camera video,
and the LIDAR_TOP -> CAM_FRONT camera calibration so Driveline can overlay the
point cloud on the camera image with no reader changes.

Outputs (default `/tmp/datasets/nuscenes_demo/`, gitignored):

  nuscenes.lidar.parquet        Driveline point-cloud schema (see
                                crates/data-core/src/pointcloud.rs):
                                  t_ns        Int64           spin ts (ns)
                                  positions   List<Float32>   flat xyz (m)
                                  intensities List<UInt8>     0..255
                                metadata driveline.pointcloud.name = LIDAR_TOP.
                                One row per LIDAR_TOP sample_data (keyframes +
                                sweeps) of the chosen scene, in LIDAR_TOP frame.

  nuscenes_cam_front.mp4        CAM_FRONT JPGs encoded to H.264 (avc1) via
  nuscenes_cam_front.mp4.timestamps
                                ffmpeg, plus the `.mp4.timestamps` sidecar
                                (see crates/data-core/src/mp4_sidecar.rs):
                                one `<frame>\t<ts_ns>\n` line per frame, ns from
                                the nuScenes sample_data `timestamp` (us -> ns).

  nuscenes_cam_front.calib.json `driveline.calibration/v1` (see docs/13):
                                CAM_FRONT pinhole intrinsics from the nuScenes
                                `camera_intrinsic` 3x3 K, distortion [] (the
                                nuScenes camera images are pre-undistorted), and
                                the LIDAR_TOP -> CAM_FRONT optical extrinsic
                                (translation + scalar-LAST quaternion).

Frame / quaternion / extrinsic math (per docs/13):
  - nuScenes quaternions are scalar-FIRST [w,x,y,z]; Driveline is scalar-LAST
    [qx,qy,qz,qw]. We rotate by them as matrices and emit scalar-last at the end.
  - nuScenes `calibrated_sensor` gives `T_ego_from_sensor` (rotation+translation
    of the sensor in the ego frame). The direct LIDAR_TOP -> CAM_FRONT extrinsic
    for a keyframe is:
        T_cam_from_lidar = inv(T_ego_from_cam) o T_ego_from_lidar
        R = R_cam^-1 @ R_lidar
        t = R_cam^-1 @ (t_lidar - t_cam)
    The lidar<->cam mount is static, so any keyframe's pair gives the same
    sensor-to-sensor transform (ego motion within the scene cancels). The ~90deg
    ISO-8855 (z-up) -> OpenCV (z-forward) rotation is baked into R; nuScenes
    CAM_FRONT's `calibrated_sensor.rotation` already carries the optical frame.

The downloaded tgz and the converted output both live under /tmp and are NOT
committed; the tgz SHA256 is pinned in sample-data/EXPECTED_HASHES.txt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

DEFAULT_DATASET_DIR = Path("/tmp/datasets/nuscenes-mini")
DEFAULT_TGZ = Path("/tmp/datasets/v1.0-mini.tgz")
DEFAULT_OUT = Path("/tmp/datasets/nuscenes_demo")
DOWNLOAD_URL = "https://www.nuscenes.org/data/v1.0-mini.tgz"
EXPECTED_TGZ_BYTES = 4167696325

HERE = Path(__file__).resolve().parent
EXPECTED_HASHES = HERE.parent / "sample-data" / "EXPECTED_HASHES.txt"
TGZ_HASH_KEY = "v1.0-mini.tgz"

LIDAR_SENSOR = "LIDAR_TOP"
CAM_SENSOR = "CAM_FRONT"
CAM_WIDTH = 1600
CAM_HEIGHT = 900

NAME_META_KEY = "driveline.pointcloud.name"


# --------------------------------------------------------------------------- #
# Download / extract
# --------------------------------------------------------------------------- #
def expected_tgz_sha256() -> str | None:
    """Pinned SHA256 for v1.0-mini.tgz from EXPECTED_HASHES.txt, or None."""
    if not EXPECTED_HASHES.exists():
        return None
    pattern = re.compile(r"^([0-9a-fA-F]{64})\s+(\S+)\s*$")
    for line in EXPECTED_HASHES.read_text().splitlines():
        m = pattern.match(line)
        if m and m.group(2) == TGZ_HASH_KEY:
            return m.group(1).lower()
    return None


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_dataset(dataset_dir: Path, tgz: Path, skip_hash_check: bool) -> None:
    """Make sure `dataset_dir` holds the extracted v1.0-mini tree.

    Resilient to re-runs: if the tables already exist we do nothing. Otherwise
    download (resumable) to `tgz`, verify the byte size, optionally verify the
    pinned SHA256, and extract into `dataset_dir`.
    """
    tables = dataset_dir / "v1.0-mini"
    if (tables / "sample.json").exists() and (dataset_dir / "samples").exists():
        print(f"dataset already populated at {dataset_dir}")
        return

    if not tgz.exists() or tgz.stat().st_size < EXPECTED_TGZ_BYTES:
        print(f"downloading {DOWNLOAD_URL} -> {tgz}")
        tgz.parent.mkdir(parents=True, exist_ok=True)
        # Resumable, with retries on transient network blips.
        cmd = [
            "curl", "-L", "-C", "-", "--fail",
            "--retry", "8", "--retry-delay", "10", "--retry-all-errors",
            "-o", str(tgz), DOWNLOAD_URL,
        ]
        rc = subprocess.call(cmd)
        if rc != 0:
            sys.exit(f"curl failed (rc={rc}) downloading {DOWNLOAD_URL}")

    size = tgz.stat().st_size
    if size != EXPECTED_TGZ_BYTES:
        print(
            f"warning: {tgz} is {size} bytes, expected {EXPECTED_TGZ_BYTES}",
            file=sys.stderr,
        )
        if size < EXPECTED_TGZ_BYTES:
            sys.exit("download truncated; re-run to resume")

    expected = expected_tgz_sha256()
    if expected and not skip_hash_check:
        print("verifying tgz SHA256 ...")
        actual = sha256_of(tgz)
        if actual != expected:
            sys.exit(
                f"SHA256 mismatch for {tgz}:\n  expected {expected}\n"
                f"  got      {actual}\nupstream may have re-published the "
                f"archive — audit then update sample-data/EXPECTED_HASHES.txt."
            )
    elif not expected:
        print(
            f"note: no SHA256 entry for {TGZ_HASH_KEY} in {EXPECTED_HASHES}; "
            f"computing it so you can pin it:",
            file=sys.stderr,
        )
        print(f"  {sha256_of(tgz)}  {TGZ_HASH_KEY}", file=sys.stderr)

    print(f"extracting {tgz} -> {dataset_dir}")
    dataset_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(tgz, "r:gz") as tf:
        tf.extractall(dataset_dir)
    if not (tables / "sample.json").exists():
        sys.exit(f"extraction did not produce {tables}/sample.json")


# --------------------------------------------------------------------------- #
# nuScenes table parsing (no devkit dependency)
# --------------------------------------------------------------------------- #
def load_table(tables_dir: Path, name: str) -> list[dict]:
    return json.loads((tables_dir / f"{name}.json").read_text())


def index_by_token(rows: list[dict]) -> dict[str, dict]:
    return {r["token"]: r for r in rows}


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
def quat_wxyz_to_matrix(q: list[float]) -> np.ndarray:
    """nuScenes scalar-FIRST [w,x,y,z] unit quaternion -> 3x3 rotation."""
    w, x, y, z = q
    n = (w * w + x * x + y * y + z * z) ** 0.5
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def matrix_to_quat_xyzw(R: np.ndarray) -> list[float]:
    """3x3 rotation -> Driveline scalar-LAST [qx,qy,qz,qw] unit quaternion."""
    t = R[0, 0] + R[1, 1] + R[2, 2]
    if t > 0:
        s = (t + 1.0) ** 0.5 * 2.0
        w = 0.25 * s
        x = (R[2, 1] - R[1, 2]) / s
        y = (R[0, 2] - R[2, 0]) / s
        z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = (1.0 + R[0, 0] - R[1, 1] - R[2, 2]) ** 0.5 * 2.0
        w = (R[2, 1] - R[1, 2]) / s
        x = 0.25 * s
        y = (R[0, 1] + R[1, 0]) / s
        z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = (1.0 + R[1, 1] - R[0, 0] - R[2, 2]) ** 0.5 * 2.0
        w = (R[0, 2] - R[2, 0]) / s
        x = (R[0, 1] + R[1, 0]) / s
        y = 0.25 * s
        z = (R[1, 2] + R[2, 1]) / s
    else:
        s = (1.0 + R[2, 2] - R[0, 0] - R[1, 1]) ** 0.5 * 2.0
        w = (R[1, 0] - R[0, 1]) / s
        x = (R[0, 2] + R[2, 0]) / s
        y = (R[1, 2] + R[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    return q.tolist()


def quat_rotate_xyzw(q: list[float], p: np.ndarray) -> np.ndarray:
    """Active rotation of vector(s) `p` (..,3) by scalar-last quaternion `q`.

    Mirrors quatRotate() in pointCloudRenderer.ts so the extrinsic round-trips
    with the frontend's projection.
    """
    qx, qy, qz, qw = q
    R = quat_wxyz_to_matrix([qw, qx, qy, qz])
    return p @ R.T


def compose_lidar_to_cam(cs_lidar: dict, cs_cam: dict) -> tuple[np.ndarray, np.ndarray]:
    """T_cam_from_lidar = inv(T_ego_from_cam) o T_ego_from_lidar.

    Returns (R, t): rotation 3x3 and translation (3,) taking a point from the
    LIDAR_TOP frame into the CAM_FRONT optical frame.
    """
    R_lidar = quat_wxyz_to_matrix(cs_lidar["rotation"])
    t_lidar = np.asarray(cs_lidar["translation"], dtype=np.float64)
    R_cam = quat_wxyz_to_matrix(cs_cam["rotation"])
    t_cam = np.asarray(cs_cam["translation"], dtype=np.float64)
    R_cam_inv = R_cam.T  # rotation matrices are orthonormal
    R = R_cam_inv @ R_lidar
    t = R_cam_inv @ (t_lidar - t_cam)
    return R, t


# --------------------------------------------------------------------------- #
# LiDAR
# --------------------------------------------------------------------------- #
def read_pcd_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    """nuScenes LIDAR_TOP .pcd.bin: float32 [x,y,z,intensity,ring] per point.

    Returns (positions Nx3 float32, intensities N uint8).
    """
    raw = np.fromfile(path, dtype=np.float32)
    pts = raw.reshape(-1, 5)
    positions = pts[:, :3].astype(np.float32)
    inten = pts[:, 3]
    # nuScenes intensity is 0..255 already; clip + cast for the UInt8 schema.
    intensities = np.clip(np.round(inten), 0, 255).astype(np.uint8)
    return positions, intensities


def write_lidar_parquet(sample_datas: list[dict], dataset_dir: Path, out: Path) -> int:
    """Write all LIDAR_TOP sample_data of the scene as a Driveline point-cloud
    Parquet (one row per spin). Returns the row count."""
    sds = sorted(sample_datas, key=lambda sd: sd["timestamp"])
    t_ns: list[int] = []
    pos_flat: list[np.ndarray] = []
    pos_offsets = [0]
    int_flat: list[np.ndarray] = []
    int_offsets = [0]

    for sd in sds:
        positions, intensities = read_pcd_bin(dataset_dir / sd["filename"])
        t_ns.append(int(sd["timestamp"]) * 1000)  # us -> ns
        flat = positions.reshape(-1)  # x0,y0,z0,x1,...
        pos_flat.append(flat)
        pos_offsets.append(pos_offsets[-1] + flat.size)
        int_flat.append(intensities)
        int_offsets.append(int_offsets[-1] + intensities.size)

    pos_values = pa.array(np.concatenate(pos_flat), type=pa.float32())
    pos_list = pa.ListArray.from_arrays(
        pa.array(pos_offsets, type=pa.int32()), pos_values
    )
    int_values = pa.array(np.concatenate(int_flat), type=pa.uint8())
    int_list = pa.ListArray.from_arrays(
        pa.array(int_offsets, type=pa.int32()), int_values
    )
    ts_array = pa.array(t_ns, type=pa.int64())

    schema = pa.schema(
        [
            pa.field("t_ns", pa.int64(), nullable=False),
            pa.field("positions", pa.list_(pa.float32()), nullable=False),
            pa.field("intensities", pa.list_(pa.uint8()), nullable=False),
        ],
        metadata={
            NAME_META_KEY: LIDAR_SENSOR,
            "driveline.format": "pointcloud",
        },
    )
    table = pa.Table.from_arrays([ts_array, pos_list, int_list], schema=schema)
    out.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(table, out)
    return len(sds)


# --------------------------------------------------------------------------- #
# Camera video + sidecar
# --------------------------------------------------------------------------- #
def write_camera_video(
    sample_datas: list[dict], dataset_dir: Path, out_mp4: Path, fps: int
) -> tuple[int, int]:
    """Encode CAM_FRONT JPGs to H.264 and write the timestamp sidecar.

    Returns (frame_count, sidecar_line_count). Uses ffmpeg's concat demuxer over
    the real JPG paths (no copies), encoding avc1 at a constant cadence; the
    sidecar carries the *real* per-frame nuScenes timestamps so video PTS and
    LiDAR share a clock.
    """
    sds = sorted(sample_datas, key=lambda sd: sd["timestamp"])
    out_mp4.parent.mkdir(parents=True, exist_ok=True)

    # ffmpeg concat list, one entry per JPG held for 1/fps. We deliberately
    # *omit* the trailing duplicate-last-frame idiom and use
    # `-fps_mode passthrough` so the encoder emits exactly one output frame per
    # input image — the frame count must match the sidecar line count one-to-one
    # or Mp4SidecarReader::open_pair rejects the pair (SidecarLengthMismatch).
    list_path = out_mp4.with_suffix(".concat.txt")
    per = 1.0 / fps
    lines = []
    for sd in sds:
        p = (dataset_dir / sd["filename"]).resolve().as_posix()
        lines.append(f"file '{p}'")
        lines.append(f"duration {per:.6f}")
    list_path.write_text("\n".join(lines) + "\n")

    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_path),
        "-fps_mode", "passthrough",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-g", str(fps), "-keyint_min", str(fps),
        "-vf", f"scale={CAM_WIDTH}:{CAM_HEIGHT}",
        "-video_track_timescale", "90000",
        "-movflags", "+faststart", "-an", str(out_mp4),
    ]
    rc = subprocess.call(cmd)
    list_path.unlink(missing_ok=True)
    if rc != 0:
        sys.exit(f"ffmpeg failed (rc={rc})")

    # The encoder must produce exactly one frame per input image so the sidecar
    # lines up one-to-one with the mp4 samples. A mismatch is fatal — emitting a
    # sidecar of the wrong length would just make the reader reject the pair.
    n_encoded = ffprobe_frame_count(out_mp4)
    if n_encoded != len(sds):
        sys.exit(
            f"ffmpeg encoded {n_encoded} frames but there were {len(sds)} "
            f"CAM_FRONT JPGs; the sidecar must match the mp4 sample count "
            f"exactly. Aborting rather than writing a mismatched sidecar."
        )

    sidecar = out_mp4.with_suffix(".mp4.timestamps")
    with sidecar.open("w") as f:
        for i in range(n_encoded):
            ts_ns = int(sds[i]["timestamp"]) * 1000  # us -> ns
            f.write(f"{i}\t{ts_ns}\n")
    return n_encoded, n_encoded


def ffprobe_frame_count(mp4: Path) -> int:
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-count_frames", "-show_entries", "stream=nb_read_frames",
        "-of", "default=nokey=1:noprint_wrappers=1", str(mp4),
    ]).decode().strip()
    return int(out)


# --------------------------------------------------------------------------- #
# Calibration JSON
# --------------------------------------------------------------------------- #
def write_calibration(
    cs_lidar: dict, cs_cam: dict, out: Path
) -> tuple[dict, np.ndarray, list[float]]:
    """Emit the driveline.calibration/v1 JSON. Returns (intrinsics dict,
    translation, quaternion) for the sanity check / reporting."""
    K = np.asarray(cs_cam["camera_intrinsic"], dtype=np.float64)
    intr = {
        "fx": float(K[0][0]), "fy": float(K[1][1]),
        "cx": float(K[0][2]), "cy": float(K[1][2]),
        "width": CAM_WIDTH, "height": CAM_HEIGHT,
    }
    R, t = compose_lidar_to_cam(cs_lidar, cs_cam)
    quat = matrix_to_quat_xyzw(R)
    doc = {
        "schema": "driveline.calibration/v1",
        "cameras": [
            {
                "name": CAM_SENSOR,
                "intrinsics": intr,
                "distortion": [],
                "extrinsic": {
                    "translation": [float(v) for v in t],
                    "quaternion": quat,
                },
                "target_frame": "lidar",
            }
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2) + "\n")
    return intr, t, quat


# --------------------------------------------------------------------------- #
# Reprojection sanity check
# --------------------------------------------------------------------------- #
def reprojection_stats(
    positions: np.ndarray, intr: dict, t: np.ndarray, quat: list[float]
) -> dict:
    """Project LIDAR_TOP points by the extrinsic + intrinsics and count how many
    land in front of the camera (Z>0) and inside the image."""
    p_cam = quat_rotate_xyzw(quat, positions.astype(np.float64)) + t
    Z = p_cam[:, 2]
    in_front = Z > 0
    Xf, Yf, Zf = p_cam[in_front, 0], p_cam[in_front, 1], p_cam[in_front, 2]
    u = intr["fx"] * (Xf / Zf) + intr["cx"]
    v = intr["fy"] * (Yf / Zf) + intr["cy"]
    in_img = (u >= 0) & (u < intr["width"]) & (v >= 0) & (v < intr["height"])
    n = len(positions)
    return {
        "total": n,
        "in_front": int(in_front.sum()),
        "in_image": int(in_img.sum()),
        "pct_in_front": 100.0 * in_front.sum() / n if n else 0.0,
        "pct_in_image": 100.0 * in_img.sum() / n if n else 0.0,
    }


# --------------------------------------------------------------------------- #
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset-dir", type=Path, default=DEFAULT_DATASET_DIR)
    ap.add_argument("--tgz", type=Path, default=DEFAULT_TGZ)
    ap.add_argument("--out-dir", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--scene-index", type=int, default=0)
    ap.add_argument("--fps", type=int, default=12,
                    help="CAM_FRONT keyframes are ~2 Hz, sweeps ~12 Hz; 12 fps "
                         "matches the camera sample_data cadence.")
    ap.add_argument("--skip-hash-check", action="store_true")
    ap.add_argument("--skip-download", action="store_true",
                    help="Assume the dataset is already extracted.")
    args = ap.parse_args()

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        sys.exit("ffmpeg/ffprobe not found on PATH; install ffmpeg first.")

    if not args.skip_download:
        ensure_dataset(args.dataset_dir, args.tgz, args.skip_hash_check)
    tables_dir = args.dataset_dir / "v1.0-mini"

    print("parsing nuScenes tables ...")
    scenes = load_table(tables_dir, "scene")
    samples = load_table(tables_dir, "sample")
    sample_datas = load_table(tables_dir, "sample_data")
    calibrated_sensors = load_table(tables_dir, "calibrated_sensor")
    sensors = load_table(tables_dir, "sensor")

    sensor_by_token = index_by_token(sensors)
    cs_by_token = index_by_token(calibrated_sensors)
    sample_by_token = index_by_token(samples)

    if args.scene_index >= len(scenes):
        sys.exit(f"scene-index {args.scene_index} out of range ({len(scenes)} scenes)")
    scene = scenes[args.scene_index]
    print(f"scene {args.scene_index}: {scene['name']}  token={scene['token']}")

    # Collect the sample tokens belonging to this scene (walk the linked list).
    scene_sample_tokens: set[str] = set()
    tok = scene["first_sample_token"]
    while tok:
        scene_sample_tokens.add(tok)
        tok = sample_by_token[tok]["next"]
    print(f"  {len(scene_sample_tokens)} keyframe samples")

    # sample_data channel name comes from sensor via calibrated_sensor.
    def sd_channel(sd: dict) -> str:
        cs = cs_by_token[sd["calibrated_sensor_token"]]
        return sensor_by_token[cs["sensor_token"]]["channel"]

    scene_sds = [sd for sd in sample_datas if sd["sample_token"] in scene_sample_tokens]
    lidar_sds = [sd for sd in scene_sds if sd_channel(sd) == LIDAR_SENSOR]
    cam_sds = [sd for sd in scene_sds if sd_channel(sd) == CAM_SENSOR]
    print(f"  LIDAR_TOP sample_data: {len(lidar_sds)} (keyframes + sweeps)")
    print(f"  CAM_FRONT sample_data: {len(cam_sds)}")
    if not lidar_sds or not cam_sds:
        sys.exit("scene is missing LIDAR_TOP or CAM_FRONT sample_data")

    # Representative keyframe calibrated_sensor for each sensor. The mount is
    # static within the scene, so the first keyframe's pair is representative.
    kf_lidar = next(sd for sd in lidar_sds if sd["is_key_frame"])
    kf_cam = next(sd for sd in cam_sds if sd["is_key_frame"])
    cs_lidar = cs_by_token[kf_lidar["calibrated_sensor_token"]]
    cs_cam = cs_by_token[kf_cam["calibrated_sensor_token"]]

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)

    # --- LiDAR Parquet ---
    lidar_out = out_dir / "nuscenes.lidar.parquet"
    print(f"writing {lidar_out} ...")
    n_spins = write_lidar_parquet(lidar_sds, args.dataset_dir, lidar_out)

    # --- Camera video + sidecar ---
    mp4_out = out_dir / "nuscenes_cam_front.mp4"
    print(f"writing {mp4_out} ...")
    n_frames, n_sidecar = write_camera_video(cam_sds, args.dataset_dir, mp4_out, args.fps)

    # --- Calibration JSON ---
    calib_out = out_dir / "nuscenes_cam_front.calib.json"
    print(f"writing {calib_out} ...")
    intr, t, quat = write_calibration(cs_lidar, cs_cam, calib_out)

    # --- Verification & reporting ---
    print("\n=== verification ===")
    table = pq.read_table(lidar_out)
    print(f"parquet schema:\n{table.schema}")
    print(f"parquet rows (spins): {table.num_rows}")
    row0_pos = table.column("positions")[0].values.to_numpy()
    row0_int = table.column("intensities")[0].values.to_numpy()
    print(f"row 0: t_ns={table.column('t_ns')[0].as_py()}  "
          f"points={len(row0_int)}  sample xyz="
          f"({row0_pos[0]:.3f},{row0_pos[1]:.3f},{row0_pos[2]:.3f})  "
          f"intensity={row0_int[0]}")

    print(f"\nmp4 frames (ffprobe): {n_frames}  sidecar lines: {n_sidecar}")
    assert mp4_out.exists() and (out_dir / "nuscenes_cam_front.mp4.timestamps").exists()

    print(f"\nintrinsics: fx={intr['fx']:.3f} fy={intr['fy']:.3f} "
          f"cx={intr['cx']:.3f} cy={intr['cy']:.3f} "
          f"{intr['width']}x{intr['height']}")
    print(f"extrinsic translation: [{t[0]:.4f}, {t[1]:.4f}, {t[2]:.4f}]")
    print(f"extrinsic quaternion (xyzw): "
          f"[{quat[0]:.5f}, {quat[1]:.5f}, {quat[2]:.5f}, {quat[3]:.5f}]")
    finite = all(np.isfinite(v) for v in (intr['fx'], intr['fy'], intr['cx'], intr['cy']))
    finite &= bool(np.all(np.isfinite(t))) and all(np.isfinite(q) for q in quat)
    print(f"all calib values finite: {finite}")

    # Reprojection sanity check on the keyframe nearest the calib pair.
    positions, _ = read_pcd_bin(args.dataset_dir / kf_lidar["filename"])
    stats = reprojection_stats(positions, intr, t, quat)
    print(f"\nreprojection sanity (keyframe LIDAR_TOP spin, "
          f"{stats['total']} points):")
    print(f"  Z>0 (in front): {stats['in_front']} ({stats['pct_in_front']:.1f}%)")
    print(f"  inside {intr['width']}x{intr['height']}: "
          f"{stats['in_image']} ({stats['pct_in_image']:.1f}%)")

    print("\nDONE. Output files:")
    for p in (lidar_out, mp4_out,
              out_dir / "nuscenes_cam_front.mp4.timestamps", calib_out):
        print(f"  {p}  ({p.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
