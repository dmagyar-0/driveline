# ROS Discourse — Projects category

- **Where:** https://discourse.openrobotics.org/ → **Projects** category
- **When:** Tue–Thu ~14:00–16:00 UTC (morning US-East / afternoon EU)
- **Format:** standalone topic, GIF first, repo + honest scope, end with a question
- **Rules:** sanctioned show-and-tell ("built with/for open robotics"). Do **not**
  use Community News (gated) or a support framing. One post, Projects only.
- **Risk:** Low. Disclose authorship.

> Attach the BYOA demo GIF (or a rosbag/MCAP screenshot) at the top.

---

**Title:** Driveline — browser-based replay for MCAP/rosbag2 with synced video + signals

Hi all — I'm a solo dev and I've been building **Driveline**, an open-source
(MPL-2.0) viewer for multimodal logs, and wanted to share it with the people who
live in rosbag2/MCAP.

It plays back 4K video alongside your signal channels, all normalised to one
nanosecond clock with frame-accurate scrubbing — drop an MCAP with embedded
H.264 and it just works. It runs **entirely client-side** (a portable Rust core
compiled to WASM; the file is read in the tab and never uploaded), so there's no
server to stand up.

Two things that might interest this group specifically:

- It also reads **ASAM MF4** first-class, which is handy if you straddle robotics
  and automotive.
- It has a stable agent interface (`window.__drivelineAgent`) so a script or LLM
  can drive it headlessly — load data, lay out panels, read channel ranges back
  as Arrow, tag events.

Honest scope: the MVP reads MCAP messages as opaque blobs with schema metadata —
full ROS schema decoding into human-readable structs is post-MVP. Chromium-only
(WebCodecs), replay-only.

Try it: https://driveline.pages.dev · Repo + design docs:
https://github.com/dmagyar-0/driveline

Would love feedback on what's missing for your rosbag2 workflow — especially
which message schemas you'd most want decoded next.

---

**Pre-post checklist**
- [ ] GIF attached at top
- [ ] Category = Projects (not Community News / not a support category)
- [ ] Authorship disclosed ("I'm a solo dev")
- [ ] Ends with a question to invite discussion
- [ ] Live link + repo correct
