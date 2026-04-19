# 09 — Verification Plan

Driveline's MVP is "done" when it passes every check in this document on a
reference machine. The plan covers:

- the sample corpus used for testing,
- automated tests (unit, contract, e2e),
- manual functional checks,
- performance targets,
- per-milestone gates (what blocks the next milestone).

## Reference environment

- **Hardware:** a recent consumer laptop (Apple Silicon M-series or x86
  with a discrete or integrated GPU that supports H.264 hardware decode).
- **Browser:** latest stable Chrome or Edge, HTTPS context, no extensions.
- **OS:** macOS, Linux, or Windows.

Numbers below are measured on this class of machine. Lower-end hardware
is acceptable as long as the functional checks pass and perf degrades
gracefully.

## Sample corpus

All fixtures live under `sample-data/` (gitignored; fetched via a script
or committed via git-lfs when small enough).

### `sample-data/short.mcap` — primary fixture

- Duration: 10.0 s
- Channels:
  - `/camera/front` — video, H.264, 3840×2160, 30 fps, 1 keyframe/sec,
    AVCC extradata in channel metadata.
  - `/vehicle/speed` — scalar Float64, 100 Hz.
  - `/imu/accel`    — vector Float32 (xyz), 1000 Hz.
  - `/control/mode` — enum (Int32, dict: {0: "Manual", 1: "Auto"}),
    sparse.
- First `log_time` aligns with a known absolute timestamp (e.g.
  2024-01-01T00:00:00Z) to make assertions readable.

### `sample-data/short.mf4` — signal-only fixture

- Same four signal channels as above (no video).
- Same `start_time`, same per-sample timestamps, so overlaying them on
  the MCAP signals should produce visually identical traces.

### `sample-data/short.mp4` + `short.mp4.ts.bin`

- Same 10-second 4K H.264 stream as `/camera/front`, but as a standalone
  mp4.
- Sidecar binary file of 300 `i64` values (30 fps × 10 s) matching the
  `log_time`s of the MCAP video frames.

### Reference frames

Five known frames: `t = {0.0, 2.5, 5.0, 7.5, 10.0 - 1/30}` seconds from
the session start. Each reference is stored as a PNG
(`sample-data/refs/t_<ms>.png`) for pixel-compare assertions in Playwright.
Pixel-compare uses a tolerance (e.g. `pixelmatch` with threshold 0.02) to
account for colour space drift between decoders.

## Automated tests

### Unit — Rust (`cargo test -p data-core`)

- `reader::tests::infers_channel_kind_from_schema`
- `mcap::tests::builds_keyframe_index_from_fixture`
- `mcap::tests::fetch_range_respects_time_bounds`
- `mcap::tests::fetch_range_includes_prev_when_requested`
- `mf4::tests::translates_cg_time_to_ns_utc`
- `mf4::tests::fetch_range_returns_expected_arrow_schema`
- `mp4_sidecar::tests::rejects_length_mismatch`
- `decimate::tests::min_before_max_order_preserved`
- `decimate::tests::max_before_min_order_preserved`
- `decimate::tests::partial_nan_bucket_picks_finite_extrema`
  - *M5 note*: the original plan row named one LTTB test. The
    implementation in `crates/data-core/src/decimate.rs` picked
    min-max bucketed decimation instead (preserves per-bucket
    extrema, cheaper under heavy IMU); see T5.1 in
    `docs/10-task-breakdown.md`. Plan rows retitled to track the
    three extrema-preservation tests that actually ship.

These run on the **native** target — the `Reader` implementations are
written so that their logic is not wasm-specific. The wasm build only
tests the binding layer.

### Unit — JS (`vitest`)

- `state/store.test.ts` — transport state transitions, speed bounds,
  cursor clamping to range.
- `workers/arrow.test.ts` — Arrow IPC bytes → typed arrays, schema
  validation.
- `panels/PlotPanel.test.tsx` — multi-series rendering with a fake
  Arrow batch; cursor overlay position.
- `timeline/Transport.test.tsx` — keyboard shortcuts, scrubber drag
  semantics.

### Contract tests

One test fixture that both sides agree on, preventing drift:

- Rust test produces Arrow IPC bytes from the primary fixture's
  `/vehicle/speed` range `[1s, 2s]` and writes them to a canonical file.
