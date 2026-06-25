# Driveline — Community Launch Playbook

> Forum/community-first launch plan (not cold email). Ranked venues with each
> one's **self-promotion rules**, best format, timing, and removal risk — plus
> ready-to-paste posts and a 2-week sequence. Copy for Show HN / Reddit / X /
> LinkedIn / Product Hunt lives in [`01-content-kit.md`](./01-content-kit.md);
> this doc adds the venue-specific posts and the rules that keep them from being
> removed.

## Cross-cutting rules (break these and you get removed/flamed)

1. **Picture/GIF first, everywhere.** The 4K-video + signal-sync story is
   visual. Lead with the BYOA agent demo or the nuScenes fusion clip
   (the GIFs already in the README). A bare GitHub link underperforms or gets
   removed in every venue.
2. **Disclose you're the solo dev** ("I built this"). Undisclosed self-promo is
   the fastest way to lose goodwill and trips Reddit's 9:1 norm.
3. **Never ask for upvotes** — this is a hard Product Hunt rule (votes get
   cleared / disqualified) and the same etiquette holds on HN/Reddit. Ask for
   *feedback / comments / questions* instead.
4. **Never blast the same link across many places the same day.** Reddit's own
   spam filter flags rapid multi-sub posting; space venues over ~2 weeks and
   tailor each title to the venue's angle.
5. **State the limits honestly** (Chromium-only, replay-only, no ULog yet).
   Technical communities punish bait-and-switch harder than they punish scope.
6. **Warm accounts ~30 days ahead** (Product Hunt and strict subs down-weight
   brand-new / low-karma accounts). Earn standing in Tier-1 dev communities by
   *helping* before you post your tool.
7. **Right category, one post.** Don't cross-post across a forum's own
   categories (ROS Discourse Projects vs General; ArduPilot Blog vs Developers).
