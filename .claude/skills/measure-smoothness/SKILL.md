---
description: Measure how SMOOTH video playback actually is on the decode-worker path, with all the frame-pacing metrics (jitter, p95/max dwell, repeats/rushed, playback-rate, blit-clock tick-gap health, re-anchors, player-vs-source judder, and frame loss). Delegates the run+score to a subagent. Use when the user asks to "measure the smoothness", "is playback smooth", "check frame pacing/judder/cadence", "get the smoothness numbers", or wants a hard pass/fail on the video hot path after a decode/blit/playback change. Spec-agnostic: scores any Playwright run that logs a `PACING {json}` line from the video dev hooks.
allowed-tools: Agent AskUserQuestion SendUserFile Read Bash(node *) Bash(ls *) Bash(cat *)
---

# measure-smoothness

A **hard, source-aware smoothness number** for Driveline's video hot path —
not a vibe check. The decode worker (`videoDecode.worker.ts`) already
instruments its own frame pacing into a `CadenceSummary`; this skill drives a
playback run, samples that telemetry through the dev hooks, and scores it
against the worker's *own* smoothness thresholds.

The heavy run is **delegated to a subagent**. The main thread stays cheap:
capture intent → dispatch one subagent → relay the scored verdict. Do **not**
run the build/fixture/Playwright pipeline in the main thread.

## What gets measured (and why it's trustworthy)

The verdict mirrors the worker's own `smooth` boolean — same thresholds,
recomputed by `scripts/score-cadence.mjs` so the skill can never drift from the
app. Components (all relative to a *self-calibrating* `idealDwellMs`, so the
clip fps need not be known up front):

| Metric | Budget | Means |
| --- | --- | --- |
| `jitterMs` (dwell stdev) | ≤ 0.25 × ideal | the headline smoothness number |
| `p95DwellMs` | ≤ 1.5 × ideal | no frame held > 50% over ideal |
| `repeats` (held ≥1.5× ideal) | ≤ 5% of paints | visible stutters / "same frame twice" |
| `playbackRateRatio` | 0.9–1.1× | running at the right speed |
| `backwardSteps` | 0 | monotonic-guard breach (must be 0) |

Plus **diagnostics that localise the cause** (not part of the verdict):

- **`playerErrStdRegularMs` vs `sourceJitterMs`** — the crucial
  disambiguation. The ~12 fps real-world captures are themselves irregular;
  this isolates *player* judder from a *steppy source*. Large player-error on
  regular-interval frames ⇒ the player is the cause; small ⇒ it's faithfully
  tracking uneven data.
- **`tickGapMaxMs` / `starvedTicks`** — 200 Hz blit-clock health. Starvation
  (worker briefly unscheduled, e.g. headless CPU contention) → capped catch-up
  rushes.
- **`resyncReanchors` / `scrubReanchors`** — clock re-anchors; a resync triggers
  a catch-up rush (the periodic single-frame-slip suspect).
- **HUD frame-loss counters** — `skipped` (source frames the cursor jumped past
  undrawn = visual frame-loss), `dropped` (decode-queue loss), `straggler`,
  `drawn`. All 0 in smooth playback.

## Step 1 — Capture intent (one line)

Pin down *which playback* to measure and *what would count as smooth*. Default
target is the **nuScenes fusion demo** (`_demo-nuscenes-fusion.spec.ts`), which
already logs a `[demo] PACING {…}` line. If the user changed the decode/blit/
playback path and wants to know whether it's smooth now, that's the intent;
the bar is the worker's own thresholds (above).

If the target is genuinely ambiguous (multiple playback specs in play, or the
user points at a different dataset), ask **one** `AskUserQuestion`. Otherwise
proceed with the nuScenes demo and say so.

## Step 2 — Dispatch the measurement subagent

Launch **one** `Agent` (`subagent_type: general-purpose`), foreground (you need
its numbers to answer). Template:

> You are measuring Driveline video-playback **smoothness** with hard numbers.
> Read `.claude/skills/measure-smoothness/SKILL.md` and follow the
> **"Measurement procedure"** section exactly:
> environment → fixtures → run the playback spec → capture the `PACING` line →
> score it with `scripts/score-cadence.mjs`.
>
> Target spec: **<SPEC, default `_demo-nuscenes-fusion.spec.ts`>**. The user's
> intent / what "smooth" must mean here: "<INTENT>".
>
> Return:
> - the **full scored report** from `score-cadence.mjs` verbatim (the table +
>   diagnostics + VERDICT line),
> - the raw `PACING {…}` JSON line you captured,
> - a one-paragraph read: SMOOTH or NOT SMOOTH, the dominant cause from the
>   diagnostics (player vs source; tick-starvation; resync rushes; frame-loss),
>   and the **environment caveat** (headless software-decode vs GPU headed),
> - any artifact paths (e.g. a recorded `.webm`) worth surfacing.

The subagent owns all heavy tools. The main thread does not re-run the
pipeline.

## Step 3 — Relay the verdict

Surface the scored table and the VERDICT plainly: is playback smooth, by the
worker's own bar? Quote the headline numbers (jitter vs budget, frame-loss),
name the dominant cause, and **always carry the environment caveat** — a
headless software-decode box with CPU contention is the worst case, not the
representative one; the same metrics on the GPU headed config
(`playwright.demo.config.ts`) are the real-world figure. If the subagent
returned a `.webm`, `SendUserFile` it. Don't paste the subagent's transcript —
relay the report and the conclusion.

