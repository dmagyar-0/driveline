# Test Audit — 2026-04-30

**Range:** `7336395..7e039d2` (15 commits)

## Summary

Range covers a 4K-decoder pacing fix (split `PRIMING_BATCH` from `PULL_BATCH`,
add `pullInFlight` mutex, widen `MAX_QUEUE` to 16), an always-on video stats
strip on the panel, dark-theme `axisStyle` resolution in `PlotPanel`, and the
new UI persistence slice (`apps/web/src/state/persist/ui.ts`) which already
ships with comprehensive tests. Baseline was green before any changes; the new
pacing constants exposed by `videoDecodeOps.ts` had no regression guard, and
`findSps` had no test for streams with multiple SPS NALs (a duplicated SPS
pattern that real H.264 bitstreams ship). Added three tightly scoped tests with
mutation checks. Suite stays green at 322/322.

## Baseline

- **Web (vitest):** 30 files / 319 tests passing pre-change, 322 post-change.
- **Rust (cargo test --workspace):** 66 tests across 9 crates, all passing.
- **Coverage:** no coverage tool configured in `apps/web/package.json` /
  `vite.config.ts` and no `cargo-llvm-cov` setup — fell back to diff-based gap
  analysis only, per playbook.

## Added tests

| File:test | What it covers | Mutation check |
| --- | --- | --- |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `findSps > returns the first SPS when multiple SPS NALs are present` | Pins early-return semantics: when an Annex-B buffer contains two SPS NALs (real H.264 sometimes ships a duplicated SPS at AU boundaries), `findSps` must return the first one and bound it at the second SPS's start code. Without this, an inter-frame profile change would silently swap the codec config mid-stream. | Flipped `nalType === 7` to `nalType === 5` in `videoDecodeOps.ts` → test failed (`object null is not iterable`); reverted. ✓ catches the mutation. |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pacing constants > primes with at least as many chunks as a steady-state pull` | Pins the relative ordering `PRIMING_BATCH > PULL_BATCH` introduced in this range. Open primes the decoder more aggressively than steady-state pulls so a fresh stream converges before the cursor outruns it; if anyone shrinks `PRIMING_BATCH` past `PULL_BATCH` without rethinking pacing, the canvas freezes on a 4K stream. | Set `PRIMING_BATCH = 2` in `videoDecodeOps.ts` → test failed with `expected 2 to be greater than 4`; reverted. ✓ |
| `apps/web/src/workers/videoDecodeOps.test.ts` :: `pacing constants > LOOKAHEAD_NS is a positive bigint watermark` | Pins that `LOOKAHEAD_NS` is positive. The pacing gate compares `lastEmittedPtsNs - cursorNs <= LOOKAHEAD_NS`; a zero/negative watermark would only refill while behind the cursor, effectively disabling lookahead and starving the panel queue. | Set `LOOKAHEAD_NS = 0n` in `videoDecodeOps.ts` → test failed (`expected false to be true`); reverted. ✓ |

## Modified tests

None. The existing tests in scope (`videoDecodeOps.test.ts`, `ui.test.ts`) are
correct and well-scoped.

## Findings

### Missing coverage

- **Worker mutex (`pullInFlight`)** — `videoDecode.worker.ts:126` introduces
  a serialise gate so concurrent `setCursor`/`onFrame` callbacks don't fire
  overlapping `pullAndFeed`s. The gate is only exercised through the worker's
  Comlink boundary; no unit test pins "two concurrent `maybeRefill` calls
  yield exactly one `ops.next` invocation." Severity: medium. Suggestion:
  extract the mutex predicate (or `maybeRefill` itself) into the pure-helper
  module so a fake `VideoStreamOps` can verify dispatch counts under
  concurrent calls.
- **`VideoPanel` always-on stats strip** — `apps/web/src/panels/VideoPanel.tsx:271-296`
  computes `lag = cursor - lastBlitPts` and toggles a warn class when
  `dropped > 0 || lag > 66ms`. No unit test asserts the threshold, the warn
  class swap, or the textContent format. Severity: low (visual + e2e
  observable). Suggestion: extract a pure `formatStatsText(snapshot, cursor,
  maxQueue) → { text, warn }` helper and unit-test the threshold (66ms = 2
  frames @ 30fps), the `—` fallback when `ptsNs === null`, and the
  `dropped > 0` warn path.
- **`PlotPanel` `axisStyle()`** — `apps/web/src/panels/PlotPanel.tsx:104-114`
  resolves CSS tokens with a fallback when `document` is undefined or the
  variables are empty. The fallback branch (no `document`) is hit during
  module-time evaluation in node, but no test pins the fallback values
  (`#e0e0e0` / `#2a2a2a`). Severity: low. Suggestion: export `axisStyle` (or
  a thin `resolveAxisStyle(getCs?: () => CSSStyleDeclaration)` wrapper) so a
  test can stub `getComputedStyle` and verify both the token-present and
  token-empty branches.
- **`videoDecode.worker.ts:184` cursor re-seed** — when `openInternal` runs,
  it resets `cursorNs` to `fromPtsNs` only `if (cursorNs < fromPtsNs)`. The
  reverse case (cursor already ahead of the seek target) silently keeps the
  old cursor, which is the intended behaviour for forward seeks but is not
  pinned anywhere. Severity: low.

### Suspect tests

- None. The added `videoDecodeOps.test.ts` and `ui.test.ts` cases all carry
  meaningful assertions and the existing `PlotPanel.test.tsx` /
  `EnumPanel.test.tsx` / `MapPanel.test.tsx` / `TablePanel.test.tsx` are
  hermetic against the worker (the "session store: worker not initialised"
  stderr is expected — those panels assert the unbound/loading state, not
  fetched data).

### Flaky patterns

- None observed. The `waitFor` polling helper in `PlotPanel.test.tsx` and
  `EventsDrawer.test.tsx` uses a 1-second timeout with a 10ms tick, which is
  bounded against a deterministic store mutation — not wall-clock dependent.

### Edge cases

- **`findSps` start code at very end of buffer** — `[0,0,1]` and `[0,0,0,1]`
  with no NAL byte after. Inspection shows the function returns `null` here,
  but a test asserting this would also catch a future off-by-one in the
  `nalStart >= annexB.length` guard. (Not added because removing the guard
  in JavaScript still returns `null` via `undefined & 0x1f === 0`, so the
  mutation check would not fail — the guard is defensive rather than
  load-bearing in JS semantics.)
- **`shouldRefill` exact-boundary mutation** — already pinned at
  `lastEmittedPtsNs === LOOKAHEAD_NS` (true) and `LOOKAHEAD_NS + 1n` (false).

## Skipped

- A unit test for the `VideoPanel` stats strip — the formatter is inlined
  inside the rAF tick; extracting it is a refactor that touches a
  non-test source file (out of scope per playbook constraint "never touch
  non-test source files").
- A unit test for `axisStyle()` in `PlotPanel.tsx` — same rationale; it's
  a private function.
- A unit test for the `pullInFlight` mutex in `videoDecode.worker.ts` —
  same rationale; the predicate is module-internal.
- A behavioural test for `openInternal`'s cursor re-seed (`cursorNs <
  fromPtsNs`) — the worker isn't structured for direct unit testing without
  a refactor.

## Stats

- Files touched: 1 (`apps/web/src/workers/videoDecodeOps.test.ts`).
- Tests added: 3 (1 `findSps` edge case, 2 pacing-constant invariants).
- Tests modified: 0.
- Coverage delta: n/a (no coverage tool configured).
