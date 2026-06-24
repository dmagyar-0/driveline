---
name: demo-video
description: Produce Driveline's shareable nuScenes camera+LiDAR fusion demo video and embed it in the README so it autoplays on GitHub. Use when the user asks to "create/make/regenerate the demo video", "record the fusion demo", "update the README demo", "make a demo GIF", or wants the autoplaying clip on the repo homepage refreshed. Covers the full pipeline: convert + record (delegated to sample-data/realworld/README.md), trim the .webm to one continuous take, build a size-budgeted autoplaying GIF, host it as a GitHub attachment, and wire it into README.md — plus the CC BY-NC-SA licence and gitignore rules that keep the NC artefacts out of git.
allowed-tools: Read Edit SendUserFile AskUserQuestion Bash(python3 *) Bash(pnpm *) Bash(ffmpeg *) Bash(ffprobe *) Bash(gifsicle *) Bash(apt-get *) Bash(find *) Bash(cp *) Bash(ls *) Bash(git *)
---

# demo-video — record the fusion demo and make it autoplay on GitHub

Driveline's homepage demo is the **nuScenes v1.0-mini scene-0061 camera +
LiDAR fusion** clip: CAM_FRONT dashcam with the LiDAR point cloud projected
on, the same spin in the 3D Scene panel, and the ego speed/yaw-rate plot — one
continuous forward take on a single synchronised timeline.

This skill takes you from raw dataset to an **autoplaying loop embedded in
`README.md`**. The convert + record + trim steps are authoritatively
documented and kept in sync in
[`sample-data/realworld/README.md`](../../../sample-data/realworld/README.md)
(section **"Recording the fusion demo video"**) — this skill defers to it for
those and owns the part that lives nowhere else: turning the clip into a GIF
that GitHub will actually autoplay, hosting it, and wiring it into the README.

## The one rule that drives everything: GitHub won't autoplay `<video>`

GitHub **strips `autoplay`/`loop` from `<video>` in rendered READMEs** and
always shows a play button. There is no markup that makes an MP4 autoplay
there. A **GIF embedded with `![alt](url)` autoplays and loops natively.** So
the homepage demo must ship as a GIF, even though the source is an MP4.

## The NC-licence guardrail (do not skip)

The recording is a derivative of nuScenes → **CC BY-NC-SA 4.0**: attribute
Motional, keep it non-commercial, share-alike. Consequences this skill must
honour:

- **Never commit the MP4 or GIF.** They are gitignored (`.gitignore`, the
  "Shareable demo video/GIF" block). Only the GitHub-attachment **URL** and the
  README text are committed. After producing artefacts, run
  `git status --porcelain` and confirm no `*fusion*` binary is staged.
- **Host the GIF as a GitHub attachment**, not in the repo — drag-drop upload
  (see step 3). If a new artefact filename is introduced, add it to that
  gitignore block in the same change.
- Keep the attribution/licence line in the README next to the embed.

## Pipeline

### 1. Produce the loop MP4 (delegated)

Follow **`sample-data/realworld/README.md` → "Recording the fusion demo
video"** verbatim: it converts geometry + signals, records the Playwright spec
(`apps/e2e/tests/_demo-nuscenes-fusion.spec.ts`), trims the `.webm` to the
continuous-playback span using the `[demo] TRIM_WINDOW ...` log line, and (step
4 there) produces the **seamless-loop** variant `driveline-nuscenes-fusion-loop.mp4`.
Use that loop MP4 as the input below. Don't duplicate those commands here — if
they drift, fix the README and this skill points at the fix.

Sanity per that README: first frame and last frame are both live painted
fusion frames (neither black), no mid-video jump cut.

### 2. Build a size-budgeted autoplaying GIF

GitHub's attachment cap for images/GIFs is **10 MB**, and the GIF auto-loads on
every README view, so keep it lean. Downscale + drop fps + palette-optimise,
then lossy-compress with `gifsicle`. Tuned defaults (≈6 MB, the recommended
balance): **800 px wide, 10 fps, lossy 80**.

