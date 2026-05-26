# Test Audit — 2026-05-26

**Range:** `07f8220..cf4700b` (6 commits)

## Summary

The audit window contains six commits, but every change is restricted to
documentation and audit-state bookkeeping:

- `cf4700b` docs: add `CLAUDE.md` with project context for AI agents (#138)
- `2768b97` chore(review): daily code review 2026-05-25 (#137)
- `5ae6974` merge of `test-audit-report/2026-05-25-state`
- `186b0cb` test: record PR URL for 2026-05-25 audit (state file only)
- `0b1e814` merge of `test-audit-report/2026-05-25`
- `15b6ea6` test: daily test audit 2026-05-25 (report file only)

No production source files (`apps/web/src/**`, `crates/**/src/**`) and no
test files (`*.test.ts(x)`, `crates/**/tests/**`, `apps/e2e/**`) were
modified in this range. The only files touched are `CLAUDE.md`,
`docs/reviews/2026-05-25-review.md`, `docs/reviews/2026-05-25-test-audit.md`,
`docs/reviews/daily-review-state.json`, and
`docs/reviews/test-audit-state.json`. Diff-based gap analysis therefore
yields zero coverage gaps and zero new behaviours requiring tests.

The baseline was confirmed green prior to writing this report.

## Baseline

- `cargo test --workspace`: **PASS** — 50 (data-core unit) + 2 + 3 + 4 + 3 + 5
  = 67 tests across `data-core` unit + integration suites plus
  `wasm_bindings` (0 tests). 0 failures, 0 ignored.
- `pnpm test:web`: **PASS** — 38 test files, 447 tests, 0 failures.
- Coverage: no coverage tool configured in the repository (no
  `cargo-llvm-cov`, no `vitest --coverage`/`c8` configuration). Per the
  audit policy, none was installed; analysis is diff-based.

## Added tests

None. The audit range contains no production code changes, so no new
behaviour exists to cover.

## Modified tests

None.

## Findings

### Missing coverage

None applicable — no source code changes in the audit range.

### Suspect tests

None identified during the diff scan (no test files modified).

### Flaky patterns

None identified during the diff scan.

### Edge cases

None applicable — no new branches or inputs introduced.

## Skipped

Nothing was skipped on confidence grounds. The audit range is
docs-only, so there were no candidate tests to evaluate.

## Stats

- Files touched in range: 5 (all documentation / state JSON)
- Tests added: 0
- Tests modified: 0
- Coverage delta: n/a (no coverage tool configured; no code changes)
