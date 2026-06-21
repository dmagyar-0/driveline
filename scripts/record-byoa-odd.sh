#!/usr/bin/env bash
#
# Record the "Bring Your Own Agent — ODD tagging" demo: an agent analyses the
# comma2k19 dashcam + CAN, watches the drive (sampling frames), and tags the
# Operational Design Domain (weather / road type / illumination / other road
# user) on one event — with its terminal (prompt, thinking, tool calls,
# inspected frames, answer, follow-up Q&A) shown side-by-side with the app.
#
# Two browser contexts are recorded by scripts/agent-drive/odd-driver.mjs:
# a rendered Claude-Code terminal (left) and the real Driveline UI driven via
# window.__drivelineAgent (right). This script stitches them horizontally with
# ffmpeg into one clip.
#
# Usage:  scripts/record-byoa-odd.sh
# Output: demo/byoa-odd.webm        (terminal | app, composited)
#         demo/byoa-odd-app.webm    (app pane only)
#         demo/byoa-odd-term.webm   (terminal pane only)
#
# Prereqs: pnpm install, pnpm wasm:build (or :dev), Playwright chromium
# (scripts/setup-test-env.sh), ffmpeg, and the comma2k19 fixtures present under
# sample-data/realworld/ (see sample-data/realworld/README.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${BASE:-http://localhost:5173}"
REC="${AGENT_REC:-/tmp/odd-rec}"

# --- prereqs ----------------------------------------------------------------
command -v ffmpeg >/dev/null || { echo "ffmpeg not found — see scripts/setup-test-env.sh" >&2; exit 1; }
for f in comma2k19.mcap comma2k19_seg10.mp4 comma2k19_seg10.mp4.timestamps; do
  [[ -s "$ROOT/sample-data/realworld/$f" ]] || {
    echo "missing sample-data/realworld/$f — build the comma2k19 fixtures first" >&2
    echo "  bash .claude/skills/verify-visually/scripts/fetch-sources.sh" >&2
    echo "  bash .claude/skills/verify-visually/scripts/build-fixtures.sh" >&2
    exit 1
  }
done

# --- dev server (reuse if already up) ---------------------------------------
STARTED_SERVER=0
if ! curl -sf -o /dev/null -m 3 "$BASE"; then
  echo "[odd] starting web dev server..."
  ( cd "$ROOT" && pnpm --filter web dev >/tmp/byoa-odd-vite.log 2>&1 ) &
  STARTED_SERVER=$!
  curl -s --retry-connrefused --retry 90 --retry-delay 1 -o /dev/null "$BASE"
fi
echo "[odd] dev server: $BASE"

# --- record both panes ------------------------------------------------------
rm -rf "$REC"; mkdir -p "$REC"
echo "[odd] recording terminal + app (this drives window.__drivelineAgent live)..."
AGENT_BASE="$BASE" AGENT_REC="$REC" node "$ROOT/scripts/agent-drive/odd-driver.mjs"

APP="$(ls -t "$REC"/app/*.webm | head -1)"
TERM="$(ls -t "$REC"/term/*.webm | head -1)"
echo "[odd] app pane:  $APP"
echo "[odd] term pane: $TERM"

mkdir -p "$ROOT/demo"
cp "$APP" "$ROOT/demo/byoa-odd-app.webm"
cp "$TERM" "$ROOT/demo/byoa-odd-term.webm"

# --- composite side-by-side -------------------------------------------------
# Normalise both to 720p / 30fps, clone each one's last frame for a few extra
# seconds so neither stream starves the hstack, then cut the result back to the
# longer of the two so both panes stay visible to the end.
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
DA="$(dur "$APP")"; DT="$(dur "$TERM")"
MAX="$(python3 -c "print(max($DA,$DT))")"
echo "[odd] durations — app ${DA}s · term ${DT}s · compose ${MAX}s"

echo "[odd] compositing with ffmpeg (terminal | app)..."
ffmpeg -hide_banner -v error -y -i "$TERM" -i "$APP" -filter_complex "
  [0:v]fps=30,scale=-2:720,tpad=stop_mode=clone:stop_duration=8[t];
  [1:v]fps=30,scale=-2:720,tpad=stop_mode=clone:stop_duration=8[a];
  [t][a]hstack=inputs=2[v]" \
  -map "[v]" -t "$MAX" \
  -c:v libvpx-vp9 -b:v 2.5M -pix_fmt yuv420p -an "$ROOT/demo/byoa-odd.webm"

# --- README-ready GIF -------------------------------------------------------
# A README hero embeds best as a GIF served from a GitHub attachment URL
# (drag the file into a PR/issue to mint one) rather than a committed binary.
# Two-pass palette keeps the terminal text legible; 10 fps @ 900px lands the
# ~44 s clip under GitHub's 10 MB image-attachment limit (~8 MB).
echo "[odd] rendering README GIF (palette pass)..."
ffmpeg -hide_banner -v error -y -i "$ROOT/demo/byoa-odd.webm" \
  -vf "fps=10,scale=900:-1:flags=lanczos,palettegen=stats_mode=diff" \
  "$REC/odd-palette.png"
ffmpeg -hide_banner -v error -y -i "$ROOT/demo/byoa-odd.webm" -i "$REC/odd-palette.png" \
  -lavfi "fps=10,scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4" \
  "$ROOT/demo/byoa-odd.gif"

# --- cleanup ----------------------------------------------------------------
[[ "$STARTED_SERVER" != 0 ]] && kill "$STARTED_SERVER" 2>/dev/null || true

echo "[odd] done:"
echo "  demo/byoa-odd.webm ($(dur "$ROOT/demo/byoa-odd.webm")s)"
echo "  demo/byoa-odd.gif ($(ls -lh "$ROOT/demo/byoa-odd.gif" | awk '{print $5}'))"
echo "  demo/byoa-odd-app.webm · demo/byoa-odd-term.webm"
