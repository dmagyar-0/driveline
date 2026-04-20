# Spike T0.3 — Sample corpus generation

**Status:** investigation complete; implementation pending.
**Related:** `10-task-breakdown.md` T0.3, `09-verification-plan.md`,
`08-risks-and-open-questions.md` (open question 2).
**Date:** 2026-04-17.

---

## 1. Verdict — GO, verified

Implemented inline as part of T6.3 on branch
`claude/implement-t6-3-JL33j`. The pipeline described in this spike
now ships as `sample-data/generate.py`; outputs hash-match
`sample-data/EXPECTED_HASHES.txt`; the full verification plan runs
green against the produced corpus. See
[`verification-t6.3-run.md`](./verification-t6.3-run.md).

Feasible end-to-end with mainstream open-source tooling. Recommended
stack, pinned for reproducibility:

- **Python 3.11**
- **`mcap` 1.3.1** (Foxglove, MIT) — MCAP writer
- **`asammdf` 8.x** — MF4 writer (preferred over `mf4-rs` for the
  fixture generator; see §4)
- **`ffmpeg` 7.x with `libx264` 0.164+** — H.264 encode, remux, frame
  extraction
- **`numpy`** — signal synthesis

All five required artefacts — `short.mcap`, `short.mf4`, `short.mp4`,
`short.mp4.ts.bin`, `sample-data/refs/t_*.png` — can be produced from
a single `sample-data/generate.py`.

## 2. Architecture

One Python script drives `subprocess.run` against ffmpeg and the two
library writers:

```
generate.py
  ├─ encode_h264()       # ffmpeg: testsrc2 → out.h264 (Annex-B ES)
  ├─ split_access_units()# ffprobe or start-code scan → per-AU byte ranges
  ├─ build_avcc()        # SPS+PPS → avcC for MCAP channel metadata
  ├─ write_mcap()        # mcap.writer.Writer
  ├─ write_mf4()         # asammdf.MDF
  ├─ write_mp4()         # ffmpeg remux + sidecar i64 array
  └─ extract_refs()      # ffmpeg -ss 2.5 -frames:v 1 per ref time
```

One single source of truth for timestamps:

```python
START_NS   = 1_704_067_200_000_000_000        # 2024-01-01T00:00:00Z
FRAME_NS   = 33_333_333                        # truncated 30 fps period
frame_ts   = lambda i: START_NS + i * FRAME_NS
```

Compute everything as integer nanoseconds; convert to float only at the
MF4 boundary.

## 3. MCAP writing

The `mcap` Python package is strictly easier than the Rust `mcap` crate
for fixture generation: single-file API, no codegen, numpy-adjacent.

