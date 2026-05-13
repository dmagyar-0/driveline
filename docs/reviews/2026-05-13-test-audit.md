# Test Audit — 2026-05-13

**Range:** `fa9641e..9e2fd84` (4 commits)

## Summary

The audited range contains zero production source changes. The diff is:

- `apps/web/src/panels/videoReadiness.test.ts` — one test added by the prior daily audit (`logs subscriber errors via console.warn so a swallowed-update regression is visible`).
- `docs/reviews/2026-05-12-{review,test-audit}.md` — review/audit reports.
- `docs/reviews/{daily-review,test-audit}-state.json` — state files (HEAD SHA + PR URL bookkeeping).

Because no production code changed, there are no new branches, public APIs, or error paths to cover. The audit therefore reduces to (a) verifying the one already-landed test is mutation-correct and (b) re-checking the carry-over finding from the 2026-05-12 audit. Both confirmed; no new tests added or modified this run.

## Baseline

- `pnpm --filter web test --run` — **38 files / 447 tests passing, 0 failed.**
- `cargo test --workspace` — **67 tests passing, 0 failed** (across `data_core` lib + integration suites and `wasm_bindings`).
- Coverage tool: **no coverage tool configured** in `package.json`, `apps/web/package.json`, `pnpm-workspace.yaml`, or `Cargo.toml`. Per the playbook, falling back to diff-based gap analysis only — not installing one.

## Added tests

None this audit.

The single test that landed in the range (`apps/web/src/panels/videoReadiness.test.ts:156`, `logs subscriber errors via console.warn so a swallowed-update regression is visible`) was added by the prior daily audit. Re-validated here as part of the diff review:

| File | Test | Mutation check (this audit) |
|------|------|-----------------------------|
| `apps/web/src/panels/videoReadiness.test.ts:156` | `logs subscriber errors via console.warn so a swallowed-update regression is visible` | **Passed.** Replaced the literal string `"videoReadiness: subscriber threw"` in `videoReadiness.ts:51` with `"MUTATION: subscriber threw"`; the test failed with `expected "warn" to be called with arguments: [...]` (received the mutated message). Reverted; suite green again. |

## Modified tests

None. No existing test in the range was demonstrably wrong, and the modification bar (test wrong + behavior unambiguous + still passes after fix + mutation-survives) is not met for anything in the diff.

## Findings

### Missing coverage

- _None of note in the range._ No production code changed, so no new symbols or branches need pinning. The carry-over finding from 2026-05-12 about the `setTimeout` fallback in `scheduleNotify` (`apps/web/src/panels/videoReadiness.ts:57`) still stands but is unchanged by this range — listed under **Skipped** below for continuity.

### Suspect tests

- `apps/web/src/panels/videoReadiness.test.ts:143` — `subscriber callbacks that throw do not break the notify loop` lets an un-mocked subscriber throw, which (since the 2026-05-12 source change in `videoReadiness.ts:51`) routes through `console.warn` and writes `videoReadiness: subscriber threw Error: boom` to stderr on every run. **Severity: low** — this is correct production behavior, not a test bug, just stderr noise. Concrete suggestion: add `const warn = vi.spyOn(console, "warn").mockImplementation(() => {});` at the top of that test (and `warn.mockRestore()` at the end), mirroring the silencing pattern at `videoReadiness.test.ts:163`. Held back rather than modifying because the modification bar (test demonstrably wrong) is not met — it's a polish item for human review.

### Flaky patterns

- _None observed._ The new test uses `vi.spyOn(console, "warn")` with `mockRestore()` and runs inside the existing synchronous-rAF stub from the suite's `beforeEach`; no wall-clock, network, or shared mutable state introduced.

### Edge cases

- _None opened in this range._ The carry-over `setTimeout`-branch coverage gap from 2026-05-12 is still skipped (see **Skipped**); nothing else in the diff exposes new edge cases.

## Skipped

- **Carry-over from 2026-05-12:** an explicit test pinning the `setTimeout` fallback branch in `scheduleNotify` (`apps/web/src/panels/videoReadiness.ts:57`). Still skipped this audit for the same reason — the fallback exists for jsdom + Vitest node environments and is *de facto* exercised by every test that mounts the registry; adding a `vi.useFakeTimers()` + delete-rAF-stub pin would be defense-in-depth rather than coverage of code changed in this range, and the diff contains no related change to anchor it. Recorded for human consideration if the registry's scheduling shape ever changes.
- **Polish for `videoReadiness.test.ts:143`:** silencing `console.warn` (see **Suspect tests** above). Skipped because it modifies an existing test for stylistic reasons, not correctness — outside the modification bar.

## Stats

- Files touched: **0** (no test files added or modified by this audit)
- Tests added: **0**
- Tests modified: **0**
- Tests deleted: **0**
- Coverage delta: n/a (no coverage tool configured)
- Web suite: 447 → 447 passing
- Cargo suite: 67 → 67 passing
