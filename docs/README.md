# Driveline — Docs

Driveline is a browser-first multimodal log viewer for synchronised 4K
video and high-rate signal data. Think Foxglove Studio, but with native
support for ASAM MF4 alongside MCAP, and with a pipeline built for
4K-first video from day one.

The MVP has shipped. This directory now holds two kinds of content:

1. **Design docs (`NN-*.md`)** — the shape of the system and the
   decisions behind it. Useful when you want to know *why* something
   looks the way it does.
2. **The book (`book/`)** — a guided, code-first walkthrough of the
   actual codebase written for readers who have not used Rust,
   TypeScript, or React before. Useful when you want to know *how*
   the code works, file by file.

## Start here

- **New to the codebase?** Read the book. Eleven short chapters,
  starting at [`book/README.md`](./book/README.md).
- **Need design rationale?** Read the numbered docs below.
- **Looking for future-work items?** See
  [`10-task-breakdown.md`](./10-task-breakdown.md) and
  [`08-risks-and-open-questions.md`](./08-risks-and-open-questions.md).

## Design docs

1. [`01-vision-and-scope.md`](./01-vision-and-scope.md) — the problem,
   the MVP boundary, non-goals, success criteria.
2. [`02-architecture.md`](./02-architecture.md) — the three-layer
   browser architecture (React ↔ data-core WASM worker ↔ video-decode
   worker) and why.
3. [`03-data-model.md`](./03-data-model.md) — the single ns-UTC clock,
   `Channel`/`Message`/`TimeRange` types, Arrow IPC as the wire format.
4. [`04-reader-abstraction.md`](./04-reader-abstraction.md) — the
   `Reader` trait and how MCAP, MF4, and mp4+sidecar plug in.
5. [`05-video-pipeline.md`](./05-video-pipeline.md) — WebCodecs flow,
   seek strategy, MCAP-embedded vs mp4+sidecar paths, why not MSE.
6. [`06-ui-and-panels.md`](./06-ui-and-panels.md) — React + FlexLayout
   + uPlot + Zustand; panel responsibilities; scrub → cursor path.
7. [`07-build-and-tooling.md`](./07-build-and-tooling.md) — the
   architectural seam for the build (book chapter 11 covers the
   day-to-day commands).
8. [`08-risks-and-open-questions.md`](./08-risks-and-open-questions.md)
   — unresolved open questions for post-MVP work.
9. [`09-verification-plan.md`](./09-verification-plan.md) — tiers of
   tests, sample corpus, perf targets.
10. [`10-task-breakdown.md`](./10-task-breakdown.md) — deferred
    post-MVP work items.
11. [`11-agent-interface.md`](./11-agent-interface.md) — the automation
    surface: `window.__drivelineAgent` (`?agent` opt-in), the event
    JSON import/export format, and the `driveline-data` CLI.
12. [`12-format-agent.md`](./12-format-agent.md) — design for BYOK
    ingestion of unknown data types: a Claude-driven agent derives a
    declarative Ingest Recipe from a consented file sample, the
    `RecipeReader` decodes the full file locally, and a layout
    proposal bootstraps the panels.

## Key decisions at a glance

- **Web browser only** for the MVP. No server, no desktop app.
  (Tauri is preserved as a future option; see `07`.)
- **Rust-in-WASM core** in a Web Worker, behind a React + TypeScript
  UI.
- **Formats:** MCAP, MF4, and mp4 + per-frame timestamps sidecar.
  Everything normalises to a single `i64` ns-UTC clock.
- **Video:** H.264 via WebCodecs. 4K @ 30 fps with hardware decode.
  Seek by keyframe + decode-forward. MSE rejected.
- **Signals:** uPlot, fed by Arrow IPC record batches produced by the
  Rust core. Every in-range sample is returned verbatim.
- **Layout:** FlexLayout for dockable panels; state in Zustand.
- **Chromium-first.** Firefox best-effort. Safari not in MVP.

## MVP definition of done

On a reference laptop running Chrome, the user can:

1. Drop an MCAP containing a 4K H.264 stream plus 1 kHz signal
   channels and an MF4 with matching signals.
2. See a unified timeline and a channel list.
3. Play, pause, scrub, and change speed.
4. Watch the video and the signal plot stay frame-accurately in sync.

All of the above is currently implemented and covered by the tests in
`09-verification-plan.md`. Full criteria in `01-vision-and-scope.md`.

## Glossary

- **AU** — access unit; one frame's worth of encoded video bytes.
- **AVCC** — an H.264 byte-stream framing with length-prefixed NAL
  units (as opposed to Annex-B start codes).
- **CG** — channel group (MF4 concept).
- **GOP** — group of pictures; keyframe plus the deltas until the
  next keyframe.
- **IPC** — inter-process communication; in this project usually
  "Arrow IPC" — the standard columnar record-batch wire format.
- **MCAP** — Foxglove's/ROS's self-describing log container.
- **MF4** — ASAM MDF v4; a standard automotive measurement format.
- **ns-UTC** — nanoseconds since the Unix epoch in UTC; the one
  clock everything normalises to.
- **PTS / DTS** — presentation / decode timestamps.
- **WebCodecs** — browser API for direct access to hardware video
  codecs (`VideoDecoder`, `VideoFrame`).
