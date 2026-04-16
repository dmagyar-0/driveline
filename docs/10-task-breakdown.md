# 10 — Task Breakdown

MVP delivery is organised into seven milestones. Every task has:

- **ID** — stable identifier.
- **Title** — what it is.
- **Summary** — one or two sentences.
- **Depends on** — upstream tasks that must be done first.
- **Acceptance** — how we know it is done.
- **Size** — S (≤ 1 day), M (2–3 days), L (4+ days).

Tasks are mutually exclusive; together they cover every "must-have" in
`01-vision-and-scope.md`.

Legend:

- **Size S / M / L** is engineering time, not elapsed time.
- "Spike" means: output is learning + a decision, not production code.

---

## M0 — De-risk (blocking all work below)

### T0.1 · `mf4-rs` WASM build spike

- **Summary:** Make `mf4-rs` compile for `wasm32-unknown-unknown` and
  read a reference MF4 file in a Web Worker. Document any necessary
  source changes.
- **Depends on:** nothing.
- **Acceptance:**
  1. `cargo build --target wasm32-unknown-unknown -p mf4-rs` succeeds
     (with no more than a documented minimal patch set).
  2. A throwaway harness in a Web Worker loads a 100 MB MF4 via
     `Blob.slice()` and prints channel names + sample counts in < 1 s.
  3. A short write-up in `docs/08-risks-and-open-questions.md` updated
     with the outcome and any patches we will maintain.
- **Size:** M (could escalate to L if C deps need to be swapped out).
- **Gate:** blocking for M1. If T0.1 fails within its time box,
  escalate to R1 fallbacks in `docs/08-risks-and-open-questions.md`.

### T0.2 · WebCodecs + MCAP H.264 feasibility

- **Summary:** In a standalone HTML page, decode one keyframe from
  `sample-data/short.mcap` using `VideoDecoder`. No UI, no React.
- **Depends on:** nothing.
- **Acceptance:**
  1. Page opens, loads fixture via `<input type=file>`.
  2. Produces a `<canvas>` with the first keyframe rendered.
  3. Works in Chrome current stable.
- **Size:** S.
- **Gate:** blocking for M5.

### T0.3 · Sample corpus generation

- **Summary:** Produce `sample-data/short.mcap`, `short.mf4`, and
  `short.mp4` + `short.mp4.ts.bin` per `09-verification-plan.md`.
- **Depends on:** nothing.
- **Acceptance:** all three fixtures produced, checked for correct
  durations, channel counts, and timestamps. Reference PNGs captured
  for the five ref times.
- **Size:** M.
- **Gate:** blocking for M2 e2e tests; non-blocking for earlier dev
  (can stub in the meantime).

---

## M1 — Foundations

### T1.1 · Repo scaffold

- **Summary:** Create the file layout from `07-build-and-tooling.md`:
  `apps/web`, `crates/data-core`, `crates/wasm-bindings`, workspace
  configs, empty entry files.
- **Depends on:** T0.1 result (informs whether any in-tree patches
  are needed).
- **Acceptance:** `pnpm install` succeeds; `cargo check --workspace`
  succeeds; `pnpm dev` serves an empty React app; `pnpm wasm:build`
  produces a wasm artifact and a generated JS binding.
- **Size:** M.

### T1.2 · `Reader` trait finalised

- **Summary:** Write the trait + associated types in
  `crates/data-core/src/reader.rs`, based on `04-reader-abstraction.md`.
  No implementations yet beyond a `NoopReader` for wiring tests.
- **Depends on:** T1.1.
- **Acceptance:** code compiles; `cargo test -p data-core` includes a
  test that constructs `NoopReader`, asserts zero channels and an
  empty time range.
- **Size:** S.

### T1.3 · Worker plumbing

- **Summary:** Stand up `dataCore.worker.ts` and `videoDecode.worker.ts`
  shells; wire Comlink; the main thread can call `dataCore.ping()` and
  receive a pong.
