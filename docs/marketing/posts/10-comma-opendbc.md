# comma.ai — opendbc Discord / openpilot GitHub Discussions

- **Where:** comma.ai Discord `#dev-opendbc-cars` (read `#guidelines` first), and/or
  https://github.com/commaai/openpilot/discussions (category: **General**)
- **When:** weekday late morning–afternoon PT (~18:00–22:00 UTC)
- **Format:** dev-to-dev, no marketing gloss. Show it **working on comma2k19 data
  specifically** (you already use comma2k19 in fixtures — strong credibility hook).
- **Rules:** no written self-promo policy; it's a dev channel, not a promo channel
  — earn standing by helping with decode questions first. This crowd flames fluff.
  Don't post in support/dev-help channels; don't imply comma affiliation; don't ask
  them to debug your tool; don't cross-post Discord + Discussions simultaneously.
- **Risk:** Medium (blunt crowd).

---

**Title:** Browser tool: scrub a comma2k19 dashcam against CAN on one clock (open source)

Built an open-source viewer (MPL-2.0) that loads a **comma2k19** segment and puts
the dashcam next to the CAN signals on a single nanosecond clock, frame-accurate,
in a browser tab — nothing uploaded. I use comma2k19 in the fixtures, so it works
on real comma data out of the box. Reads MCAP and ASAM MF4; there's also an agent
interface so you can have a script load a drive, sample frames, and tag it
headlessly.

Not a fork of anything, no comma affiliation — just sharing a tool. Chromium only,
replay only. Demo + repo: https://github.com/dmagyar-0/driveline

Curious whether a load-a-DBC-and-verify-a-decode-against-video workflow would be
useful here — happy to wire it up if so.

---

**Pre-post checklist**
- [ ] Demo clearly shows comma2k19 data working
- [ ] Read `#guidelines`; posting in a tools/projects or off-topic channel
- [ ] No "please try / upvote", no affiliation implied
- [ ] Helped with something in the community first
- [ ] Not cross-posted to Discord + Discussions at once
