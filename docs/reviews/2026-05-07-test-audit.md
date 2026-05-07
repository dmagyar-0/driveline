## 2026-05-07T02:13:00Z

# Test Audit — 2026-05-07

**Range:** `5ee30f03..f985b50d` (6 commits)

## Summary

Quiet day. The audit range contains zero changes to non-test source files —
all six commits are documentation, daily-review artefacts, the previous test
audit (PR #93 merge), and a state-file update recording its PR URL. The only
non-doc diff is the `pre-allocates enough buffer for a series with many
consecutive gaps` test added to `apps/web/src/panels/mergeSeries.test.ts` by
the previous audit, which I re-validated via mutation check (see below).

No new tests added, no existing tests modified, no findings raised. Skipping
the code-touching PR per the workflow's "no tests added/modified, no findings"
branch.

## Baseline

- Web (vitest): **421 passed / 0 failed** across 37 test files (~9 s).
- Rust (`cargo test --workspace`): **67 passed / 0 failed / 0 ignored** across
  unit + integration + doc tests (50 + 2 + 3 + 4 + 3 + 5; the remaining suites
  report `0 tests`).
- Coverage: no coverage tool configured in this repo (no
  `@vitest/coverage-*`, `c8`, `nyc`, or `cargo llvm-cov` wired into
  `package.json` / `Cargo.toml`). Per audit policy, no tooling installed; this
  audit relies on diff-based gap analysis only.

## Added tests

None.

## Modified tests

None.

## Findings

### Missing coverage

None. No production source changed in `5ee30f03..f985b50d`, so there is no new
surface to cover.

### Suspect tests

None observed in the changed file. The newly-added test
`mergeSeries.test.ts:199 "pre-allocates enough buffer for a series with many
consecutive gaps"` is well-formed: strict-equality assertion on `out.xs.length
=== 10`, plus presence checks for the three held-end markers and a strict-
ascending invariant on the output xs. Re-validated as part of this audit by
flipping `upper += 2` → `upper += 1` in `mergeSeries.ts:133` — the test went
red on `expect(out.xs.length).toBe(10)`; revert verified clean (`git diff`
empty).

### Flaky patterns

None.

### Edge cases

The `mergeStepHold` path remains under-exercised in some shapes that did not
appear in the audit diff and therefore are not in scope to add today, but are
worth noting for a future audit:

- Three-or-more series step-hold with interleaved gaps. Current suite tops out
  at two series in gap-threshold mode (`mergeSeries.test.ts:230`), where the
  k-way merge with marker queueing across `k` cursors is most likely to
  surface ordering bugs.
- Threshold-coincident timestamps where a real sample of one series lands at
  exactly `lastX + threshold` of another series' gap marker (only the single-
  series version is tested at `mergeSeries.test.ts:173`).

These are recorded under "Skipped" — they reflect untouched code, not a
regression risk introduced this range.

## Skipped

- Adding multi-series step-hold edge-case tests described above. The
  surrounding production code did not change in this audit range, so per the
  audit's scope rule ("for each changed file") these belong to a code-driven
  audit, not a daily run with no source diff.

## Stats

- Files touched (this audit): 0 source/test files; 2 docs files (this report
  and the state pointer).
- Tests added: 0
- Tests modified: 0
- Coverage delta: n/a (no coverage tool configured).
