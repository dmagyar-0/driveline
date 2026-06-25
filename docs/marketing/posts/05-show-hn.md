# Hacker News — Show HN

- **Where:** https://news.ycombinator.com/showhn.html (submit a Show HN)
- **When:** Tue–Thu ~13:00–15:00 UTC (weekday US morning). Avoid weekends.
- **Format:** "Show HN: <name> – <plain description>". URL = the live app
  (`https://driveline.pages.dev`); put the repo in the first comment if needed.
- **Rules:** no upvote asking anywhere. Be present to answer every comment for the
  first few hours. If it sinks early with little traction, you can email
  hn@ycombinator.com for the **second-chance** pool / a re-up.
- **Risk:** Low.

---

**Title:** Show HN: Driveline – browser-only viewer for 4K video + CAN/MF4 logs, agent-drivable

**URL:** https://driveline.pages.dev

**Text (first comment):**

I build tooling around vehicle and robot logs, and I kept hitting the same wall:
the logs are multimodal — 4K camera plus high-rate signals (CAN, IMU, control
loops) on a shared clock — but no single tool reads the formats we actually record
in *and* runs without an install.

Foxglove Studio is great but centred on ROS/MCAP, with no ASAM MF4 path. Rerun is
excellent but it's a desktop SDK, not a replay tool for pre-existing automotive
formats. So I built Driveline.

It's a web-first viewer that treats **MCAP and MF4 as first-class inputs** and
plays back 4K H.264 alongside signal plots with frame-accurate scrubbing —
everything normalised to one nanosecond clock. The data core is portable Rust
compiled to WASM; the UI is React. It's **fully client-side**: files are read with
the File API and never leave the tab. No server, no upload, no account.

The part I'm most interested in feedback on: Driveline is **agent-drivable by
design**. There's a stable `window.__drivelineAgent` surface — discovery
(`getSkill()`/`describe()`) is always on, and `?agent` unlocks mutation. An agent
can load data, lay out panels, read channel ranges back as Arrow, drive the
transport, capture a video frame at any timestamp without moving the cursor, and
write tagged events stamped `origin: "agent"`. The README demo shows an agent
loading a real comma2k19 dashcam + CAN log, sampling frames across the drive, and
tagging the Operational Design Domain from a vision pass over the frames it
captured.

Honest limits: Chromium-only (WebCodecs — Safari unsupported by design), and
replay-only — no live streaming yet, though the `Reader` abstraction leaves room
for it. MPL-2.0. Repo + design docs: https://github.com/dmagyar-0/driveline

Happy to go deep on the WASM data pipeline, the Arrow IPC wire format, or the
agent interface.

---

**Pre-post checklist**
- [ ] Title starts with "Show HN:" and is plain (no hype)
- [ ] URL = live app; repo in the text
- [ ] Free the next 3–4 hours to reply to every comment
- [ ] No "please upvote" anywhere
