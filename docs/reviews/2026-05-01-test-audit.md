# Test Audit — 2026-05-01

**Range:** `7336395..09ed7bc` (18 commits)

## Summary

The window covers the v1 shell + Phase-6 panel work that already
landed under `main`: the binding-cull `sources.length === 0` gate
across all four binding-aware panels, a `lastOpenErrors` slice +
Sources-drawer surface for failed drops, the `shouldRefill` /
`PRIMING_BATCH` extraction in the video pacing loop, the cached
`cursorStrokeColor` + `axisStyle` helpers, and a refactor of the
EventsDrawer rename row out from inside a parent button. Most of the
changed surfaces ship with their own unit tests; this audit fills two
gaps that the merged tests left open.

## Baseline

- `pnpm --filter web test --run`: **325 → 329 passed**, 0 failed (31 files).
- `cargo test --workspace`: 49 + 2 + 3 + 4 + 3 + 5 = **66 passed**, 0 failed (across `data-core` lib, integration tests, and doctests).
- Coverage: **no coverage tool configured** in `package.json` /
  `vitest.config.ts` / `Cargo.toml`. Per the audit charter the gap
  analysis below is diff-based only; we did not install `vitest
  --coverage`, `c8`, or `cargo llvm-cov`.

## Added tests

| File | Test | What it covers | Mutation check |
| --- | --- | --- | --- |
| `apps/web/src/panels/PlotPanel.test.tsx` | `does not clear persisted bindings before any source loads` | The new `if (sources.length === 0) return;` gate inside `PlotPanel`'s binding-cull effect (mirrors the gate already test-locked in EnumPanel/MapPanel/TablePanel). Asserts `plotBindings["test-panel"]` survives a render where `sources=[]`, `channels=[]`, `globalRange=null`. | **Red on mutation** — removing the early-return from `PlotPanel.tsx` makes the cull wipe `plotBindings["test-panel"]` to `[]`; the test fails with `Array []` ≠ `["persisted-a","persisted-b"]`. |
| `apps/web/src/shell/drawers/SourcesDrawer.test.tsx` (new file) | `hides the drop-errors section when lastOpenErrors is empty` | The conditional render of the `<section data-testid="sources-errors">` block — without the gate the section appears in the empty state. | **Red on mutation** — replacing `errors.length > 0 ? (...) : null` with `true ? (...) : null` makes `screen.queryByTestId("sources-errors")` resolve, the test fails on the `toBeNull` assertion. |
| `apps/web/src/shell/drawers/SourcesDrawer.test.tsx` | `renders one row per error when lastOpenErrors has entries` | The `errors.map` render path, including the `name`/`reason` text. | **Red on mutation** — replacing the `<ul>{errors.map(...)}</ul>` body with an empty `<ul/>` makes `getByText("notes.txt")` throw "Unable to find an element with the text". |
| `apps/web/src/shell/drawers/SourcesDrawer.test.tsx` | `dismiss button clears lastOpenErrors via dismissOpenErrors` | The dismiss button is wired to the new `dismissOpenErrors` action and that the section disappears once the slice clears. | **Red on mutation** — replacing `onClick={dismissOpenErrors}` with `onClick={() => undefined}` leaves `lastOpenErrors` populated; the post-click `toEqual([])` assertion fails. |

All four tests pass with the production code on `main`.

## Modified tests

None. The bar in this audit (demonstrably wrong + unambiguous correct
behaviour + post-fix mutation passes + one-sentence bug articulation)
was not met by anything in `7336395..09ed7bc`.

## Findings

### Missing coverage
- `apps/web/src/panels/VideoPanel.tsx:354-378` — the new
  `SETCURSOR_DELTA_NS = LOOKAHEAD_NS / 2n` coalescer that drops 60 Hz
  cursor ticks down to ~7 Hz Comlink calls is gated entirely on
  closure-local refs (`lastCursorSentRef`) and the worker stub. There
  is no unit test pinning that (a) the first cursor change after open
  always pushes through, (b) sub-`SETCURSOR_DELTA_NS` ticks are
  swallowed, (c) a `seek()` re-baselines `lastCursorSentRef` to the
  seek target. Severity: medium — a regression here brings back the
  4K freeze symptom (worker decodes faster than blits, queue drains).
  Suggestion: extract the predicate (analogous to `shouldRefill` in
  `videoDecodeOps.ts`) so it can be tested without rendering
  `<VideoPanel>`.
