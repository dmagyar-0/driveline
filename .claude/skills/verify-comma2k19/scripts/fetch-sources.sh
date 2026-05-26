#!/usr/bin/env bash
# Fetch the two upstream comma2k19 inputs the demo needs:
#   - the HF demo parquet (signals for 22 segments, ~78 MB)
#   - the HF compression_challenge HEVC for segment 10 (~36 MB)
#
# Both downloads run in parallel via background jobs. Idempotent —
# skips a download if the file already exists. Verifies the parquet's
# SHA256 against sample-data/EXPECTED_HASHES.txt when possible.

set -euo pipefail

DEST="${DRIVELINE_DATASETS_DIR:-/tmp/datasets}"
PARQUET="$DEST/comma2k19_demo.parquet"
HEVC="$DEST/video_seg10.hevc"
PARQUET_URL="https://huggingface.co/datasets/commaai/comma2k19/resolve/main/data/demo-00000-of-00003.parquet"
HEVC_URL='https://huggingface.co/datasets/commaai/comma2k19/resolve/main/compression_challenge/b0c9d2329ad1606b%7C2018-07-27--06-03-57/10/video.hevc'

mkdir -p "$DEST"

download() {
  local url="$1" out="$2" label="$3"
  if [[ -s "$out" ]]; then
    echo "[$label] already present: $out"
    return 0
  fi
  echo "[$label] downloading -> $out"
  # `-fL` so a 4xx/5xx fails the script instead of writing an HTML
  # error body to the target path.
  curl -fL --retry 4 --retry-delay 2 -o "$out.partial" "$url"
  mv "$out.partial" "$out"
  echo "[$label] done ($(du -h "$out" | cut -f1))"
}

# Parallel: kick off both downloads and `wait` on both. Either failing
# trips `set -e` because of the `wait %1` / `wait %2` exit-code check.
download "$PARQUET_URL" "$PARQUET" parquet &
PID_P=$!
download "$HEVC_URL" "$HEVC" hevc &
PID_H=$!
wait $PID_P
wait $PID_H

# Optional SHA256 check for the parquet — only enforced if the project
# has a pinned hash for that filename. Lets the conversion fail early
# if upstream resharded.
if [[ -f sample-data/EXPECTED_HASHES.txt ]] \
    && grep -q comma2k19_demo.parquet sample-data/EXPECTED_HASHES.txt; then
  echo "[parquet] verifying SHA256"
  grep comma2k19_demo.parquet sample-data/EXPECTED_HASHES.txt \
    | (cd "$DEST" && sha256sum -c -)
fi

echo "sources ready in $DEST"
