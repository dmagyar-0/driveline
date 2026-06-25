# r/ROS

- **Where:** https://www.reddit.com/r/ROS (~39k)
- **When:** Tue–Thu late morning ET
- **Format:** text self-post, GIF in body, GitHub link in body (not a link post)
- **Rules:** permissive for relevant OSS; 9:1 norm + karma/age gates. Confirm the
  sub's live *About → Rules* in a logged-in browser first. Flair: Tool/Project or
  Discussion. Call out MCAP in the title.
- **Risk:** Low.

> Lead with the demo GIF. Have a crisp answer ready for "ROS 1 or 2?" and "does it
> read my rosbags/MCAP?"

---

**Title:** Open-source, browser-native MCAP viewer (also reads ASAM MF4) — no install, fully client-side

Sharing a tool I built that might be useful if you live in MCAP. **Driveline** is
a web-first multimodal log viewer: drop an MCAP with embedded H.264 and it plays
the video alongside your signal channels, all normalised to one nanosecond clock
with frame-accurate scrubbing. No server — the file is read in-browser and never
uploaded.

Two things that differ from Foxglove: it also reads **ASAM MF4** first-class
(handy if you straddle robotics and automotive), and it has a stable agent
interface so scripts/LLMs can drive it headlessly — load data, lay out panels,
read channel ranges back as Arrow, tag events.

Current scope is honest: the MVP reads MCAP messages as opaque blobs with schema
metadata — full ROS schema decoding into human-readable structs is post-MVP.
Chromium-only (WebCodecs), replay-only. The core is portable Rust (cargo-testable,
no browser deps) compiled to WASM. MPL-2.0.

Try it: https://driveline.pages.dev · Repo + design docs:
https://github.com/dmagyar-0/driveline

Interested in what's missing for your ROS workflow.

---

**Pre-post checklist**
- [ ] Demo GIF in the body
- [ ] Confirmed live sub rules + have ~50+ karma / aged account
- [ ] Flair set (Tool/Project or Discussion)
- [ ] Disclosed "I built"
- [ ] Not cross-posted to r/robotics the same hour
