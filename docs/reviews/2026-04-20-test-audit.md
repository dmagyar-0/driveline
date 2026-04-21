# Test Audit — 2026-04-20

**Range:** `7ddcb44..62b1ca3` (56 commits)

## Summary

Initial seed of the repo through M1/M2: the full Rust + Web toolchains,
reader crates (`McapReader`, `Mf4Reader`, `Mp4SidecarReader`), the data-core
Arrow contract, the Zustand session store, the T3 transport slice + rAF
playback loop, T4 PlotPanel decimation, and T6 layout/binding persistence.
Baseline is green. Audit focused on the three modules with non-trivial
branching that had thin surface coverage: the `NoopReader` / `TimeRange`
public contract, `bucketFiles`, `mergeSeries` k-way merge for k ≥ 3, and
`attachLayoutPersistence`. No test was modified or deleted.

## Baseline

- **Web (vitest):** 105 tests passing, 0 failing across 12 files.
- **Rust (cargo workspace):** 67 tests passing, 0 failing across 6 test
  targets (55 unit + 2 + 3 + 4 + 3 integration).
- **Coverage tool:** none configured (no `cargo-llvm-cov`, `vitest
  --coverage`, `c8`, or `nyc` in the workspace). Falling back to
  diff-based gap analysis only, per audit policy.

## Added tests

| File:test                                                                                            | What it covers                                                                     | Mutation check |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------- |
| `crates/data-core/tests/noop_reader.rs::noop_video_stream_defaults_to_unsupported_kind`              | Trait default body of `Reader::video_stream` on a non-video reader                 | ✅ caught changing default to `Err(ChannelNotFound)` |
| `crates/data-core/tests/noop_reader.rs::time_range_empty_constant_is_empty`                          | `TimeRange::empty().is_empty()` — public helper, only hit transitively before     | ✅ caught flipping `<=` → `<` and `<=` → `>`         |
| `crates/data-core/tests/noop_reader.rs::time_range_positive_width_is_not_empty`                      | Positive-width range reports `is_empty() == false`                                 | ✅ caught flipping `<=` → `>`                        |
| `crates/data-core/tests/noop_reader.rs::time_range_zero_width_is_empty`                              | Zero-width range (start == end) reports `is_empty() == true`                       | ✅ caught flipping `<=` → `<`                        |
| `crates/data-core/tests/noop_reader.rs::time_range_inverted_bounds_are_empty`                        | Inverted bounds (end < start) report `is_empty() == true`                          | ✅ caught flipping `<=` → `>`                        |
| `apps/web/src/state/bucket.test.ts::bucketFiles > matches extensions case-insensitively`             | `.toLowerCase()` step of the extension match — uppercase `.MCAP` / `.MF4` still bucket | ✅ caught removing `.toLowerCase()`              |
| `apps/web/src/state/bucket.test.ts::bucketFiles > pairs the matching mp4 and errors on the unpaired one` | Partial pairing: one mp4 has a sidecar, one does not                              | ✅ caught removing the missing-sidecar error path    |
| `apps/web/src/panels/mergeSeries.test.ts::mergeSeries > merges three series with partial overlap into a single union` | k-way merge path for k = 3 (k = 2 can collapse to a simpler interleave) | ✅ caught clamping `k = min(inputs.length, 2)`   |
| `apps/web/src/layout/persist.test.ts::attachLayoutPersistence > writes the current slice when any of the three tracked refs change` | Write path on `layoutJson` change                                          | ✅ caught short-circuiting to always-skip            |
| `apps/web/src/layout/persist.test.ts::attachLayoutPersistence > skips the write when the tracked refs are all identical to the snapshot` | Skip-on-unchanged fast path                                                 | ✅ caught removing the early-return guard            |
| `apps/web/src/layout/persist.test.ts::attachLayoutPersistence > unsubscribes on the returned dispose handle` | Dispose function returned from `attachLayoutPersistence`                   | ✅ caught returning an inert dispose                 |
| `apps/web/src/layout/persist.test.ts::attachLayoutPersistence > writes when plotBindings is a new object, even with equal contents` | Pins adapter as reference-based, not deep-equal                                 | ✅ caught short-circuiting to always-skip            |
| `apps/web/src/layout/persist.test.ts::attachLayoutPersistence > is a no-op when storage is undefined` | `if (!storage) return () => undefined;` guard                                      | ✅ caught removing the undefined-storage guard       |

## Modified tests

None. No test in the audited range was demonstrably wrong.

## Findings

### Missing coverage

