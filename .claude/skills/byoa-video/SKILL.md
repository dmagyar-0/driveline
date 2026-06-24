---
description: Create the "Bring Your Own Agent" (BYOA) demo video — the agent terminal beside the live Driveline app — and the README-ready GIF. Records two synchronised browser contexts (a Claude-Code-style terminal + the real app driven via window.__drivelineAgent on the comma2k19 dashcam + CAN), composites them side-by-side with ffmpeg, and emits a GIF for embedding via a GitHub attachment URL. Delegates the heavy build/record run to a subagent. Use when the user asks to "create/record the BYOA video", "make the ODD demo", "regenerate byoa-odd.webm/gif", "redo the agent terminal demo", or invokes /byoa-video.
allowed-tools: Agent AskUserQuestion SendUserFile Read Bash(bash *) Bash(ls *) Bash(cat *) Bash(curl *) Bash(ffprobe *) Bash(git *)
---

# byoa-video

Produces the **Bring Your Own Agent** demo: an agent drives Driveline
headlessly through `window.__drivelineAgent` (loads the comma2k19 dashcam +
CAN, samples frames, tags the drive's **ODD** — Operational Design Domain),
shown with its **terminal on the left and the live app on the right**, then a
README-ready **GIF**.

The recording is **delegated to a subagent** — it floods context with
build/fixture/ffmpeg output, so the main thread stays cheap. Your job in the
main thread:

1. **Confirm what to record** (defaults are fine — see Step 1).
2. **Dispatch one subagent** that runs the whole pipeline and returns the
   artifact paths.
3. **Surface the artifacts** (`SendUserFile` the GIF + webm) and explain the
   GitHub-attachment-URL flow for the README embed.

Do **not** run the env-setup / fetch / build-fixtures / record pipeline
yourself in the main thread.

---

## What the pipeline produces

`scripts/record-byoa-odd.sh` is the entry point. It:

- runs `scripts/agent-drive/odd-driver.mjs`, which records **two browser
  contexts in one run** — a rendered terminal
  (`scripts/agent-drive/odd-terminal.html`: prompt, thinking, tool calls,
  inspected-frame thumbnails, the final answer, and a follow-up user question)
  and the real app at `/?agent=1` driven through the production agent surface;
- composites them side-by-side with ffmpeg `hstack`;
- emits a palette-based **GIF** (10 fps @ 900px, ~8 MB — under GitHub's 10 MB
  image-attachment limit).

Outputs (all in the **gitignored** `demo/` dir — never committed):

- `demo/byoa-odd.webm` — composited terminal | app
- `demo/byoa-odd.gif` — README-ready GIF
- `demo/byoa-odd-app.webm` · `demo/byoa-odd-term.webm` — per-pane clips

## Honesty contract (do not skip)

The CAN figures in the clip (speed/steering/decel) are computed **live** from
the data via `fetchChannelRange`. The four ODD scene-element tag *values* +
confidences are **transcribed from a real Claude vision pass** over the
captured frames, replayed by the driver so the recording is reproducible — it
is **not** a live model call inside the page. If you change the demo footage
or want fresh tags, **re-derive them** (see "Refresh the ODD verdict") rather
than inventing values. The earlier draft hardcoded "Day" on what is actually a
**night** drive — that is the failure mode this contract exists to prevent.

---

## Step 1 — Confirm scope

Defaults need no question: record the standard comma2k19 ODD story and produce
both the composited webm and the GIF. Only ask (one `AskUserQuestion`) if the
user implied something non-default — e.g. different footage, a different pane
size, or "just the GIF / just the webm".

## Step 2 — Dispatch the recording subagent

Launch **one** subagent (`Agent`, `subagent_type: general-purpose`,
foreground — you need its result to respond). Template:

> You are recording the Driveline BYOA ODD demo. Read
> `.claude/skills/byoa-video/SKILL.md` and follow the **"Recording
> procedure"** section exactly. Run from the repo root. Return, as structured
> output: the absolute paths of `demo/byoa-odd.webm`, `demo/byoa-odd.gif`, and
> the per-pane webms; the GIF's size in MB (must be < 10 MB); and the ODD tag
> values the terminal actually shows. If anything failed (server, fixtures,
> ffmpeg), say what and stop — do not fabricate a result.

## Step 3 — Surface the artifacts

When the subagent returns:

1. `SendUserFile` the `demo/byoa-odd.gif` (the README deliverable) and, if
   useful, `demo/byoa-odd.webm`. Confirm the GIF is < 10 MB.
2. Explain the embed flow: the multi-MB GIF is **not committed** (`demo/` is
   gitignored). To put it in the README, **drag the GIF into a PR/issue
   description on GitHub** to mint a `https://github.com/user-attachments/...`
   URL, then reference that URL with `<img src="…">` in `README.md`. There is
   no API to mint that URL — it is a web-UI action.
3. If a README section doesn't exist yet, it lives under `## Demo — Bring Your
   Own Agent`; see `docs/13-bring-your-own-agent.md` for the write-up.

---

# Recording procedure

> **This section is for the recording subagent.** If you are the main thread,
> dispatch a subagent (Step 2) — don't run this. Every step is idempotent;
> re-run freely and skip anything already on disk.

## 1. Environment (one-shot; ~2 min cold)

```sh
scripts/setup-test-env.sh >/dev/null        # ffmpeg, wasm-pack + bundle, chromium, python
python3 -c "import pyarrow" 2>/dev/null \
  || pip3 install --break-system-packages -q 'pyarrow>=14,<20'
```

This bootstraps ffmpeg, the wasm bundle (required before `pnpm dev`), the
Python fixture toolchain, and Playwright's Chromium.

## 2. comma2k19 fixtures (the demo data)

The demo needs `sample-data/realworld/comma2k19.mcap`,
`comma2k19_seg10.mp4`, and `comma2k19_seg10.mp4.timestamps` (gitignored). Build
them if absent:

```sh
bash .claude/skills/verify-visually/scripts/fetch-sources.sh    # ~114 MB download
bash .claude/skills/verify-visually/scripts/build-fixtures.sh
```

## 3. Record

`record-byoa-odd.sh` starts the dev server if one isn't already on
`http://localhost:5173` (reuses it if it is), drives both contexts, composites,
and writes the GIF:

```sh
scripts/record-byoa-odd.sh
```

Verify the outputs exist and the GIF is under the limit:

```sh
ls -lh demo/byoa-odd.webm demo/byoa-odd.gif
ffprobe -v error -show_entries format=duration -of csv=p=0 demo/byoa-odd.webm
```

If the GIF exceeds 10 MB, lower the `fps`/`scale` in the GIF block of
`record-byoa-odd.sh` (it's 10 fps @ 900px by default).

## 4. Verify it visually (don't trust the run alone)

Extract a frame from the tagging beat and **look at it** with `Read` — confirm
the terminal shows the ODD verdict and the app shows the tagged agent event:

```sh
ffmpeg -hide_banner -v error -y -ss 30 -i demo/byoa-odd.webm -frames:v 1 /tmp/byoa-check.png
```

The terminal verdict must match the footage (the standard comma2k19 seg10 clip
is a **night** highway cruise → illumination = Night). If the footage changed,
re-derive the tags before reporting done.

## Refresh the ODD verdict (only when footage/tags change)

The tag values live in `scripts/agent-drive/odd-driver.mjs` (the `addEvent({
tags })` call + the terminal `tTag`/summary lines). To re-derive them honestly:

1. Capture the five sampled frames the driver uses (fractions 0.08/0.30/0.50/
   0.72/0.92 of the segment) via `captureVideoFrameAt` against the dev server,
   or extract them from the mp4 with ffmpeg at the matching times.
2. Hand those PNGs to a vision model (a `general-purpose` subagent can `Read`
   them) with the ODD prompt: classify weather / road type / illumination /
   other road user, each with a confidence + one-line justification, using the
   `DEFAULT_EVENT_TAG_CONFIG` option sets.
3. Transcribe the model's verdict into the driver (values, confidences,
   justification text, label, summary) and re-record. Keep the exact model id
   out of committed files — say "Claude" generically.

## Notes

- `demo/` is gitignored — the webms/GIF are build artifacts, never committed
  (like the wasm bundle).
- The demo-only inspection badge and the terminal page are not product code;
  the app pane itself is the real UI driven through the production agent
  surface (only the dev-only `openFiles` loader is privileged, as in the other
  demos).
- Full write-up: `docs/13-bring-your-own-agent.md` ("ODD tagging — terminal
  beside the UI").
