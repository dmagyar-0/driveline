#!/usr/bin/env bash
# Build every comma2k19 demo fixture in parallel.
#
# Stages:
#   1. Transcode HEVC -> H.264 MP4 at 20 fps and write the matching
#      `.mp4.timestamps` sidecar anchored to the segment start. The
#      transcode runs as a background job while the converters spin
#      up so the CPU is busy throughout.
#   2. Run the four `--only` converter invocations in parallel:
#        chassis.mcap  (speed + steering)
#        wheels.mcap   (4 corner speeds)
#        imu.mf4       (accel + gyro)
#        gnss.mf4      (lat/lon/alt)
#      Plus the original single-MCAP/MF4 outputs the first two demo
#      tests use. All six converter calls are independent — they read
#      the same parquet but write to different output files.
#
# Designed to fail fast: any background job failing returns non-zero
# from `wait -n` and `set -e` aborts the rest.

set -euo pipefail

DEST="${DRIVELINE_DATASETS_DIR:-/tmp/datasets}"
PARQUET="$DEST/comma2k19_demo.parquet"
HEVC="$DEST/video_seg10.hevc"
OUTDIR="sample-data/realworld"

mkdir -p "$OUTDIR"

[[ -s "$PARQUET" ]] || {
  echo "missing $PARQUET — run scripts/fetch-sources.sh first" >&2
  exit 1
}
[[ -s "$HEVC" ]] || {
  echo "missing $HEVC — run scripts/fetch-sources.sh first" >&2
  exit 1
}

# Stage 1 — kick the H.264 transcode off in the background. It takes
# ~10 s and runs single-threaded ffmpeg, so the converter fan-out
# below uses the rest of the cores in the meantime.
transcode() {
  local mp4="$OUTDIR/comma2k19_seg10.mp4"
  local sidecar="$OUTDIR/comma2k19_seg10.mp4.timestamps"
  if [[ -s "$mp4" && -s "$sidecar" ]]; then
    echo "[mp4] already present"
    return 0
  fi
  echo "[mp4] transcoding HEVC -> H.264"
  ffmpeg -hide_banner -v error -y -framerate 20 -i "$HEVC" \
    -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
    -g 20 -keyint_min 20 -movflags +faststart -an "$mp4"
  echo "[mp4] writing sidecar"
  python3 - "$mp4" "$sidecar" <<'PY'
import sys, subprocess, json
mp4, sidecar = sys.argv[1], sys.argv[2]
# Frame count from ffprobe; matches the converter's segment-start ns
# (2018-07-27T06:03:57Z = 1532671437000000000) at 50_000_000 ns/frame.
out = subprocess.check_output([
    "ffprobe", "-v", "error", "-select_streams", "v:0",
    "-count_frames", "-show_entries", "stream=nb_read_frames",
    "-of", "json", mp4,
])
n = int(json.loads(out)["streams"][0]["nb_read_frames"])
start_ns = 1_532_671_437_000_000_000
period_ns = 50_000_000  # 20 fps
with open(sidecar, "w") as f:
    for i in range(n):
        f.write(f"{i}\t{start_ns + i * period_ns}\n")
print(f"[mp4] sidecar wrote {n} lines")
PY
}
transcode &
PID_MP4=$!

# Stage 2 — converter fan-out. One background job per output file.
# `set -e` does NOT propagate from a `&` child to its parent, so each
# job stamps its exit code into a per-PID file; we check them all in
# stage 3 and abort the script if any failed.

run_one() {
  local kind="$1" only="$2" out="$3" seg_idx="${4:-0}" seg_off="${5:-0}"
  if [[ -s "$out" ]]; then
    echo "[$kind:${only:-all}] already present: $out"
    return 0
  fi
  local script="scripts/convert_comma2k19_to_${kind}.py"
  local args=(--parquet "$PARQUET" --out "$out"
              --segment-index "$seg_idx"
              --segment-offset-seconds "$seg_off")
  [[ -n "$only" ]] && args+=(--only "$only")
  echo "[$kind:${only:-all}:seg-idx=$seg_idx] -> $out"
  if python3 "$script" "${args[@]}" >/dev/null; then
    echo "[$kind:${only:-all}:seg-idx=$seg_idx] done"
  else
    echo "[$kind:${only:-all}:seg-idx=$seg_idx] FAILED" >&2
    return 1
  fi
}

spawn() {
  run_one "$@" &
  PIDS+=("$!")
}

# Three converter cohorts run concurrently:
#
#   A. Whole-segment-10 dumps (tests 1, 2 — backwards-compatible
#      single-file outputs).
#   B. Topic split of segment 10 (tests 4, 5 — `--only` fan-out into
#      four topic-specific files).
#   C. Per-segment dumps for segments 4, 7, 10 (test 3 — uses
#      `--segment-offset-seconds` so the unified timeline lays the
#      three blocks out without overlap).
#
# The parquet's row-group 0 has the three drive-2018-07-27 segments at
# indices 0, 1, 2 (= seg 10 / 4 / 7).
PIDS=()

# A. whole-segment-10 (no `--only`)
spawn mcap "" "$OUTDIR/comma2k19.mcap"
spawn mf4  "" "$OUTDIR/comma2k19.mf4"

# B. topic split of segment 10
spawn mcap "speed,steering_angle" "$OUTDIR/comma2k19_chassis.mcap"
spawn mcap "wheel_speed"          "$OUTDIR/comma2k19_wheels.mcap"
spawn mf4  "accel,gyro"           "$OUTDIR/comma2k19_imu.mf4"
spawn mf4  "gnss"                 "$OUTDIR/comma2k19_gnss.mf4"

# C. per-segment files at proper segment-start offsets
#    args: kind only out seg-idx seg-offset-seconds
spawn mcap "" "$OUTDIR/comma2k19_seg10.mcap" 0 600
spawn mf4  "" "$OUTDIR/comma2k19_seg10.mf4"  0 600
spawn mcap "" "$OUTDIR/comma2k19_seg4.mcap"  1 240
spawn mf4  "" "$OUTDIR/comma2k19_seg4.mf4"   1 240
spawn mcap "" "$OUTDIR/comma2k19_seg7.mcap"  2 420
spawn mf4  "" "$OUTDIR/comma2k19_seg7.mf4"   2 420

FAILED=0
for pid in "${PIDS[@]}"; do
  if ! wait "$pid"; then
    FAILED=1
  fi
done
[[ "$FAILED" -eq 0 ]] || { echo "converter fan-out had failures" >&2; exit 1; }

# Stage 3 — wait on the transcode and confirm it exit-coded cleanly.
wait "$PID_MP4"
echo "fixtures ready in $OUTDIR"
ls -lh "$OUTDIR"
