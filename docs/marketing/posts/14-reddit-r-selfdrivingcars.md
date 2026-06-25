# r/SelfDrivingCars

- **Where:** https://www.reddit.com/r/SelfDrivingCars (~112k)
- **When:** Tue–Thu ~8:30–10:30am ET
- **Format:** text self-post framed as a **technical contribution/discussion**, not
  a product pitch. Lead with the problem. Flair: Discussion (or Research).
- **Rules:** the sub is allergic to hype/startup-pitch tone; low-effort self-promo
  gets removed. Open-source + free + no signup keeps you in the safe zone. Confirm
  live rules; disclose authorship. Be ready for hard technical questions.
- **Risk:** Medium.

---

**Title:** I built an open-source, browser-only viewer for AV logs — 4K dashcam + CAN, synced, with an agent that auto-tags the ODD

If you work with drive logs, you know the pain: the camera is in one tool, the
CAN/IMU signals are in another, and stitching them onto one timeline is a chore.
**Driveline** is an open-source (MPL-2.0) viewer that does it in the browser — 4K
video next to high-rate signals on a single nanosecond clock, frame-accurate
scrubbing, reading MCAP and ASAM MF4 directly. Files stay on your machine (fully
client-side).

The piece relevant to this sub: it's built to be driven by an agent. In the demo
it loads a real comma2k19 dashcam + CAN segment, samples frames across the drive,
and tags the **Operational Design Domain** — weather, road type, illumination,
other road users — from a vision pass over the captured frames, then writes that
back as a tagged event.

Caveats up front: Chromium-only (WebCodecs), replay-only — no live streaming.
MPL-2.0, no server, no upload. Try it: https://driveline.pages.dev · Repo:
https://github.com/dmagyar-0/driveline

Would love feedback from people doing ODD/scenario work — what would make this
useful in your triage loop?

---

**Pre-post checklist**
- [ ] Problem-first framing, zero startup-pitch tone
- [ ] Discussion/Research flair
- [ ] Authorship disclosed; live rules confirmed
- [ ] Around for hard technical questions
