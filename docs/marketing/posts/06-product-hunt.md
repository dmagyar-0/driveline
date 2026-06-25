# Product Hunt

- **Where:** https://www.producthunt.com/launch (self-launch from a **personal**
  account — no hunter needed; company accounts can't launch)
- **When:** **12:01am PT**, Tue/Wed/Thu only. Avoid Mon + weekends.
- **Format:** strong tagline + a 45–60s gallery **video first**, then screenshots,
  then the maker first comment immediately.
- **Rules:** **never ask for upvotes** (DMs, Discord, email, or the post) — votes
  get cleared / you get disqualified. Ask people to *visit and comment*. Warm the
  account ~30 days ahead. Reply to every comment fast.
- **Risk:** Medium (penalty risk is all about the upvote rule + unwarmed account).
  Treat PH as a credibility + backlink play, not a growth channel.

---

**Name:** Driveline

**Tagline (60 char):** Replay 4K video + CAN/IMU logs in your browser, synced

**Description:**
Driveline is an open-source, browser-first viewer for multimodal logs. It syncs 4K
camera video with high-rate signals (CAN, IMU, control loops) on a single
nanosecond clock, reading MCAP and ASAM MF4 as first-class inputs. Everything runs
client-side via a Rust→WASM core — your files never leave the tab. No server, no
upload, no install. The twist: Driveline is built to be driven by agents, not just
clicked. A stable JavaScript surface lets an AI agent or script load data, lay out
panels, read signal ranges back, capture a frame at any timestamp, and tag events
— headlessly, in the same browser. Chromium-only (WebCodecs), replay-only,
MPL-2.0.

**Gallery:** lead with the 45–60s BYOA video (most impressive thing in first 5s),
then 2–3 annotated screenshots (synced scrub, MCAP+MF4 loaded, plots). Do **not**
use the nuScenes clip here (CC BY-NC-SA / non-commercial).

**First comment (maker, post immediately):**
Hi PH 👋 I'm the maker — a solo dev. I work with vehicle and robot logs, where the
data is multimodal (4K camera + high-rate signals on a shared clock) but the
tooling forces a trade-off: Foxglove is great but ROS/MCAP-centric with no MF4
path; Rerun is a brilliant desktop SDK but not a replay tool for the automotive
formats we already have. Driveline targets that gap: web-first, reads MCAP *and*
MF4, plays 4K alongside signal plots with frame-accurate scrubbing, and never
uploads your files. The thing I'd most love feedback on is the agent surface —
nothing a human can do is unreachable to automation. Honest limits: Chromium-only
and replay-only today. MPL-2.0. Would genuinely love your questions and feedback.

---

**Pre-launch checklist**
- [ ] Personal account warmed ~30 days (upvoting/commenting/following)
- [ ] 45–60s video ready (BYOA, not nuScenes)
- [ ] Tagline benefit-led, concrete
- [ ] Maker first comment drafted, posted at launch
- [ ] Outreach language = "visit + comment / feedback", NEVER "upvote"
- [ ] Blocked the full day to answer comments within minutes
