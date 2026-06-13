---
description: ALWAYS use this skill whenever the user says "verify visually" (in any phrasing). Delegates end-to-end visual verification of Driveline's comma2k19 demo path (real-world ADAS dataset, dashcam + signals across MCAP and MF4) to a verification subagent. You capture the user's *intent* — what the change was supposed to deliver visually — hand it to the subagent, and the subagent runs the pipeline (fetch sources, build fixtures, run the Playwright specs), opens the resulting screenshots/recordings, and judges whether that intent was actually delivered. Use when the user asks to "verify visually", verify the comma2k19 demo, regenerate the demo fixtures, run the `_demo-comma2k19-video.spec.ts` Playwright tests, or visualise comma2k19 dashcam + signals end-to-end. Also use when the user asks to "rebuild the fixtures", "redo the demo", or "check the dashcam + plots still render".
allowed-tools: Agent AskUserQuestion SendUserFile Read Bash(ls *) Bash(cat *)
---

# verify-visually

Visual verification is **delegated to a subagent**. Your job in the main
thread is small and intent-focused:

1. **Capture the user's intent** — what was this change supposed to make
   visible/work? That intent is the success criterion.
2. **Dispatch one verification subagent** — hand it the intent and point
   it at the procedure below. It runs the whole pipeline, *opens the
   screenshots/recordings*, and judges whether the intent was delivered.
3. **Relay the verdict** — surface the artifacts the subagent returns and
   state plainly whether the intent was delivered, citing the visual
   evidence.

Do **not** run the fetch/build/test pipeline yourself in the main thread.
That work, and the visual judgement, belongs to the subagent. The main
thread stays cheap so its context isn't flooded by build/test output.

---

## Step 1 — Capture the user's intent

The intent is a concrete, checkable visual claim — the thing the
subagent must confirm is true on screen. Derive it from the conversation:
what did the user just build, change, or fix, and what should now be
visible in the app?

Phrase it as a verifiable statement, e.g.:

- "The steering-angle trace renders and stays aligned with the video
  cursor as it scrubs."
- "Both dashcams in the 6-panel dashboard show the *correct* frame after
  each jump (no frozen/stale canvas)."
- "Adding the MF4 source draws a second line on the shared plot rather
  than blanking the panel."

If you genuinely cannot infer a specific intent from context (e.g. the
user said only "verify visually" with nothing prior), ask **one**
`AskUserQuestion` to pin down what the verification should confirm. If
the user has no specific intent, fall back to this default intent and
say you're using it:

> The comma2k19 demo path renders dashcam video synchronised with the
> signal plots across MCAP + MF4, every panel paints real content (no
> blank/broken panels), and replay/jump latency stays within the
> documented baselines.

Keep the intent tight enough that "delivered / not delivered" is
answerable from the screenshots and the per-jump numbers.

## Step 2 — Dispatch the verification subagent

Launch **one** subagent with the `Agent` tool (`subagent_type:
general-purpose`). Give it the intent verbatim and tell it to follow the
procedure in this file. Template:

> You are verifying a Driveline change visually. **The user's intent — the
> thing you must confirm was actually delivered — is:**
>
> "<INTENT, verbatim>"
>
> Read `.claude/skills/verify-visually/SKILL.md` and follow the
> **"Verification procedure"** section exactly (environment → fetch →
> build fixtures → run the screenshot specs → run the replay/perf specs).
> Then **open every relevant screenshot and the per-jump montage with the
> `Read` tool and look at them**, and read the per-jump stdout numbers
> against the "Replay latency findings" baselines.
>
> Judge **against the intent above** — not just "did the tests pass". A
> green test run with a blank panel, a stale frame, or a missing trace is
> a FAIL if the intent says that content should be visible.
>
> Return a structured verdict:
> - **VERDICT:** delivered / partially delivered / not delivered
> - **Evidence:** which specific screenshots/recordings/numbers support
>   the verdict, described in terms of what you actually saw.
> - **Artifacts to surface:** absolute paths of the PNGs / `.webm`s /
>   montage the main thread should send to the user.
> - **Anything off-baseline or broken**, even if tangential to the intent.