- **`apps/web/src/panels/seriesFromArrow.ts:26-30` — zero-row and missing-column branches are uncovered.** `seriesFromArrow.test.ts` only exercises a populated fixture. A zero-row Arrow IPC and a schema without the `ts` / `value` columns both go down the `return EMPTY` path with no test. Severity: **Low**. Suggestion: build a minimal Arrow IPC via `apache-arrow` in-test (a zero-row RecordBatch for the first case, a mislabelled schema for the second) and assert `.xs.length === 0`.
- **`apps/web/src/unsupportedSplash.ts:34-37` — `renderUnsupportedSplash(root)` is uncovered.** Vitest's env is `node`, so a `HTMLElement` mock would be needed (`{ set innerHTML(v: string) { … }, set className(v: string) { … } }`). Severity: **Low**. The HTML constant `unsupportedSplashHtml` is covered.
- **`apps/web/src/panels/palette.ts:22-30` — `colorFor` coverage verifies only "is in palette" and "is deterministic".** A known-input → known-output check for at least one channel id would pin the FNV-1a constants; right now any reshuffle of the palette or changing the seed goes undetected as long as a collision keeps the palette covered. Severity: **Very low** (colour assignment is cosmetic).
- **`crates/data-core/src/reader.rs:38-45` — `Reader::video_stream` default body is now covered on `NoopReader`.** The three real readers (`Mf4Reader`, `Mp4SidecarReader`, `McapReader`) override it; `McapReader`'s override, in particular, has a `keyframe_index` carry-over from M2 that has no integration test yet (the T5.1 mcap-video path is still TODO). Severity: **Low** — called out because future M5 work will need a fixture with an H.264 `foxglove.CompressedVideo` channel.

### Suspect tests for human review

- **`apps/web/src/panels/palette.test.ts:9-12` — `"is deterministic for the same id"` is a tautology for any pure function.** It would only fail if `colorFor` called `Math.random()` or consulted external state; a memoisation bug would slip through. Non-harmful but low-value.
- **`apps/web/src/panels/mergeSeries.test.ts:28-31` — `"passes the single-series case through without copying"` asserts identity (`out.xs === s.xs`, `out.ys[0] === s.ys`) on the fast path.** This pins an intentional zero-copy behaviour — legitimate and noted, just flag that if the fast path is ever removed this test is the one load-bearing assertion catching it.

### Flaky patterns

- **`apps/web/src/state/store.test.ts` and `apps/web/src/timeline/playback.test.ts` both call `useSession.getState().clear()` in `beforeEach`.** They share the singleton Zustand store across tests. Vitest runs tests in a file sequentially, so this is safe as-is, but a future switch to `--threads` per-file or parallelisation within a file would surface race conditions. Suggestion (low priority): wrap the store in a factory the test can instantiate per-test, or add a `vitest.config.ts` note pinning the isolation level.
- No network, wall-clock, or filesystem ordering dependencies observed in the suite. `playback.test.ts` uses a hand-rolled fake clock, which is the pattern to prefer.

### Edge cases

- **`bucketFiles` has no test for mixed-case sidecars.** E.g., `drive.MP4` + `drive.mp4.timestamps` — the current implementation keys sidecars by the (case-preserved) mp4 name slice, so this pair would NOT match. Intentional? Unclear from the code or docs. Left as a finding rather than a test.
- **`formatAbsolute(ns)` with negative ns.** Not tested. Current behaviour: `ns / 1_000_000n` for negative `ns` is Number-safe (bigint division rounds toward zero), so `Date(-N)` returns a pre-1970 wall-clock. Behavior is defined but undocumented. Severity: **Very low**.

## Skipped

- **`renderUnsupportedSplash` DOM mock.** Could mock `HTMLElement` but the return is void and the only observable is the mutation of the passed-in element. Single-line coverage gain vs. test brittleness — left as a finding.
- **`seriesFromArrow` zero-row path.** Would require building a zero-row Arrow IPC in the test rather than loading the existing fixture. Do-able but the extra surface competes with an in-fixture representation; left as a finding.
- **`VideoPanel`, `VideoPanelContainer`, `PlotPanel`, `Workspace`, `ChannelPicker`, `Transport`, `App` React components.** No component-render tests exist (vitest env is `node`, no jsdom). Adding JSX rendering tests would require introducing `@testing-library/react` + jsdom — new tooling, out of scope per audit policy.
- **Worker entry points (`dataCore.worker.ts`, `videoDecode.worker.ts`) and `workerClient.ts`.** Exercised by Playwright e2e specs; no unit test layer. Out of scope.

## Stats

- **Files touched:** 4 test files (1 new, 3 modified).
- **Tests added:** 13 (5 Rust, 8 TypeScript).
- **Tests modified:** 0.
- **Tests deleted:** 0.
- **Web suite:** 105 → 113 (+8).
- **Rust suite:** 67 → 72 (+5).
- **Coverage delta:** n/a (no coverage tool configured).
