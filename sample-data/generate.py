#!/usr/bin/env python3
"""Sample corpus generator for Driveline — T0.3.

Produces the fixtures called for by docs/09-verification-plan.md:
  sample-data/out.h264              (regenerated, not committed)
  sample-data/short.mcap            (regenerated, not committed)
  sample-data/short.mp4             (regenerated, not committed)
  sample-data/short.mp4.timestamps  (committed, 300 text lines: `frame\tts_ns`)
  sample-data/short.mf4             (committed, LFS)
  sample-data/refs/t_*.png          (committed, LFS)
  sample-data/EXPECTED_HASHES.txt   (committed, SHA256 of out.h264)

The single source of truth for video timestamps is frame_ts(i). All
other timestamp fields (MCAP log_time, CompressedVideo.timestamp, the
sidecar bin) derive from it.

Usage:
    python3 sample-data/generate.py              # generate everything
    python3 sample-data/generate.py --check      # verify existing outputs
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from asammdf import MDF, Signal
from mcap.writer import CompressionType, Writer

HERE = Path(__file__).resolve().parent
SCHEMAS = HERE / "schemas"
REFS = HERE / "refs"
HASHES_FILE = HERE / "EXPECTED_HASHES.txt"

START_NS = 1_704_067_200_000_000_000   # 2024-01-01T00:00:00Z
FRAME_NS = 33_333_333                   # truncated 30 fps period
FPS = 30
DURATION_S = 10
TOTAL_FRAMES = FPS * DURATION_S         # 300
WIDTH = 3840
HEIGHT = 2160

REF_TIMES_S = [0.0, 2.5, 5.0, 7.5, 10.0 - 1 / 30]


def frame_ts(i: int) -> int:
    return START_NS + i * FRAME_NS


def run(cmd: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("$", " ".join(cmd), flush=True)
    return subprocess.run(cmd, check=True, **kwargs)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def require_libx264() -> None:
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-encoders"],
        capture_output=True, text=True,
    )
    if "libx264" not in r.stdout:
        sys.exit("ERROR: ffmpeg build does not include libx264; install "
                 "a build with --enable-libx264 (ubuntu: `apt install ffmpeg`).")


def encode_h264(out: Path) -> None:
    """Encode a deterministic 10s 4K H.264 Annex-B stream."""
    out.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-y", "-bitexact",
        "-f", "lavfi",
        "-i", f"testsrc2=size={WIDTH}x{HEIGHT}:rate={FPS}",
        "-t", str(DURATION_S),
        "-c:v", "libx264",
        "-preset", "medium",
        "-tune", "stillimage",
        "-x264-params", (
            f"keyint={FPS}:min-keyint={FPS}:scenecut=0:bframes=0:"
            "ref=1:threads=1:sliced-threads=0:aud=1:repeat-headers=1"
        ),
        "-pix_fmt", "yuv420p",
        "-an",
        str(out),
    ])


def split_access_units(h264: bytes) -> tuple[list[bytes], bytes, bytes]:
    """Split an Annex-B elementary stream into access units.

    Returns (access_units, sps, pps). Each access unit is the full
    byte range from one AUD (NAL type 9) start code to (but not
    including) the next. Inline SPS and PPS are extracted from the
    first IDR so we can construct AVCC extradata; they remain inlined
    in every AU as emitted by x264 with repeat-headers=1.
    """
    # Find NAL start codes (00 00 00 01 or 00 00 01).
    nal_starts: list[int] = []
    i = 0
    n = len(h264)
    while i < n - 3:
        if h264[i] == 0 and h264[i + 1] == 0:
            if h264[i + 2] == 1:
                nal_starts.append(i)
                i += 3
                continue
            if h264[i + 2] == 0 and h264[i + 3] == 1:
                nal_starts.append(i)
                i += 4
                continue
        i += 1
    nal_starts.append(n)  # sentinel

    sps: bytes | None = None
    pps: bytes | None = None
    aus: list[bytes] = []
    current_start: int | None = None

    for idx in range(len(nal_starts) - 1):
        start = nal_starts[idx]
        end = nal_starts[idx + 1]
        # Skip the start code prefix to read the NAL header byte.
        sc_len = 4 if h264[start + 2] == 0 else 3
        header = h264[start + sc_len]
        nal_type = header & 0x1F

        if nal_type == 9:  # AUD — begins a new access unit.
            if current_start is not None:
                aus.append(h264[current_start:start])
            current_start = start
        if nal_type == 7 and sps is None:
            sps = h264[start + sc_len:end].rstrip(b"\x00")
        if nal_type == 8 and pps is None:
            pps = h264[start + sc_len:end].rstrip(b"\x00")

    if current_start is not None:
        aus.append(h264[current_start:nal_starts[-1]])

    if sps is None or pps is None:
        sys.exit("ERROR: no SPS/PPS found; x264 repeat-headers may be off.")

    # Every AU must begin with 00 00 00 01 (Annex-B long start code).
    for i, au in enumerate(aus):
        if au[:4] != b"\x00\x00\x00\x01":
            sys.exit(f"ERROR: AU {i} does not start with long start code; "
                     f"first bytes = {au[:8].hex()}")

    if len(aus) != TOTAL_FRAMES:
        sys.exit(f"ERROR: expected {TOTAL_FRAMES} access units, got {len(aus)}")

    return aus, sps, pps


def build_avcc(sps: bytes, pps: bytes) -> bytes:
    """Construct AVCC extradata (ISO/IEC 14496-15 §5.3.3.1)."""
    # AVCDecoderConfigurationRecord:
    #   configurationVersion = 1
    #   AVCProfileIndication, profile_compatibility, AVCLevelIndication
    #     taken from SPS bytes [1..4]
    #   lengthSizeMinusOne = 3 (4-byte NAL length prefix)
    #   numOfSequenceParameterSets = 1
    #   sequenceParameterSetLength (u16) + SPS
    #   numOfPictureParameterSets = 1
    #   pictureParameterSetLength (u16) + PPS
    profile_idc = sps[1]
    profile_compat = sps[2]
    level_idc = sps[3]
    buf = bytearray()
    buf += bytes([1, profile_idc, profile_compat, level_idc, 0xFF, 0xE1])
    buf += struct.pack(">H", len(sps)) + sps
    buf += bytes([1])
    buf += struct.pack(">H", len(pps)) + pps
    return bytes(buf)


def load_schema(name: str) -> bytes:
    return (SCHEMAS / f"{name}.jsonschema").read_bytes()


def synth_speed(i: int) -> float:
    # 100 Hz, sin wave period = 2 s — min/max stable at ±1.0.
    t = i / 100.0
    return float(np.sin(2 * np.pi * t / 2.0))


def synth_accel(i: int) -> tuple[float, float, float]:
    # 1 kHz, small triangular x,y,z — deterministic and bounded.
    t = i / 1000.0
    x = (t % 1.0) - 0.5
    y = ((t + 0.25) % 1.0) - 0.5
    z = ((t + 0.5) % 1.0) - 0.5
    return x, y, z


MODE_EVENTS = [
    (0.0, 0),   # Manual at session start
    (4.2, 1),   # Auto
    (8.9, 0),   # back to Manual
]


def write_mcap(out: Path, aus: list[bytes], sps: bytes, pps: bytes) -> None:
    avcc = build_avcc(sps, pps)
    with open(out, "wb") as f:
        # Uncompressed — the Rust mcap reader in `crates/data-core`
        # disables default features (no zstd/lz4), and this fixture is
        # for a verification pass, not a storage benchmark.
        w = Writer(f, compression=CompressionType.NONE)
        w.start()

        video_schema = w.register_schema(
            name="foxglove.CompressedVideo",
            encoding="jsonschema",
            data=load_schema("foxglove.CompressedVideo"),
        )
        float64_schema = w.register_schema(
            name="foxglove.Float64",
            encoding="jsonschema",
            data=load_schema("foxglove.Float64"),
        )
        vector3_schema = w.register_schema(
            name="foxglove.Vector3",
            encoding="jsonschema",
            data=load_schema("foxglove.Vector3"),
        )
        mode_schema = w.register_schema(
            name="driveline.ControlMode",
            encoding="jsonschema",
            data=load_schema("driveline.ControlMode"),
        )

        video_ch = w.register_channel(
            topic="/camera/front",
            message_encoding="json",
            schema_id=video_schema,
            metadata={
                "avcc_extradata": base64.b64encode(avcc).decode("ascii"),
                "width": str(WIDTH),
                "height": str(HEIGHT),
                "codec": "h264",
            },
        )
        speed_ch = w.register_channel(
            topic="/vehicle/speed",
            message_encoding="json",
            schema_id=float64_schema,
        )
        accel_ch = w.register_channel(
            topic="/imu/accel",
            message_encoding="json",
            schema_id=vector3_schema,
        )
        mode_ch = w.register_channel(
            topic="/control/mode",
            message_encoding="json",
            schema_id=mode_schema,
        )

        # Interleave by log_time to match real-world record order.
        entries: list[tuple[int, int, bytes]] = []

        for i, au in enumerate(aus):
            ts = frame_ts(i)
            payload = {
                "timestamp": {"sec": ts // 1_000_000_000, "nsec": ts % 1_000_000_000},
                "frame_id": "camera_front",
                "format": "h264",
                "data": base64.b64encode(au).decode("ascii"),
            }
            entries.append((ts, video_ch, json.dumps(payload).encode("utf-8")))

        for i in range(100 * DURATION_S):  # 100 Hz
            ts = START_NS + int(i * 1e9 / 100)
            payload = {
                "timestamp": {"sec": ts // 1_000_000_000, "nsec": ts % 1_000_000_000},
                "value": synth_speed(i),
            }
            entries.append((ts, speed_ch, json.dumps(payload).encode("utf-8")))

        for i in range(1000 * DURATION_S):  # 1 kHz
            ts = START_NS + int(i * 1e9 / 1000)
            x, y, z = synth_accel(i)
            payload = {
                "timestamp": {"sec": ts // 1_000_000_000, "nsec": ts % 1_000_000_000},
                "x": x, "y": y, "z": z,
            }
            entries.append((ts, accel_ch, json.dumps(payload).encode("utf-8")))

        for t_s, v in MODE_EVENTS:
            ts = START_NS + int(t_s * 1e9)
            payload = {
                "timestamp": {"sec": ts // 1_000_000_000, "nsec": ts % 1_000_000_000},
                "value": v,
            }
            entries.append((ts, mode_ch, json.dumps(payload).encode("utf-8")))

        entries.sort(key=lambda e: (e[0], e[1]))

        # Per-channel sequence counters for add_message's `sequence`.
        seq: dict[int, int] = {}
        for ts, ch, data in entries:
            s = seq.get(ch, 0)
            w.add_message(
                channel_id=ch, log_time=ts, publish_time=ts,
                sequence=s, data=data,
            )
            seq[ch] = s + 1

        w.finish()


def write_mf4(out: Path) -> None:
    t_speed = np.arange(0, DURATION_S, 1 / 100, dtype=np.float64)
    speed_samples = np.array(
        [synth_speed(i) for i in range(len(t_speed))], dtype=np.float64,
    )
    speed = Signal(
        samples=speed_samples, timestamps=t_speed,
        name="vehicle_speed", unit="m/s",
    )

    t_imu = np.arange(0, DURATION_S, 1 / 1000, dtype=np.float64)
    imu_xyz = np.array(
        [synth_accel(i) for i in range(len(t_imu))], dtype=np.float32,
    )
    accel = Signal(
        samples=imu_xyz, timestamps=t_imu, name="imu_accel",
    )

    mode_t = np.array([e[0] for e in MODE_EVENTS], dtype=np.float64)
    mode_v = np.array([e[1] for e in MODE_EVENTS], dtype=np.int32)
    mode = Signal(samples=mode_v, timestamps=mode_t, name="control_mode")

    mdf = MDF(version="4.10")
    mdf.header.start_time = datetime(2024, 1, 1, tzinfo=timezone.utc)
    mdf.append([speed], comment="speed @100Hz")
    mdf.append([accel], comment="imu @1kHz")
    mdf.append([mode], comment="mode sparse")
    mdf.save(str(out), overwrite=True)


def write_mp4(h264: Path, mp4: Path, sidecar: Path) -> None:
    run([
        "ffmpeg", "-y", "-bitexact",
        "-f", "h264", "-r", str(FPS), "-i", str(h264),
        "-c", "copy",
        "-movflags", "+faststart",
        str(mp4),
    ])
    # UTF-8 text, one line per frame: `<frame_index>\t<ts_ns>\n`.
    # See docs/05-video-pipeline.md §"Sidecar format".
    with open(sidecar, "w", encoding="utf-8", newline="\n") as f:
        for i in range(TOTAL_FRAMES):
            f.write(f"{i}\t{frame_ts(i)}\n")


def assert_no_b_frames(mp4: Path) -> None:
    r = subprocess.run(
        [
            "ffprobe", "-hide_banner", "-loglevel", "error",
            "-select_streams", "v:0",
            "-show_entries", "packet=pts,dts",
            "-of", "csv=p=0", str(mp4),
        ],
        check=True, capture_output=True, text=True,
    )
    lines = [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]
    for ln in lines:
        parts = ln.split(",")
        if len(parts) < 2:
            continue
        pts, dts = parts[0], parts[1]
        if pts != dts:
            sys.exit(
                f"ERROR: mp4 contains B-frames (pts={pts} dts={dts}); "
                "Foxglove CompressedVideo forbids them."
            )


def extract_refs(mp4: Path, refs_dir: Path) -> None:
    """Extract the five reference frames as 3840x2160 RGB PNGs.

    Uses software h264 decode (`-c:v h264 -threads 1` placed *before*
    `-i` so it applies to the input) + explicit BT.709 to minimise
    machine-dependent YUV→RGB drift (spike §7).

    Seeks to the middle of the target frame (`t - 1/(2·fps)`) then
    selects the single frame whose PTS is nearest to `t_s`. This keeps
    the last frame (t = 10.0 − 1/30) inside the container regardless
    of how ffmpeg computes the MP4 duration.
    """
    refs_dir.mkdir(parents=True, exist_ok=True)
    half_frame = 1.0 / (2 * FPS)
    for t_s in REF_TIMES_S:
        ms = int(round(t_s * 1000))
        out = refs_dir / f"t_{ms:04d}.png"
        seek_s = max(0.0, t_s - half_frame)
        run([
            "ffmpeg", "-y", "-bitexact",
            "-c:v", "h264", "-threads", "1",
            "-ss", f"{seek_s:.6f}",
            "-i", str(mp4),
            "-frames:v", "1", "-vsync", "0",
            "-c:v", "png",
            "-vf", "scale=out_color_matrix=bt709,format=rgb24",
            "-f", "image2", str(out),
        ])


def write_hashes(h264: Path) -> None:
    digest = sha256_of(h264)
    HASHES_FILE.write_text(
        "# SHA256 of sample-data/out.h264 — the bit-identical\n"
        "# cornerstone. All other outputs derive from it.\n"
        f"{digest}  out.h264\n"
    )


def check_hashes(h264: Path) -> bool:
    if not HASHES_FILE.exists():
        print("no EXPECTED_HASHES.txt — run without --check first", file=sys.stderr)
        return False
    expected = None
    for line in HASHES_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(maxsplit=1)
        if len(parts) == 2 and parts[1].endswith("out.h264"):
            expected = parts[0]
            break
    if expected is None:
        print("no out.h264 hash in EXPECTED_HASHES.txt", file=sys.stderr)
        return False
    actual = sha256_of(h264)
    ok = actual == expected
    print(f"out.h264 hash {'MATCH' if ok else 'MISMATCH'}")
    if not ok:
        print(f"  expected {expected}")
        print(f"  actual   {actual}")
    return ok


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify hashes against EXPECTED_HASHES.txt; "
                         "does not regenerate")
    args = ap.parse_args()

    require_libx264()

    h264 = HERE / "out.h264"
    mcap = HERE / "short.mcap"
    mf4 = HERE / "short.mf4"
    mp4 = HERE / "short.mp4"
    sidecar = HERE / "short.mp4.timestamps"

    if args.check:
        if not h264.exists():
            sys.exit("sample-data/out.h264 missing — run without --check first")
        sys.exit(0 if check_hashes(h264) else 1)

    encode_h264(h264)
    raw = h264.read_bytes()
    aus, sps, pps = split_access_units(raw)
    print(f"split_access_units: {len(aus)} AUs, sps={len(sps)}B, pps={len(pps)}B")

    write_mcap(mcap, aus, sps, pps)
    print(f"mcap: {mcap.stat().st_size:,} bytes")

    write_mf4(mf4)
    print(f"mf4:  {mf4.stat().st_size:,} bytes")

    write_mp4(h264, mp4, sidecar)
    print(f"mp4:  {mp4.stat().st_size:,} bytes")
    print(f"sidecar: {sidecar.stat().st_size:,} bytes")

    assert_no_b_frames(mp4)
    print("b-frame check: OK")

    extract_refs(mp4, REFS)
    print(f"refs: {sorted(p.name for p in REFS.iterdir())}")

    write_hashes(h264)
    print(f"hashes written to {HASHES_FILE}")


if __name__ == "__main__":
    main()
