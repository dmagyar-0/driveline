# Driveline — Marketing Content Kit

> Ready-to-publish copy. Concrete claims only; honest about limits
> (Chromium-only, replay-only). Reuse the two existing GitHub-attachment demo
> GIFs already in the README — the nuScenes camera+LiDAR fusion clip and the
> BYOA ODD-tagging clip render inline on X/LinkedIn. Replace `DEPLOY_URL` and
> `OWNER` placeholders before posting.

## Elevator pitch (3 variants)

**Technical** — Driveline is a browser-first, fully client-side log viewer that
syncs 4K video and high-rate signals (CAN, IMU, control loops) on a single
nanosecond clock, reading MCAP and ASAM MF4 as first-class inputs via a
Rust→WASM core — no server, no upload, no install.

**Plain** — Driveline lets you replay vehicle and robot logs — camera video next
to all your sensor signals, perfectly time-aligned — straight in your browser.
Your files never leave your machine.

**Agent-forward** — Driveline is a multimodal log viewer that an AI agent can
drive headlessly: anything a human can do from the keyboard — load data, scrub,
plot, tag the operational design domain — an agent can do through one stable
JavaScript surface, in the same browser tab, with no API key.

## Taglines

1. Your logs, synchronised. In the browser. Nothing uploaded.
2. 4K video and high-rate signals on one nanosecond clock.
3. MCAP and MF4, side by side, in a tab.
4. A log viewer your agent can drive.
5. Replay vehicle logs without leaving the browser — or the loop.

## Show HN

**Title:** `Show HN: Driveline – browser-only viewer for 4K video + CAN/MF4 logs, agent-drivable`

**Body:**

I build tooling around vehicle and robot logs, and I kept hitting the same wall:
the logs are multimodal — 4K camera plus high-rate signals (CAN, IMU, control
loops) on a shared clock — but no single tool reads the formats we actually
record in *and* runs without an install.

Foxglove Studio is great but centred on ROS/MCAP, with no ASAM MF4 path. Rerun
is excellent but it's a desktop SDK, not a replay tool for pre-existing
automotive formats. So I built Driveline.

It's a web-first viewer that treats **MCAP and MF4 as first-class inputs** and
plays back 4K H.264 alongside signal plots with frame-accurate scrubbing —
everything normalised to one nanosecond clock. The data core is portable Rust
compiled to WASM; the UI is React. It's **fully client-side**: files are read
with the File API and never leave the tab. No server, no upload, no account.

The part I'm most interested in feedback on: Driveline is **agent-drivable by
design**. There's a stable `window.__drivelineAgent` surface — discovery
(`getSkill()`/`describe()`) is always on, and `?agent` unlocks mutation. An
agent can load data, lay out panels, read channel ranges back as Arrow, drive
the transport, capture a video frame at any timestamp without moving the cursor,
and write tagged events stamped `origin: "agent"`. The README demo shows an
agent loading a real comma2k19 dashcam + CAN log, sampling frames across the
drive, and tagging the Operational Design Domain (weather / road type /
illumination / other road users) from a vision pass over the frames it captured.

Honest limits: it's **Chromium-only** (WebCodecs — Safari unsupported by design,
detection handled gracefully), and it's **replay-only** — no live streaming yet,
though the `Reader` abstraction leaves room for it. MPL-2.0.

Repo, design docs, and two demo GIFs: [link]

Happy to go deep on the WASM data pipeline, the Arrow IPC wire format, or the
agent interface.

## Reddit

### r/SelfDrivingCars
**Title:** `I built a browser-only viewer for AV logs — 4K dashcam + CAN, synced, with an agent that auto-tags the ODD`

If you work with drive logs, you know the pain: the camera is in one tool, the
CAN/IMU signals are in another, and stitching them onto one timeline is a chore.
Driveline is an open-source viewer that does it in the browser — 4K video next
to high-rate signals on a single nanosecond clock, frame-accurate scrubbing,
reading MCAP and ASAM MF4 directly. Files stay on your machine (fully
client-side).

The piece relevant to this sub: it's built to be driven by an agent. In the
demo it loads a real comma2k19 dashcam + CAN segment, samples frames across the
drive, and tags the **Operational Design Domain** — weather, road type,
illumination, other road users — from a vision pass over the captured frames,
then writes that back as a tagged event. (It correctly tagged the segment Night,
not Day.)

Caveats up front: Chromium-only (WebCodecs), replay-only — no live streaming.
MPL-2.0, no server, no upload. Would love feedback from people doing ODD/scenario
work. [link]

### r/ROS
**Title:** `Driveline: open-source, browser-native MCAP viewer (also reads ASAM MF4) — no install, fully client-side`