Schema encoding: **JSON** for all four channels. Grep-ability and
zero codegen. The Foxglove JSON schemas live in
[`foxglove/foxglove-sdk/schemas`](https://github.com/foxglove/foxglove-sdk/tree/main/schemas).

Channel map:

| Topic | `schema.name` | `schema.encoding` | `messageEncoding` |
|---|---|---|---|
| `/camera/front` | `foxglove.CompressedVideo` | `jsonschema` | `json` |
| `/vehicle/speed` | `foxglove.Float64` | `jsonschema` | `json` |
| `/imu/accel` | `foxglove.Vector3` | `jsonschema` | `json` |
| `/control/mode` | `driveline.ControlMode` | `jsonschema` | `json` |

Writer skeleton:

```python
from mcap.writer import Writer
with open("sample-data/short.mcap", "wb") as f:
    w = Writer(f); w.start()
    video_schema = w.register_schema(
        name="foxglove.CompressedVideo",
        encoding="jsonschema",
        data=load_schema("CompressedVideo.jsonschema"))
    video_ch = w.register_channel(
        topic="/camera/front",
        message_encoding="json",
        schema_id=video_schema,
        metadata={"avcc_extradata": base64.b64encode(avcc).decode("ascii")})
    for i, au_bytes in enumerate(access_units):
        w.write_message(
            channel_id=video_ch,
            log_time=frame_ts(i),
            publish_time=frame_ts(i),
            sequence=i,
            data=json.dumps({
                "timestamp": {
                    "sec": frame_ts(i) // 1_000_000_000,
                    "nsec": frame_ts(i) % 1_000_000_000,
                },
                "frame_id": "camera_front",
                "format": "h264",
                "data": base64.b64encode(au_bytes).decode("ascii"),
            }).encode("utf-8"))
    # ... similar loops for /vehicle/speed, /imu/accel, /control/mode ...
    w.finish()
```

Notes:

- Per Foxglove's CompressedVideo contract, the `data` field in each
  message is **Annex-B** bytes containing one access unit, and every
  IDR message must inline SPS+PPS. That matches what ffmpeg emits with
  `repeat-headers=1`.
- `avcc_extradata` is **not** part of the schema. Stash it in the
  channel's free-form `metadata` map so consumers that want AVCC mode
  (`VideoDecoder.configure({ description })`) can recover it without
  scanning the stream.

## 4. H.264 encoding

Use `ffmpeg` with deterministic x264 settings:

```sh
ffmpeg -y -bitexact \
  -f lavfi -i "testsrc2=size=3840x2160:rate=30" \
  -t 10 -c:v libx264 -preset medium -tune stillimage \
  -x264-params "keyint=30:min-keyint=30:scenecut=0:bframes=0:ref=1:threads=1:sliced-threads=0:aud=1:repeat-headers=1" \
  -pix_fmt yuv420p -an sample-data/out.h264
```

Key flags:

- `bframes=0` — Foxglove's CompressedVideo contract forbids B-frames,
  and with no B-frames decode order equals presentation order, making
  the sidecar trivial.
- `keyint=30 min-keyint=30 scenecut=0` — exactly 1 keyframe per second.
- `repeat-headers=1` — SPS/PPS prepended to every IDR, so per-AU
  packaging is pure copy.
- `threads=1 aud=1` — deterministic bitstream with explicit AU
  delimiters.
- `-bitexact` — no encoder-ID metadata; same build → same output bytes.

### Splitting into access units

Two reliable options:

- **`ffprobe`** — `ffprobe -select_streams v -show_packets -of json
  sample-data/out.h264` gives per-packet `pos` and `size`. For an
  elementary stream, one packet equals one AU.
- **Start-code scan** — scan for `00 00 00 01` / `00 00 01`, bucket
  NALs by AUD (type 9) or first-VCL-slice rule. Capture SPS (type 7)
  and PPS (type 8) on the first pass.

Building `avcC` (ISO/IEC 14496-15 §5.3.3.1) is documented in
`spike-T0.2-webcodecs-mcap.md` §4 — the generator and the browser
reader must stay bit-identical here.

## 5. MF4 writing — prefer `asammdf`

`mf4-rs` works (`MdfWriter::new` → `init_mdf_file` → `add_channel_group`
→ `add_channel(..., Some(&time_ch_id), ...)` → `start_data_block_for_cg`
→ `write_record` → `finish_data_block`), but requires a Rust build step
from a Python pipeline for zero functional gain. `asammdf` also
supports VTAB (value-to-text) conversions natively for the enum
channel.

```python
from asammdf import MDF, Signal
from datetime import datetime, timezone
import numpy as np

t_speed = np.arange(0, 10, 1/100, dtype=np.float64)
speed = Signal(
    samples=np.sin(t_speed).astype(np.float64),
    timestamps=t_speed,
    name="vehicle_speed", unit="m/s")

t_imu = np.arange(0, 10, 1/1000, dtype=np.float64)
accel = Signal(
    samples=np.zeros((len(t_imu), 3), dtype=np.float32),
    timestamps=t_imu,
    name="imu_accel")

mode = Signal(
    samples=np.array([0, 1, 0], dtype=np.int32),
    timestamps=np.array([0.0, 4.2, 8.9]),
    name="control_mode",
    conversion={
        "conversion_type": "value_to_text",
        "val_0": 0, "text_0": b"Manual",
        "val_1": 1, "text_1": b"Auto",
        "default": b"",
    })

mdf = MDF(version="4.10")
mdf.header.start_time = datetime(2024, 1, 1, tzinfo=timezone.utc)
mdf.append([speed], comment="speed @100Hz")
mdf.append([accel], comment="imu @1kHz")
mdf.append([mode],  comment="mode sparse")
mdf.save("sample-data/short.mf4", overwrite=True)
```

Each `append([...])` creates a new channel group with its own master
time channel — exactly what we want for mismatched rates and sparsity.

We still want a `mf4-rs`-side test that reads this file to verify the
Rust wrapper we are building; that is part of T2.2, not T0.3.

## 6. mp4 + sidecar

```sh
ffmpeg -y -bitexact -i sample-data/out.h264 \
  -c copy -movflags +faststart sample-data/short.mp4
```

```python
import struct
with open("sample-data/short.mp4.ts.bin", "wb") as f:
    for i in range(300):
        f.write(struct.pack("<q", frame_ts(i)))
```

300 × 8 bytes = 2,400 bytes. Trivial to check in.

Document in this script and the reader: **33_333_333 ns is the contract**
(truncated 30 fps period). Do not drift to `round(1e9/30)` later.

## 7. Reference PNGs

Accurate seek requires `-ss` **after** `-i`:

```sh
ffmpeg -i sample-data/short.mp4 \
  -ss 2.5 -frames:v 1 -vsync 0 \
  -c:v h264 -threads 1 \
  -vf "scale=out_color_matrix=bt709,format=rgb24" \
  -f image2 sample-data/refs/t_2500.png
```

- `-ss` before `-i` is keyframe-only seek; it drifts.
- Force software decode (`-c:v h264 -threads 1`) because hardware
  decoders produce slightly different YUV→RGB output between machines.
- `rgb24` + explicit BT.709 matrix minimises pixelmatch noise. Use a
  tolerance of ≥ 2 in pixelmatch to tolerate the unavoidable chroma
  round-trip.
- Five reference times: `0.0`, `2.5`, `5.0`, `7.5`, `10.0 - 1/30`.

## 8. Script organisation & checked-in artefacts

Single file: `sample-data/generate.py`. Pure Python driving
`subprocess.run(["ffmpeg", ...])` keeps the pipeline debuggable and
CI-portable.

Check-in policy:

| Artefact | Size | Where |
|---|---|---|
| `sample-data/generate.py` | small | git |
| `sample-data/schemas/*.jsonschema` | small | git |
| `sample-data/short.mf4` | ~3–5 MB | git (or LFS) |
| `sample-data/short.mp4.ts.bin` | 2,400 B | git |
| `sample-data/refs/t_*.png` | ~1–3 MB × 5 | git LFS |
| `sample-data/short.mcap` | ~40 MB | regenerated via `make fixtures` |
| `sample-data/short.mp4` | ~30–60 MB | regenerated via `make fixtures` |
| `sample-data/out.h264` | similar | regenerated |

Add a `--check` mode to `generate.py` that re-hashes the outputs and
warns on drift. Pin ffmpeg+libx264 via a Docker image (e.g.
`jrottenberg/ffmpeg:7.1-ubuntu`) in CI and commit the expected SHA256
of `out.h264` to `sample-data/EXPECTED_HASHES.txt`.

## 9. Known gotchas

- **Timestamp alignment.** MCAP `log_time` is integer ns; MF4 master
  timestamps are float64 seconds. Double precision is safe at 1 kHz;
  at 1 MHz it is not. Compute integer ns, convert to float only at the
  MF4 boundary.
- **Decode vs presentation order.** With `bframes=0` these are the
  same, so `short.mp4.ts.bin` in decode order is unambiguous. Add an
  assertion in `generate.py` that reads back the mp4 and confirms
  `b_frame_count == 0`.
- **Single timestamp source.** Compute `log_time`, the MCAP
  `CompressedVideo.timestamp` field, and the sidecar all from
  `frame_ts(i)`. Do not derive any from the mp4 container's PTS.
- **Foxglove B-frame rule.** Violating it silently breaks the viewer;
  the spike's `generate.py` must fail loudly if x264 ever emits one.
- **AVCC vs Annex-B confusion.** The in-MCAP video bytes are Annex-B;
  the `avcc_extradata` in channel metadata is AVCC (length-prefixed).
  Write a self-check in `generate.py` asserting the first four bytes
  of each video message are `00 00 00 01`.
- **libx264 determinism.** Only deterministic with `threads=1`,
  `-bitexact`, and a pinned ffmpeg+libx264 version. Document the
  pinned build.
- **libx264 availability.** Ubuntu 22.04+ and Homebrew ship it; Alpine
  does not. Fail fast in `generate.py` with
  `ffmpeg -hide_banner -encoders | grep libx264`.

## 10. Acceptance mapping

Task acceptance from `10-task-breakdown.md`:

1. All three fixtures produced — §3, §5, §6.
2. Correct durations, channel counts, and timestamps — §9 hash check +
   an assertion pass in `generate.py`.
3. Reference PNGs captured for the five ref times — §7.

## 11. Deliverables when implemented

- `sample-data/generate.py` plus `sample-data/schemas/`.
- `sample-data/short.mf4` and `sample-data/short.mp4.ts.bin` checked in.
- `sample-data/refs/t_*.png` committed via Git LFS.
- A `Makefile` or `justfile` target `fixtures` that regenerates the
  rest from the pinned ffmpeg image.
- `sample-data/EXPECTED_HASHES.txt` with SHA256 of `out.h264` (the
  bit-identical cornerstone all other outputs derive from).
- Update this doc's verdict to `GO, verified` after the first run
  passes unit-test-level checks. **Done** — see §1.

## 12. References

- Foxglove MCAP: <https://github.com/foxglove/mcap>
- `mcap` PyPI: <https://pypi.org/project/mcap/>
- MCAP JSON writing guide: <https://mcap.dev/guides/python/json>
- `CompressedVideo` schema:
  <https://docs.foxglove.dev/docs/sdk/schemas/compressed-video>
- Foxglove schemas repo:
  <https://github.com/foxglove/foxglove-sdk/tree/main/schemas>
- Foxglove H.264 announcement:
  <https://foxglove.dev/blog/announcing-h264-support-in-foxglove>
- FFmpeg bitstream filters:
  <https://ffmpeg.org/ffmpeg-bitstream-filters.html>
- FFmpeg codec docs: <https://ffmpeg.org/ffmpeg-codecs.html>
- `asammdf` API: <https://asammdf.readthedocs.io/en/latest/api.html>
- `mf4-rs`: <https://github.com/dmagyar-0/mf4-rs>
- `h26x-extractor`: <https://github.com/slhck/h26x-extractor>
