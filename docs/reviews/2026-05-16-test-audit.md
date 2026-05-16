# Test Audit — 2026-05-16

**Range:** `3f1670e..975be6a` (3 commits)

## Summary

No source or test files changed in this range. The three commits since the previous audit (`3f1670e`) consist exclusively of documentation churn under `docs/reviews/`:

- `975be6a` — daily code review for 2026-05-15
- `be0f6bd` — merge of `test-audit-report/2026-05-15`
- `3065378` — daily test audit for 2026-05-15

With zero changes to production or test code, there is nothing new to cover, no new behavior to assert, and no diff-localized correctness risk to investigate. The audit was still run end-to-end against the established baselines so that any regression in the existing suite would surface.

## Baseline

| Suite                 | Result | Notes                                                          |
| --------------------- | ------ | -------------------------------------------------------------- |
| `pnpm --filter web test --run` (vitest) | 447 passed / 0 failed across 38 files | Stderr warnings about `getContext()` and "worker not initialised" are pre-existing in jsdom panel tests; tests still pass. |
| `cargo test --workspace` | 67 passed / 0 failed (50 + 2 + 3 + 4 + 3 + 5 unit/integration; 0 doc-tests) | Baseline matches prior audit. |
| Coverage tool         | not configured | No `cargo llvm-cov`, `@vitest/coverage-*`, or `c8` is wired into the repo — per audit policy, none was installed. |

## Added tests

_None._ The diff contains no source code, so no behavior exists for which a new test would be meaningful.

## Modified tests

_None._

## Findings

### Missing coverage

_None new._ No public API or branch was added in this range.

### Suspect tests

_None new._ No test files were touched.

### Flaky patterns

_None new._

### Edge cases

_None new._

## Skipped

Nothing was deferred — there was no candidate work to weigh.

## Stats

| Metric              | Value |
| ------------------- | ----- |
| Source files touched in range | 0 |
| Test files touched in range   | 0 |
| Tests added                   | 0 |
| Tests modified                | 0 |
| Coverage delta                | n/a (no tool configured) |
| Baseline suite status         | green (web 447/447, rust 67/67) |