The subagent owns all the heavy tools (Bash/pnpm/python/ffmpeg, plus
`Read` for looking at images). The main thread does not re-run any of it.

Run the subagent in the foreground unless the user asked to keep working
in parallel — you need its verdict to respond.

## Step 3 — Relay the verdict and surface artifacts

When the subagent returns:

1. `SendUserFile` the artifact paths it listed (the screenshot PNGs, any
   `.webm` recordings, the jump-frames montage). These are the
   deliverable — the user needs to see them.
2. State the verdict plainly: **was the intent delivered?** Quote the
   intent, then give the answer and the specific visual evidence for it.
   If it was *not* delivered, say exactly what was missing or wrong.
3. Pass along any off-baseline latency or broken-panel notes the subagent
   flagged, even if they're outside the stated intent.

Don't paste the subagent's whole transcript — relay the conclusion and
the evidence that backs it.

---

# Verification procedure

> **This section is for the verification subagent.** If you are the main
> thread, do not run it — dispatch a subagent (see Step 2). Run cold
> (fresh container) and warm (skip anything already on disk). Parallelise
> every step that is independent. After running, you must **open the
> screenshots/recordings and judge them against the user's intent** (see
> "Judge against intent" at the end).

## What the demo path exercises

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

Each stage is idempotent. Re-run freely.

### 1. Environment (one-shot, ~2 min on cold cache)

```
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

```
.claude/skills/verify-visually/scripts/fetch-sources.sh
```

Downloads two files concurrently into `${DRIVELINE_DATASETS_DIR:-/tmp/datasets}`:

- `comma2k19_demo.parquet` — 78 MB, signals for 22 segments.
- `video_seg10.hevc` — 36 MB, dashcam for segment 10.

Verifies the parquet SHA256 against `sample-data/EXPECTED_HASHES.txt`
when an entry exists.

### 3. Build fixtures (parallel, ~10 s warm cache)

```
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

```
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

```
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

Scope the run to the intent when it makes sense: if the intent only
concerns, say, the MCAP+MF4 plot, you can `-g "MCAP and MF4 together"`
to iterate fast — but a clean final verdict should still run the full
set so a regression elsewhere doesn't hide.

### 5. Collect the screenshots + recordings

The screenshot specs write into `apps/e2e/tests/screenshots/`. The
replay/perf specs write a per-test `video.webm` under
`apps/e2e/test-results/<test-dir>/`, and the frame spec writes per-jump
canvases to `/tmp/jumpframes/`. For the frame spec, build a contact
sheet of the captured cams so the "correct frame per jump" claim is
eyeball-checkable, e.g.:

```
ffmpeg -v error -framerate 1 -pattern_type glob \
  -i '/tmp/jumpframes/jump*-cam*.png' \
  -vf 'scale=400:-1,tile=2x5:padding=4:color=white' \
  -frames:v 1 /tmp/jf_cams_montage.png -y
```

The five screenshot filenames are listed in the stage-4 table.

## Judge against intent (the point of this run)

A passing test run is **necessary but not sufficient**. Now actually
**look**:

1. `Read` each screenshot the run produced (and the jump-frames montage).
   Describe what is actually on screen — panels painted? traces drawn?
   video frame present and plausibly the right moment? cursor aligned?
2. Read the per-jump stdout numbers against "Replay latency findings".
3. Hold all of that against **the user's intent**. The intent is the bar:
   - If the intent says a trace/panel/frame should be visible and it is →
     evidence toward "delivered".
   - If a spec is green but the relevant pixels are blank, stale, or
     wrong → **not delivered**, regardless of the green check.
4. Form the verdict (delivered / partially delivered / not delivered),
   cite the specific screenshots/numbers, and list the absolute artifact
   paths for the main thread to surface.

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

If a stage fails outright (can't fetch, can't build, specs error before
producing screenshots), that is itself a verdict input: report **not
delivered — could not verify**, with the failing stage and error, rather
than guessing.

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
</content>
</invoke>
