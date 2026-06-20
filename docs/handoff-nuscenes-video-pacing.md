# Handoff — nuScenes video pacing & the "back-and-forth" investigation

**Branch:** `claude/nuscenes-clip-smoothness-vjp1m7`
**Status:** player pacing work done & merge-ready; an *open* frame-order
("back-and-forth") issue is mid-diagnosis — almost certainly the **LiDAR
overlay**, not the decoder. Read this before continuing or merging.

---

## 1. What this branch did (the player fixes — KEEP these)

The nuScenes CAM_FRONT clip played NOT SMOOTH in the headless decode-worker
path. Root-caused and fixed, in `apps/web/src/workers/videoDecode.worker.ts`:

| Commit | Fix | Why |
| --- | --- | --- |
| `871f077` | **Pure wall-clock blit cursor** | the old slew/resync accumulator *rushed* after every starved tick (catch-up bursts) |
| `1781008` | **Removed a stale 1 s delta clamp** | with the new fixed anchor it froze the cursor at `anchor+1s` — playback died one second in |
| `202b3a8` | **Encoded-chunk prefetch ring** | the decoder starved on the reader RPC (contends with the main thread); the blit queue drained to empty → held-then-rushed judder. Now fed synchronously from a local ring; a background pump refills it |
| `b51c70c` | **Pump resumes feed after refill** | fixes a paused-seek stall the ring introduced (no blit clock when paused, so nothing re-drove the feed) |

These took `playerErrStdRegularMs` (player judder on regular-interval frames)
from **~111 ms → ~4–7 ms**. The player is now faithful. **Keep all four.**

## 2. The presentation-timing decision (real timestamps — current state)

The nuScenes source timestamps are genuinely uneven (the `.mp4.timestamps`
sidecar carries nuScenes' *real* CAM_FRONT capture times — 50/100/150 ms
intervals, `sourceJitter ~27 ms`). That alone caps dwell-jitter at ~27 ms, so
the hard SMOOTH bar can't pass on a faithful player.

- `ab3dddf` added a **constant-cadence presentation grid** (even on-screen dwell,
  real PTS kept for LiDAR sync) → it DID pass: **VERDICT SMOOTH, jitter ~11–17 ms**.
- **User then chose to stay faithful to the data**, so `1cbda6d` **reverted** the
  grid: the blit again selects/dwells against the real capture PTS.

**Current `HEAD` plays at REAL timestamps.** Verdict is NOT SMOOTH (jitter
~27 ms, rate ~1.15×) but the diagnostics confirm it's the *source*, not the
player (`playerErrStdRegular ~4 ms ≪ sourceJitter ~27 ms`). This is intentional.

> If we ever want it to *look* smoother while staying real, the clean path is
> "split present vs data-sync": drive presentation off the **mp4 container's
> even PTS** (it's already a clean ~80 ms / 12.5 fps grid, `stdev 11 ms`) while
> keeping the sidecar times for LiDAR. The grid code in `ab3dddf` is the
> reference implementation to resurrect (it remaps presPtsNs; just source the
> even grid from the container instead of an EMA).

## 3. "Video going back and forth" — RESOLVED: it's the VP8 recording, not the app

User reported the playback visibly jumps **back and forth**. Investigated with a
new model-free **frame-order** test (now in the skill, see §5) and run to ground.
**Conclusion: it is a Playwright VP8 screen-recording artifact in high-motion
regions, NOT a real playback bug.** Evidence chain:

- The detector ("does distinct frame N resemble a frame ≥2 steps back more than
  its immediate predecessor") is **validated**: the raw source mp4 scores **0%**.
- Recorded playback `.webm`: **~38–41%** back-and-forth — real *in the recording*.
- **Overlay ruled out:** a `NO_OVERLAY=1` run (overlay binding skipped,
  `projectedVisibleCount=0`) still scored **41%**. The earlier "upper region 0%
  vs road 25%" split was a false lead — the upper region was just too static
  (≈5 distinct frames) to register; the road region back-and-forths with or
  without the overlay.
- **The worker paints monotonically.** A per-blit `PAINTROW` trace showed the
  real-capture-PTS of each painted frame **strictly increasing** (0, 50, 150,
  250, 300, 400 … ms). The blit's monotonic guard (`target.ptsNs > shownPts`)
  enforces this, and frame content is tied to PTS — the decoded canvas cannot
  revert.
- **Live compositor is clean.** `page.screenshot` clips of the dashcam during
  playback (bypassing the VP8 encoder) scored ~0% (1/14 distinct = noise),
  nowhere near the recording's 41%.

So: worker/decode/blit forward-ordered ✔, live compositor clean ✔, the 41% lives
only in the **VP8-encoded `.webm`** (high-motion road region; static sky stays
clean). Any clip exported via Playwright's video recording will show it; the app
itself does not. **No code fix needed for this.** If a *visibly* perfect demo
clip is required, record via a lossless/CFR path (e.g. higher-quality VP9 / a
PNG-frame export at the true cadence) instead of Playwright's default VP8
screencast.

> NOTE: this is independent of the §2 cadence question. Even a recording-only
> artifact aside, real-timestamp playback is still NOT SMOOTH on the cadence bar
> because the source timestamps are uneven (§2) — that part is a data property,
> by design.

## 4. Cleanup owed before merge

- All temporary probes are **reverted** — the demo spec
  (`_demo-nuscenes-fusion.spec.ts`) is byte-identical to its clean pre-investigation
  state (verified `git diff 1cbda6d` is empty). No `NO_OVERLAY` / `SHOT` /
  `PAINTROW` / DBG code remains in the tree.
- Branch history still has WIP debug commits (`b15c475`, `b404fc1`, `ad2f129`,
  `37f2c55`, `872944c` — each later reverted/removed). **Squash** the branch
  before the PR so only the net change lands: the four player fixes, the
  real-timestamp presentation state, the handoff doc, and the skill additions.
- `sample-data/realworld/` fixtures are gitignored (correct) — not in the diff.

## 5. New tooling (in the measure-smoothness skill)

- `.claude/skills/measure-smoothness/scripts/score-frame-order.py` — the
  back-and-forth detector. Cadence (`score-cadence.mjs`) measures *timing* and
  is blind to *order* (`backwardSteps` is 0 by construction). ALWAYS pass
  `--control <known-forward clip>`; it must score ~0% or the crop/scale is too
  lossy. Re-run on sub-regions to localise overlay-vs-video. SKILL.md documents
  the whole workflow.

## 6. How to reproduce / measure

```
# env: scripts/setup-test-env.sh ; pnpm wasm:build:dev ; fixtures in sample-data/realworld/
cd apps/e2e && CI=1 pnpm exec playwright test _demo-nuscenes-fusion.spec.ts --project=chromium --timeout=240000 | tee /tmp/run.log
grep "\[demo\] PACING" /tmp/run.log | tail -1 > /tmp/p.line
node .claude/skills/measure-smoothness/scripts/score-cadence.mjs /tmp/p.line     # timing
# frame-order (needs a recorded .webm from test-results/ + the raw source):
python3 .claude/skills/measure-smoothness/scripts/score-frame-order.py CLIP.webm \
  --crop 792:446:8:44 --ss 4 --t 6 --control sample-data/realworld/nuscenes_cam_front.mp4
```

**Environment caveat:** all numbers above are headless software-decode under
Playwright — the worst case for pacing. The GPU-headed config is the
representative figure.
