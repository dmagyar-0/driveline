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

## 3. OPEN ISSUE — "video going back and forth"

User reports the playback visibly jumps **back and forth**. Investigated with a
new model-free **frame-order** test (now in the skill, see §5). Findings:

- Built a "does frame N resemble a frame ≥2 steps back more than its immediate
  predecessor" detector. **Validated**: the raw source mp4 scores **0%**.
- Recorded playback `.webm`: **~38–41%** back-and-forth — REAL, confirmed.
- **Localised:** upper frame (sky/buildings, **no overlay**) = **0%**; road
  region (**heavy LiDAR overlay**) = **~25%**.
- **The video is monotonic.** The worker draws the whole frame in one
  `drawImage` with one PTS, so if the buildings region is forward-ordered the
  road is too. ⇒ the back-and-forth is the **LiDAR overlay drawn on top**, OR a
  VP8 screen-recording artifact in high-motion regions.

### Where I stopped
Running two confirmations (results not yet folded in here):
1. **Live-compositor screenshots** via `page.screenshot` during playback
   (bypasses the VP8 encoder) — temporary probe added to the demo spec
   (`37f2c55`, **must be reverted**). If live screenshots are clean → it was a
   recording artifact and the app is fine. If they show back-and-forth → real
   overlay bug.
2. **No-overlay run**: skip `setVideoOverlayBinding` (spec lines ~302–310) +
   its `projectedVisibleCount>0` gate, then re-score frame-order and capture the
   video. Back-and-forth vanishing = definitive proof it's the overlay.

### Next steps for the overlay (if confirmed)
The overlay is drawn on the **main thread** in `apps/web/src/panels/VideoPanel.tsx`
(`setVideoOverlayBinding` → projects the LIDAR_TOP point cloud via the
calibration). Suspect: the overlay redraw picks a LiDAR sweep / uses a cursor or
`blitPtsNs` that isn't monotonic with the video blit, so the projected points
flicker between sweeps. Check the overlay's rAF redraw vs the blit `blitPtsNs`
(now the real capture PTS again after `1cbda6d`) and make the overlay's chosen
sweep monotonic with the displayed frame.

## 4. Cleanup owed before merge

- **Revert the screenshot probe** (`37f2c55`) — temporary, do not ship.
- Branch history has WIP debug commits (`b15c475`, `b404fc1` — already removed
  by `04bd1c0`; `ad2f129` — reverted by `6f183cf`). **Squash** the branch before
  the PR so only the four player fixes + the real-timestamp state + the skill
  changes land.
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
