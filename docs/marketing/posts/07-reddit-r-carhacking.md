# r/CarHacking

- **Where:** https://www.reddit.com/r/CarHacking (~44k) — small but bullseye
- **When:** weekday ~7–9pm ET or Sun afternoon/evening ET (hobbyist skew)
- **Format:** text self-post, lead the **CAN angle hard**, demo loading real CAN
  data. Position as complementary to SavvyCAN/comma, not a competitor.
- **Rules:** tool-friendly community; 9:1 + karma/age gates. Confirm live rules.
  Address format support (raw candump, DBC decode, .asc/.blf, MF4) up front —
  they'll ask immediately.
- **Risk:** Low.

---

**Title:** Browser tool: load a CAN log + synced dashcam video on one clock (open source, MCAP/MF4)

Built this for the "what was on the bus the instant the camera saw X" question,
without installing anything or uploading a capture anywhere. **Driveline** is an
open-source (MPL-2.0) viewer that puts a dashcam next to your CAN signals on a
single nanosecond clock, frame-accurate, entirely in the browser — the file is
read in the tab and never leaves it (Rust→WASM core).

It reads **MCAP** and **ASAM MF4** today. Honest about formats: [edit this line to
your real support — e.g. "DBC decode + raw candump via MCAP; .asc/.blf on the
roadmap"]. There's also an agent interface so you can script "load segment, sample
frames, tag events" headlessly.

Complementary to the capture/graph tools you already use — this is the
replay-with-video side. Chromium-only (WebCodecs), replay-only. Try it:
https://driveline.pages.dev · Repo: https://github.com/dmagyar-0/driveline

What CAN formats would you most want it to ingest next?

---

**Pre-post checklist**
- [ ] CAN angle leads; demo shows real CAN data
- [ ] Format-support line edited to the truth (DBC? candump? .asc/.blf?)
- [ ] Framed as complementary, not "replaces SavvyCAN"
- [ ] Confirmed live rules; account gate cleared
