# Test Audit — 2026-05-06

**Range:** `cd39f65..5ee30f0` (7 commits, 2 substantive non-test source diffs)

## Summary

Range covers Phase-8 follow-up: a substantial rewrite of
`mergeSeries.mergeStepHold` (collect-then-sort → k-way merge with
lazy gap markers) plus a small `predecompress_zstd_chunks` cleanup
in `crates/data-core/src/mcap.rs`. The shipping commits already
brought five new unit tests covering the rewritten merge, the new
Enter-commits-and-blurs handler in `PanelDrawer`, and Phase-8
named-layout snapshot/restore for `plotPanelSettings`, plus a Rust
idempotence test for the zstd pre-pass.

The audit found one mutation-uncaught coverage gap: the
pre-allocation upper bound in `mergeStepHold` (the new
`upper += 2` accounting for held-end + gap-start markers) was not
exercised by any existing test on a series with multiple
consecutive gaps. Added one test that mutation-fails when
`upper += 2` is changed to `upper += 1` (output silently truncates
to 7 entries instead of 10). All other findings are documented
suggestions; no existing tests required modification.

## Baseline

- `pnpm --filter web test --run`: **37 files, 420 tests pass** (pre-audit).
- `cargo test --workspace`: **67 tests pass** across data-core (50
  unit + 17 integration), wasm-bindings (0).
- No coverage tool configured (no `vitest --coverage`, no `cargo
  llvm-cov`, no `tarpaulin`); falling back to diff-based gap
  analysis only.
- After audit: **421 web tests, 67 Rust tests** — full suite green.

## Added tests

| File:test_name | What it covers | Mutation check |
| --- | --- | --- |
| `apps/web/src/panels/mergeSeries.test.ts` · `mergeSeries · gap-threshold mode (Phase 8) > pre-allocates enough buffer for a series with many consecutive gaps` | `mergeStepHold` upper-bound math at `mergeSeries.ts:128-135`. Drives a single 4-sample series where every interval > threshold so all three gaps inject (held-end, gap-start) marker pairs. Asserts strict `xs.length === 10`, that real samples and held-end markers are present, that xs is strictly ascending, and that the trailing real value is preserved (would zero-fill if the buffer were undersized, since Float64Array writes past length silently no-op and `subarray()` clamps). | Changed `upper += 2` → `upper += 1` at `mergeSeries.ts:133`. New test went red (`expected 7 to be 10`). Reverted. |

## Modified tests

None. No existing test in the audit range met the bar (demonstrably
wrong, unambiguous correct behavior, mutation-confirmed catch).

## Findings

### Missing coverage

- `apps/web/src/panels/mergeSeries.ts:128-135` — *(addressed)* The
  upper-bound calculation for the augmented Float64Array was not
  exercised on a multi-gap series; addressed by the test added
  above.
- `apps/web/src/panels/mergeSeries.ts:111-208` (`mergeStepHold`) —
  Empty-input edge case: `mergeSeries([mk([],[]), mk([],[])], 1)`
  is not tested. The early `inputs.length === 0` return (line 48)
  catches the no-inputs case but not the all-empty-inputs case.
  Severity: low (existing single-empty-alongside-populated test
  exercises most of the same paths). Suggestion: assert `xs.length
  === 0` and `ys.length === inputs.length` for an all-empty input
  array.
- `apps/web/src/panels/mergeSeries.ts:170` — Boundary at
  `xs[next] - xs[idx] > threshold`: a gap of exactly the threshold
  (not strictly greater) must NOT inject markers. Currently
  implicit; no test asserts the strict inequality. Severity: low.
  Suggestion: a test with `xs = [0, 5]`, `threshold = 5`, asserting
  `xs.length === 2` (no markers).

### Suspect tests

- `apps/web/src/panels/mergeSeries.test.ts:101-123`
  (`step-holds within the threshold for a single series`) — The
  assertion `expect(out.ys[0][heldIdx + 1]).toBeNull()` assumes
  the gap-start marker is the immediate next entry. With the
  rewritten merger this remains true for a single input, but the
  invariant is no longer structural — it relies on no other
  series interleaving an x at `heldEnd < x < heldEnd + ε`. Not
  wrong today, but brittle if a future caller passes additional
  inputs. Severity: low. Suggestion: index by xs value
  (`xs.indexOf(7 + epsilon)`) rather than by neighbour offset.

### Flaky patterns

- None observed. No `setTimeout`/`Date.now`/network/random in any
  added or modified test; `mergeSeries` tests are pure data
  transforms; `PanelDrawer` test uses synchronous `fireEvent` and
  asserts on synchronous store state.

### Edge cases

- `apps/web/src/state/store.ts:728-746` (`restoreNamedLayout`) —
  The `?? {}` fallback for `entry.plotPanelSettings` defends
  against legacy entries that lack the Phase-8 field. The persist
  layer (`namedLayouts.ts`) already validates and defaults this
  on hydrate, so the in-memory `restoreNamedLayout` path will
  realistically never see a missing field; the `?? {}` is a
  belt-and-suspenders guard. Coverage exists indirectly via
  `namedLayouts.test.ts:213` (Phase-8 backwards compat) but no
  direct unit test on `restoreNamedLayout` exercises a hand-built
  legacy entry. Severity: low (defensive).
- `crates/data-core/src/mcap.rs` (`predecompress_zstd_chunks`) —
  The new idempotence test (line 1262) covers the second-pass
  path. Not exercised: a pre-pass on bytes that were once-zstd,
  rewritten, then truncated mid-record. Severity: low (failure
  mode is a parser error from `mcap::MessageStream`, surfaces as
  a `Reader::open` error which is the expected behavior). No
  action.
- `scripts/convert_comma2k19_to_mcap.py` — One-shot ETL helper.
  The new mid-stream RR-registration warning (line 254-265) is
  observable only via stderr; the script has no test
  infrastructure in this repo. Severity: low. No action.

## Skipped

- `mergeStepHold` empty-inputs and exact-threshold-boundary
  edge cases — described under Findings. Not added because the
  intended behavior at those boundaries is *clear* but the
  business value is marginal and the additions would dilute
  rather than strengthen the suite. Listed for human discretion.
- `restoreNamedLayout` legacy-entry path — would require
  hand-fabricating a partial `NamedLayout` and bypassing the
  `saveCurrentLayoutAs` constructor; the persist layer already
  has matching coverage at `namedLayouts.test.ts:213`. Better
  served by an integration-style hydrate→restore test, which is
  out of scope for a same-day audit.
- `scripts/convert_comma2k19_to_mcap.py` warning — no python
  test infrastructure in the repo; per audit rules, do not
  install new tooling.

## Stats

- Files touched: **1** (`apps/web/src/panels/mergeSeries.test.ts`).
- Tests added: **1**.
- Tests modified: **0**.
- Coverage delta: not measurable — no coverage tool configured.
- Web suite: 420 → 421 (+1).
- Rust suite: 67 → 67 (no change).
