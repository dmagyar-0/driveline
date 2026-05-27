# Test Audit — 2026-05-27

**Range:** `cf4700b..67ece17` (10 commits)

## Summary

The audit window contains ten commits, all of which sit outside the
production source tree:

- `67ece17` Merge PR #142 (dataset-visualization-camera-signals)
- `50fa2df` skill(verify-comma2k19): one-command end-to-end demo verifier
- `07e480a` demo(e2e): add dashcam to the split-by-topic 3-panel layout
- `0e67e44` demo(e2e): split one segment across 4 files and plot on 2 panels
- `aabc528` demo(e2e): plot 3 MCAPs + 3 MF4s across two panels
- `20b2a30` demo(e2e): plot a comma2k19 channel from MCAP and MF4 on one panel
- `8e84732` demo(e2e): pair comma2k19 dashcam with CAN signals
- `139b614` docs: add goal-driven execution note to CLAUDE.md
- `d2aec45` chore(review): daily code review 2026-05-26
- `554f0ba` test: daily test audit 2026-05-26

The only non-doc, non-data file touched in either `apps/web/src/**` or
`crates/**/src/**` is the new e2e spec
`apps/e2e/tests/_demo-comma2k19-video.spec.ts`. Its leading-underscore
filename keeps it out of Playwright's default CI run — it's an
interactive, fixture-gated demo invoked only when the comma2k19 corpus
is materialised locally. The Python fixture-conversion scripts
(`scripts/convert_comma2k19_to_{mcap,mf4}.py`) are dev-time utilities,
and the repository has no Python test infrastructure (no `pyproject.toml`,
no `pytest.ini`, no `conftest.py`, no Python deps wired into
`package.json` or `Cargo.toml`).

Diff-based gap analysis therefore yields zero coverage gaps in shipped
product code. No tests are added or modified.

## Baseline

- `pnpm test:web`: **PASS** — 38 test files, 447 tests, 0 failures
  (Duration 9.21s).
- `cargo test --workspace`: **PASS** — 50 (data-core unit) + 2 + 3 + 4 +
  3 + 5 = 67 tests across data-core unit + integration suites plus
  `wasm_bindings` (0 tests). 0 failures, 0 ignored.
- Coverage: no coverage tool configured (no `cargo-llvm-cov`, no
  `vitest --coverage`/`c8` wiring). Per the audit policy, none was
  installed; analysis is diff-based.

## Added tests

None. The only production-tree file changed in the range is itself a
test spec (`_demo-comma2k19-video.spec.ts`). It demonstrates dashcam +
multi-format signal alignment against the real-world comma2k19 corpus
and relies on locally-built fixtures referenced by
`sample-data/realworld/README.md`. There is no behaviour in shipped
source code for the audit to add coverage for.

## Modified tests

None.

## Findings

### Missing coverage

- **`scripts/convert_comma2k19_to_mcap.py` `--only` validation
  (lines 152–159)** — the new `--only` argument exits with a non-zero
  status on unknown group names. There is no automated test that
  exercises that error path or the happy path (the gated split-by-topic
  e2e spec verifies it implicitly by depending on fixtures the script
  produces, but doesn't pin behaviour). Severity: **low**. Suggested
  remediation: add a Python test harness in a follow-up — out of scope
  for this audit because no Python test runner is configured in the
  repo, and the audit policy forbids installing new tooling.
- **`scripts/convert_comma2k19_to_mcap.py` `--segment-offset-seconds`
  (lines 122–134, 185–187)** — the offset is added to the parsed
  segment-start ns. Behavior is currently covered only by the
  underscore-prefixed e2e specs that consume the output. Same
  recommendation: defer until a Python test runner is configured.
- **`scripts/convert_comma2k19_to_mf4.py` (new, 242 lines)** — has no
  automated tests at all. Same constraint applies; surface-level testing
  via the gated e2e specs is the current safety net.

### Suspect tests

None identified in the audit range. The new e2e spec uses gated
fixture-existence checks (`test.skip(!existsSync(...))`) so it cannot
silently no-op for the wrong reason, and each test asserts a concrete
panel-state outcome (`waitForPlotSeries`, `getPlotPanelSeriesStats`,
`videoLastBlitPtsNs`) rather than a screenshot-only smoke.

### Flaky patterns

- **`paintAndSettle()` uses `page.waitForTimeout(800)`** at
  `apps/e2e/tests/_demo-comma2k19-video.spec.ts:116`. Wall-clock
  dependencies are normally a flake source, but the spec is
  underscore-prefixed and intentionally excluded from CI default runs
  — it exists for manual demo capture. Severity: **info / acceptable
  for current scope**. If the spec is ever promoted into CI, the fixed
  800 ms settle should be replaced with a polling assertion on a
  concrete signal (e.g. uPlot frame counter, perf mark count).

### Edge cases

- **Last test ("splits one segment + dashcam video across 3 panels",
  line 661)** does not assert source-diversity at the end (the
  preceding `splits one segment across 4 files` test at line 488 does
  via `expect(files.size).toBeGreaterThanOrEqual(3)`). Adding the same
  assertion would tighten the demo's regression value. Severity:
  **info**. Not added because it would mean modifying a test that is
  currently correct (just under-asserts), which exceeds the
  "demonstrably wrong" bar of the modification policy.

## Skipped

- Adding Python unit tests for `convert_comma2k19_to_{mcap,mf4}.py`:
  no Python test runner is configured in the repository, and the audit
  policy forbids installing new tooling. Listed under Findings →
  Missing coverage for human follow-up.
- Strengthening the 3-panel demo test with a source-diversity
  assertion: bar for modifying existing tests is "demonstrably wrong",
  which is not met (the test is correct, just under-asserts). Listed
  under Findings → Edge cases.

## Stats

- Files touched in range: 17 (1 new e2e spec, 2 Python scripts, 2 bash
  scripts, 5 PNGs, 4 docs, 2 state JSON, 1 markdown skill).
- Production source files (`apps/web/src/**` or `crates/**/src/**`)
  touched: **0**.
- Tests added: 0
- Tests modified: 0
- Coverage delta: n/a (no coverage tool configured; no code changes)
