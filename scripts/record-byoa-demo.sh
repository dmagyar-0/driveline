#!/usr/bin/env bash
# Record the "Bring Your Own Agent" demo screencast end-to-end.
#
# Produces a single stitched clip at demo/byoa-demo.webm from the two
# scenes in apps/e2e/tests/_demo-byoa-agent.spec.ts:
#   Scene 1 — pure BYOA: the agent brings, plots, analyses, and tags its
#             own inline data (no fixtures; always recorded).
#   Scene 2 — BYOA on the real comma2k19 dashcam (recorded only when the
#             fixtures are present; fetched + built automatically below
#             unless --scene1-only is passed).
#
# Usage:
#   scripts/record-byoa-demo.sh              # both scenes (fetches fixtures)
#   scripts/record-byoa-demo.sh --scene1-only  # skip the dataset download
#
# Prerequisites: a built WASM bundle (`pnpm wasm:build:dev`), the e2e
# Playwright browser (`pnpm --filter e2e exec playwright install chromium`),
# and ffmpeg on PATH. Scene 2 additionally needs the python fixture deps
# (see scripts/setup-test-env.sh) and ffmpeg for the HEVC transcode.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SCENE1_ONLY=0
[[ "${1:-}" == "--scene1-only" ]] && SCENE1_ONLY=1

SKILL_SCRIPTS=".claude/skills/verify-visually/scripts"
OUT_DIR="demo"
OUT="$OUT_DIR/byoa-demo.webm"
RESULTS="apps/e2e/test-results"

command -v ffmpeg >/dev/null || { echo "ffmpeg not found on PATH" >&2; exit 1; }

# Scene 2 needs the comma2k19 fixtures. Fetch + build them unless the
# caller opted out; the spec self-skips scene 2 if they remain absent.
if [[ "$SCENE1_ONLY" -eq 0 ]]; then
  echo "==> fetching + building comma2k19 fixtures (scene 2)"
  bash "$SKILL_SCRIPTS/fetch-sources.sh"
  bash "$SKILL_SCRIPTS/build-fixtures.sh"
fi

echo "==> recording scenes (Playwright)"
mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CLIPS=()

# Record each scene in its own run so clip ordering is deterministic
# (Playwright names result dirs with a content hash, which does NOT sort
# by scene number). A scene that self-skips (e.g. scene 2 with no
# fixtures) simply produces no video and is left out of the stitch.
record_scene() {
  local grep="$1" dest="$2"
  rm -rf "$RESULTS"
  pnpm --filter e2e exec playwright test _demo-byoa-agent.spec.ts \
    -g "$grep" --project=chromium
  local clip
  clip="$(find "$RESULTS" -name "video.webm" | head -1)"
  if [[ -n "$clip" ]]; then
    cp "$clip" "$dest"
    CLIPS+=("$dest")
    echo "    recorded: $grep"
  else
    echo "    skipped (no recording): $grep"
  fi
}

record_scene "scene 1" "$WORK/01-scene1.webm"
record_scene "scene 2" "$WORK/02-scene2.webm"

echo "==> stitching clips -> $OUT"
if [[ "${#CLIPS[@]}" -eq 0 ]]; then
  echo "no recordings produced" >&2
  exit 1
fi

if [[ "${#CLIPS[@]}" -eq 1 ]]; then
  cp "${CLIPS[0]}" "$OUT"
else
  # Re-encode with a concat filter so mismatched stream params (keyframes,
  # timing) join cleanly into one playable webm.
  args=()
  for c in "${CLIPS[@]}"; do args+=(-i "$c"); done
  filter=""
  for i in "${!CLIPS[@]}"; do filter+="[$i:v:0]"; done
  filter+="concat=n=${#CLIPS[@]}:v=1:a=0[v]"
  ffmpeg -hide_banner -v error -y "${args[@]}" \
    -filter_complex "$filter" -map "[v]" \
    -c:v libvpx-vp9 -b:v 2M -pix_fmt yuv420p "$OUT"
fi

echo "==> done: $OUT"
ls -lh "$OUT"
