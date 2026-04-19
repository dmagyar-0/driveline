# Test Audit — 2026-04-19

**Range:** `7ddcb44..f90cf42` (20 commits)

No prior `.claude/test-audit-state.json` existed, so the last audited SHA was
treated as the repo root commit per the runbook. The range spans the entire
history to date: M0 spikes, M1 scaffold / NoopReader / Arrow IPC contract, and
M2 reader implementations (MCAP, MF4, mp4+sidecar) plus the session store and
file-drop bucketer.

## Summary

- Baseline is green. 53 tests pass (15 vitest + 38 cargo) with zero failures
  before this audit, 57 after (17 vitest + 40 cargo).
- Existing suites are already thoughtful: every reader has its own unit tests
  plus an integration test against a committed binary fixture, and the
  Rust↔JS Arrow IPC contract is verified on both sides against the same
  generator.
- Added four tests that fill two narrow gaps: `TimeRange::is_empty`
  half-open semantics (never hit directly) and two `bucketFiles`
  drop-order / duplicate edge cases. Each survives a mutation check.
- No tests were weakened or modified. No production code was touched.

## Baseline

- `pnpm --filter web test --run` → 3 files, 15 tests passing.
- `cargo test --workspace` → 38 tests passing (27 unit + 2 arrow_contract +
  3 mcap_reader + 4 mf4_reader + 2 mp4_reader; doc-tests empty).
- Coverage tool: **none configured** (no `cargo llvm-cov`, no
  `@vitest/coverage-*`, no `c8` / `nyc` in any manifest). Per the runbook,
  the audit falls back to diff-based gap analysis only — nothing was
  installed.

## Added tests

| file:test_name | what it covers | mutation check |
| --- | --- | --- |
| `crates/data-core/src/types.rs::tests::time_range_empty_constructor_is_empty` | `TimeRange::empty()` returns `(0, 0)` and reports `is_empty()`. | Flipped the predicate to `<` (dropped the `=`). Test went red. Reverted. |
| `crates/data-core/src/types.rs::tests::time_range_is_empty_half_open_semantics` | Pins the three boundary cases of the half-open contract: `end > start` (not empty), `end == start` (empty), `end < start` (empty). The previous suite only exercised `(0, 0)` via `NoopReader` and `Mf4Reader`'s empty-CG path. | Same mutation (`<=` → `<`); both new cases went red. Reverted. |
| `apps/web/src/state/bucket.test.ts::bucketFiles > pairs regardless of drop order (sidecar listed before its mp4)` | Drops a `.mp4.ts.bin` before its `.mp4` sibling. Documents that `bucketFiles` builds the sidecar map in one pass and matches afterwards, so the OS/drag-drop order the caller receives does not matter. | Changed the sidecar key from the stripped name to the raw `.mp4.ts.bin` name. Pairing collapsed across the suite; the new test went red among others. Reverted. |
| `apps/web/src/state/bucket.test.ts::bucketFiles > with two mp4s sharing a basename and one sidecar, pairs once and flags the other` | Two identically named `.mp4` files plus one sidecar. Asserts the sidecar is consumed exactly once and the second mp4 surfaces `missing sidecar`. Previously the `sidecars.delete(mp4.name)` line had no covering test — a sidecar could silently double-pair without the suite noticing. | Removed the `sidecars.delete(mp4.name)` call. The new test caught it (two pairs, zero errors instead of one pair, one error). Reverted. |

## Modified tests

None. No existing test met the bar for modification.

## Findings

### Missing coverage

- `apps/web/src/workers/dataCore.worker.ts:81-157` — module-private
  `toBig` / `normaliseMf4` / `normaliseMcap` / `normaliseMp4` handle the
  `number` vs `bigint` boundary that the `store.test.ts` fake worker sidesteps
  (the fake already returns `bigint`s). The BigInt branch (ns values above
  `Number.MAX_SAFE_INTEGER`) is only exercised transitively by the Playwright
  e2e and is not a unit-level guard. Suggestion: export
  `toBig` + `normalise*` or extract them into a sibling `workerNormalise.ts`
  that the unit suite can import. Severity: **medium** — a regression here
  would silently drop ns precision on the mp4 timeline and only surface as a
  wrong-time seek in the UI.
