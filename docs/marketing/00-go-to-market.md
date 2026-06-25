# Driveline — Go-to-Market Plan

> Research-backed positioning, audiences, channels, and monetization. Companion
> docs in this folder: [`01-content-kit.md`](./01-content-kit.md) (ready-to-post
> copy), [`02-deployment.md`](./02-deployment.md) (how to ship it live),
> [`03-automation-matrix.md`](./03-automation-matrix.md) (what an agent can do
> for the launch).

## The one-line position

**Driveline opens both your MCAP *and* your MF4, synced to 4K video, in a
browser tab — and an AI agent can drive every part of it headlessly.**

That combination is unoccupied. No competitor reads *both* MCAP and MF4; none
that read MF4 are browser-based or video-synced; none are designed for an LLM
to drive headlessly. See the competitive table below.

## Differentiators (ranked by how hard they are to copy)

1. **MCAP + MF4 together, first-class.** The hardest-to-copy moat. Foxglove
   (the MCAP incumbent) has *no* MF4 path; the MF4 tools (asammdf, Vector
   CANape, NI DIAdem) are desktop-only and don't sync video.
2. **Fully client-side / files never leave the tab.** A genuine privacy and
   zero-friction story; hard for a cloud-platform incumbent to match without
   undermining their own model.
3. **Agent-drivable (`window.__drivelineAgent`).** The attention-grabbing
   wedge for 2026's "Physical AI" moment — but a *thin, copyable* feature moat.
   Use it to win attention and a beachhead; defend with #1 and #2.

## Honest limits (don't chase audiences these rule out)

- **Chromium-only** (WebCodecs) — no Safari/Firefox shops, no broad-consumer.
- **Replay-only, no live streaming** — no live bench debugging (Vector CANoe
  territory), no robot bring-up.
- **Read-only, no authoring** — asammdf edits, CANape calibrates; Driveline
  views.
- **No ULog/ArduPilot/rlog readers yet** — the drone and comma audiences below
  need an adapter first (an adapter away, not a current capability).

## Top 3 beachhead audiences (ranked)

1. **Automotive ADAS/AV log-triage & scenario-mining engineers.** *Wedge: "The
   one viewer that opens both your MCAP and your MF4 in a browser tab, and lets
   your triage agent tag scenarios headlessly."* The only audience that needs
   all three differentiators at once: MF4 is their native pain, they record
   synchronised camera+CAN, and they run fleet-scale scenario-mining pipelines
   crying out for an agent-drivable replay surface. Highest willingness-to-pay,
   clearest gap. (Incumbent to respect: Foxglove, $40M Series B Nov 2025.)
2. **comma.ai / openpilot community + independent AV/ADAS hackers.** *Wedge:
   "Drop a drive segment, scrub the dashcam against CAN, no install, no upload —
   and let Claude tag the interesting bits."* Driveline already ships a
   comma2k19 demo. OSS-native, privacy-sensitive, loud and reachable. Low
   revenue, best distribution flywheel and credibility builder.
3. **Drone/UAV flight-log reviewers (PX4/ArduPilot).** *Wedge: "Flight Review,
   but with your onboard 4K video frame-locked to the ULog — in the browser."*
   Culturally primed for web log review; the video-sync gap is real. **Needs a
   ULog/.bin reader in `data-core` first** — honest gap, scope before chasing.

Secondary niches (breadth, not beachhead): general ROS 2 robotics (Foxglove
owns it — compete only on the agent angle), motorsport (proprietary formats),
agriculture/heavy machinery/mining/marine (real MF4+video pain via CANedge, but
fragmented), defense/energy/industrial (long cycles, client-side is a plus),
academic AV/robotics labs (free adoption → citations → funnel; nuScenes demo
targets them).

## Competitive landscape

