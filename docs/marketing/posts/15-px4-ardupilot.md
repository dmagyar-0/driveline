# PX4 / ArduPilot Discourse — only as an interest-gauging question

- **Where:** PX4 → https://discuss.px4.io/ **Spotlight** category · ArduPilot →
  https://discuss.ardupilot.org/ **Blog** category (image-first is **required**
  there — start the post with a picture/GIF).
- **When:** Tue–Thu ~13:00–16:00 UTC
- **Format:** lead with the **ULog/.bin caveat** — Driveline reads MCAP/MF4 and
  **does not read ULog or DataFlash `.bin` yet**, which is what this audience has.
  Frame the whole post as "would this be useful?" so the gap becomes a legitimate
  question, not a bait-and-switch.
- **Rules:** project sharing welcome in the right category; no solicitation, don't
  imply Dronecode/PX4/ArduPilot endorsement, don't put it in Flight-Testing/Logs or
  Developers. **Only post once ULog support is real, OR clearly as a roadmap Q.**
- **Risk:** Medium (off-topic if oversold).

---

**Title:** Would ULog/.bin support in a browser video+signal viewer be useful to you?

[image/GIF first — required on ArduPilot Blog]

I built an open-source, client-side log viewer (**Driveline**) that syncs 4K video
to high-rate signals on one nanosecond clock, entirely in the browser — today it
reads MCAP and ASAM MF4, **not ULog/.bin yet**. Before I build a reader, I wanted
to ask the people who'd actually use it: is "onboard video frame-locked to your
flight log, in the browser" worth having? What would make it genuinely useful
versus Flight Review / UAV Log Viewer?

Repo: https://github.com/dmagyar-0/driveline

---

**Pre-post checklist**
- [ ] ULog/.bin gap stated in the first paragraph
- [ ] Image/GIF at the very top (ArduPilot Blog requirement)
- [ ] Posted in Spotlight (PX4) / Blog (ArduPilot), not Logs/Developers
- [ ] No endorsement implied; framed as a roadmap question
