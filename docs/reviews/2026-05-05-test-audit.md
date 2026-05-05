# Test Audit — 2026-05-05

**Range:** `b285218..cd39f65` (8 commits)

## Summary

Phase 8 lands per-plot-panel "gap threshold" controls (PR #87 + the
related fix-up commits): a new `plotPanelSettings` map in the session
store, a UI toggle + numeric input in `PanelDrawer`, a step-hold mode
in `mergeSeries` that injects synthetic gap markers, and the matching
v3 / v2 schema updates in the layout and named-layout adapters. The
rust side picked up three smoke tests around `predecompress_zstd_chunks`
edge cases (non-MCAP bytes, short inputs, uncompressed pass-through).

The shipped tests cover the bulk of the new behaviour. This audit adds
**5 tests** that close gaps in the merge-step-hold null path, the
named-layout snapshot/restore round-trip for `plotPanelSettings`, the
keyboard-commit branch of the gap-threshold input, and idempotence of
the zstd pre-decompression pass. All five pass and have been
mutation-checked. No existing tests were modified.

## Baseline

- **Web (vitest):** 415 → 419 tests pass across 37 files.
- **Rust (cargo test --workspace):** 49 + 2 + 3 + 4 + 3 + 5 = 66 → 67
  tests pass; doc-tests: 0.
- **Coverage tool:** none configured (no `cargo llvm-cov`, no
  `vitest --coverage`, no `c8`). Not installing one — diff-based gap
  analysis only, per instructions.

## Added tests

