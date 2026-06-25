# Driveline — Press / Launch One-Pager

> Copy-ready boilerplate for outreach, newsletters, and a press kit. A Google
> Drive press-kit folder was created at *Driveline — Press Kit*, but the Drive
> connector's scope blocked uploading file contents into it — this doc is the
> portable source of truth. Visual assets are linked below.

## What it is

Driveline is an open-source, browser-first viewer for multimodal logs. It syncs
4K camera video with high-rate signals (CAN, IMU, control loops) on a single
nanosecond clock, reading **MCAP** and **ASAM MF4** as first-class inputs.
Everything runs client-side via a Rust→WebAssembly core — your files never leave
the browser tab. No server, no upload, no install.

## The differentiator (one unoccupied cell)

No competitor opens **both** MCAP and MF4, synced to 4K video, in a browser,
and is drivable by an AI agent. Foxglove has no MF4 path; the MF4 tools
(asammdf, Vector CANape, NI DIAdem) are desktop-only and don't sync video.
Driveline is also **agent-drivable**: anything a human can do from the keyboard,
an agent can do headlessly through one stable JS surface
(`window.__drivelineAgent`) — load data, lay out panels, read signal ranges,
capture a frame at any timestamp, and write tagged events.

## Who it's for

- Automotive ADAS/AV log-triage & scenario-mining engineers (primary)
- comma.ai / openpilot community & independent AV/ADAS hackers
- Robotics teams living in MCAP who also need an MF4 path
- Embedded / controls engineers debugging high-rate loops against video

## Honest limits

Chromium-only (WebCodecs). Replay-only — no live streaming yet. Read-only
(viewer, not an editor). No ULog/ArduPilot reader yet.

## Key facts

- License: **MPL-2.0** (open core)
- Core: portable Rust → WASM; wire format Apache Arrow IPC
- UI: React 19 + TypeScript + Vite
- Deploy target: Cloudflare Pages (fully static SPA)

## Links

- Live app: <https://driveline.pages.dev> (once secrets are added — see
  `02-deployment.md`)
- Repository: <https://github.com/dmagyar-0/driveline>
- Design docs: <https://github.com/dmagyar-0/driveline/tree/main/docs>
- Bring Your Own Agent: [`docs/13-bring-your-own-agent.md`](../13-bring-your-own-agent.md)

## Visual assets

- **OG / social card:** [`apps/web/public/brand/og-image.png`](../../apps/web/public/brand/og-image.png) (1200×630)
- **Demo GIF — nuScenes camera+LiDAR fusion:**
  `https://github.com/user-attachments/assets/3877ca75-1ac0-4ce9-9b95-ba4657259993`
  — ⚠️ nuScenes data is CC BY-NC-SA, **non-commercial only**
- **Demo GIF — Bring Your Own Agent / ODD tagging:**
  `https://github.com/user-attachments/assets/6e90dd7c-bd1e-4de0-9e5c-f05dd93f1726`
  — safer hero asset for commercial/marketing contexts
- **Brand SVGs:** `apps/web/public/brand/{logo,wordmark,favicon}.svg`

## Boilerplate (50 words)

> Driveline is an open-source, browser-first viewer for multimodal vehicle and
> robot logs. It synchronises 4K video with high-rate signals on one nanosecond
> clock, reads MCAP and ASAM MF4 first-class, runs entirely client-side, and is
> built to be driven headlessly by AI agents. MPL-2.0. Chromium-only, replay-only.

## Outreach drafts

Three ready-to-send Gmail drafts were prepared (a robotics/AV newsletter, CSS
Electronics for the MF4 wedge, and a 1:1 to a target ADAS engineer / design
partner). Each is addressed to you with a "set the To: before sending" note.
