#!/usr/bin/env bash
# Install everything needed to run the Driveline test suite end-to-end:
#   - pnpm workspace install
#   - the wasm bundle (`pnpm wasm:build`) consumed by the web app + workers
#   - the Python toolchain that produces the MCAP/MP4 fixtures
#   - the system ffmpeg used by `sample-data/generate.py`
#   - the actual fixtures under `sample-data/short.*`
#   - Playwright's chromium browser
#
# Idempotent: each step skips itself if its output is already present.
# Safe to re-run.
#
# Assumes:
#   - Rust toolchain with the `wasm32-unknown-unknown` target is already
#     installed (`rustup target add wasm32-unknown-unknown`)
#   - Node.js 22+ and pnpm 10+ are on PATH
#
# Usage:
#   scripts/setup-test-env.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

log() { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*" >&2; }

# Pick the right privilege escalation strategy. Sandboxes that already
# run as root don't need (and often don't have) sudo.
if [[ $EUID -eq 0 ]]; then
  SUDO=()
elif command -v sudo >/dev/null 2>&1; then
  SUDO=(sudo)
else
  SUDO=()
  warn "not root and sudo missing — apt installs will fail if ffmpeg is absent"
fi

# 1 · ffmpeg (with libx264) — sample-data/generate.py shells out to it.
log "ffmpeg"
if command -v ffmpeg >/dev/null 2>&1; then
  echo "already installed: $(ffmpeg -version | head -1)"
else
  if command -v apt-get >/dev/null 2>&1; then
    "${SUDO[@]}" apt-get update -y
    "${SUDO[@]}" apt-get install -y ffmpeg
  else
    warn "no apt-get; install ffmpeg (with libx264) manually for your OS"
    exit 1
  fi
fi

# 2 · wasm-pack — drives `pnpm wasm:build`.
log "wasm-pack"
if command -v wasm-pack >/dev/null 2>&1; then
  echo "already installed: $(wasm-pack --version)"
else
  if ! command -v cargo >/dev/null 2>&1; then
    warn "cargo not found — install the Rust toolchain first"
    exit 1
  fi
  cargo install wasm-pack --locked
fi

# 3 · pnpm workspace dependencies. Cheap no-op if the lockfile is fresh.
log "pnpm install"
pnpm install

# 4 · WASM bundle. Skip if the bindings output already exists; it's a
# ~1.5 minute build on a cold cache.
log "wasm:build"
if [[ -f apps/web/src/wasm/wasm_bindings_bg.wasm ]]; then
  echo "already built: apps/web/src/wasm/wasm_bindings_bg.wasm"
else
  pnpm wasm:build
fi

# 5 · Python deps for the fixture generator. PEP 668 systems require
# --break-system-packages; older pips don't recognise the flag, so try
# the plain install first and fall back.
log "python deps (numpy, mcap, asammdf)"
if python3 -c "import numpy, mcap, asammdf" >/dev/null 2>&1; then
  echo "already installed"
else
  if ! pip3 install numpy mcap asammdf 2>/dev/null; then
    pip3 install --break-system-packages numpy mcap asammdf
  fi
fi

# 6 · Generate the corpus the Playwright fixtures depend on. Skip if
# both binary outputs are already present (mf4 + sidecar timestamps are
# committed; mcap and mp4 are gitignored).
log "sample-data fixtures"
if [[ -s sample-data/short.mcap && -s sample-data/short.zstd.mcap && -s sample-data/short.mp4 ]]; then
  echo "already generated"
else
  python3 sample-data/generate.py
fi

# 6b · Broken-decode mp4 fixture for decodeAwareCursor.spec.ts. Patched
# from short.mp4 (NAL payloads XOR'd) so the container parses but every
# decode() errors — the "decoder alive, producing nothing" state the
# cursor-gating tests need. Gitignored like the other generated mp4s, so
# regenerate it whenever short.mp4 exists but the broken pair doesn't.
log "broken-decode mp4 fixture"
if [[ -s sample-data/short.broken.mp4 && -s sample-data/short.broken.mp4.timestamps ]]; then
  echo "already generated"
elif [[ -s sample-data/short.mp4 ]]; then
  python3 scripts/video/make_broken_decode_mp4.py \
    sample-data/short.mp4 sample-data/short.broken.mp4
  cp sample-data/short.mp4.timestamps sample-data/short.broken.mp4.timestamps
else
  warn "sample-data/short.mp4 missing — skipping broken-decode fixture"
fi

# 7 · Playwright's chromium. The CLI is idempotent on its own, so we
# always run it.
log "playwright chromium"
pnpm --filter e2e exec playwright install chromium

log "done"
echo "Run the test suites:"
echo "  pnpm --filter web build"
echo "  pnpm --filter web test --run"
echo "  pnpm --filter e2e test"
