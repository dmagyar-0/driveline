# Test Audit — 2026-04-25

**Range:** `62b1ca3..e596ce4` (21 commits)

## Summary

Daily delta covers: extraction of pure helpers from
`dataCore.worker.ts` / `videoDecode.worker.ts` (T6.4 → T6.5 work that
landed in this window), the new `apps/web/src/perf.ts` shim wired into
the store + transport + plot/video panels for T6.3 perf budgets,
substantial rework of the mp4 sidecar reader (text format, AVCC →
Annex-B conversion, SPS/PPS prepend), MCAP video stream support, and
two new React-Testing-Library suites for `<Transport />` and
`<PlotPanel />`. Most modules already ship with strong unit tests; the
audit zooms in on `perf.ts` (zero coverage at HEAD) and three branch
gaps in `mp4_sidecar.rs`'s text parser + `avcc_to_annexb` walker. No
test was modified, none deleted, and every added test was mutation-
verified before commit.

## Baseline

- **Web (vitest):** 145 tests passing, 0 failing across 16 files.
- **Rust (cargo workspace):** 62 tests passing, 0 failing across 6 test
  targets (45 unit + 2 + 3 + 4 + 3 + 5 integration).
- **Coverage tool:** none configured (no `cargo-llvm-cov`, `vitest
  --coverage`, `c8`, or `nyc` in the workspace). Falling back to
  diff-based gap analysis only, per audit policy.

## Added tests

| File:test                                                                                            | What it covers                                                                       | Mutation check |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------- |
| `apps/web/src/perf.test.ts::mark > records a 'mark' entry under the supplied name`                   | `performance.mark()` is reached on the supplied name                                 | ✅ caught dropping the body of `mark()`              |
| `apps/web/src/perf.test.ts::measure > records a 'measure' entry between two existing marks`          | Happy-path `performance.measure(name, start, end)` round-trip                        | ✅ caught dropping `mark()` (precondition broke)     |
| `apps/web/src/perf.test.ts::measure > swallows the DOMException when the start mark is missing`      | The deliberate `try/catch` in `measure()` for missing-mark `DOMException`            | ✅ caught removing the `try/catch` wrapper           |
| `apps/web/src/perf.test.ts::timed > emits ':start' / ':end' marks and a measure`                     | `timed()` decorator records both bracket marks + the named measure                   | ✅ caught dropping the body of `mark()`              |
| `apps/web/src/perf.test.ts::timed > re-throws the wrapped op's rejection but still emits the end mark + measure` | `try/finally` ensures end mark + measure on the rejection path             | ✅ caught replacing `try/finally` with linear await  |
| `apps/web/src/perf.test.ts::snapshot > returns the current entries plus a memory placeholder`        | `snapshot()` exposes a structural copy of `getEntries()` + the optional memory shape | ✅ caught dropping `mark()` (entries snapshot empty) |
| `apps/web/src/perf.test.ts::installPerfHooks > is a silent no-op when 'window' is undefined`         | Pins the `typeof window === "undefined"` early-return guard                          | ✅ caught removing the early-return guard            |
| `crates/data-core/src/mp4_sidecar.rs::tests::rejects_sidecar_with_extra_tab_field`                   | `splitn(3, '\t')` + `parts.next().is_some()` extra-column branch                     | ✅ caught replacing the guard with `let _ = parts.next();` |
| `crates/data-core/src/mp4_sidecar.rs::tests::rejects_sidecar_with_embedded_empty_line`               | Empty-line rejection in `parse_sidecar_text` (`if line.is_empty()`)                  | ✅ caught dropping the empty-line guard              |
| `crates/data-core/src/mp4_sidecar.rs::tests::avcc_to_annexb_drops_zero_length_nals`                  | `nal_len == 0 { continue; }` skip in `avcc_to_annexb`                                | ✅ caught removing the zero-length skip              |

## Modified tests

None. No test in the audited range was demonstrably wrong.

## Findings

### Missing coverage

- **`apps/web/src/state/store.ts:303-340` — `fetchChannelRange` perf
  marks aren't tested.** The route to `mcapFetchRange` / `mf4FetchRange`
  is unit-tested by `store.test.ts:378-426`, but the surrounding
  `mark(perfStart)` / `measure(...)` calls (added in this range) are
  fire-and-forget. A mutation that swaps the mark names (e.g.
  `fetch-range:start` → `fetch-range:s`) would silently break the
  Playwright `perfBudgets.spec.ts` lookup. Severity: **Low**.
  Suggestion: read `performance.getEntriesByName('fetch-range:<id>')`
  inside the existing `routes mcap channels …` test.