- `apps/web/src/workers/dataCore.worker.ts::dataCoreApi` methods — the API
  surface is covered only via e2e and not exercised against the real
  `wasm_bindings` crate in CI (unit suite uses a fake worker).
  Suggestion: add a smoke test that `Comlink.wrap`s the built worker in a
  Node / jsdom harness, or explicitly document that `apps/e2e` is the sole
  guard. Severity: **low** (documented scope).
- `crates/data-core/src/mcap.rs::find_start_code` — private. The 4-byte
  start-code branch is exercised indirectly by `is_keyframe_detects_idr_and_sps`
  but there is no direct test for bounded-input edge cases (trailing
  `00 00 00` with no `01` byte; empty input). Severity: **low**.
- `apps/web/src/state/store.ts::uniqueSourceId` — the `n >= 3` branch
  (`short.mcap (3)`, `short.mcap (4)`, …) is not exercised; only the first
  collision is tested. Severity: **low**.
- `apps/web/src/App.tsx` — the drop-zone UI and error rendering have no unit
  tests. Playwright covers the happy path in `apps/e2e/tests/session-drop.spec.ts`
  but nothing pins the rendered error list when `openFiles` returns partial
  failures. Severity: **low** for M2, will matter when the panel/layout UI
  lands.

### Suspect tests

None. Every test I read either asserts a concrete output against a
deterministic fixture or exercises a named error variant with `matches!`. I
did not find tautological assertions, self-input comparisons, or tests that
over-mock the thing they claim to cover. Snapshot testing is not in use.

### Flaky patterns

- `apps/web/src/state/store.test.ts` uses `await new Promise((r) =>
  setTimeout(r, 0))` pairs to drain microtasks between blocked open calls
  (`serialises overlapping openFiles calls`). On a heavily loaded CI runner
  this can be brittle if `openResolvers.shift()!()` fires before the second
  `openFiles` has queued. Severity: **low**, but watch for sporadic failures
  — an explicit "wait until `openLog.length === n`" poll would be more
  robust than fixed-count microtask yields.
- The e2e suite (`apps/e2e/**`) was not run by this audit (requires a
  running dev server / `pnpm wasm:build`). Any timing-based flakiness there
  is not in scope here. Severity: informational.

### Edge cases

- `bucketFiles` pairs strictly by case-sensitive basename
  (`apps/web/src/state/bucket.ts:54`). A user dropping `DRIVE.mp4` +
  `drive.mp4.ts.bin` will see both reported as errors on case-sensitive file
  systems. Whether this is intended or a bug is unclear from the code and
  docs — flagging rather than asserting a direction. Severity: **low**.
- `crates/data-core/src/mf4.rs::translate_abs_ns` collapses `NaN` master
  samples to the file base. Not covered by a dedicated test; the behaviour
  is noted only in the source comment. Severity: **low**.
- `crates/data-core/src/mcap.rs::extract_video_bytes_from_json` falls back
  to the raw payload when JSON parsing fails, but this fallback path is not
  tested directly — the fixture always uses the JSON envelope. Severity:
  **low**.

## Skipped

- Did not touch `normaliseMf4` / `normaliseMcap` / `normaliseMp4`. Adding
  tests would require changing their export status, which is a
  production-code edit outside the audit's scope ("never touch non-test
  source files"). Flagged under Findings → Missing coverage instead.
- Did not write a test for the case-sensitive sidecar pairing — behaviour
  direction is ambiguous between "intended strictness" and "latent bug".
  Runbook: "if you cannot determine the intended behavior from the code,
  docstrings, or existing tests, skip it and list it as a finding instead."
- Did not run `apps/e2e` — requires `wasm-pack build` + a live dev server;
  outside the unit-level scope of this audit and would require installing /
  downloading tooling.

## Stats

- Files touched (tests only): 2 (`crates/data-core/src/types.rs`,
  `apps/web/src/state/bucket.test.ts`).
- Tests added: 4 (2 Rust, 2 TypeScript).
- Tests modified: 0.
- Tests deleted: 0.
- Coverage delta: not measurable (no coverage tool configured). New branch
  coverage on `TimeRange::is_empty` (all three half-open cases) and on the
  duplicate-pair / order-independence paths of `bucketFiles`.
