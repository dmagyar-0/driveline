# sample-data/

The ground-truth corpus for driveline verification (T0.3 /
`docs/09-verification-plan.md`).

## Prerequisites

- `ffmpeg` 6+ built with `libx264`
  (`apt install ffmpeg`, `brew install ffmpeg`)
- Python 3.11+
- `pip install mcap asammdf numpy`
- `git lfs install && git lfs pull` (for the committed `short.mf4`
  and `refs/t_*.png`)

## Generate

```sh
make fixtures            # from the repo root
# or:
python3 sample-data/generate.py
```

Outputs:

| File | Committed? | Notes |
|---|---|---|
| `out.h264` | no | Regenerated. SHA256 pinned in `EXPECTED_HASHES.txt`. |
| `short.mcap` | no | ~40 MB. Regenerated, uncompressed. |
| `short.zstd.mcap` | no | Same corpus as `short.mcap`, chunk-level zstd compression. Used by `apps/e2e/tests/zstdMcap.spec.ts`. |
| `short.mp4` | no | Regenerated. |
| `short.mp4.timestamps` | yes | Text, 300 lines of `<frame_index>\t<ts_ns>\n`. |
| `short.mf4` | yes (LFS) | ~3–5 MB. |
| `refs/t_*.png` | yes (LFS) | 5 pixel-compare references. |
| `EXPECTED_HASHES.txt` | yes | Pinned hash of `out.h264`. |

## Verify

```sh
python3 sample-data/generate.py --check
```

Re-hashes `out.h264` and warns if it drifts from `EXPECTED_HASHES.txt`.

## Timestamp contract

- `START_NS = 1_704_067_200_000_000_000` (2024-01-01T00:00:00Z)
- `FRAME_NS = 33_333_333` (truncated 30 fps period)
- `frame_ts(i) = START_NS + i * FRAME_NS`

All four data sources (MCAP `log_time`, the embedded
`CompressedVideo.timestamp`, the MP4 sidecar bin, and the MF4 master
time) derive from `frame_ts(i)`. Do not round `FRAME_NS` to 33,333,334
or derive timestamps from the MP4 container PTS.

## Determinism

The x264 flags in `generate.py` (`-bitexact`, `threads=1`,
`bframes=0`, explicit `keyint`) produce bit-identical output on a
given ffmpeg+libx264 build. The `EXPECTED_HASHES.txt` file pins
`out.h264`'s SHA256; rerun `--check` after updating ffmpeg to catch
encoder drift.