| File | Test | What it covers | Mutation check |
| --- | --- | --- | --- |
| `apps/web/src/panels/mergeSeries.test.ts` | `yields all-null for an empty series alongside a populated one` | Step-hold mode (`gapThresholdSec > 0`) with one empty input + one populated input. The empty series must read as null at every union slot — confirms the `hasSample` guard fires before `lastY` is read. | Flipped `out[i] = null` to `out[i] = 0` in the `!hasSample` branch of `mergeStepHold` — test went red ("expected [0,0,0] to deeply equal [null,null,null]"); reverted. |
| `apps/web/src/state/store.test.ts` | `saveCurrentLayoutAs snapshots plotPanelSettings (Phase 8)` | Phase 8's `plotPanelSettings` is included in the named-layout snapshot at save time and not perturbed by post-save mutations to live state. | Replaced `plotPanelSettings: { ...plotPanelSettings }` with `plotPanelSettings: {}` in `saveCurrentLayoutAs` — test went red (entry's plotPanelSettings was empty); reverted. |
| `apps/web/src/state/store.test.ts` | `restoreNamedLayout restores plotPanelSettings (Phase 8)` | `restoreNamedLayout` writes `plotPanelSettings` from the saved entry back into live state; verifies the field round-trips through save → drift → restore. | Same dropping-mutation as above; the restore test also went red because the saved entry was empty and live state was unchanged; reverted. |
| `apps/web/src/shell/drawers/PanelDrawer.test.tsx` | `pressing Enter commits the draft and blurs the input` | Enter-key path of the gap-threshold numeric input: commits the draft via `setPlotGapThreshold` AND removes focus (so global shortcuts like space-to-play aren't swallowed). | Replaced `if (e.key === "Enter")` with `if (e.key === "__never__")` in `PlotGapThresholdControl.onKeyDown` — test went red (store stayed at 1, focus stayed on input); reverted. |
| `crates/data-core/src/mcap.rs` | `predecompress_zstd_chunks_is_idempotent_on_zstd_input` | Running the pre-pass on its own output is a byte-for-byte no-op (no chunks left to rewrite), and the doubly-rewritten bytes still open cleanly through `McapReader`. Includes an `assert_ne!` to catch regressions that silently no-op the zstd branch. | Inverted `if comp == b"zstd"` to `if comp != b"zstd"` — test went red on the `assert_ne!` (first pass produced bytes identical to compressed input); reverted. |

## Modified tests

None. The test suite is internally consistent and no existing tests
asserted the wrong invariant.

## Findings

### Missing coverage

- **`apps/web/src/layout/persist.ts:99-115`, `apps/web/src/state/persist/namedLayouts.ts:91-101`** —
  severity: low. The `isPlotPanelSettingsMap` /
  `validatePlotPanelSettingsMap` validators reject non-finite numbers
  but accept zero and negative numbers (`gapThresholdSec: 0` or `-5`
  loads as-is). The store's `setPlotGapThreshold` setter normalises
  these to `null`, but a value loaded from localStorage flows
  unnormalised into `useSession` initial state via the `hydrated?.` line
  in `store.ts:453`. Concrete suggestion: tighten the validator to
  reject non-positive thresholds (`t === null || (typeof t === "number"
  && Number.isFinite(t) && t > 0)`), matching the store's contract.
  Document this with a test that craft-loads `{ "plot-1": {
  gapThresholdSec: -5 } }` and asserts the loader rejects it.
- **`apps/web/src/panels/PlotPanel.tsx:135-137`, `:271-275`** —
  severity: low. The new `gapThresholdSec` selector and its inclusion in
  `seriesKey` are not directly exercised by the existing
  `PlotPanel.test.tsx` (3 tests, focused on render + sync). A targeted
  test that flips the per-panel setting and asserts the plot rebuild
  fires (e.g. by spying on `seriesKey` change or counting render passes)
  would catch a regression that drops `g=...` from the key. Skipped
  here because the existing PlotPanel tests use jsdom without canvas
  shims and walking uPlot internals from a unit test is brittle; the
  e2e suite is the right tier for this.
- **`apps/web/src/state/store.ts:735-745`** — severity: low.
  `restoreNamedLayout`'s `entry.plotPanelSettings ?? {}` Phase-8
  backwards-compat fallback is logically correct but not directly
  tested with an entry that pre-dates the field. In JS,
  `{...undefined}` happens to equal `{}`, so the `?? {}` is technically
  redundant; a future refactor that removes it would be silently safe
  but visually concerning. Concrete suggestion: add a test that
  `restoreNamedLayout`s a manually-constructed entry without
  `plotPanelSettings` and asserts live state lands as `{}`. Not added
  here because the only mutation that catches this also catches the
  existing tests, so it doesn't add independent signal.

### Suspect tests

None. The Phase 8 tests added in `mergeSeries.test.ts`,
`PanelDrawer.test.tsx`, `store.test.ts`, `persist.test.ts`, and
`namedLayouts.test.ts` all have meaningful assertions and don't fall
into the "tests that can't fail" category.

### Flaky patterns

None. New tests are deterministic — no timers, no network, no
`waitFor`-based polls.

### Edge cases

- **`apps/web/src/panels/mergeSeries.ts:127-138`** — severity: low. The
  candidate-xs collection pre-sort allocates an unbounded `number[]`
  and sorts it. With ~1M samples per series and N series, this is N×M
  log(N×M) on every plot rebuild; the existing default-mode k-way merge
  is N×M. Not a correctness issue, but worth flagging for the perf
  budget in `apps/web/src/perf.test.ts`. Concrete suggestion: add a
  perf-budget test that asserts `mergeSeries` with threshold mode and
  100k samples/series stays under (say) 50ms on the CI machine,
  paralleling the existing `perf.test.ts` pattern.
- **`crates/data-core/src/mcap.rs:282`** — severity: info. The
  `input.len() < MCAP_MAGIC.len() * 2` early-return guards underflow
  but doesn't explicitly guard the case where the input is exactly
  `MCAP_MAGIC.len() * 2` (16 bytes). Walking the cursor loop with
  `body_end = 8` and `cursor = 8` correctly terminates the
  `cursor + 9 <= body_end` check, but a regression that loosened the
  early-return to `<` (instead of `<=`?) wouldn't be caught. The added
  short-input test covers length-8; an additional length-16
  truncated-but-not-rejected fixture would be belt-and-braces.

## Skipped

- A test asserting that the persist validator rejects non-positive
  thresholds: would require either changing source (not allowed by the
  hard constraints) or asserting the *current* lax behavior, which is
  asserting a bug. Recorded as a finding instead.
- A direct unit test of `seriesKey` containing the gap-threshold token
  in `PlotPanel.tsx`: requires either exposing the seriesKey or driving
  the full uPlot render path, both brittle in jsdom. The e2e tier is
  the right place for this; an e2e spec already covers the plot path
  via `apps/e2e/tests/realworld-comma2k19.spec.ts`.
- A perf-budget test for `mergeSeries` step-hold mode: would need a
  CI-machine-tuned threshold, and the existing `perf.test.ts` doesn't
  yet cover the merge stage. Out of scope for this audit — flagged as
  an edge case above.

## Stats

- Files touched: 4 test files (`mergeSeries.test.ts`, `store.test.ts`,
  `PanelDrawer.test.tsx`, `mcap.rs` test module).
- Tests added: 5 (4 web + 1 rust).
- Tests modified: 0.
- Coverage delta: not measured (no coverage tool configured).
- Test counts: web 415 → 419, rust 66 → 67.
