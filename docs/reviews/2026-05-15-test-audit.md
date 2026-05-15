# Test Audit — 2026-05-15

**Range:** `85aded8..3f1670e` (4 commits)

## Summary

The audit window contains only documentation changes — book edits, daily
review/sync log additions, and state-file bumps. No application source
files, test files, or build configuration were touched. The baseline test
suite is green and the diff offers no surface for new tests, mutation
checks, or coverage analysis. No changes were made to the test corpus.

## Baseline

- `pnpm test:web`: **447 passed / 0 failed** across 38 test files
  (vitest 2.1, jsdom, 10.62s).
- `cargo test --workspace`: **67 passed / 0 failed** across the
  `data_core`, `mp4_reader`, and `wasm_bindings` crates.
- Coverage tool: **no coverage tool configured** (no
  `@vitest/coverage-*` dependency in `apps/web/package.json`, no
  `cargo-llvm-cov` invocation in the repo). Per the audit rules no new
  tooling was installed; analysis fell back to diff-based gap review.

## Added tests

None — the range introduces no testable behavior change.

## Modified tests

None — no existing test was demonstrably wrong against the new diff.

## Findings

### Missing coverage

None. Every changed file is prose documentation or a JSON state record
authored by previous audit/sync jobs; there is no executable surface to
cover.

### Suspect tests

None identified.

### Flaky patterns

None identified in this range. (`apps/web/src/timeline/playback.test.ts`
and `apps/web/src/workers/videoDecodeOps.test.ts` use deterministic fake
clocks / inlined fixtures and remain stable — they were vetted in the
prior audit window and are unchanged here.)

### Edge cases

None applicable.

## Skipped

- Docs-only edits in `docs/book/10-timeline-and-playback.md` and
  `docs/book/11-run-test-ship.md` rename the public cursor-write API in
  prose (`setCursor` → `advanceCursor` for rAF writes). The actual code
  rename (`apps/web/src/timeline/playback.ts`, `state/store.ts`) landed
  in the previous audit window (`9e2fd84..85aded8`) and is already
  exercised by `playback.test.ts`. Nothing new to add here.

## Stats

- Files touched (audit code/test changes): **0**
- Tests added: **0**
- Tests modified: **0**
- Coverage delta: **n/a** (no coverage tool configured; no source diff)
- Baseline status: **green** (447 web + 67 rust = 514 tests passing)