- **Depends on:** T1.1.
- **Acceptance:** e2e test opens the page, calls ping via a dev-only
  hook, asserts the pong.
- **Size:** S.

### T1.4 · Arrow-over-Comlink contract

- **Summary:** Implement `fetch_range` in a stub that returns a
  hand-rolled Arrow IPC record batch; JS side parses it with
  `apache-arrow`; contract test (see `09-verification-plan.md`)
  passes.
- **Depends on:** T1.2, T1.3.
- **Acceptance:** contract test runs in both Rust and JS against a
  shared fixture file; passes.
- **Size:** M.

---

## M2 — Ingest

### T2.1 · MCAP reader

- **Summary:** Implement `McapReader` per `04-reader-abstraction.md`:
  parse summary, build channel list, build keyframe index for video
  channels, implement `fetch_range` for scalar, vector, and enum
  channels.
- **Depends on:** T1.2, T1.4, T0.3.
- **Acceptance:** unit tests from `09-verification-plan.md` pass
  against `short.mcap`.
- **Size:** L.

### T2.2 · MF4 reader

- **Summary:** Implement `Mf4Reader` wrapping `mf4-rs`: enumerate CGs,
  compute absolute ns UTC, implement `fetch_range` for scalar + vector.
- **Depends on:** T0.1, T1.2, T1.4, T0.3.
- **Acceptance:** unit tests from `09-verification-plan.md` pass
  against `short.mf4`; contract test passes.
- **Size:** L.

### T2.3 · mp4 + sidecar reader

- **Summary:** Implement `Mp4SidecarReader`: mp4 moov parse, sidecar
  binary parse, validation, `video_stream`.
- **Depends on:** T1.2, T0.3.
- **Acceptance:** unit test on the `short.mp4` + `.ts.bin` pair; length
  mismatch fails the open with the documented error.
- **Size:** M.

### T2.4 · Session registry and file drop

- **Summary:** UI drop target, file bucketing, pairing of mp4 + sidecar,
  session merge of multiple sources; store populated with
  `SessionView`.
- **Depends on:** T2.1, T2.2, T2.3.
- **Acceptance:** drop the three fixtures; UI shows correct source
  names, channel counts, and global time range.
- **Size:** M.

---

## M3 — Timeline and transport

### T3.1 · Transport state machine

- **Summary:** Zustand actions for `play`, `pause`, `setSpeed`,
  `setCursor`; clamp to `globalRange`; stop at end-of-session.
- **Depends on:** T2.4.
- **Acceptance:** unit tests for all transitions and edge cases.
- **Size:** S.

### T3.2 · Timeline UI (scrubber)

- **Summary:** Transport bar component with scrubber, time readout,
  play/pause/speed controls; keyboard shortcuts wired.
- **Depends on:** T3.1.
- **Acceptance:** manual check list (`09-verification-plan.md`) for
  keyboard/mouse behaviours passes.
- **Size:** M.

### T3.3 · Playback loop

- **Summary:** rAF-driven advance of `cursorNs` while playing; respects
  `speed`; does not drift measurably over 10 s.
- **Depends on:** T3.1.
- **Acceptance:** e2e test asserts `cursorNs` advances correctly over
  1 s of wall-clock.
- **Size:** S.

---

## M4 — Signal plotting

### T4.1 · PlotPanel — single series

- **Summary:** uPlot integration; bind to one `ChannelId`; fetch
  Arrow batch for the visible range; render; draw cursor overlay.
- **Depends on:** T1.4, T2.4, T3.1.
- **Acceptance:** opens the session, binds to `/vehicle/speed`, trace
  renders; perf target from `09-verification-plan.md` met.
- **Size:** M.

### T4.2 · PlotPanel — multi-series and channel picker

- **Summary:** Channel picker popover (tree by source → channel);
  overlay up to 8 series; deterministic colours; y-axis autoscale.
- **Depends on:** T4.1.
- **Acceptance:** overlay MCAP `/vehicle/speed` and MF4 same-name
  channel; traces match.
- **Size:** M.