8. **Confirm each subreddit's live rules before posting.** Reddit blocks
   automated rule-text access, so the per-sub rules here reflect known norms,
   not a fresh read — open each sub's *About → Rules* + pinned posts in a
   logged-in browser first. Highest-risk to double-check: **r/embedded**
   (strict promo enforcement) and **r/dataengineering** (a standalone tool post
   is usually removed — use that week's self-promo megathread). Most subs also
   gate on account age (~7–30 days) and karma (~50–500), so seed a few genuine
   comments per sub first.

## Ranked venues (reach × fit)

| # | Venue | Reach×fit | Self-promo allowed? | Best format | Timing (UTC) | Removal risk |
|---|---|---|---|---|---|---|
| 1 | **MCAP / Foxglove Discord + `foxglove/mcap` GitHub** | ★★★★★ | Yes, as a *complementary* MCAP reader — never "Foxglove-killer" | Discord intro + GitHub Discussion, MCAP-gratitude framing | weekday ~18:00 PT-AM | **High** (host's house) |
| 2 | **ROS Discourse — Projects category** | ★★★★★ | **Yes — sanctioned show-and-tell** ("built with/for open robotics") | Standalone topic, GIF + repo + honest scope | Tue–Thu 14:00–16:00 | Low |
| 3 | **comma.ai — opendbc Discord `#dev-opendbc-cars` / openpilot Discussions (General)** | ★★★★☆ | Tolerated if it solves *their* CAN task; dev channel, not promo | Show it working on comma2k19 dashcam+CAN, dev-to-dev | weekday 18:00–22:00 | Medium (blunt crowd) |
| 4 | **Hacker News — Show HN** | ★★★★☆ | Yes (Show HN is for exactly this) | "Show HN: Driveline – …", no upvote asks | Tue–Thu 13:00–15:00 | Low |
| 5 | **r/ROS** (~39k) | ★★★★☆ | Permissive for relevant OSS | "I built…" + MCAP mention + GIF | weekday AM ET | Low |
| 6 | **r/CarHacking** (~44k) | ★★★★☆ | Tool-friendly (SavvyCAN crowd) | Lead CAN-hard, DBC/format support up front | eve/weekend ET | Low |
| 7 | **r/rust** (large) | ★★★☆☆ | Yes *as a technical writeup* | "How I kept a 4K viewer's WASM <2 MB" — repo as detail | weekday AM ET | Medium (anti-ad) |
| 8 | **r/robotics** (~320k) | ★★★☆☆ | **Yes, with showcase/"I made this" flair** + 9:1 | Demo video mandatory | Sat–Sun AM ET | Med (flair-gated) |
| 9 | **r/SelfDrivingCars** (~112k) | ★★★☆☆ | Only as substantive discussion, not an ad | Text, problem-first, "Discussion" flair | Tue–Thu 13:00–16:00 | Med |
| 10 | **Lobsters (lobste.rs)** | ★★★☆☆ | Only your own work, invite-only to *post* | Title + `rust`/`web` tags, no marketing | Tue–Thu AM ET | Med (strict) |
| 11 | **dev.to `#showdev`** | ★★☆☆☆ | **Yes — the "I built X" tag** | Build-story article + GIF, tags showdev/rust/webdev | any weekday | Low |
| 12 | **This Week in Rust** (newsletter) | ★★★☆☆ | Yes — **submit a PR** linking a writeup/release | Needs a link-worthy artifact first | n/a (PR) | Low |
| 13 | **SavvyCAN GitHub Discussions** | ★★☆☆☆ (fit-not-reach) | Yes, as interop/show post | Browser complement to SavvyCAN capture/graph | any | Low |
| 14 | **AV dataset communities** (nuScenes forum, Alpamayo HF, Waymo, Argoverse, ZOD) | ★★★☆☆ | As a *dataset tooling* contribution | Clip of Driveline replaying *their* data (mind the licence) | any | Low–Med (licence-gated) — see [dataset section](#av-dataset-communities-nuscenes-alpamayo-waymo-argoverse) |
| 15 | **PX4 / ArduPilot Discourse** | ★★☆☆☆ today | Only as "would ULog/.bin support be useful?" | Image-first (ArduPilot Blog *requires* it), caveat foregrounded | Tue–Thu 13:00–16:00 | Med (off-topic if oversold) |
| 16 | **Weekly Robotics** (newsletter) | ★★★☆☆ | Curator-gated tip | One-paragraph pitch + demo GIF | n/a | Low |
| 17 | **r/embedded** (~250k) | ★★☆☆☆ | **Strict** — sparingly, FOSS-framed, no product tone | Problem-first, FOSS/no-cloud emphasis | weekday AM ET | **High** |
| 18 | **r/dataengineering** (~250k) | ★★☆☆☆ | **Only in the weekly self-promo megathread** | Frame around Arrow/MCAP/MF4 | when thread is fresh | High (standalone = removed) |

**Skip-or-optional:** Foxglove Discord is the highest-fit *and* highest-risk —
do it only with genuine MCAP-gratitude framing, or skip. Rust Zulip is for
contributing to Rust itself — **don't** self-promo there (use Rust Discord).

---

## Ready-to-paste posts (venue-specific)

> Show HN, the three Reddit posts (r/SelfDrivingCars, r/ROS, r/embedded), the X
> thread, LinkedIn, and Product Hunt copy are already in
> [`01-content-kit.md`](./01-content-kit.md). The posts below are the new
> venue-specific ones. Swap in your demo GIF/clip and the live link
> (`https://driveline.pages.dev`).

### ROS Discourse — **Projects** category (lead with this)

**Title:** `Driveline — browser-based replay for MCAP/rosbag2 with synced video + signals`

**Body:**
> Hi all — I'm a solo dev and I've been building **Driveline**, an open-source
> (MPL-2.0) viewer for multimodal logs, and wanted to share it with the people
> who live in rosbag2/MCAP.
>
> It plays back 4K video alongside your signal channels, all normalised to one
> nanosecond clock with frame-accurate scrubbing — drop an MCAP with embedded
> H.264 and it just works. It runs **entirely client-side** (a portable Rust
> core compiled to WASM; the file is read in the tab and never uploaded), so
> there's no server to stand up.
>
> Two things that might interest this group specifically:
> - It also reads **ASAM MF4** first-class, which is handy if you straddle
>   robotics and automotive.
> - It has a stable agent interface (`window.__drivelineAgent`) so a script or
>   LLM can drive it headlessly — load data, lay out panels, read channel ranges
>   back as Arrow, tag events.
>
> Honest scope: the MVP reads MCAP messages as opaque blobs with schema
> metadata — full ROS schema decoding into human-readable structs is post-MVP.
> Chromium-only (WebCodecs), replay-only.
>
> [GIF here] · Try it: https://driveline.pages.dev · Repo + design docs:
> https://github.com/dmagyar-0/driveline
>
> Would love feedback on what's missing for your rosbag2 workflow — especially
> which message schemas you'd most want decoded next.

### MCAP / Foxglove Discord — `#lounge` intro (gratitude-first, never "alternative to Foxglove")

> 👋 Thanks for MCAP — it's become the backbone of how I handle multimodal logs.
> I built a small open-source, browser-only MCAP viewer called **Driveline**
> (Rust→WASM, fully client-side) that syncs embedded 4K video to signal plots on
> one ns clock, and can be driven headlessly by an agent. It's complementary to
> Studio (replay-only, Chromium-only, also reads ASAM MF4). Sharing in case the
> MCAP-in-WASM angle is interesting — happy to write up how the reader works.
> Repo: https://github.com/dmagyar-0/driveline

*(Then engage in `foxglove/mcap` GitHub Discussions with a compatibility note —
don't @-ping staff, don't position as a competitor.)*

### comma.ai — openpilot **GitHub Discussions (General)** / opendbc Discord

**Title:** `Browser tool: scrub a comma2k19 dashcam against CAN on one clock (open source)`

**Body:**
> Built an open-source viewer (MPL-2.0) that loads a **comma2k19** segment and
> puts the dashcam next to the CAN signals on a single nanosecond clock,
> frame-accurate, in a browser tab — nothing uploaded. I use comma2k19 in the
> fixtures, so it works on real comma data out of the box. Reads MCAP and ASAM
> MF4; there's also an agent interface so you can have a script load a drive,
> sample frames, and tag it headlessly.
>
> Not a fork of anything, no comma affiliation — just sharing a tool. Chromium
> only, replay only. Demo + repo: https://github.com/dmagyar-0/driveline
>
> Curious whether a load-a-DBC-and-verify-a-decode-against-video workflow would
> be useful here — happy to wire it up if so.

### r/rust — technical writeup (repo as supporting detail, not the headline)

**Title:** `Shipped a 4K-video + CAN-log viewer with a Rust→WASM core — notes on keeping it under the size budget`

**Body:**
> I built an open-source browser log viewer (Driveline) where the whole data
> core is portable Rust compiled to `wasm32-unknown-unknown` and driven from
> Comlink workers. A few things that were fun/painful and might interest r/rust:
> - Keeping first-load **WASM under 2 MB gzip** with `wasm-opt -Oz` while still
>   parsing MCAP + ASAM MF4 and producing Arrow.
> - **Apache Arrow IPC** as the zero-copy wire format between Rust and JS; the
>   pipeline is lazy and ranged (panels request `[startNs, endNs]`, never whole
>   channels).
> - Keeping the core **browser-dependency-free** so it's testable natively with
>   `cargo test` and reusable from a native CLI.
>
> It reads vehicle/robot logs and syncs 4K video to signals on one ns clock,
> fully client-side. MPL-2.0. Repo (design docs are detailed):
> https://github.com/dmagyar-0/driveline — happy to go deep on the WASM or Arrow
> bits.

### dev.to — `#showdev` article (intro; expand into a build story)

**Title:** `Show: I built a browser-based 4K-video + CAN-log viewer in Rust + WASM`
**Tags:** `#showdev` `#rust` `#webassembly` `#webdev`
> Opening: the problem (camera in one tool, signals in another, a server to glue
> them) → the approach (Rust→WASM core, Arrow IPC, WebCodecs, fully client-side)
> → the agent-drivable surface → honest limits → try-it link + repo. Include the
> two demo GIFs and 2–3 annotated screenshots.

### Lobsters (lobste.rs)

**Title:** `Driveline – browser-only viewer for 4K video + MCAP/MF4 logs, agent-drivable`
**Tags:** `rust` `web` `show`
> Note: you must be a member to submit, and you may only post **your own** work
> (tick "authored by me"). No marketing copy — Lobsters is terse and technical;
> a one-line factual description + the repo is the idiom. Expect sharp,
> high-quality comments.

### PX4 / ArduPilot Discourse — *only* as an interest-gauging question

**PX4 → Spotlight category. ArduPilot → Blog category (image-first is required there).**

**Title:** `Would ULog/.bin support in a browser video+signal viewer be useful to you?`
> I built an open-source, client-side log viewer (Driveline) that syncs 4K video
> to high-rate signals on one ns clock — today it reads MCAP and ASAM MF4, **not
> ULog/.bin yet**. Before I build a reader, I wanted to ask the people who'd use
> it: is "onboard video frame-locked to your flight log, in the browser" worth
> having? [image] Repo: https://github.com/dmagyar-0/driveline

---

## AV dataset communities (nuScenes, Alpamayo, Waymo, Argoverse)

Driveline already renders a **nuScenes** camera+LiDAR fusion demo, which gives it
real standing to post in dataset communities as a *tooling contribution* rather
than an ad. These are niche but precisely your users (AV researchers). **The
licence on the data — not your MPL-2.0 code — is the thing that bites here.**

### Ranked dataset posts

1. **comma2k19 (comma.ai)** — already covered above (opendbc/openpilot). Your
   **warmest** dataset audience: you render comma2k19, the crowd loves tools, and
   the data licence is **permissive** (lowest screenshot risk). Lead here.
2. **nuScenes → `forum.nuscenes.org`** (Discourse; category *More details* or
   *Howto*) — the official venue. The devkit GitHub
   (`nutonomy/nuscenes-devkit`) is **Issues-only and not for showcases** — post
   on the forum. Prior art: Foxglove shipped a nuScenes viewer + `nuscenes2mcap`
   and blogged it, so third-party viewers are welcomed.
   ⚠️ **Licence: CC BY-NC-SA 4.0.** Any nuScenes screenshot/GIF is
   non-commercial, must **attribute nuScenes/Motional**, and is share-alike.
   (You already gitignore the NC demo artefacts — keep doing that.)
3. **Alpamayo → Hugging Face community tab** on
   `nvidia/PhysicalAI-Autonomous-Vehicles` — reaches NVIDIA engineers who watch
   that tab. Frame as a **format question**, because Driveline reads MCAP/MF4 and
   **does not read Alpamayo's MP4 + Draco-Parquet layout yet** — this is
   "would this be useful / can it read your layout?", not "it works."
   🚫 **Licence: proprietary `nvidia-av-dataset` EULA — far stricter than
   nuScenes.** No derivative works, **no redistribution/hosting of the data in
   whole or part**, 12-month expiry, scoped to "internal AV development using
   NVIDIA technology." **Do not put any Alpamayo frame in your README/demo/post.**
   Demo with your own footage; ask NVIDIA (in the HF thread) before publishing any
   sample frame. Secondary venue: NVIDIA Developer Forums (DRIVE/AV) — more formal.
4. **Waymo Open Dataset** (`waymo-research/waymo-open-dataset` Issues + Google
   Group) — same tooling pitch. ⚠️ Non-commercial media terms like nuScenes.
5. **Argoverse** (`github.com/argoverse` Issues + community Slack) — same pitch.
   ⚠️ CC BY-NC-SA media terms.
6. **Zenseact ZOD** (`zod.zenseact.com`, `zenseact/zod` Issues) — smaller/quieter,
   friendly, permissive-ish research licence. Lower leverage.
   **Skip:** PandaSet (withdrawn), Lyft L5 (legacy), KITTI (no live channel).

### Ready-to-paste — nuScenes forum

**Title:** `Driveline: open-source, browser-only viewer for nuScenes camera+LiDAR fusion (MPL-2.0)`
> Hi all — I built **Driveline**, an open-source (MPL-2.0), fully client-side
> viewer that replays multimodal logs in the browser, and it renders a
> **nuScenes** CAM_FRONT + projected-LiDAR fusion (plus the 3D scene and ego
> speed/yaw-rate) on one synchronised timeline. No install, no upload — the data
> is read in the tab.
>
> Sharing in case it's useful for eyeballing scenes quickly, and to ask what
> you'd want next (more sensors? radar? a specific scene-export path?). I went in
> via an MCAP conversion, similar in spirit to Foxglove's `nuscenes2mcap`.
>
> Demo + repo: https://github.com/dmagyar-0/driveline · live:
> https://driveline.pages.dev
>
> *The demo media shows nuScenes v1.0-mini data under **CC BY-NC-SA 4.0**, ©
> Motional — non-commercial, attribution, share-alike.*
> Honest scope: Chromium-only (WebCodecs), replay-only.

### Ready-to-paste — Alpamayo (Hugging Face community tab) — *format question, no frames*

**Title:** `Open-source browser viewer (Driveline) — could it read the PhysicalAI-AV MP4 + Draco-Parquet layout?`
> Hi — I maintain **Driveline**, an open-source (MPL-2.0), client-side browser
> viewer for multimodal driving logs. It currently reads **MCAP** and **ASAM
> MF4**, syncing camera video to high-rate signals on one nanosecond clock, and
> it's agent-drivable.
>
> I'd like to support this dataset's layout (7× MP4 1080p + LiDAR/radar in
> Draco-compressed Parquet) so people can scrub it in a browser. Two questions
> before I start:
> 1. Is there appetite for a browser viewer for this dataset?
> 2. Per the dataset licence, am I permitted to publish a small sample
>    screenshot/clip when documenting viewer support, or should demos use only
>    my own footage? I want to respect the EULA's redistribution terms.
>
> Repo: https://github.com/dmagyar-0/driveline. Happy to contribute a loader if
> it's welcome.

*(Do not attach Alpamayo frames to this post — the EULA's no-redistribution
clause plausibly covers a public sample frame. Ask first, as above.)*

---

## 2-week posting sequence (solo dev)

**Week 0 — prep & standing (no pitching):**
- Warm a **personal** Product Hunt account + your Reddit account (upvote,
  comment, follow for ~2–3 weeks).
- Build standing in **Tier-1 dev communities** by helping: answer a question in
  the MCAP Discord, comment in ROS Discourse, help with a decode in opendbc.
- Prep assets: the two demo GIFs, a 45–60s gallery video (BYOA clip — *not* the
  CC-BY-NC-SA nuScenes one for commercial surfaces), a concrete benefit-led PH
  tagline (e.g. "Replay 4K video + CAN/IMU logs in your browser, perfectly
  synced"), and your maker first-comment.

**Week 1:**
- **Tue** — **ROS Discourse → Projects** post (your single best sanctioned fit). Sit on replies.
- **Wed** — **r/ROS** post (tailored title + GIF + flair).
- **Thu** — **MCAP/Foxglove Discord** intro (gratitude framing) + a `foxglove/mcap` Discussion.
- **weekend** — **r/robotics** (Sat AM, "I made this" flair, video) — this sub skews off-hours.

**Week 2:**
- **Tue** — **Show HN** ("Show HN: Driveline – …", ~13:00 UTC). No upvote asks; reply to every comment. (HN has a *second-chance* pool — if it sinks with few points, you can ask mods for a re-up later.)
- **Tue (same day, optional)** — **Product Hunt** launch at **12:01 PT**, Tue/Wed/Thu only. Post the maker comment immediately, ask for *feedback* not votes, reply within minutes.
- **Wed** — **r/CarHacking** (lead the CAN angle, address DBC/format support).
- **Thu** — **r/rust** technical writeup + submit a **This Week in Rust** PR linking it.
- **Fri** — **dev.to `#showdev`** build-story article.
- **Rolling** — **Weekly Robotics** tip, **SavvyCAN** Discussions, **nuScenes/ZOD**
  dataset-tooling posts, and the strict venues (**r/embedded** FOSS-framed,
  **r/dataengineering** *megathread only*) as you have bandwidth.

**Measure the right thing:** for a Chromium-only, replay-only niche tool, success
is the *right* engineers commenting + GitHub stars/issues from real users — not
PH rank or front-page HN. Lead where your users actually are (Tier 1), and treat
HN/PH as a credibility + backlink spike.