- **`apps/web/src/timeline/playback.ts:79-86` — `tick:start` /
  `tick:end` marks are uncovered.** Same shape as the store finding;
  the tick body itself is exercised by the synchronous-rAF tests in
  `playback.test.ts`, but no test asserts that the perf marks fire on
  every tick. Severity: **Very low** (advisory marks; a regression
  loses the tick budget signal but doesn't break playback).
- **`apps/web/src/panels/PlotPanel.tsx:316-321` —
  `plot:render:<panelId>` measure name format is not pinned.** A
  rename here would silently invalidate the perfBudgets spec's
  `plot:render:` filter. Severity: **Very low**. Suggestion: in the
  existing `PlotPanel.test.tsx`, after the seedSession render,
  `expect(performance.getEntriesByName('plot:render:test-panel'))`
  to be non-empty.
- **`crates/data-core/src/mp4_sidecar.rs::Mp4SidecarReader::video_stream`
  — the no-keyframe branch (`sync_indices.is_empty()` → empty stream)
  is uncovered.** Reachable only by an mp4 with zero sync samples; the
  helper `synth_mp4` always marks index 0 sync, so synthesising the
  no-keyframe case would require a custom mp4 writer. Severity: **Low**
  (the contract mirrors `McapReader::video_stream`, which has the
  same path covered by the empty-keyframe-index branch via direct test
  setup). Listed for future work rather than added: synthesising an
  H.264 mp4 with no IDR sample is non-trivial via the `mp4` crate's
  `Mp4Writer`.
- **`apps/web/src/workers/dataCore.worker.ts` and
  `videoDecode.worker.ts`** still have no unit-test layer. The
  extracted `normalise.ts` / `videoDecodeOps.ts` (which moved most of
  the logic out) are now well-covered, but the worker entry shells
  (Comlink wiring, the dataCore port bridging in
  `videoDecode.worker.ts`) are exercised only by the e2e specs. Out
  of scope for this audit per policy.

### Suspect tests for human review

- **`apps/web/src/state/store.test.ts:222-244` —
  `serialises overlapping openFiles calls` uses `setTimeout(r, 0)`
  to flush microtasks.** This relies on the test runner not changing
  scheduling; under a future migration to `vi.useFakeTimers()` the
  test would deadlock waiting on the resolver. Non-actionable today
  but worth flagging: the comment explicitly says "queued behind"
  and the assertion captures only the post-resolve order, so a
  scheduling-drift mutation would not be caught.
- **`apps/web/src/panels/PlotPanel.test.tsx:255-282` — the test
  asserts that both fixture rows resolve to `value === 1` at cursor
  `1.0 s`.** This is correct for the current `IPC_BYTES` fixture
  (`ts = [1.0, 1.01, 1.02] s`), but the fixture path
  (`test-fixtures/arrow_scalar.ipc`) is shared with
  `seriesFromArrow.test.ts` and `arrow.contract.test.ts`. Flag: any
  re-generation of the fixture must update three independent test
  files in lockstep; a contract mismatch would likely show up as a
  PlotPanel test failure first since it is the most timing-sensitive.

### Flaky patterns

- **The new `Transport.test.tsx` and `PlotPanel.test.tsx` install a
  global `Element.prototype.getBoundingClientRect` override in
  `beforeEach` and never explicitly restore it.** `cleanup()` in
  `afterEach` only unmounts the React tree; the prototype patch
  persists into the next test file. Vitest's `node` environment is
  fresh per file, so cross-file leakage is not currently an issue,
  but a future move to `--isolate=false` would surface it. Suggestion
  (low priority): cache the original prototype getter and reinstate
  it in `afterEach`.
- No new network, wall-clock, or filesystem-ordering dependencies in
  the suite. The `perf.ts` tests use `performance.clearMarks()` /
  `clearMeasures()` in `beforeEach` and `afterEach` so prior entries
  cannot leak between tests.

### Edge cases

- **`apps/web/src/perf.ts::measure` with only a start mark (no end
  mark) and no matching mark in the buffer** is not directly tested
  here — the swallow-on-missing-mark test covers the with-end-mark
  path. Adding the second arity would be one extra line; left as a
  finding because the catch is unconditional and the existing test
  still pins the swallow contract.
- **`avcc_to_annexb` with a length-prefixed NAL where `nal_len`
  reaches `usize::MAX`** is guarded by `i.checked_add(nal_len)` and
  documented; not added because the test would just exercise the
  `Some(e) if e <= bytes.len() => e` arm with absurd input. The
  existing truncation test covers the fallible path.
- **`parse_sidecar_text` with `\r` only (no `\n`)** is a corner that
  `str::lines()` already handles deterministically (treats `\r` as
  part of the content); not added since a regression here would
  surface as a frame-index mismatch via the existing tests.

## Skipped

- **No-keyframe `Mp4SidecarReader::video_stream` test.** Would
  require a custom mp4 fixture with no sync samples; the `mp4` crate's
  `Mp4Writer` doesn't expose a "force is_sync = false on every sample"
  configuration cleanly. Listed under Findings.
- **Coverage of `mcap.rs::is_keyframe` on an empty buffer / pure
  start-code-only buffer.** The function is well-defined for both
  (returns `false`) and the existing four-case test pins the relevant
  branches. A new test would be tautological given the loop guard.
- **`apps/web/src/panels/VideoPanel.tsx`** still has no unit test;
  it depends on `HTMLCanvasElement.captureStream` and a real
  `VideoDecoder`. The extracted helpers in `videoDecodeOps.ts` are
  covered. Listed as out of scope.
- **`apps/web/src/App.tsx`'s `installPerfHooks()` call** is exercised
  only via `installPerfHooks > is a silent no-op when 'window' is
  undefined`. Calling it under jsdom + asserting the
  `__drivelinePerf` install would require a separate test file with
  `// @vitest-environment jsdom`; deferred — the install path is one
  line and the consumer (`apps/e2e/tests/perfBudgets.spec.ts`) pins
  the contract end-to-end.

## Stats

- **Files touched:** 2 test files (1 new, 1 modified).
- **Tests added:** 10 (3 Rust, 7 TypeScript).
- **Tests modified:** 0.
- **Tests deleted:** 0.
- **Web suite:** 145 → 152 (+7).
- **Rust suite:** 62 → 65 (+3).
- **Coverage delta:** n/a (no coverage tool configured).