```sh
command -v gifsicle >/dev/null || sudo apt-get install -y gifsicle

SRC=driveline-nuscenes-fusion-loop.mp4      # the seamless-loop MP4 from step 1
W=800; FPS=10                                # 900/12 is sharper but ~8.8 MB

ffmpeg -y -v error -i "$SRC" \
  -vf "fps=${FPS},scale=${W}:-1:flags=lanczos,palettegen=stats_mode=diff" /tmp/pal.png
ffmpeg -y -v error -i "$SRC" -i /tmp/pal.png \
  -lavfi "fps=${FPS},scale=${W}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  /tmp/base.gif
gifsicle -O3 --lossy=80 --colors 200 /tmp/base.gif -o driveline-nuscenes-fusion-loop.gif

ls -lh driveline-nuscenes-fusion-loop.gif    # confirm < 10 MB
```

If it lands over ~9 MB, drop to `W=720`/`FPS=10` or raise `--lossy` before
sacrificing the seamless loop. Don't trim the clip just to fit — the loop is
the point.

### 3. Host it as a GitHub attachment (the one manual step)

You cannot mint an attachment URL from tools — only the user can. Send them the
GIF and ask them to upload it:

1. `SendUserFile` the `driveline-nuscenes-fusion-loop.gif`.
2. Tell them: drag it into any GitHub PR/issue comment box (no need to submit) →
   GitHub inserts a `https://github.com/user-attachments/assets/<uuid>` URL.
3. They paste that URL back.

### 4. Embed in README.md

Replace the `## Demo` body with a GIF embed (markdown `![...]()`, **not**
`<video>`), keeping the explanatory comment, caption, reproduce link, and
licence line:

```markdown
## Demo

<!-- Embedded as a GIF (not <video>): GitHub strips autoplay/loop from <video>
     in rendered READMEs and shows a play button, whereas a GIF autoplays and
     loops on its own. The clip is CC BY-NC-SA 4.0 (nuScenes) so it is hosted
     as a GitHub attachment, NEVER committed (see sample-data/realworld/README.md).
     To refresh: regenerate the GIF per that README, drag it into any GitHub
     comment box, and swap the URL. -->

![Camera + LiDAR fusion replay on nuScenes scene-0061](https://github.com/user-attachments/assets/<uuid>)

Camera + LiDAR **fusion** on nuScenes v1.0-mini scene-0061: the CAM_FRONT
dashcam with the LiDAR point cloud projected onto it, the same spin in the 3D
scene panel, and the ego speed / yaw-rate plot — all on one synchronised
timeline. Produced by
[`apps/e2e/tests/_demo-nuscenes-fusion.spec.ts`](./apps/e2e/tests/_demo-nuscenes-fusion.spec.ts)
(see [`sample-data/realworld/README.md`](./sample-data/realworld/README.md) to
reproduce it).

<sub>Data: nuScenes v1.0-mini scene-0061 © Motional, licensed CC BY-NC-SA 4.0 — non-commercial demo.</sub>
```

### 5. Commit only text, verify clean

Stage explicit paths (`README.md`, and `.gitignore` if you added a filename) —
**never** `git add -A`. Then confirm no NC binary leaked:

```sh
git status --porcelain        # expect only README.md / .gitignore, no *.gif/*.mp4
```

Reload the README on the branch in a browser to confirm the GIF moves on its
own (no play button).

## Gotchas

- **One video panel by design.** Two panels on the same MP4 contend for the
  single decoder; the second lags by seconds. (See the README note.)
- **GPU vs headless** changes how much of the scene one play pass covers — on a
  GPU box raise the spec's play window to ~20 s to capture the full ~19 s scene
  (README "GPU vs. headless" note).
- **Refreshing the clip** means a new attachment upload every time — the old
  URL keeps serving the old GIF; you must swap the URL in the README.
- If the user wants crispness over autoplay, offer the **combo**: GIF up top
  for autoplay + a link to the higher-quality MP4 (also attachment-hosted).
