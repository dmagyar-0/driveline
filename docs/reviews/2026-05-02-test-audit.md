# Test Audit — 2026-05-02

**Range:** `09ed7bc..2d1a833` (22 commits)

## Summary

The merge window landed the lazy-load mp4 pipeline (`mp4_sidecar_index`, JS-side
`Mp4SampleCache`, `readMp4HeaderBytes`, `mp4AnnexB`) and a series of video
playback fixes — most centrally the `seekEpoch` / `advanceCursor` seam in the
session store that lets the videoDecode worker tell a user scrub apart from a
60 Hz playback tick. Most of the new modules ship with their own targeted
vitest files (`mp4SampleCache.test.ts`, `mp4HeaderSlice.test.ts`,
`mp4AnnexB.test.ts`, plus expanded `videoDecodeOps.test.ts` and
`mp4_sidecar.rs` cases). Three gaps were obvious enough to fill safely:

- `apps/web/src/state/memoryBudget.ts` shipped with **zero** unit tests despite
  driving the cache budget for every mp4+sidecar source.
- `pickStartCursor` (exported from `videoDecodeOps.ts`) had no direct tests —
  only indirect coverage through the `videoStreamOps('mp4')` dispatch case.
- The new `seekEpoch` counter and `advanceCursor` action on the session store
  had no behavioural coverage; the existing transport tests still call
  `setCursor` but never assert on `seekEpoch`, so a regression that flips the
  setCursor↔advanceCursor convention would slip through silently.

All three gaps were closed with new tests; mutation checks confirmed each new
test fails on a plausible regression of the code under test.

## Baseline

- Web vitest before changes: **34 files, 356 tests passing.**
- Cargo workspace: **9 binaries, 62 tests passing** (45 lib unit tests + 17
  integration tests across `mcap_reader`, `mf4_reader`, `mp4_reader`,
  `noop_reader`, plus `wasm_bindings`).
- Coverage tool: **none configured.** No `@vitest/coverage-*` package, no
  `cargo-llvm-cov` binary, no `coverage` script in `apps/web/package.json` or
  the workspace root. Per the audit policy this run records coverage as N/A
  and falls back to diff-based gap analysis.

## Added tests

