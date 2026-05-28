# Test Audit — 2026-05-28

**Range:** `67ece17..df8e1ee` (2 commits)

## Summary

The two commits in this range are the merges of the previous daily code-review
PR (#144) and test-audit PR (#143). The diff is entirely confined to
`docs/reviews/` — two new markdown reports and the two state JSON files. No
source code, no tests, no build/config changes. Nothing to audit beyond
re-verifying the baseline.

```
docs/reviews/2026-05-27-review.md     | 193 ++++++++++++++++++++++++++++++++++
docs/reviews/2026-05-27-test-audit.md | 130 +++++++++++++++++++++++
docs/reviews/daily-review-state.json  |   6 +-
docs/reviews/test-audit-state.json    |   6 +-
4 files changed, 329 insertions(+), 6 deletions(-)
```

Source/test diff filtered to `*.ts`, `*.tsx`, `*.rs`, `*.py`: **empty**.

## Baseline

- `pnpm --filter web test --run` — **447 passed / 0 failed** across 38 files
  (vitest, 11.95 s). The stderr "session store: worker not initialised" and
  "HTMLCanvasElement.getContext()" messages are expected behaviour exercised
  by existing tests, not failures.
- `cargo test --workspace` — **67 passed / 0 failed / 0 ignored** across the
  `data-core` and `wasm-bindings` crates and their integration tests
  (`mcap_reader`, `mf4_reader`, `mp4_reader`, `noop_reader`).
- Coverage: **no coverage tool configured** in the repo (no `cargo-llvm-cov`,
  no `vitest --coverage`, no `c8`). Per the audit charter, falling back to
  diff-based gap analysis only. The diff contains no source code, so there
  is no coverage gap to assess.

## Added tests

None. The diff has no source-code surface that could be exercised by a new
test, so any test added today would be unrelated to `LAST..HEAD` and outside
the audit scope.

## Modified tests

None.

## Findings

### Missing coverage
- None applicable to this range.

### Suspect tests
- None.

### Flaky patterns
- None observed in the baseline run; all 514 tests passed deterministically.

### Edge cases
- None to flag — no source behaviour changed.

## Skipped

- Mutation-based test additions for previously-uncovered modules. The audit
  charter scopes additions to "the range `LAST..HEAD`" and forbids adding
  tests for behaviour you're guessing at. With zero source diff, any add
  would be speculative and out of scope. Backlog work for an explicit
  coverage-improvement task, not for the daily delta audit.

## Stats

- Files touched (by this audit): **0 test files**, **1 report**, **1 state**.
- Tests added: **0**
- Tests modified: **0**
- Coverage delta: n/a (no tool configured; no source diff)
- Baseline tests: **514 passing** (447 vitest + 67 cargo)
