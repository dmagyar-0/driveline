# Test Audit — 2026-04-26

**Range:** `e596ce4..642ae4c` (6 commits)

## Summary

Audited the 6 commits merged since the 2026-04-25 audit. The substantive
test-relevant churn was concentrated in two files:

- `apps/web/src/perf.test.ts` (new, added in the previous audit window)
- `crates/data-core/src/mp4_sidecar.rs` (3 new tests added in the previous
  audit window)

Both test additions are well-targeted, tied to real behaviour, and pass with
clear assertions. I added two further tests to close uncovered branches:
the `parse_sidecar_text` "frame column not a non-negative integer" error
path, and the `installPerfHooks` happy path (mocked `window`). Both new
tests passed mutation-checks (red on a real-code break, green again on
revert). All other findings are low-priority and listed below.

## Baseline

- `cargo test --workspace`: **65 passed / 0 failed** (across `data-core`
  unit tests + 4 integration tests + `wasm_bindings`).
- `pnpm --filter web test --run`: **152 passed / 0 failed** across 17
  files.
- No coverage tool is configured in either toolchain
  (`cargo llvm-cov` / `vitest --coverage` / `c8` / `nyc` are not declared
  in `Cargo.toml`, root `package.json`, `apps/web/package.json`, or any
  `vitest.config*`/`.nycrc`). Per the audit policy: **no coverage tool
  installed**; gap analysis is diff-based only.

## Added tests

| File:test | Covers | Mutation check |
|---|---|---|
| `crates/data-core/src/mp4_sidecar.rs::tests::rejects_sidecar_with_non_integer_frame_column` | The `frame_str.parse::<usize>()` error branch in `parse_sidecar_text` (line 207–213). Existing tests covered missing-tab, wrong-frame-index, and bad-timestamp but not bad-frame. | Replaced `parse().map_err(...)?` with `parse().unwrap_or(pts_ns.len())` so a non-numeric frame would silently coerce to the expected index. Test went **red** with `called Result::unwrap_err on Ok(...)`. Reverted; test green. |
| `apps/web/src/perf.test.ts::installPerfHooks > attaches __drivelinePerf with snapshot/clear/now when window exists` | The install path of `installPerfHooks` (line 86–97 in `perf.ts`). Pre-existing test only pinned the `typeof window === "undefined"` early-return. Stubs a bare object on `globalThis.window` so the install path runs in the default node environment, then exercises `now()` and `clear()`. | Inserted an unconditional `return;` at the top of `installPerfHooks`. Test went **red** (`expected undefined to be defined`). Reverted; test green. |

## Modified tests

None. No existing test was demonstrably wrong.

## Findings

### Missing coverage (low priority — left as findings)

- `crates/data-core/src/mp4_sidecar.rs:278` — `annex_b_has_sps` is only
  indirectly exercised via `video_stream_first_chunk_contains_sps_and_pps`.
  The 3-byte vs 4-byte start-code branches and the `nal_start >= len`
  early-return aren't directly pinned. Severity: low. Suggestion: add a
  focused unit test feeding hand-rolled buffers (`[0,0,1,0x67]` with NAL
  type 7, `[0,0,0,1,0x67]`, and a buffer ending mid-start-code).
- `apps/web/src/perf.ts:30` — `now()` is reachable only through
  `__drivelinePerf.now`, now indirectly exercised by the new install-hooks
  test (which calls `hook.now()` and asserts a finite number). Severity:
  trivial.
- `apps/web/src/perf.ts:74` — `snapshot()`'s memory-coercion branch on
  Chromium-flavoured runtimes (`mem.usedJSHeapSize` is a number) cannot
  be reached in vitest's node env without stubbing
  `(performance as any).memory`. The existing test loosely asserts
  `null || number`. Severity: low. Suggestion: stub
  `(performance as any).memory = { usedJSHeapSize: 1, totalJSHeapSize: 2 }`
  and assert the values pass through.

### Suspect tests

- None observed. The 3 mp4_sidecar tests added in the range each map to
  a documented branch with a structural assertion; the 7 perf tests
  cover one behaviour each with concrete `expect(...)` calls and use
  `beforeEach`/`afterEach` to reset perf state.

### Flaky patterns

- None. No timing-dependent assertions, no shared mutable state, no
  network or wall-clock dependencies in the new tests. The
  `installPerfHooks` test uses `try/finally` to restore
  `globalThis.window`, so it doesn't leak global state to siblings.

### Edge cases

- `crates/data-core/src/mp4_sidecar.rs::parse_sidecar_text` — accepts
  negative `i64` timestamps because `i64::from_str` allows them. The
  docstring describes the column as "absolute ns-UTC", which leaves
  pre-1970 instants ambiguous. Not adding a test because the intended
  contract is unclear; recommend either an explicit
  "negative timestamps are accepted" test or a parser-level check that
  rejects them — whichever matches the spec.
- `apps/web/src/perf.ts::measure` — when only `startMark` is passed
  (no `endMark`), the second `else` branch runs. The existing test
  exercises both branches via the explicit-`endMark` happy path and the
  swallow-throw path; the implicit-end-mark variant
  (`measure("name", "start")` after `mark("start")`) isn't pinned.
  Severity: very low.

## Skipped

- An `annex_b_has_sps` direct unit test — confidence is high, but the
  function is private (`fn`, not `pub fn`); adding a test in the same
  `mod tests` block would work, and would mirror the
  `avcc_to_annexb_*` style. Left as a suggestion rather than landed
  here because the indirect coverage via `video_stream_first_chunk_*`
  is sufficient to catch a regression.
- A perf.ts `snapshot()` test that stubs `performance.memory` to a
  Chromium-shape object — left as a finding because the production
  behaviour on jsdom/Node and on Chromium both round-trip through the
  same `mem?.usedJSHeapSize ?? null` coalesce; a narrow stub test
  wouldn't catch much beyond what the existing assertion already
  expresses.
- A negative-timestamp parser test — intent is ambiguous (see Edge
  cases). Per the audit rules: skip when the intended behaviour can't
  be derived from code, docstrings, or existing tests.

## Stats

- Files touched: 2 (`crates/data-core/src/mp4_sidecar.rs`,
  `apps/web/src/perf.test.ts`).
- Tests added: 2 (1 Rust unit test, 1 vitest case).
- Tests modified: 0.
- Coverage delta: not measured — no coverage tool configured.
- Final suite totals: cargo `66 passed / 0 failed`; vitest
  `153 passed / 0 failed`.
