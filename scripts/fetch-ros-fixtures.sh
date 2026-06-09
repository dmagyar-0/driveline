#!/usr/bin/env bash
# Fetch / derive larger real ROS bags for end-to-end visual verification of the
# ROS1/ROS2 readers. The small fixtures committed under test-fixtures/ros/ are
# enough for unit tests; this pulls richer real-world data on demand (kept out
# of git, comma2k19-style).
#
# Produces, under $DRIVELINE_DATASETS_DIR/ros (default /tmp/datasets/ros):
#   - demo.bag                  real foxglove ROS1 demo bag (~67 MB, many topics)
#   - turtle_ros2.mcap          ROS2 MCAP  derived from the committed turtle.bag
#   - turtle_ros2_db3/          ROS2 SQLite derived from the committed turtle.bag
#
# Idempotent: skips any artefact already present. Needs python3 + pip (for the
# pure-python `rosbags` converter — no ROS install required) and curl.
#
# Usage: scripts/fetch-ros-fixtures.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${DRIVELINE_DATASETS_DIR:-/tmp/datasets}/ros"
DEMO_BAG="$DEST/demo.bag"
TURTLE_SRC="$REPO_ROOT/test-fixtures/ros/turtle.bag"
TURTLE_MCAP="$DEST/turtle_ros2.mcap"
TURTLE_DB3_DIR="$DEST/turtle_ros2_db3"
DEMO_BAG_URL="https://assets.foxglove.dev/demo.bag"

mkdir -p "$DEST"

if [[ -s "$DEMO_BAG" ]]; then
  echo "[demo.bag] already present: $DEMO_BAG"
else
  echo "[demo.bag] downloading -> $DEMO_BAG"
  curl -fL --retry 4 --retry-delay 2 -o "$DEMO_BAG.partial" "$DEMO_BAG_URL"
  mv "$DEMO_BAG.partial" "$DEMO_BAG"
  echo "[demo.bag] done ($(du -h "$DEMO_BAG" | cut -f1))"
fi

# Derive real ROS2 bags (db3 + mcap) from the committed turtlesim recording so
# visual verification covers all three containers with the same real data.
if [[ ! -s "$TURTLE_SRC" ]]; then
  echo "[ros2] missing $TURTLE_SRC — run from a checkout with the committed fixtures" >&2
  exit 1
fi

if ! python3 -c "import rosbags" 2>/dev/null; then
  echo "[rosbags] installing pure-python converter"
  pip3 install --user --quiet rosbags
fi

if [[ -d "$TURTLE_DB3_DIR" ]]; then
  echo "[turtle db3] already present: $TURTLE_DB3_DIR"
else
  echo "[turtle db3] converting -> $TURTLE_DB3_DIR"
  rm -rf "$TURTLE_DB3_DIR"
  python3 -m rosbags.convert --src "$TURTLE_SRC" --dst "$TURTLE_DB3_DIR" --dst-storage sqlite3
fi

if [[ -s "$TURTLE_MCAP" ]]; then
  echo "[turtle mcap] already present: $TURTLE_MCAP"
else
  echo "[turtle mcap] converting -> $TURTLE_MCAP"
  tmpdir="$(mktemp -d)"
  rm -rf "$tmpdir/out"
  python3 -m rosbags.convert --src "$TURTLE_SRC" --dst "$tmpdir/out" --dst-storage mcap
  # rosbags writes a bag directory; lift the single .mcap out of it.
  found="$(find "$tmpdir/out" -name '*.mcap' | head -1)"
  cp "$found" "$TURTLE_MCAP"
  rm -rf "$tmpdir"
fi

echo "ROS fixtures ready in $DEST"