Sharing a tool that might be useful if you live in MCAP. Driveline is a web-first
multimodal log viewer: drop an MCAP with embedded H.264 and it plays the video
alongside your signal channels, all normalised to one nanosecond clock with
frame-accurate scrubbing. No server — the file is read in-browser and never
uploaded.

Two things that differ from Foxglove: it also reads **ASAM MF4** first-class
(handy if you straddle robotics and automotive), and it has a stable agent
interface so scripts/LLMs can drive it headlessly — load data, lay out panels,
read channel ranges back as Arrow, tag events.

Current scope is honest: MVP reads MCAP messages as opaque blobs with schema
metadata — full ROS schema decoding into human-readable structs is post-MVP.
Chromium-only (WebCodecs), replay-only. The core is portable Rust (cargo-testable,
no browser deps) compiled to WASM. MPL-2.0. Repo + design docs: [link]. Interested
in what's missing for your ROS workflow.

### r/embedded
**Title:** `Browser-only log viewer (Rust→WASM) for synced video + high-rate signals — MCAP/MF4, no install`

Built this for correlating "what the camera saw" with "what the signals were
doing" at a given instant, without standing up a server or installing a desktop
app. Driveline reads MCAP and ASAM MF4, syncs 4K video against high-rate
channels (CAN, IMU, control loops) on a single ns clock, and scrubs
frame-accurately — all in a Chromium tab, files never leaving the machine.

Implementation notes: the data core is **portable Rust** with no browser
dependencies (testable natively with `cargo test`), compiled to
`wasm32-unknown-unknown` and driven from Comlink workers. The wire format between
Rust and JS is **Arrow IPC**; the pipeline is lazy and ranged — panels request
`[startNs, endNs]` rather than materialising whole channels. There's also a
native CLI (`driveline-data`) over the same readers for shell-only flows.

Limits: Chromium-only (WebCodecs), replay-only, no live source yet. MPL-2.0. [link]

## X / Twitter thread