### T4.3 · PlotPanel — decimation

- **Summary:** Implement `max_points` path in `fetch_range` (min-max
  per bucket in Rust) so 1 M-sample windows render under the perf
  budget.
- **Depends on:** T2.1, T2.2, T4.1.
- **Acceptance:** perf target from `09-verification-plan.md` met for
  1 M points.
- **Size:** M.

---

## M5 — Video

### T5.1 · VideoPanel — MCAP path

- **Summary:** `VideoPanel` component; `videoDecode` worker configures
  `VideoDecoder` from MCAP extradata; frames delivered and blitted.
- **Depends on:** T0.2, T2.1, T1.3.
- **Acceptance:** playing `short.mcap` shows video in sync with
  `cursorNs`; no frame drops at 1× over 10 s.
- **Size:** L.

### T5.2 · Seek strategy and HUD

- **Summary:** Implement keyframe-based seek with debounce; perf HUD
  overlay (PTS, frame index, decode queue, drops).
- **Depends on:** T5.1.
- **Acceptance:** scrub seek settles < 250 ms for all five ref times.
- **Size:** M.

### T5.3 · mp4 + sidecar path

- **Summary:** Second `VideoPanel` wiring for `Mp4SidecarReader`
  sources; no signal-panel interaction (mp4 is video-only).
- **Depends on:** T2.3, T5.1.
- **Acceptance:** playing `short.mp4` + sidecar shows video aligned
  with the session cursor; pixel compare at ref times matches
  `short.mcap` output within tolerance.
- **Size:** M.

---

## M6 — Sync, layout, polish

### T6.1 · Frame-accurate cross-panel sync

- **Summary:** End-to-end verification that VideoPanel + PlotPanel
  agree on cursor: blit the frame whose PTS ≤ cursor, plot the value
  sample whose ts ≤ cursor.
- **Depends on:** T4.2, T5.2.
- **Acceptance:** e2e test from `09-verification-plan.md` step 2
  (scrub-and-assert) passes.
- **Size:** M.

### T6.2 · FlexLayout docking + saved layouts

- **Summary:** Integrate FlexLayout; persist JSON to `localStorage`;
  `+` button adds new panels; users can split, close, rearrange.
- **Depends on:** T4.1, T5.1.
- **Acceptance:** manual checklist items for layout pass; layout
  survives page reload.
- **Size:** M.

### T6.3 · Full verification pass

- **Summary:** Run every check in `09-verification-plan.md`: unit,
  contract, e2e, manual, perf targets. Fix anything that fails.
- **Depends on:** all above.
- **Acceptance:** every check listed passes on the reference
  environment.
- **Size:** M.

### T6.4 · Unsupported-browser splash

- **Summary:** Detect WebCodecs at boot; if missing, render a clear
  splash screen pointing users at Chrome/Edge; do not initialise the
  rest of the app.
- **Depends on:** T1.1.
- **Acceptance:** manual check in Firefox or an older browser shows
  the splash; no console errors.
- **Size:** S.

---

## Out of scope (explicitly, for the MVP)

Deferred to post-MVP; not included in this breakdown:

- Live streaming source (Foxglove WebSocket).
- Tauri desktop wrapper.
- Schema-aware decoding of MCAP message payloads.
- H.265, AV1, VP9.
- Annotations / labels / markers.
- Shareable session URLs / cloud storage.
- Pre-decoded poster thumbnail strip.
- Per-source time offset UI.
- OPFS caching for large files.
- Formal accessibility audit.

## Rough timeline (engineering-days only)

Assuming a single engineer, no unrelated interrupts, fixtures available
at the start of M2:

| Milestone | Days |
|---|---|
| M0 | 3–5 |
| M1 | 3 |
| M2 | 8 |
| M3 | 3 |
| M4 | 5 |
| M5 | 7 |
| M6 | 4 |
| **Total** | **33–35** |

If T0.1 escalates to fallback R1.2 (JS-side MF4 reader), add 5–8 days
to M2.
