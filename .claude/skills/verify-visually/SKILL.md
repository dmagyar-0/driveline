---
description: ALWAYS use this skill whenever the user says "verify visually" (in any phrasing). End-to-end visual verification of Driveline's comma2k19 demo path (real-world ADAS dataset, dashcam + signals across MCAP and MF4): fetch the public sources, build the fixtures, run the Playwright specs, and surface the screenshots/recordings. Use when the user asks to "verify visually", verify the comma2k19 demo, regenerate the demo fixtures, run the `_demo-comma2k19-video.spec.ts` Playwright tests, or visualise comma2k19 dashcam + signals end-to-end. Also use when the user asks to "rebuild the fixtures", "redo the demo", or "check the dashcam + plots still render".
allowed-tools: Bash(scripts/setup-test-env.sh*) Bash(.claude/skills/verify-visually/scripts/*) Bash(pnpm *) Bash(python3 *) Bash(ls *) Bash(cat *) Bash(ffmpeg *) Bash(ffprobe *)
---

# verify-visually

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

Plus four **replay / performance** specs that drive playback (press
Play, then seek forward by progressively larger intervals) and, for most
of them, record the running app to a `.webm` — not just screenshots.
These need the second-camera fixture (`comma2k19_rear.mp4`, built in
stage 3):

6. `_demo-comma2k19-replay-record.spec.ts` — dashcam + one plot bound to
   five m/s speed signals. Records the replay across the jumps.
7. `_demo-comma2k19-dashboard-record.spec.ts` — dense 6-panel dashboard:
   **two** dashcams (front + the hflip mirror) stacked left, a 2×2 plot
   grid right carrying 16 signals across MCAP + MF4. Same recording.
8. `_demo-comma2k19-jump-latency.spec.ts` — no recording; quantifies, per
   jump, the decode **catch-up to live** and the residual cursor→blit
   **lag** via the readiness + blit-PTS dev hooks. Asserts catch-up
   finishes inside the timeout.
9. `_demo-comma2k19-jump-frames-record.spec.ts` — recording **on**; after
   each jump it scrubs (paused) to force a re-seek, confirms each cam is
   on the **correct cursor frame** (front-cam frame index strictly
   increases across jumps; both cams agree within a frame), screenshots
   each video canvas to `/tmp/jumpframes/`, and separately times catch-up
   + play drift. See "Replay latency findings" below for the baselines.

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
.claude/skills/verify-visually/scripts/fetch-sources.sh
```

Downloads two files concurrently into `${DRIVELINE_DATASETS_DIR:-/tmp/datasets}`:

- `comma2k19_demo.parquet` — 78 MB, signals for 22 segments.
- `video_seg10.hevc` — 36 MB, dashcam for segment 10.

Verifies the parquet SHA256 against `sample-data/EXPECTED_HASHES.txt`
when an entry exists.

### 3. Build fixtures (parallel, ~10 s warm cache)

```!
.claude/skills/verify-visually/scripts/build-fixtures.sh
```

12 converter runs plus the ffmpeg transcode all fire concurrently as
bash background jobs (each is independent — they read the same parquet
but write to different output files). The backgrounded transcode also
emits the second camera. Outputs land in `sample-data/realworld/`:

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
| video  | `comma2k19_rear.mp4` (+ `.timestamps`) | hflip re-encode of seg10, reuses the sidecar (second camera for specs 7–9) |

Cohorts:
- A — single-file backwards-compatible outputs (tests 1, 2).
- B — `--only` topic split of segment 10 (tests 4, 5).
- C — per-segment-offset files for segments 4 / 7 / 10 (test 3).
- video — the front dashcam plus a horizontally-flipped second camera.
  comma2k19's public demo ships only one real camera, so `comma2k19_rear.mp4`
  stands in as a second feed for the multi-video specs (7–9). It is an
  hflip re-encode of the front mp4 with identical fps/GOP/pix_fmt (so
  WebCodecs still decodes it) and reuses the front sidecar verbatim, so
  the two cameras stay time-aligned on the unified clock.

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

Then run the **replay / performance** specs — a full validation must
include these (they exercise playback, multi-video decode, jump
latency, and frame correctness, none of which the screenshot specs
cover):

```!
pnpm --filter e2e exec playwright test \
  _demo-comma2k19-replay-record.spec.ts \
  _demo-comma2k19-dashboard-record.spec.ts \
  _demo-comma2k19-jump-latency.spec.ts \
  _demo-comma2k19-jump-frames-record.spec.ts \
  --project=chromium --reporter=list
```

These are slower (the dashboard + frame specs record video and run
~30–60 s each). They are underscore-prefixed so normal CI skips them;
this skill is where they get run. `_demo-comma2k19-jump-latency.spec.ts`
and `_demo-comma2k19-jump-frames-record.spec.ts` log per-jump numbers
(`JUMP→…`, `SUMMARY …`, `FRAMES_JSON=…`) to stdout — read those against
the baselines in "Replay latency findings".

### 5. Surface the screenshots + recordings

The screenshot specs write into `apps/e2e/tests/screenshots/`. The
replay/perf specs write a per-test `video.webm` under
`apps/e2e/test-results/<test-dir>/`, and the frame spec writes per-jump
canvases to `/tmp/jumpframes/`. After the run, send the relevant PNG(s)
and webm(s) to the user with `SendUserFile`. For the frame spec, build a
contact sheet of the captured cams first so the "correct frame per jump"
claim is eyeball-checkable, e.g.:

```
ffmpeg -v error -framerate 1 -pattern_type glob \
  -i '/tmp/jumpframes/jump*-cam*.png' \
  -vf 'scale=400:-1,tile=2x5:padding=4:color=white' \
  -frames:v 1 /tmp/jf_cams_montage.png -y
```

The five screenshot filenames are listed in the stage-4 table.

## Replay latency findings

Measured on the dense dashboard (two dashcams + four plots, 16 signals,
1× playback) with specs 8 and 9. Use these as regression baselines —
flag a run that is materially worse.

**Interactive (spec 8, no page recording):**
- Catch-up to live after a jump: **mean ~0.4 s** (range ~0.26–0.59 s).
- Steady cursor→blit lag once live: **~0.2 s median** (p95 ~0.35 s,
  occasional ~0.6 s spike).
- Catch-up is **independent of jump size** — the pipeline is ranged and
  seeks to the nearest keyframe near the target, so a 16 s jump is no
  slower than a 5 s one. A regression here usually means seeking went
  non-lazy.

**With page recording (spec 9, heavy — 2-cam decode + page capture):**
- Catch-up: **0.67–4.2 s**; play drift median **~0.3–1.0 s**.
- i.e. recording the page roughly **triples** the interactive numbers.
  Report recorded-run latency as "heavy-overhead", not the real
  interactive figure.

**Frame correctness (spec 9):**
- A paused scrub lands on the **correct cursor frame**: front-cam frame
  index strictly increases across the jumps (observed 119 → 261 → 482 →
  779 → 1081) and both cameras agree within ±1 frame.
- Residual seek frame-lag is mostly **< 200 ms** (as tight as ~18 ms
  once the paused seek fully settles).
- Caveat: lag is measured via the readiness/blit-PTS dev hooks, so it is
  an **upper bound** on the true visual error (it includes one frame
  period @ 20 fps plus rAF-snapshot timing). For a stricter check,
  pixel-diff the captured canvas against the source frame decoded offline.

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
- **`comma2k19_rear.mp4` missing** — the replay/perf specs (7–9) skip
  themselves when it's absent. Re-run `build-fixtures.sh`; the rear
  camera is built by the backgrounded transcode after the front mp4.
- **Playwright test "Cannot call 'decode' on a closed codec" / "VideoDecoder
  error: EncodingError"** — benign noise from the first VideoDecoder
  init when a tab swap fires before configure completes. Tests still pass.
- **Recorded-run latency looks bad** — that's expected; page capture
  steals CPU from the decoders. Cross-check against spec 8 (no recording)
  before treating it as a regression.
- **Status line shows wrong source count** — clear the persisted
  layout: in the dev hooks evaluate
  `window.__drivelineDevHooks.clearSession()` then
  `resetLayout()`. The spec's `beforeEach` already does this.

## Where things live (when you need to edit)

- `scripts/convert_comma2k19_to_mcap.py` — MCAP converter (`--only`,
  `--segment-index`, `--segment-offset-seconds`).
- `scripts/convert_comma2k19_to_mf4.py` — MF4 converter (same flags
  minus `--compression`).
- `apps/e2e/tests/_demo-comma2k19-video.spec.ts` — the five screenshot tests.
- `apps/e2e/tests/_demo-comma2k19-replay-record.spec.ts` — replay recording.
- `apps/e2e/tests/_demo-comma2k19-dashboard-record.spec.ts` — 6-panel dashboard.
- `apps/e2e/tests/_demo-comma2k19-jump-latency.spec.ts` — jump latency numbers.
- `apps/e2e/tests/_demo-comma2k19-jump-frames-record.spec.ts` — per-jump frame check.
- `sample-data/realworld/README.md` — operator-facing recipe for the
  whole pipeline.
- `apps/e2e/tests/screenshots/comma2k19-*.png` — last-good outputs;
  committed so a regression shows up in the diff.

## Conventions to preserve

- Don't anchor multiple segments at the same wall-clock. Pass
  `--segment-offset-seconds N` to put segment N at `N*60` past the
  drive start, otherwise the unified timeline stacks them on top of
  each other.
- Don't transcode H.265 — the WebCodecs path is `avc1.*` only. The rear
  camera mirrors the front's H.264 encode params for the same reason.
- Don't commit `sample-data/realworld/*.{mcap,mf4,mp4,timestamps}` —
  they're gitignored. Commit screenshots and converter changes only.
- The mp4 + sidecar pair counts as one source in the status bar.
  When asserting `listSources().length`, factor that in.