**1/** Replaying vehicle/robot logs usually means: camera in one tool, CAN/IMU
signals in another, and a server to glue them. Driveline does it in a browser
tab. 4K video + high-rate signals, one nanosecond clock, frame-accurate. Files
never leave your machine. 🧵

**2/** It reads the formats you already record in — **MCAP and ASAM MF4** — as
first-class inputs. Foxglove is ROS/MCAP-centric with no MF4 path. Rerun is a
desktop SDK. Driveline is web-first and reads both.

**3/** Fully client-side. The data core is portable Rust compiled to WASM; the
UI is React. Your files are read with the File API and never uploaded. No
server, no account, no install.

**4/** The part I care about most: it's **agent-drivable**. Anything you can do
from the keyboard — load data, lay out panels, scrub, plot, tag — an agent can
do through one stable JS surface (`window.__drivelineAgent`), in the same tab,
no API key.

**5/** Demo: an agent loads a real comma2k19 dashcam + CAN log, samples frames
across the drive, and tags the Operational Design Domain — weather / road type /
illumination / other road users — from a vision pass over the frames it captured.
[GIF]

**6/** It can read a video frame at any timestamp *without* moving the cursor —
so an agent can analyse a drive headlessly while a human scrubs the same session
undisturbed. Agent-authored findings are stamped `origin: "agent"`.

**7/** Honest limits: Chromium-only (WebCodecs), replay-only for now. MPL-2.0,
open source. Repo + design docs + demos 👇 [link]

## LinkedIn

Most tools for replaying vehicle and robot logs make you choose: the right
formats, or the right ergonomics. Driveline is an attempt to have both — and to
take automation seriously from day one.

It's an open-source, browser-first viewer that syncs 4K camera video with
high-rate signals (CAN, IMU, control loops) on a single nanosecond clock,
reading MCAP and ASAM MF4 as first-class inputs. The whole thing runs
client-side via a Rust core compiled to WebAssembly — your log files are read in
the browser and never leave your machine. No server, no upload, no install.

The differentiator I'm most proud of: Driveline is built to be driven by agents,
not just clicked. There's one stable interface where an AI agent (or a script,
or CI) can load data, lay out panels, read signal ranges back, capture a video
frame at any timestamp, and write tagged events — headlessly, in the same
browser tab. In the demo, an agent loads a real driving log and tags its
Operational Design Domain (weather, road type, illumination, other road users)
from a vision pass over the frames it sampled.

It's honest about scope: Chromium-only (it leans on WebCodecs), and replay-only
for now. Licensed MPL-2.0. If you work with multimodal logs, I'd value your
feedback. Link in the comments.

## Product Hunt

**Name:** Driveline
**Tagline (60 char):** 4K video + sensor logs, synced in your browser — agent-drivable

**Description:** Driveline is an open-source, browser-first viewer for
multimodal logs. It syncs 4K camera video with high-rate signals (CAN, IMU,
control loops) on a single nanosecond clock, reading MCAP and ASAM MF4 as
first-class inputs. Everything runs client-side via a Rust→WASM core — your files
never leave the tab. No server, no upload, no install. The twist: Driveline is
built to be driven by agents, not just clicked. A stable JavaScript surface lets
an AI agent or script load data, lay out panels, read signal ranges back,
capture a frame at any timestamp, and tag events — headlessly, in the same
browser. Chromium-only (WebCodecs), replay-only, MPL-2.0.

**First comment (maker):** Hi PH 👋 I'm the maker. I work with vehicle and robot
logs, where the data is multimodal — 4K camera plus high-rate signals on a
shared clock — but the tooling forces a trade-off. Foxglove is great but
ROS/MCAP-centric with no MF4 path; Rerun is a brilliant desktop SDK but not a
replay tool for the automotive formats we already have. Driveline targets that
gap: web-first, reads MCAP *and* MF4, plays 4K alongside signal plots with
frame-accurate scrubbing, and never uploads your files. The thing I'd most love
feedback on is the agent surface — nothing a human can do is unreachable to
automation. Honest limits: Chromium-only and replay-only today. MPL-2.0.

## GitHub repo polish

**Description (≤350 chars):**
> Browser-first, fully client-side viewer for multimodal logs: 4K video +
> high-rate signals (CAN/IMU) synced on one nanosecond clock. Reads MCAP and
> ASAM MF4 first-class via a Rust→WASM core — files never leave the tab.
> Agent-drivable: AI agents drive it headlessly. Chromium-only, replay-only.
> MPL-2.0.

**Topics:** `mcap` `mf4` `asam` `mdf4` `log-viewer` `webassembly` `rust`
`webcodecs` `data-visualization` `autonomous-vehicles` `robotics` `can-bus`
`telemetry` `apache-arrow` `time-series` `react` `self-driving` `ros2`
`ai-agents` `foxglove`

## Landing page copy

**Hero headline:** Your logs, synchronised — in the browser, nothing uploaded.

**Subhead:** Driveline replays 4K camera video and high-rate signals (CAN, IMU,
control loops) on a single nanosecond clock. It reads MCAP and ASAM MF4
first-class, runs entirely client-side, and an AI agent can drive every part of
it headlessly.

**Feature blocks:**
- **One clock, every modality** — 4K H.264 video and high-rate channels,
  normalised to nanoseconds and locked together. Scrub the timeline and the
  frame and the plot cursor move in lock-step — frame-accurate.
- **The formats you already record** — MCAP with embedded video, ASAM MF4 with
  signals — both first-class, side by side, no manual offset, no proprietary
  conversion.
- **Nothing leaves your machine** — Fully client-side. A portable Rust core
  compiled to WebAssembly reads your files in the tab. No server, no upload, no
  account.
- **Built for agents, not just clicks** — Every capability a human has, an
  agent has too, through one stable interface. Headless, same browser, no API key.

**Who it's for:** AV/ADAS engineers correlating dashcam footage with CAN/IMU ·
robotics teams in MCAP who also need an MF4 path · embedded/controls engineers
debugging high-rate loops against video · anyone building agent/LLM pipelines
over driving and sensor logs.

**CTA:** Open a log in your browser in under a minute — no install, no upload.
*Chromium-only (WebCodecs). Replay-only. Open source, MPL-2.0.*

## Demo-video script (30–45s)

```
[0:00–0:04] A browser tab. A log file drag-and-drops onto the page.
  "This is a vehicle log — 4K video and sensor signals — opening in a browser tab."
[0:04–0:10] Video panel + signal plots appear side by side; cursor scrubs.
  "No install, no upload. The file is read right here in the tab and never leaves it."
[0:10–0:16] Scrubbing; video frame and plot cursor move in lock-step.
  "4K video and high-rate signals, synced on one nanosecond clock. Frame-accurate."
[0:16–0:22] Channel rail showing an MCAP source and an MF4 source together.
  "It reads MCAP and ASAM MF4 first-class — the formats you already record in."
[0:22–0:34] Split view — agent terminal left, live app right. Frames captured; ODD event appears.
  "And it's built for agents. Here, an agent loads a real driving log, watches the
   drive frame by frame, and tags the operational design domain — itself."
[0:34–0:42] Tagged event badged "agent". Cut to repo / try-it link.
  "Everything a person can do, an agent can do too. Open source. Try it in your browser."
[0:42–0:45] END CARD: Driveline wordmark. "Chromium-only · replay-only · MPL-2.0" + URL.
```

## HTML meta / OG tags

Applied to `apps/web/index.html` (swap `driveline.pages.dev` if you host
elsewhere; needs a 1200×630 `og-image.png` at `/brand/`). See that file for the
live block.
