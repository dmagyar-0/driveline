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

## Implementation status

Legend: ✅ shipped · 🚧 in progress (branch open) · ⏳ not started.
Task list and dependencies live in
[`10-task-breakdown.md`](./10-task-breakdown.md); this section tracks
state only. Update on PR merge.

### M0 — De-risk (2026-04-17)

All three M0 spikes have been investigated. Architecture is no longer
blocked on unknowns; the upstream `mf4-rs` patches have since landed
on `main` and the spike pin is obsolete as of 2026-04-16.

- ✅ **T0.1 · `mf4-rs` WASM** — GO-WITH-PATCHES (patches merged
  upstream). Full report:
  [`mf4-rs/WASM_FEASIBILITY.md`](https://github.com/dmagyar-0/mf4-rs/blob/claude/wasm-feasibility-spike-Op9Z3/WASM_FEASIBILITY.md).
- ✅ **T0.2 · WebCodecs + MCAP** — GO. See
  [`spike-T0.2-webcodecs-mcap.md`](./spike-T0.2-webcodecs-mcap.md).
- ✅ **T0.3 · Sample corpus** — GO. See
  [`spike-T0.3-sample-corpus.md`](./spike-T0.3-sample-corpus.md).

### M1 — Foundations (PR #3)

- ✅ **T1.1 · Repo scaffold** — workspace + vite app.
- ✅ **T1.2 · `Reader` trait finalised** — `NoopReader` in `data-core`.
- ✅ **T1.3 · Worker plumbing** — Comlink ping/pong across both workers.
- ✅ **T1.4 · Arrow-over-Comlink contract** — Rust↔JS round-trip test.

### M2 — Ingest

- ⏳ **T2.1 · MCAP reader** — not started.
- 🚧 **T2.2 · MF4 reader** — on branch
  `claude/mf4-next-milestone-ec2KB`, not yet merged.
- ⏳ **T2.3 · mp4 + sidecar reader** — not started.
- ⏳ **T2.4 · Session registry and file drop** — not started
  (depends on T2.1–T2.3).

### M3 — Timeline and transport · M4 — Signal plotting · M5 — Video · M6 — Polish

⏳ Not started. Full task list in `10-task-breakdown.md`.

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
