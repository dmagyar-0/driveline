# dev.to — #showdev

- **Where:** https://dev.to/new — tags `#showdev` `#rust` `#webassembly` `#webdev`
- **When:** any weekday
- **Format:** a genuine build-story article with screenshots/GIF, not a thin link.
- **Rules:** `#showdev` is explicitly the "I built X" tag — self-promo is the
  point, provided it's a real narrative. Good for a backlink + build story.
- **Risk:** Low.

---

**Title:** Show: I built a browser-based 4K-video + CAN-log viewer in Rust + WASM

**Suggested structure** (write it out as prose):

1. **The problem** — vehicle/robot logs are multimodal (camera in one tool,
   CAN/IMU signals in another, a server to glue them). The "what did the camera
   see at the instant this signal spiked" question is annoyingly hard.
2. **The approach** — a portable Rust core compiled to `wasm32-unknown-unknown`,
   Comlink workers, WebCodecs for 4K H.264, Apache Arrow IPC as the Rust↔JS wire
   format, lazy ranged reads. Everything client-side; files never leave the tab.
3. **The hard parts** — keeping WASM under the size budget (<2 MB gzip with
   `wasm-opt -Oz`), one nanosecond clock across modalities, frame-accurate scrub.
4. **The twist** — agent-drivable: `window.__drivelineAgent` lets a script/LLM
   load data, read ranges back, capture a frame at any timestamp, tag events
   headlessly. Embed the BYOA demo GIF here.
5. **Honest limits** — Chromium-only (WebCodecs), replay-only.
6. **Try it / repo** — https://driveline.pages.dev ·
   https://github.com/dmagyar-0/driveline

Embed the BYOA demo GIF + 2–3 annotated screenshots. End with "what would you
want it to read next?"

---

**Pre-post checklist**
- [ ] Real narrative, not just a link
- [ ] Tags include #showdev
- [ ] GIF + screenshots embedded
- [ ] Canonical URL set if you cross-post from your own blog