| Tool | MCAP | **MF4** | Video sync | Web | Agent-drivable | License | Price |
|---|---|---|---|---|---|---|---|
| **Driveline** | ✅ 1st-class | ✅ **1st-class** | ✅ ns-synced 4K | ✅ client-side | ✅ **`__drivelineAgent`** | MPL-2.0 | Free |
| Foxglove Studio | ✅ native | ❌ **none** | ✅ ROS-centric | ✅ + desktop | ⚠️ ext/API, not headless-LLM | Closed | Free tier; Pro ~$20/mo+ |
| Lichtblick (BMW fork) | ✅ | ❌ | ✅ | ✅ + desktop | ❌ | MPL-2.0 | Free |
| Rerun | partial | ❌ | ✅ (you log it) | ❌ desktop | ❌ (SDK) | Apache/MIT | Free + cloud |
| PlotJuggler | plugin | ⚠️ plugin | ❌ | ❌ desktop | ❌ | MPL-2.0 | Free |
| asammdf | ❌ | ✅ **native** | ❌ | ❌ desktop | ⚠️ Python API | LGPL/GPL | Free |
| Vector CANape/CANoe | ❌ | ✅ native | ⚠️ add-on | ❌ desktop | ❌ | Proprietary | $$$$ |
| NI DIAdem | ❌ | ✅ plugin | ⚠️ | ❌ desktop | ❌ | Proprietary | $$$ |
| PX4 Flight Review | ❌ | ❌ | ❌ | ✅ | ❌ | BSD | Free |

**Wins:** the MCAP + MF4 + synced 4K + browser + agent-drivable cell is empty.
**Loses:** no live streaming, read-only, Chromium-only, no fleet/cloud/collab
platform (Foxglove's moat), no ULog yet, PlotJuggler beats it on signal math.

## Distribution channels (concrete)

- **Hacker News** — "Show HN: a browser log viewer your AI agent can drive
  (MCAP + MF4, fully client-side)." Privacy + WASM + agent angles are HN catnip.
- **Forums:** Open Robotics Discourse (discourse.openrobotics.org), Foxglove
  community Slack, comma.ai Discord + r/comma_ai + openpilot GitHub discussions,
  PX4/ArduPilot Discourse, Robotics Stack Exchange.
- **Reddit:** r/SelfDrivingCars, r/robotics, r/ROS, r/CarHacking, r/drones,
  r/UAVmapping, r/datasets, r/embedded.
- **GitHub SEO:** topics `mcap`, `mdf4`, `mf4`, `asam`, `can-bus`, `ros2`,
  `webcodecs`, `wasm`, `adas`, `autonomous-vehicles`, `log-viewer`, `foxglove`.
- **Newsletters/media:** The Robot Report, Weekly Robotics, **CSS Electronics**
  blog (the MF4 education hub — guest post is high-leverage for the MF4 wedge).
- **Datasets as a wedge:** one-click demos on datasets people know — nuScenes
  (done), comma2k19 (done), Waymo Open, Argoverse — so first contact is "my
  dataset, instantly, in a tab."
- **Conferences:** ROSCon, ICRA/IROS, ASAM events, AutoSens / Automotive
  Testing Expo, embedded-world.

## Monetization options (MPL-2.0 open core)

Keep the viewer open; charge for what teams can't self-host or won't DIY.

1. **Hosted team workspace** (primary line) — shareable replay links, saved
   layouts, event/tag review queues, SSO, RBAC. Mirrors Foxglove's proven Pro
   model; stay client-side to skip storage cost where possible.
2. **Agent Cloud** — managed headless Driveline runners so a customer's
   scenario-mining agent spins up N browser contexts to triage a fleet in
   parallel. The agent surface is the unique monetizable asset.
3. **Format/enterprise reader add-ons** — proprietary adapters (vendor MF4
   extensions, ULog, rlog, customer binary formats) as separate modules
   (MPL file-level copyleft permits this).
4. **Support + integration contracts** — SLAs, on-prem, custom panel/reader
   work for OEMs/Tier-1s.
5. **Dataset hosting** — managed demo/eval datasets (mind licensing: nuScenes
   is CC BY-NC-SA, non-commercial only).

**Caution:** MPL-2.0 is file-level weak copyleft — competitors and forks can
wrap the open core in proprietary modules too. Monetize on **hosted services
and the agent runtime**, not on code you can't keep closed.

## Bottom line

Lead with automotive ADAS/AV triage (the only audience that needs all of it).
Use the comma.ai/openpilot community and a Hacker News "Show HN" for
top-of-funnel credibility. Treat the agent surface as the attention wedge while
MF4 breadth and client-side privacy are the harder-to-copy moat. Be upfront
that Chromium-only, read-only, and no-live-streaming take live-debug and
broad-robotics audiences off the table — don't chase them.
