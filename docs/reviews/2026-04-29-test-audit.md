# Test Audit — 2026-04-29

**Range:** `7336395..b609acc` (13 commits, 9 source-touching)

## Summary

Baseline is fully green on both toolchains. The source-touching changes in
range are tightly scoped: a `videoDecode.worker.ts` refactor that extracts
the pure pieces (codec-string derivation, Annex-B SPS scan, refill-pacing
predicate, reader-kind dispatch) into a new `videoDecodeOps.ts`, plus a
panel-side stats badge and a uPlot axis-styling tweak. The worker refactor
ships with its own dedicated unit suite (`videoDecodeOps.test.ts`,
21 tests) that already pins all the pure helpers — including the
`shouldRefill` boundary at exactly `LOOKAHEAD_NS`, the SPS-bounded scan,
and the mcap/mp4 dispatch. No high-confidence test additions identified;
the remaining gaps (stats-badge lag math, `axisStyle` token resolution,
`pullInFlight` mutex) are integration-level and recorded as findings.

## Baseline

- **Web (vitest):** 30 files, 319 tests passed, 0 failed (8.37 s).
- **Rust (cargo test --workspace):** 49 unit + 17 integration + doc tests, all passed.
- **Coverage tool configured:** none. `apps/web/package.json` has no
  vitest `--coverage` invocation and no Cargo `llvm-cov` config; per the
  audit charter we did not install one. Falling back to diff-based gap
  analysis.

## Added tests

None. The new pure helpers introduced in this range
(`apps/web/src/workers/videoDecodeOps.ts`) are already tested
exhaustively in `apps/web/src/workers/videoDecodeOps.test.ts` (added in
the same PR). Existing tests pin every documented branch — verified by
mental mutation walkthrough:

- `findSps`: empty buffer, no-start-code, non-SPS NAL, 3-byte and
  4-byte start prefixes, bounded by both 3-byte and 4-byte trailing
  start codes, AUD-skip case.
- `codecStringFromSps`: valid 3-byte SPS for both High@L4.2 and
  Baseline@L3.0, all three short-buffer branches (0/1/2 bytes) hit the
  fallback, and the "ignores bytes after index 2" pin.
- `ptsToMicros`: zero, sub-µs truncation, and ordering across
  `Number.MAX_SAFE_INTEGER` (catches a buggy `Number()`-then-divide).
- `videoStreamOps`: both `mcap` and `mp4` dispatch paths, asserting
  the *other* kind's methods are never called.
- `shouldRefill`: in-flight low-water gate at exactly `REFILL_LOW_WATER`
  and above, priming case (`null` last-emitted), past-watermark false,
  exactly-at-watermark true (catches `<=` → `<` mutations), and the
  catch-up case where the decoder is behind the cursor.

## Modified tests

None. No existing test in the range was demonstrably wrong.

## Findings

### Missing coverage

- `apps/web/src/panels/VideoPanel.tsx:279-298` — **severity: low.** The
  always-on stats badge (`data-testid="video-stats"`) computes
  `lagMs = Number((cursor - ptsNs) / 1_000_000n)` and toggles the
  `statsWarn` class on `dropped > 0 || lagMs > 66`. The threshold (2
  frames @ 30 fps) and the BigInt-µs math are inlined inside the rAF
  closure, so they aren't unit-testable without mounting the whole
  panel + worker stack. Concrete suggestion: leave it for now (no test
  was added because extracting the threshold to a named export would
  require modifying a non-test source file, which the audit charter
  forbids). E2e specs `videoSeek.spec.ts` / `videoMp4.spec.ts` already
  exercise the panel end-to-end; if the badge ever gates a release,
  add a `videoStatsBadge.spec.ts` that stubs the worker snapshot via
  `__drivelineVideoHud` and asserts the textContent + warn class
  against canned `(cursor, ptsNs, dropped)` triples.

- `apps/web/src/panels/PlotPanel.tsx:103-114` — **severity: low.** The
  new `axisStyle()` helper resolves `--color-fg-2` /
  `--color-border-subtle` from `tokens.css` at plot-build time and
  falls back to hard-coded hex when `document` is undefined or the
  property is empty. It's a private function so it can't be imported
  from the test file without modifying the panel. The existing
  `PlotPanel.test.tsx` runs under jsdom and exercises the function
  (the panel renders without throwing), but doesn't assert the axis
  options. Failure mode is purely cosmetic (axes paint black again);
  dark-theme regression would be caught by the `panelKinds.spec.ts`
  visual reference if one is added.

- `apps/web/src/workers/videoDecode.worker.ts:122-148` — **severity:
  low.** The `pullInFlight` mutex is the linchpin of the 4K-pacing fix:
  without it, concurrent `setCursor` + `onFrame` callers can both pass
  the gate and start parallel `pullAndFeed`s. The pure pacing
  predicate `shouldRefill` is unit-tested, but the mutex itself
  requires a real Comlink scaffolding. Concrete suggestion: covered
  by e2e `_record-4k.spec.ts` (frame-drop budget) and `videoSeek` —
  if the e2e flake budget tightens, consider lifting the mutex into
  `videoDecodeOps.ts` as a tiny `withMutex` helper that takes a
  guard ref and a thunk, then unit-test the serialisation directly.

### Suspect tests

None.

### Flaky patterns

None new in range. The pre-existing `MapPanel.test.tsx`, `EnumPanel.test.tsx`,
and `TablePanel.test.tsx` log a `session store: worker not initialised`
stderr line in the baseline run because they intentionally render
without seeding `useSession.setWorker`. The tests still pass; the noise
was already present before this audit window. Not actionable here.

### Edge cases

- `findSps` edge case: a buffer ending with an SPS NAL header byte and
  zero payload bytes (e.g. `[0,0,0,1,0x67]`) returns an empty
  `Uint8Array` rather than `null`; `codecStringFromSps` then falls
  back to `CODEC_STRING_FALLBACK`. The behaviour is correct (the
  fallback matches the 4K/30 fixture) but the contract — "returns the
  SPS payload bytes... *or null*" — leaks a third state. Not added
  as a test because the mutation surface is benign: every observable
  consequence already routes through `codecStringFromSps`'s
  `sps.length < 3` guard, which *is* tested.

## Skipped

- A unit test for the `axisStyle()` token resolver. Would require
  exporting the helper, which crosses the "never touch non-test source
  files" line. Listed as a finding instead.
- A unit test for the VideoPanel stats badge lag computation. Same
  reason: the inlined threshold (`> 66 ms`) and BigInt math live
  inside a rAF closure with no public seam.
- A unit test for the `pullInFlight` mutex in `videoDecode.worker.ts`.
  Concurrency guard with no extracted seam; e2e covers it.
- A `findSps` test for "SPS NAL header at end of buffer with no
  payload bytes" — the downstream fallback path already pins the
  end-to-end behaviour.

## Stats

- Files touched: 0 source files, 0 test files (this audit window
  added no test code).
- Tests added: 0
- Tests modified: 0
- Coverage delta: not measured (no coverage tool configured).
- Findings: 4 (3 missing-coverage low-severity, 1 contract edge case).
