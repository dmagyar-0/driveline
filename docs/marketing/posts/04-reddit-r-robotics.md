# r/robotics

- **Where:** https://www.reddit.com/r/robotics (~320k)
- **When:** Sat AM ET (sub skews off-hours) or Tue–Thu 9–11am ET
- **Format:** **demo video/GIF is mandatory here** — visual sub. Self-post.
- **Rules:** self-promo allowed **with the showcase / "I made this" flair** and
  the 9:1 norm. A bare GitHub link with no media will be removed/ignored. Confirm
  current flair name in the sub.
- **Risk:** Medium (flair-gated).

> The video is the post here. Put the BYOA demo (or a synced 4K + signals scrub)
> front and centre.

---

**Title:** I built a browser-only viewer for robot/vehicle logs — 4K video synced to signals, reads MCAP + MF4

[video/GIF]

Camera in one tool, signals in another, and a server to glue them — that was the
workflow I wanted to kill. **Driveline** is an open-source (MPL-2.0) viewer that
plays 4K video next to high-rate signal channels on a single nanosecond clock,
frame-accurate, in a browser tab. It reads **MCAP** and **ASAM MF4** directly, and
the file never leaves your machine (fully client-side, Rust→WASM core).

It's also built to be driven by an agent: a script or LLM can load a log, lay out
panels, read channel ranges back as Arrow, capture a frame at any timestamp, and
tag events — headlessly, same browser, no API key. The clip shows an agent loading
a real driving log and tagging the operational design domain itself.

Honest limits: Chromium-only (WebCodecs), replay-only. Try it:
https://driveline.pages.dev · Repo: https://github.com/dmagyar-0/driveline

---

**Pre-post checklist**
- [ ] Video/GIF attached (non-negotiable here)
- [ ] "I made this" / showcase flair applied
- [ ] Account cleared karma/age gate; confirmed live rules
- [ ] Not the same hour as the r/ROS post