- JS test reads the same file via `apache-arrow` and asserts the exact
  number of rows, min/max `ts`, min/max `value`, and dtype.

### End-to-end (`playwright`)

Runs the built app against a headless browser with the sample corpus
served from `sample-data/`.

1. **File load.** Drop `short.mcap`; assert within 2 s that the channel
   list shows 4 channels and the timeline spans 10 s.
2. **Scrub-and-assert.** Programmatically set `cursorNs` to each of the
   five reference times. For each: capture the `VideoPanel` canvas
   pixels, compare to the reference PNG within tolerance.
3. **Signal alignment.** Query `PlotPanel` for rendered series min/max
   within the visible window; compare to pre-computed expectations.
4. **MF4 overlay.** Also drop `short.mf4`; assert that the same-named
   scalar series from both sources overlap within 1 sample.
5. **Playback.** Click play; after 1.0 s of wall-clock, assert
   `cursorNs` advanced by `1.0e9 ± 50e6` ns (5% tolerance for rAF
   jitter).

## Manual functional checks

For things that are hard to automate. Checked by a human before any
release:

- Dropping files in unusual orders (mp4 before its sidecar, MF4 before
  MCAP).
- Rapid scrub flicks (holding the mouse and moving frantically) — video
  panel should settle on the final position, not halfway through a
  stale seek.
- Pressing play near the end of the session — loops or stops cleanly.
- Tab backgrounded for 30 s then foregrounded — decoder recovers, no
  frame staleness, no runaway CPU.
- Resizing a panel while playing — no visible glitches.
- Adding a second PlotPanel via the `+` button and binding it to a
  different channel — renders independently.

## Performance targets

Measured on the reference environment with the primary fixture.

| Metric | Target |
|---|---|
| `open_file` (MCAP, 10 s 4K) | < 500 ms to channel list |
| `open_file` (MF4, 100 MB) | < 1 s to channel list |
| `fetch_range` for 10 s @ 1 kHz scalar | < 50 ms to Arrow bytes |
| Playback — dropped frames | < 1% over 10 s at 1× speed |
| Scrub seek settle | < 250 ms from drop to correct frame |
| Cursor tick end-to-end latency | < 16 ms (one rAF) |
| Signal panel render, 1 M points | < 16 ms redraw |
| Memory after session load | < 300 MB RSS for the tab |

Measured via:

- `performance.mark` / `performance.measure` at key seams (open, first
  frame, first Arrow batch).
- `VideoDecoder` reported queue stats for decoder back-pressure.
- DevTools Performance tab for frame timing and memory snapshots.

## Spike gate — Task T0.1

Before any UI work begins, `mf4-rs` must build for `wasm32-unknown-unknown`
and return channel metadata for a 100 MB MF4 within 1 s in a Web Worker
context. Specifically:

1. `cargo build --target wasm32-unknown-unknown -p mf4-rs` succeeds
   without patches that diverge from upstream (or with a documented patch
   set that we commit to).
2. A minimal test harness loads the sidecar MF4 via the wasm build and
   prints channel names + sample counts; total time from `load` to
   first output < 1 s.

If the spike fails, we do not proceed to M1; we revisit the architecture
(server-side reader, JS-side MF4 decoder, or scope reduction).

## Milestone gates

- **M0 → M1:** T0.1 (mf4 WASM) passes; T0.2 (WebCodecs + MCAP H.264
  keyframe decode) produces a single correct image.
- **M1 → M2:** Rust `Reader` trait implemented skeleton, Arrow IPC
  contract test passes round-trip with stub data.
- **M2 → M3:** Can open the three fixtures; channel registry populated;
  global time range correct to the nanosecond.
- **M3 → M4:** Transport state machine passes unit tests; scrubber
  updates `cursorNs` smoothly; play/pause/speed work on a stub.
- **M4 → M5:** PlotPanel renders 1 M points under the perf budget; Arrow
  path verified end-to-end for scalar + vector.
- **M5 → M6:** VideoPanel plays through the full 10-second fixture at
  1× within the perf budget; seek to any ref time settles under 250 ms.
- **M6 → release:** All e2e tests pass; all manual checks pass; bundle
  size within budget.