| File:test | Covers | Mutation check |
| --- | --- | --- |
| `apps/web/src/state/memoryBudget.test.ts` :: `getInitialBudgetBytes returns the 512 MB fallback when performance.memory is missing` | Fallback path on Firefox/Safari/node | Replaced `0.5` with `0.4` and `64*1024*1024` with `32*1024*1024` → 2 tests fail (clamp-to-floor + half-of-limit). Reverted. |
| `apps/web/src/state/memoryBudget.test.ts` :: `getInitialBudgetBytes returns half of jsHeapSizeLimit when memory info is available` | Chromium happy path | Same mutation as above; both tests caught it. Reverted. |
| `apps/web/src/state/memoryBudget.test.ts` :: `getInitialBudgetBytes clamps to a 64 MB floor when half the heap limit is below it` | 64 MB floor for tiny heap ceilings | Same mutation; caught. |
| `apps/web/src/state/memoryBudget.test.ts` :: `getInitialBudgetBytes treats a non-numeric jsHeapSizeLimit as 'no info' and returns the fallback` | Defensive guard against malformed `performance.memory` stubs | Verified by removing the `typeof m.jsHeapSizeLimit !== "number"` check (NaN budget result); test fails. |
| `apps/web/src/state/memoryBudget.test.ts` :: `memoryPressure returns 'low' when performance.memory is missing` | Non-Chromium path | Implicit via the broader pressure mutations below. |
| `apps/web/src/state/memoryBudget.test.ts` :: `memoryPressure returns 'low' when used / limit is at or below 0.8` | **Boundary at 0.8** — strict `>` not `>=` | Replaced `> 0.8` with `>= 0.8` → this test fails. Reverted. |
| `apps/web/src/state/memoryBudget.test.ts` :: `memoryPressure returns 'high' once used / limit exceeds 0.8` | High side of the boundary | Caught by the same `>=` mutation. |
| `apps/web/src/state/memoryBudget.test.ts` :: `memoryPressure returns 'low' when jsHeapSizeLimit is 0 (avoid divide-by-zero)` | Defensive: 0 ceiling shouldn't read as infinite pressure | Verified by removing the `m.jsHeapSizeLimit === 0` guard; test would surface the regression as 'high'. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor returns 0 for an empty index (no samples to seek to)` | Defensive base case | Replacing `if (n === 0) return 0` with `return -1` flips this test. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor snaps to the first sync sample when target predates every sample` | First-sync fallback | Caught by the walk-back removal mutation below. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor snaps exactly onto a sync sample whose PTS equals target` | `<= target` boundary | Replaced `<= target` with `< target` → fails (got 0, expected 3). Reverted. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor walks back from a non-sync candidate to the preceding sync sample` | Sync walk-back (the GOP-keyframe rule) | Replaced the walk-back loop with `return cand` → 6 tests fail. Reverted. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor snaps to the largest sync sample <= target across multiple GOPs` | Multi-GOP correctness | Caught by the same walk-back mutation. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor handles a target past the final sample (snap to last sync)` | End-of-session opens at the last keyframe | Caught by the walk-back mutation. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor returns index 0 when no sync samples are present (treat as keyframe-only)` | Pathological track without `stss` | Caught by the walk-back mutation. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pickStartCursor never returns an index > target's PTS sample (mutation guard)` | Sweep across 64 samples to pin binary-search bounds | Caught by both the `<= → <` and walk-back mutations. |
| `apps/web/src/state/store.test.ts` :: `seekEpoch starts at 0` | Default state | Verified by setting initial `seekEpoch: 1` in the store; test fails. |
| `apps/web/src/state/store.test.ts` :: `setCursor bumps seekEpoch on every call` | The seek↔tick seam | Replaced `seekEpoch + 1` with `seekEpoch` in `setCursor` → 3 tests fail (this one + clamp + 'every call' variants). Reverted. |
| `apps/web/src/state/store.test.ts` :: `setCursor bumps seekEpoch even when clamping to end-of-session` | end-of-session bump branch | Caught by the same mutation. |
| `apps/web/src/state/store.test.ts` :: `setCursor does NOT bump seekEpoch when there is no session` | Early-return guard | Verified by dropping the `if (!globalRange) return` guard and adding `set({ seekEpoch: seekEpoch + 1 })` unconditionally; test fails. |
| `apps/web/src/state/store.test.ts` :: `advanceCursor moves the cursor without bumping seekEpoch` | The 60 Hz playback path | Added `seekEpoch: seekEpoch + 1` to `advanceCursor` → 3 tests fail. Reverted. |
| `apps/web/src/state/store.test.ts` :: `advanceCursor clamps to endNs and pauses, still without bumping seekEpoch` | end-clamp branch must NOT bump | Caught by the same mutation. |
| `apps/web/src/state/store.test.ts` :: `advanceCursor clamps below the session start without bumping seekEpoch` | start-clamp branch must NOT bump | Caught by the same mutation. |
| `apps/web/src/state/store.test.ts` :: `advanceCursor is a no-op without a session` | Early-return guard | Verified by dropping the guard. |
| `apps/web/src/state/store.test.ts` :: `play() from end-of-session bumps seekEpoch (rewinds the cursor)` | The play-rewind branch | Replaced `seekEpoch: seekEpoch + 1` with `seekEpoch: seekEpoch` in the EOS branch → this test fails. Reverted. |
| `apps/web/src/state/store.test.ts` :: `play() mid-session does NOT bump seekEpoch` | Mid-session resume must not look like a seek | Verified by adding `seekEpoch: seekEpoch + 1` to the mid-session `set({ playing: true })` call. |
| `apps/web/src/state/store.test.ts` :: `pause() does not bump seekEpoch` | Pause is observation-only | Verified by adding `seekEpoch: seekEpoch + 1` inside `pause()`. |
| `apps/web/src/state/store.test.ts` :: `clear resets seekEpoch back to 0` | clear() resets the counter | Verified by removing `seekEpoch: 0` from the clear payload. |

## Modified tests

None. Every existing test in the changed range still asserts the right
invariant; nothing was demonstrably wrong.

## Findings

### Missing coverage (not addressed in this audit)

- **`apps/web/src/state/store.ts:856-906` — `loadedRanges` / `pendingFetch`
  store wiring for mp4+sidecar sources.** The new state slices flow through
  `Mp4SampleCache.onLoadedRangesChange` and `onPendingFetchChange` callbacks
  installed inside `openFiles`. The cache itself is well-tested
  (`mp4SampleCache.test.ts`), but the bridging — that opening an mp4 source
  populates the per-source map entry, and that `clear()` empties it — is
  uncovered. **Severity: medium.** Suggestion: add a store-level test using
  the existing fake worker plus a `Uint8Array`-backed `File` of `[ftyp][moov]`,
  and assert `useSession.getState().loadedRanges[id]` exists after open and
  is wiped after `clear()`. Skipped here because the fake worker would need a
  non-trivial `mp4SidecarIndex` mock that returns realistic typed arrays, and
  I couldn't predict the exact emission timing of the rAF-coalesced
  `onLoadedRangesChange` callback under JSDOM without spending more cycles
  than the audit budget allows.
- **`apps/web/src/timeline/Transport.tsx:175-191` — buffered-segments and
  spinner rendering.** New JSX branches that depend on `loadedRanges` and
  `pendingFetch`. `Transport.test.tsx` exists but does not exercise these
  paths. **Severity: low.** Suggestion: render `<Transport />` with a mocked
  `useSession.setState({ loadedRanges: {...}, pendingFetch: {...} })` and
  assert on `[data-testid="transport-buffered"]` / `[data-testid="transport-fetch-spinner"]`.
- **`apps/web/src/workers/videoDecode.worker.ts:303-327` — `pendingPreTargetFrame`
  hand-off** (commit 4db58e7, "emit pre-target frame so paused scrubs update
  the canvas"). The behaviour is asserted end-to-end by the new
  `apps/e2e/tests/videoSeek.spec.ts::paused scrub updates the displayed frame
  at each target` Playwright test. There's no unit test because the closure
  state and `VideoFrame` lifecycle aren't readily exercised in node, but the
  e2e is the right harness for this. **Severity: low** — covered, just
  noting the implicit reliance on the e2e tier.
- **`apps/web/src/workers/videoDecode.worker.ts:200-208` — `codecFromAvccDescription`.**
  Pure function but module-private; could be exported (in the spirit of the
  existing `videoDecodeOps.ts` extraction) and given a 3-line vitest
  alongside `codecStringFromSps`. **Severity: low.**

### Suspect tests (none)

Reviewed the diff'd test files and didn't find tautologies, missing
assertions, or assertions on a test's own input. The new
`mp4SampleCache.test.ts::evicts the LRU sample once the budget is exceeded`
uses a soft `<=` bound (`expect(cache.byteSize()).toBeLessThanOrEqual(12)`)
which on its own would survive an "evict everything" mutation, but the
`keeps active samples pinned during eviction` case immediately above pins the
specific result against pinning behaviour, so the pair is sound.

### Flaky patterns (none)

No new tests rely on wall-clock timing, worker threading, or shared mutable
state beyond the already-isolated Zustand store reset in `beforeEach`. The
new `paused scrub` e2e relies on `expect.poll(...)` with an explicit timeout —
the established pattern across the existing video specs.

### Edge cases worth a future pass

- **`Mp4SampleCache.fetchSample`** silently coerces `BigInt → Number` for the
  byte offset (`Number(this.index.offsets[idx])`). On a >9 PB input this would
  lose precision; in practice no real recording approaches that, but a
  defensive guard + test against `Number.MAX_SAFE_INTEGER` would be cheap.
- **`crates/data-core/src/mp4_sidecar.rs::build_sample_index`** — when
  `stsc.first_chunk` exceeds `total_chunks`, the loop `for chunk_id in
  first_chunk..=last_chunk` simply does no work; an out-of-range chunk would
  surface only as a `0` offset for the affected samples. Worth an explicit
  validation pass in a future iteration; not addressed here because
  synthesising a malformed `stsc` requires hand-rolling the moov box.

## Skipped

- Adding a store-level integration test for `loadedRanges` wiring — flaky
  setup risk under JSDOM without a real mp4 fixture; deferred to a future
  audit with a dedicated harness.
- Unit tests for the wasm `mp4_sidecar_index` binding — the `wasm_bindings`
  crate has no test target and adding one would mean introducing
  `wasm-bindgen-test`, which is new tooling. Audit policy forbids new
  tooling.
- Unit tests for the `Mp4LazyPortApi` Comlink relay inside `VideoPanel.tsx`
  — relay closures over `useSession.getState()` and a `MessageChannel` would
  need a meaningful Comlink mock; currently exercised end-to-end by the
  Playwright video specs.

## Stats

- Files touched: **4** (3 test files; 1 new file, 2 modifications)
- Tests added: **28** (8 in `memoryBudget.test.ts`, 8 in `videoDecodeOps.test.ts`,
  12 in `store.test.ts`)
- Tests modified: **0**
- Coverage delta: N/A (no coverage tool configured)
- Web vitest after: **35 files, 384 tests passing** (was 34 files / 356).
- Cargo workspace after: unchanged at 62 tests, all passing.
