# Test Audit — 2026-05-04

**Range:** `d405b47..b285218` (10 commits)

## Summary

Two PRs landed since the last audit:

- **#82 — zstd MCAP support.** Adds a pure-Rust `predecompress_zstd_chunks`
  pre-pass to `crates/data-core/src/mcap.rs` so the upstream `mcap` crate's
  reader can consume zstd-compressed chunks regardless of whether its `zstd`
  Cargo feature is enabled (matters for wasm). Adds
  `fixtures::short_mcap_zstd_bytes`, an `examples/gen_mcap_zstd_fixture.rs`
  binary, and a Playwright spec (`apps/e2e/tests/zstdMcap.spec.ts`) that
  loads `short.zstd.mcap` end-to-end.
- **#83 — comma2k19 dataset wiring.** Adds
  `scripts/convert_comma2k19_to_mcap.py` and an e2e spec that exercises the
  reader on a real-world CAN bus capture. Single behavioural change in the
  product itself: `apps/web/src/panels/PlotPanel.tsx` flips
  `spanGaps: false` → `spanGaps: true` so two same-rate CAN signals on
  different mailboxes both render (`mergeSeries` emits `null` at every
  union timestamp where the other channel has a sample).

The pre-pass function is the largest new surface in this range and the
audit's main focus. Two test files added in the previous range
(`apps/web/src/state/qualifiedChannelId.test.ts`,
`apps/web/src/panels/VideoPanelContainer.test.tsx`) also appear in
`git diff` because they were created after the last audited SHA — both
were spot-checked and need no further coverage.

## Baseline

- `cargo test --workspace`: 63 tests pass / 0 fail.
- `pnpm --filter web test --run`: 397 tests pass / 0 fail (37 files).
- Coverage tool: **no coverage tool configured** in `package.json`,
  `Cargo.toml`, or `vite.config.ts`. Per the audit policy, we did not
  install one; gap analysis is diff-based only.

## Added tests

| File | Test | Covers | Mutation check |
| --- | --- | --- | --- |
| `crates/data-core/src/mcap.rs` | `predecompress_zstd_chunks_passes_through_non_mcap_bytes` | Early-return guard on inputs that don't begin with `MCAP_MAGIC`. Without the guard the cursor loop tries to parse arbitrary bytes as record headers. | PASSED. Replacing `return Ok(input)` with `return Ok(vec![0xFF; 1])` makes the test fail. Reverted. |
| `crates/data-core/src/mcap.rs` | `predecompress_zstd_chunks_short_input_is_returned_verbatim` | Short-input guard: inputs shorter than `MCAP_MAGIC.len() * 2` (e.g. exactly one magic, no body) must short-circuit before `body_end` is computed. | PASSED (same mutation as above kills it). Reverted. |
| `crates/data-core/src/mcap.rs` | `predecompress_zstd_chunks_is_noop_for_uncompressed_mcap` | Verbatim pass-through path on an already-uncompressed MCAP fixture (`short_mcap_bytes`, written with `use_chunks(false)`). Asserts byte-for-byte equality AND that `McapReader::open` still surfaces all four channels post-pass. | PASSED. Mutating the per-record write to drop `out.extend_from_slice(body)` makes the test fail (`assert_eq!(pre, bytes)` trips). Reverted. |

## Modified tests

None. The existing test in this range
(`zstd_compressed_fixture_round_trips_through_reader`) already exercises
the happy path correctly.

## Findings

### Missing coverage

- `crates/data-core/src/mcap.rs:263` — `predecompress_zstd_chunks` zstd
  rewrite path. The added tests cover the early-return guards and the
  no-op-on-uncompressed path. The actual zstd rewrite is exercised
  end-to-end by `zstd_compressed_fixture_round_trips_through_reader`,
  but only via the public `McapReader::open` surface — the pre-pass's
  output bytes themselves are never inspected. **Severity: low.**
  Suggestion: a follow-up could synthesise a single-chunk zstd MCAP and
  assert that `predecompress_zstd_chunks` emits a chunk with
  `compression = ""` and the same `uncomp_size` / `uncomp_crc` fields,
  but doing so requires hand-crafting MCAP record bytes — not worth
  adding without a clear regression risk.
- `crates/data-core/src/mcap.rs:345` — footer `summary_start` /
  `summary_offset_start` shifting when `total_delta != 0`. Currently
  reachable only through the integration test, where a footer-shift bug
  surfaces as a `Summary::read` failure. A direct unit test would
  require the same MCAP byte synthesis. **Severity: low.**
- `apps/web/src/panels/PlotPanel.tsx:300` — the `spanGaps: true` flip is
  a uPlot config flag and is opaque to the existing
  `PlotPanel.test.tsx` (which inspects `seriesStats`, not uPlot's
  rendered geometry). The behavioural assertion lives in the new
  `realworld-comma2k19.spec.ts` Playwright test — adequate at the
  e2e layer. **Severity: low** — no unit-level test added because the
  flag's effect can only be verified by inspecting uPlot's series array
  via internals (`plotRef.current.series[i].spanGaps`), which couples
  the test to uPlot's private shape.

### Suspect tests

None identified in this range.

### Flaky patterns

- `apps/e2e/tests/realworld-comma2k19.spec.ts:154` uses
  `await page.waitForTimeout(800)` after the two-`requestAnimationFrame`
  wait. Wall-clock waits in Playwright specs are a known flake source
  on CPU-constrained CI. **Severity: low** — the spec is screenshot-only
  after that point and the assertions all run before the timeout. A
  follow-up could replace it with a poll on `getPlotPanelSeriesStats`
  reaching a stable value, but that's a polish, not a bug.
- `apps/e2e/tests/realworld-comma2k19.spec.ts:24` is `test.skip`-gated
  on the fixture's existence. Skipping rather than failing is the
  correct call here — the fixture is generated from a public dataset
  out of band — but this means the spec silently no-ops in any
  environment that hasn't run `convert_comma2k19_to_mcap.py`. Not a
  defect, just worth flagging in the audit log.

### Edge cases

- `predecompress_zstd_chunks` with a malformed `record_end > body_end`
  triggers the `return Ok(input)` defence at
  `crates/data-core/src/mcap.rs:288`. This branch is not under test.
  The downstream `Summary::read` call surfaces the canonical error, so
  the branch is functionally a fast-path; still worth a one-line
  finding so future readers know the behaviour.
- `predecompress_zstd_chunks` with `comp_len > body.len()` falls through
  to verbatim pass-through (the `if 32 + comp_len + 8 <= body.len()`
  guard at line 301). Same status as above.

## Skipped

- Did not add a unit test for the zstd-rewrite happy path — would
  require synthesising a single-chunk zstd MCAP from raw record bytes,
  and `zstd_compressed_fixture_round_trips_through_reader` already
  catches the failure mode in question.
- Did not add a unit test asserting `spanGaps: true` flows into uPlot's
  series options — the only honest way to test it is by reading
  `uPlot.series[i].spanGaps` via internals, and the e2e spec covers
  the user-visible behaviour.
- Did not add tests for `examples/probe_external.rs` and
  `examples/gen_mcap_zstd_fixture.rs` — they are ad-hoc CLI binaries.
- Did not test `scripts/convert_comma2k19_to_mcap.py` — pure Python
  data-prep glue with no test scaffold in the repo.

## Stats

- Files touched: 1 (`crates/data-core/src/mcap.rs` test module)
- Tests added: 3
- Tests modified: 0
- Coverage delta: not measured (no coverage tool configured)
- Cargo workspace test count: 63 → 66
- Vitest count: 397 → 397
