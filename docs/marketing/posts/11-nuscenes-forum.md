# nuScenes forum

- **Where:** https://forum.nuscenes.org/ (Discourse) → category *More details* or
  *Howto*. NOT the devkit GitHub (Issues-only, not for showcases).
- **When:** any weekday
- **Format:** forum thread, lead with the fusion you already render, end with a
  "what next" question. Prior art: Foxglove shipped a nuScenes viewer +
  `nuscenes2mcap` and blogged it, so third-party viewers are welcomed.
- **⚠️ Licence:** nuScenes data is **CC BY-NC-SA 4.0**. Any screenshot/clip is
  non-commercial, must **attribute nuScenes/Motional**, and is share-alike. Caption
  accordingly; keep NC artefacts out of commercial contexts (and out of git).
- **Risk:** Low.

---

**Title:** Driveline: open-source, browser-only viewer for nuScenes camera+LiDAR fusion (MPL-2.0)

Hi all — I built **Driveline**, an open-source (MPL-2.0), fully client-side viewer
that replays multimodal logs in the browser, and it renders a **nuScenes**
CAM_FRONT + projected-LiDAR fusion (plus the 3D scene and ego speed/yaw-rate) on
one synchronised timeline. No install, no upload — the data is read in the tab.

Sharing in case it's useful for eyeballing scenes quickly, and to ask what you'd
want next (more sensors? radar? a specific scene-export path?). I went in via an
MCAP conversion, similar in spirit to Foxglove's `nuscenes2mcap`.

Demo + repo: https://github.com/dmagyar-0/driveline · live:
https://driveline.pages.dev

*The demo media shows nuScenes v1.0-mini data under CC BY-NC-SA 4.0, © Motional —
non-commercial, attribution, share-alike.* Honest scope: Chromium-only
(WebCodecs), replay-only.

---

**Pre-post checklist**
- [ ] Posted on forum.nuscenes.org (not the devkit Issues)
- [ ] Demo media attributed to nuScenes/Motional + CC BY-NC-SA noted
- [ ] No nuScenes frames used in any commercial surface
- [ ] Ends with a "what next" question
