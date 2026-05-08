# Test Audit — 2026-05-08

**Range:** `5ee30f0..36355f3` (7 commits)

## Summary

The audit window contains seven commits, all chore-class: daily docs sync,
daily code review, and the merge of yesterday's test-audit PR (#93). The
only non-doc change in the range is the test file
`apps/web/src/panels/mergeSeries.test.ts`, which gained one regression test
for the `mergeStepHold` upper-bound pre-allocation. No production source
files were touched in the range, so there are no new code paths to cover
and no new suspect-test surfaces.

The full suite is green (web 421/421, rust 67/67). The added test was
audit-validated by mutation: under-allocating the buffer
(`upper += 2` → `upper += 1` in `mergeSeries.ts:133`) made the test go red
on the strict `out.xs.length === 10` assertion (and incidentally broke a
sibling step-hold test by truncating its tail). The mutation was reverted
before any commit.

No new tests were added by this audit and no findings were raised, so
this is a report-only audit.

## Baseline

- `pnpm --filter web test --run` — **421 passed / 0 failed** (37 files).
- `cargo test --workspace` — **67 passed / 0 failed** (4 unit + 63 integration/doc).
- Coverage tool: **none configured.** Neither `cargo llvm-cov`, nor
  `vitest --coverage`, nor `c8`/`nyc` is wired up in `Cargo.toml`,
  `package.json`, `apps/web/package.json`, or any CI/script. Per the
  audit charter, I did not install one — diff-based gap analysis only.

## Added tests

None. No production code changed in the range, so there is nothing new to
exercise. The single test added in the range
(`mergeSeries.test.ts:199` — "pre-allocates enough buffer for a series
with many consecutive gaps") was authored upstream in commit `b7a2cd0`
inside the merged PR #93, not by this audit.

## Modified tests

None. No existing test in the range met the high bar for modification
(demonstrably wrong, unambiguous correct behavior, post-fix mutation
check). All existing tests left untouched.

## Findings

### Missing coverage
- None in the audited range. No production source diff means no new
  branches, exports, or error paths to cover.

### Suspect tests
- None. The one test added in the range is well-formed:
  - Strict `expect(out.xs.length).toBe(10)` — exact, not a range.
  - Strictly-ascending invariant on `xs` covers both the "buffer too
    small → trailing zeros" and "buffer too large → zero-fill at tail"
    failure modes.
  - Tail check (`xs[xs.length-1] === 30`, `out.ys[0][last] === 40`)
    pins the last real sample, which is the position most sensitive
    to truncation.
  - Mutation-confirmed against `mergeSeries.ts:133` (see Summary).

### Flaky patterns
- None observed. All tests in the range are deterministic, in-process,
  no timers, no network, no shared mutable globals.

### Edge cases
- The added test exercises the worst-case-every-interval scenario
  (`3·N − 2` augmented length). Sibling tests in the same `describe`
  block already cover the no-gap case, the single-real-gap case, the
  multi-series gap-marker interleave, and the leading-null-before-first-
  sample case. Coverage of the `mergeStepHold` augmented stream is
  thorough.
- `mergeStepHold`'s `epsilon = Math.max(threshold * 1e-6, 1e-9)` floor
  (`mergeSeries.ts:122`) has no dedicated test. The floor only matters
  for thresholds so small they would underflow against `lastX` in
  Float64; constructing such a case in a way that would *fail* without
  the floor (and *pass* with it) requires inputs at the precision edge
  of the type and is brittle. Listed for awareness, not as an
  actionable gap — the comment in the source already documents the
  intent and the regression surface is essentially unreachable in real
  data (`xs` are seconds-scale).

## Skipped

- Adding a test for the `epsilon` floor in `mergeStepHold`. Reason:
  cannot construct a deterministic input that distinguishes "with
  floor" from "without floor" output in a way that doesn't depend on
  IEEE-754 rounding mode or platform-specific sub-normal handling.
  Listed under Edge cases above for human review.
- Auditing `docs/**` and `sample-data/**` files in the diff: out of
  scope for a test audit.

## Stats

- Files touched (this audit): 0 test files modified, 0 production
  files modified, 2 doc files written (`2026-05-08-test-audit.md`,
  `test-audit-state.json`).
- Tests added (this audit): 0.
- Tests modified (this audit): 0.
- Coverage delta: n/a (no coverage tool configured).
- Suite size: web 421 tests across 37 files; rust 67 tests across the
  workspace. Unchanged from yesterday's baseline.