- `apps/web/src/panels/VideoPanel.tsx:285-303` — the always-on stats
  badge sets `stats.className` and `textContent` from RAF; the warn
  threshold (`drop > 0 || lagMs > 66`) and the q `len/MAX_QUEUE`
  formatting are unit-test-able by exposing the same pure helper. No
  test exists. Severity: low (cosmetic regression, not a freeze).
- `apps/web/src/panels/PlotPanel.tsx:103-122` — the cached `axisStyle`
  helper (module-scope `axisStyleCache`) is internal and untested. The
  fallback path (`typeof document === "undefined"`) and the
  `--color-fg-2` / `--color-border-subtle` resolution share their
  shape with `cursorStrokeColor` but are not exported. Severity: low.
  Suggestion: export under a `__test`-prefixed alias the way
  `__resetCursorStrokeColorCache` is.
- `apps/web/src/state/store.ts:257-264` — the `mintId(prefix)` helper
  is exercised through `addBookmark` and `saveCurrentLayoutAs`, but
  the `Math.random` fallback path (when `crypto.randomUUID` is
  missing) is not directly tested. Under jsdom + Node ≥ 19 the real
  branch is taken. Severity: low — only matters if the helper is ever
  reused on a runtime without `crypto.randomUUID`.

### Suspect tests
- `apps/web/src/panels/EnumPanel.test.tsx` — the `seed()` helper sets
  `channels: SOURCE.channels`, but the binding-cull effect reads
  `findChannel(sources, id)` not `channels`. The test passes today
  because the gate-test seeds a real source. Worth flagging if the
  panel is ever refactored to read from `channels` instead. Severity:
  low.
- `apps/web/src/state/store.test.ts:228-253` — `lastOpenErrors` tests
  rely on the fake worker silently failing only for `notes.txt`. The
  `defaultSummaries()` factory is in scope but not asserted; if a
  future change makes `defaultSummaries()` reject `notes.txt`
  upstream, the assertion of "lastOpenErrors length === 1" stays true
  but for the wrong reason. Severity: low.

### Flaky patterns
- `apps/web/src/panels/PlotPanel.test.tsx:288-303` — `waitFor` on
  `__drivelinePlotPanels?.["test-panel"]?.sampleAtCursor[0]?.tsNs`
  uses a 1 s timeout and 10 ms polling. Acceptable, but the new
  `axisStyle` cache means the first run of this file warms the cache
  for the rest of the suite — if a future test sets a custom
  `--color-fg-2` and expects it to take effect, it will silently get
  the cached value. Suggestion: add `__resetAxisStyleCache` if/when a
  test wants to vary axis colours.
- `apps/web/src/panels/cursorOverlay.test.ts:48-67` — already cleans
  up with `__resetCursorStrokeColorCache` in `afterEach`; good.

### Edge cases
- `apps/web/src/workers/videoDecodeOps.ts:163-169` — `shouldRefill`
  pinning includes the boundary case (`lastEmittedPtsNs - cursorNs ===
  LOOKAHEAD_NS` returns `true`). One scenario not covered: a negative
  `cursorNs` (cursor seeded before global range start). The current
  code subtracts BigInts so it handles this fine, but no test
  exercises the negative-delta path. Severity: low.
- `apps/web/src/state/persist/ui.test.ts` — the new file covers
  malformed JSON, version mismatch, unknown rail tab, non-boolean
  collapsed flag, array payload, null payload, and quota errors.
  Coverage of the persistence module is excellent. No additions
  needed.

## Skipped

- The video-pacing setCursor coalescer (see Missing coverage above).
  Without an exported predicate or a worker mock that observes
  `client.setCursor` calls deterministically, any test would rely on
  RAF timing and risk being flaky.
- The `axisStyle` cache (PlotPanel). Module-scope mutable state with
  no exported reset; testing without changing source means racing
  module evaluation order across the suite.
- `formatSeconds` in `TablePanel.tsx`. The diff was a comment-only
  change; the `Number(tsNs / 1_000_000n) / 1000` expression is
  unchanged. No new test required.
- `BookmarkMarkers` aria-label removal. The change drops
  `role="button" tabIndex={-1} aria-label` in favour of
  `aria-hidden="true"`; the existing tests don't assert on either set
  of attributes and the keyboard surface lives in EventsDrawer (which
  is tested).

## Stats

- Files touched: 3 (`PlotPanel.test.tsx`, `SourcesDrawer.test.tsx`
  added, plus the report itself).
- Tests added: 4 (1 in PlotPanel, 3 in new SourcesDrawer file).
- Tests modified: 0.
- Coverage delta: not measurable (no coverage tool configured).
  Diff-based: 1 panel × 1 effect-gate behaviour and 1 drawer × 3
  rendering paths newly pinned.
