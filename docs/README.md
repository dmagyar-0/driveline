# Driveline — Design Docs

Driveline is a browser-first multimodal log viewer for synchronised 4K
video and high-rate signal data. Think Foxglove Studio, but with native
support for ASAM MF4 alongside MCAP, and with a pipeline built for
4K-first video from day one.

This directory holds the design for the MVP. No code yet — these docs
are the blueprint the implementation will follow. Every decision has a
rationale and a rejected alternative.

## Reading order

For someone new to the project, read in this order:

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
7. [`07-build-and-tooling.md`](./07-build-and-tooling.md) — repo
   layout, Vite + wasm-pack pipeline, browser targets, size budgets.
8. [`08-risks-and-open-questions.md`](./08-risks-and-open-questions.md)
   — what could invalidate the plan and what the fallbacks are.
9. [`09-verification-plan.md`](./09-verification-plan.md) — sample
   corpus, tests, perf targets, milestone gates.
10. [`10-task-breakdown.md`](./10-task-breakdown.md) — concrete tasks
    organised into milestones M0–M6, with sizes and dependencies.

## Key decisions at a glance

- **Web browser only** for the MVP. No server, no desktop app.
  (Tauri is preserved as a future option; see `07`.)
- **Rust-in-WASM core** in a Web Worker, behind a React + TypeScript
  UI. Core uses the user's existing `mf4-rs` crate.
- **Formats:** MCAP, MF4, and mp4 + per-frame timestamps sidecar.
  Everything normalises to a single `i64` ns-UTC clock.
- **Video:** H.264 via WebCodecs. 4K @ 30 fps with hardware decode.
  Seek by keyframe + decode-forward. MSE rejected.
- **Signals:** uPlot, fed by Arrow IPC record batches produced by the
  Rust core. Server-side decimation for large windows.
- **Layout:** FlexLayout for dockable panels; state in Zustand.
- **Chromium-first.** Firefox best-effort. Safari not in MVP.

## Biggest risk

`mf4-rs` does not currently build for `wasm32-unknown-unknown`. The
very first task (**T0.1** in `10-task-breakdown.md`) is a time-boxed
spike to port it; the architecture hinges on its outcome. Fallbacks
are laid out in `08-risks-and-open-questions.md`.

## MVP definition of done

On a reference laptop running Chrome, the user can:

1. Drop an MCAP containing a 4K H.264 stream plus 1 kHz signal
   channels and an MF4 with matching signals.
2. See a unified timeline and a channel list.
3. Play, pause, scrub, and change speed.
4. Watch the video and the signal plot stay frame-accurately in sync.

Full criteria in `01-vision-and-scope.md` and `09-verification-plan.md`.

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
