# Test Audit — 2026-04-28

**Range:** `642ae4c..7336395` (35 commits)

## Summary

Range covers the entire V1 shell rollout (Phases 0–10): the design wireframe
bundle, top bar / icon rail / drawer host, Sources / Channels / Layout /
Panel / Events drawers, four new panel kinds (Scene / Map / Table / Enum),
per-panel chrome, transport refinement (prev/next + arrow keys + dark
theme), bookmarks persistence, and the 4K decoder pacing fix.

Most new logic landed with co-located unit tests (`*.test.ts(x)` next to
the implementation) and a Playwright suite under `apps/e2e/tests/`. The
single notable hole was `apps/web/src/state/persist/ui.ts`, which mirrors
`bookmarks.ts` / `namedLayouts.ts` (both fully tested) but had zero
coverage.

This audit added one test file (22 unit tests) covering that gap. No
existing tests were modified. All mutation checks passed.

## Baseline

- Web (`pnpm --filter web test --run`): **292 tests / 29 files passing**
  before changes; **314 / 30 passing** after.
- Rust (`cargo test --workspace`): **66 tests passing** (49 + 2 + 3 + 4 + 3
  + 5) — unchanged.
- Coverage: **no coverage tool configured** in `package.json` /
  `apps/web/vite.config.ts` / `Cargo.toml`. Per the audit playbook, no
  tooling was installed; gap analysis is diff-based.

## Added tests

| File / test | Covers | Mutation check |
| --- | --- | --- |
| `apps/web/src/state/persist/ui.test.ts` (22 tests) | `loadUiFromStorage` / `saveUiToStorage` / `attachUiPersistence`: round-trip, version mismatch, malformed JSON, unknown rail tab, non-boolean `railCollapsed`, array / null payloads, every known `RailTab` value, throwing `getItem` / `setItem`, undefined storage, subscribe-on-change, dedupe, dispose handle, no-op without storage | ✅ — drop `version` check → `returns null when version mismatches` fails. ✅ — drop `railCollapsed` type check → `non-boolean` test fails. ✅ — drop `isRailTab` check → `unknown string` test fails. ✅ — drop dedupe in subscriber → `skips the write when neither tracked field changes` fails. |

The new file follows the existing `state/persist/bookmarks.test.ts`
template verbatim (in-memory `makeStorage` stub, fake-store harness with
listener-count, table-driven enum coverage).

## Modified tests

None. No demonstrably wrong tests were observed in the range.

## Findings

### Missing coverage

- `apps/web/src/shell/Drawer.tsx`, `Shell.tsx`, `TopBar.tsx`,
  `drawers/SourcesDrawer.tsx`, `drawers/ChannelsDrawer.tsx`,
  `drawers/LayoutDrawer.tsx` — all new in this range, no unit tests.
  Behaviour is exercised end-to-end via `apps/e2e/tests/panelDrawer.spec.ts`,
  `panelChrome.spec.ts`, `panelKinds.spec.ts`, `bookmarks.spec.ts`.
  **Severity:** low. Components are mostly thin DOM wrappers around the
  store; the e2e specs catch the integration. Worth a follow-up only if a
  pure helper grows out of one of them (e.g. the inline `kindLabel` in
  `SourcesDrawer.tsx:23` could be lifted into a tested helper if it
  spreads).
- `apps/web/src/workers/videoDecode.worker.ts:31-39` (`LOOKAHEAD_NS`
  pacing gate, `setCursor`, `lastEmittedPtsNs`). The fix is the headline
  bug from PR #54; verifying it in unit form requires mocking the
  Comlink remote, the `VideoDecoder` pull pump, and a moving cursor.
  Coverage today comes from `apps/e2e/tests/_record-4k.spec.ts`.
  **Severity:** medium — this is a known regression vector with no unit
  guard. Suggestion: extract the `inFlight + lastEmittedPtsNs - cursorNs >
  LOOKAHEAD_NS` gate into a pure predicate (`shouldRefill(state)`) and
  unit-test it; the worker keeps owning the side-effecty pull loop.

### Suspect tests

None.

### Flaky patterns

None observed in the new suites. The Transport / drawer / shell tests
all force `requestAnimationFrame` to flush synchronously and stub
pointer-capture — the right pattern for jsdom and not flaky.

### Edge cases

- `apps/web/src/state/persist/ui.test.ts` — added tests for storage
  `getItem` and `setItem` throwing (private-mode / quota), and for the
  `null` and array-payload validation branches that the prior
  `bookmarks` / `namedLayouts` test suites also exercise.
- `apps/web/src/layout/persist.ts` — Phase 6 schema bump to v3 is
  covered by additions in `persist.test.ts`. No additional gaps.

## Skipped

- **VideoDecode worker pacing.** The `LOOKAHEAD_NS` gate, `setCursor`
  watermark, and `lastEmittedPtsNs` book-keeping are tightly coupled to
  the Comlink + `VideoDecoder` runtime. Confidently testing them in
  isolation would require a non-trivial harness; the e2e
  `_record-4k.spec.ts` is the right place for now. Listed as a finding
  with a refactor suggestion above rather than a guessed test.
- **`Workspace.tsx` keyboard / drag-drop integration.** The shell
  integration is already broad — testing the full FlexLayout + drawer
  routing in a unit test would require mocking too much of FlexLayout.
  Trusting the e2e specs.
- **Drawer components without exported pure helpers.** Listed under
  Missing coverage; nothing actionable to add as a unit test today
  without writing screen-reader integration tests that duplicate the
  Playwright suite.

## Stats

- Files touched: 1 (test file added; no source file modified).
- Tests added: 22 (all in `apps/web/src/state/persist/ui.test.ts`).
- Tests modified: 0.
- Coverage delta: not measurable (no tool configured); +1 module in the
  test set.
