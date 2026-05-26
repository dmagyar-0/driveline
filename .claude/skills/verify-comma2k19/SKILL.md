---
description: End-to-end verification of Driveline's comma2k19 demo path (real-world ADAS dataset, dashcam + signals across MCAP and MF4). Use when the user asks to verify the comma2k19 demo, regenerate the demo fixtures, run the `_demo-comma2k19-video.spec.ts` Playwright tests, or visualise comma2k19 dashcam + signals end-to-end. Also use when the user asks to "rebuild the fixtures", "redo the demo", or "check the dashcam + plots still render".
allowed-tools: Bash(scripts/setup-test-env.sh*) Bash(.claude/skills/verify-comma2k19/scripts/*) Bash(pnpm *) Bash(python3 *) Bash(ls *) Bash(cat *)
---

# verify-comma2k19

End-to-end verification that the comma2k19 demo path still works: fetch
the public sources, build every fixture, run the Playwright specs, and
surface the screenshots. Designed to run cold (fresh container) and
warm (skip anything already on disk). Parallelises every step that is
independent.

## What this verifies

The five tests in `apps/e2e/tests/_demo-comma2k19-video.spec.ts`:

1. **video + speed/steering plot** — dashcam MP4 + sidecar + MCAP.
2. **MCAP + MF4 on one plot** — adds `comma2k19.mf4`, binds `/vehicle/speed`
   (MCAP) and `WheelSpeedFL` (MF4) to the same panel.
3. **3 MCAPs + 3 MF4s across 2 panels** — per-segment files for seg
   4 / 7 / 10 with `--segment-offset-seconds`, two side-by-side plots.
4. **split one segment across 4 files on 2 panels** — chassis/wheels
   MCAPs + IMU/GNSS MF4s built with `--only`, two plot panels.
5. **same split + dashcam in a 3-panel layout** — adds the video back.

## Stages — run in this order

Each stage is idempotent. Re-run the whole skill freely.

### 1. Environment (one-shot, ~2 min on cold cache)

```!
scripts/setup-test-env.sh >/dev/null
python3 -c "import pyarrow" 2>/dev/null \
  || pip3 install --break-system-packages -q 'pyarrow>=14,<20'
echo "env ready"
```

Bootstraps ffmpeg, wasm-pack + the wasm bundle, the synthetic short
fixtures, Playwright's Chromium, and the Python deps (`numpy`, `mcap`,
`asammdf`). The follow-up `pyarrow` line is the only comma2k19-specific
addition; everything else is shared with `pnpm test`.

### 2. Fetch upstream sources (parallel, ~5–15 s warm cache)

```!
.claude/skills/verify-comma2k19/scripts/fetch-sources.sh
```

Downloads two files concurrently into `${DRIVELINE_DATASETS_DIR:-/tmp/datasets}`:

- `comma2k19_demo.parquet` — 78 MB, signals for 22 segments.
- `video_seg10.hevc` — 36 MB, dashcam for segment 10.

Verifies the parquet SHA256 against `sample-data/EXPECTED_HASHES.txt`
when an entry exists.

### 3. Build fixtures (parallel, ~10 s warm cache)

```!
.claude/skills/verify-comma2k19/scripts/build-fixtures.sh
```

12 converter runs plus the ffmpeg transcode all fire concurrently as
bash background jobs (each is independent — they read the same parquet
but write to different output files). Outputs land in
`sample-data/realworld/`:

| Cohort | File                              | Converter flags                                |
| ------ | --------------------------------- | ---------------------------------------------- |
| A      | `comma2k19.mcap`                  | full segment 10, all groups                    |
| A      | `comma2k19.mf4`                   | full segment 10, all groups                    |
| B      | `comma2k19_chassis.mcap`          | `--only speed,steering_angle`                  |
| B      | `comma2k19_wheels.mcap`           | `--only wheel_speed`                           |
| B      | `comma2k19_imu.mf4`               | `--only accel,gyro`                            |
| B      | `comma2k19_gnss.mf4`              | `--only gnss`                                  |
| C      | `comma2k19_seg{4,7,10}.mcap`      | `--segment-index N --segment-offset-seconds M` |
| C      | `comma2k19_seg{4,7,10}.mf4`       | same                                           |
| video  | `comma2k19_seg10.mp4`             | ffmpeg HEVC -> H.264, 20 fps, GOP 20           |
| video  | `comma2k19_seg10.mp4.timestamps`  | one line per frame, anchored to segment start  |

Cohorts:
- A — single-file backwards-compatible outputs (tests 1, 2).
- B — `--only` topic split of segment 10 (tests 4, 5).
- C — per-segment-offset files for segments 4 / 7 / 10 (test 3).

### 4. Run the e2e specs (Playwright handles parallel)

```!
pnpm --filter e2e exec playwright test \
  _demo-comma2k19-video.spec.ts --project=chromium --reporter=list
```

Playwright defaults to one worker per CPU. The spec runs cleanly in
parallel because each `test.beforeEach` calls `resetLayout()` +
`clearSession()`. If you only want one of the five tests, append
`-g "<grep substring>"`:

| Test name fragment                | What it screenshots                                   |
| --------------------------------- | ----------------------------------------------------- |
| `video frame alongside`           | `comma2k19-video-plus-signals.png`                    |
| `MCAP and MF4 together`           | `comma2k19-mcap-plus-mf4.png`                         |
| `two side-by-side panels`         | `comma2k19-multi-segment-multi-panel.png`             |
| `splits one segment across 4`     | `comma2k19-split-by-topic.png`                        |
| `video across 3 panels`           | `comma2k19-split-by-topic-with-video.png`             |

### 5. Surface the screenshots

The specs write into `apps/e2e/tests/screenshots/`. After the run, send
the relevant PNG(s) to the user with `SendUserFile` so they can see
the result. The five filenames are listed above.

## Parallelism cheat sheet

Everything that can run concurrently does. Knobs:

- `DRIVELINE_DATASETS_DIR=path` — change where the upstream sources
  cache (default `/tmp/datasets`).
- `PLAYWRIGHT_WORKERS=N` — Playwright's per-worker concurrency
  (default: one per CPU). Pass via `--workers N` if Playwright doesn't
  pick up the env var on your platform.
- `pnpm --filter e2e exec playwright test --project=chromium -j N` —
  override worker count for one run.

## When a stage fails

- **Network 4xx/5xx from HuggingFace** — `fetch-sources.sh` uses `-fL
  --retry 4`. If it still fails, hit the URL with `curl -I` to see
  whether the path moved.
- **SHA256 mismatch on the parquet** — upstream resharded. Update
  `sample-data/EXPECTED_HASHES.txt` after auditing the new hash.
- **ffmpeg "no such filter"** — re-run `scripts/setup-test-env.sh`;
  the Ubuntu package usually includes libx264 but a container without
  apt access can miss it.
- **Playwright test "Cannot call 'decode' on a closed codec"** — that
  console error is benign noise from the first VideoDecoder init when
  a tab swap fires before the configure completes. Tests still pass.
- **Status line shows wrong source count** — clear the persisted
  layout: in the dev hooks evaluate
  `window.__drivelineDevHooks.clearSession()` then
  `resetLayout()`. The spec's `beforeEach` already does this.

## Where things live (when you need to edit)

- `scripts/convert_comma2k19_to_mcap.py` — MCAP converter (`--only`,
  `--segment-index`, `--segment-offset-seconds`).
- `scripts/convert_comma2k19_to_mf4.py` — MF4 converter (same flags
  minus `--compression`).
- `apps/e2e/tests/_demo-comma2k19-video.spec.ts` — the five tests.
- `sample-data/realworld/README.md` — operator-facing recipe for the
  whole pipeline.
- `apps/e2e/tests/screenshots/comma2k19-*.png` — last-good outputs;
  committed so a regression shows up in the diff.

## Conventions to preserve

- Don't anchor multiple segments at the same wall-clock. Pass
  `--segment-offset-seconds N` to put segment N at `N*60` past the
  drive start, otherwise the unified timeline stacks them on top of
  each other.
- Don't transcode H.265 — the WebCodecs path is `avc1.*` only.
- Don't commit `sample-data/realworld/*.{mcap,mf4,mp4,timestamps}` —
  they're gitignored. Commit screenshots and converter changes only.
- The mp4 + sidecar pair counts as one source in the status bar.
  When asserting `listSources().length`, factor that in.