---

# Measurement procedure

> **For the measurement subagent.** The main thread dispatches this; it does not
> run it. Stages are idempotent — re-run freely; skip anything already on disk.

## 1. Environment (one-shot)

```
scripts/setup-test-env.sh >/dev/null
python3 -c "import pyarrow" 2>/dev/null \
  || pip3 install --break-system-packages -q 'pyarrow>=14,<20' 'numpy>=1.24,<3'
echo "env ready"
```

Bootstraps ffmpeg, wasm-pack + the wasm bundle, Playwright's Chromium, and the
Python deps. The wasm bundle **must** be present before Playwright runs
(`pnpm wasm:build:dev` if `apps/web/src/wasm/` is empty).

## 2. Fixtures (idempotent — skip if present)

The nuScenes demo reads four files from `sample-data/realworld/`:
`nuscenes.lidar.parquet`, `nuscenes_cam_front.mp4` (+ `.mp4.timestamps`),
`nuscenes_cam_front.calib.json`, and `nuscenes.signals.mcap`. If they're
already there, **skip this stage**. To (re)build them:

```
# 4.16 GB v1.0-mini download to /tmp on a cold cache; idempotent re-runs.
python3 scripts/convert_nuscenes_to_driveline.py
python3 scripts/convert_nuscenes_signals_to_mcap.py
# then copy the four outputs from /tmp/datasets/nuscenes_demo/ into
# sample-data/realworld/  (see sample-data/realworld/README.md "nuScenes").
```

(For a different dataset, build that dataset's fixtures instead — the scoring
step is dataset-agnostic.)

## 3. Run the playback spec and capture PACING

```
cd apps/e2e && rm -rf test-results
CI=1 pnpm exec playwright test _demo-nuscenes-fusion.spec.ts \
  --project=chromium --timeout=240000 2>&1 | tee /tmp/smoothness.log
```

The spec plays through the dense/turning section, then — **while the cadence
window is still populated** (pause does not reset it; only play-start/seek do) —
samples `window.__drivelineDevHooks.videoCadence()` and `.videoHudStats()` and
logs them on a single line:

```
[demo] PACING {"cadence":{…},"hud":{…}}
```

Extract that line:

```
grep -E "\[demo\] PACING " /tmp/smoothness.log | tail -1 > /tmp/pacing.line
```

## 4. Score it

```
node .claude/skills/measure-smoothness/scripts/score-cadence.mjs /tmp/pacing.line
```

(Reads stdin too: `cat /tmp/pacing.line | node …/score-cadence.mjs`.) It prints
the scored table + diagnostics + a `VERDICT: SMOOTH | NOT SMOOTH` line, and
exits `0` smooth / `1` not smooth / `2` no cadence (null window — you sampled
after a seek; sample earlier). The PASS/FAIL set mirrors
`videoDecode.worker.ts`'s `smooth` boolean exactly.

## Reading the result — judge against intent

1. The boolean verdict is the floor. Then **read the diagnostics for the
   cause**, in this order:
   - `playerErrStdRegularMs` vs `sourceJitterMs` → is it the *player* or a
     *steppy source*? (The single most important distinction for a real-world
     12 fps capture.)
   - `resyncReanchors` > 0 and many `rushed` frames → catch-up-rush judder.
   - `starvedTicks` high, `tickGapMaxMs` large → the worker was unscheduled
     (CPU contention), not a logic defect.
   - HUD `skipped` > 0 → genuine visual frame-loss; `dropped` > 0 → the decoder
     fell behind.
2. **Environment caveat is mandatory in the report.** This skill runs the
   **headless, software-decode** Chromium under Playwright on a shared CI box —
   the *worst case* for pacing. A failing `playbackRateRatio` or high
   `starvedTicks` there can be pure environment, not a regression. For the
   representative figure, the same spec under the GPU headed config
   (`apps/e2e/playwright.demo.config.ts`, if present) is what to quote to a
   user. Report both framings; never present the headless number as "the"
   smoothness.
3. If a stage fails outright (no fixtures, spec errors before the PACING line,
   null cadence window), that's the verdict: **could not measure**, with the
   failing stage — don't guess a number.

## Measuring a DIFFERENT spec

The scorer is spec-agnostic — it scores any `{cadence, hud}` JSON. To measure
another playback spec, have it log the same line near the end of playback,
before any seek clears the window:

```ts
const pacing = await page.evaluate(() => {
  const h = window.__drivelineDevHooks!;
  return { cadence: h.videoCadence(), hud: h.videoHudStats() };
});
console.log("PACING " + JSON.stringify(pacing));
```

`videoCadence()` returns the full `CadenceSummary`; `videoHudStats()` returns
the monotonic frame-loss counters. Both are defined in
`apps/web/src/App.tsx` and published by `VideoPanel.tsx`.

## Where things live

- `scripts/score-cadence.mjs` — the scorer (thresholds mirror the worker).
- `apps/web/src/workers/videoDecode.worker.ts` — `CadenceSummary` +
  `SMOOTH_*` thresholds (source of truth — keep the scorer in lockstep).
- `apps/web/src/panels/VideoPanel.tsx` — publishes `__drivelineVideoCadence` /
  `__drivelineVideoHud` each rAF tick.
- `apps/web/src/App.tsx` — `videoCadence()` / `videoHudStats()` dev hooks.
- `apps/e2e/tests/_demo-nuscenes-fusion.spec.ts` — logs the `PACING` line.
