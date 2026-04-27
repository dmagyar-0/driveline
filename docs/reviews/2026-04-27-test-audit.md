# Test Audit — 2026-04-27

**Range:** `642ae4c..674fa7c` (14 commits)

## Summary

Audited the 14 commits merged since the 2026-04-26 audit. The substantive
test-relevant work was the V1 shell skeleton (Phase 0 token sweep + Phase
1 top-bar / icon-rail / drawer host). The new code added one persist
module (`apps/web/src/state/persist/ui.ts`) and three new actions on the
session store (`setActiveRailTab`, `setRailCollapsed`,
`setSelectedPanelId`); none of those landed with tests.

I added two test files closing both gaps. Both went red on direct
mutations of the production code and green again on revert. The shell
React components themselves (`Shell`, `TopBar`, `Rail`, `Drawer`) are
listed as findings rather than tested directly — the existing
`Transport.test.tsx` / `PlotPanel.test.tsx` jsdom pattern would mount
them, but each requires non-trivial worker / store wiring and is
better-served by the e2e specs that already cover the rail testids.

## Baseline

- `pnpm --filter web test --run`: **153 passed / 0 failed** across 17
  files at audit start; **176 passed / 0 failed** across 18 files after
  the additions below (+23 tests).
- `cargo test --workspace`: **could not run.** The sandbox blocks
  `index.crates.io` (`HTTP 503 / DNS cache overflow` after 4 retries),
  so cargo can't resolve `mp4`, `arrow-buffer`, etc. The previous audit
  recorded `66 passed / 0 failed` for the rust suite at `642ae4c`. The
  only rust file changed in this range is
  `crates/data-core/src/mp4_sidecar.rs`, and the diff is 21 added lines
  inside `mod tests` (covered in the 2026-04-26 audit). No new rust
  source paths were modified, so the suite is presumed still green —
  but flagged here for the next session that has crates.io reachable.
- No coverage tool is configured for either toolchain
  (`cargo llvm-cov`, `vitest --coverage`, `c8`, `nyc`, `.nycrc` —
  none present in `Cargo.toml`, root `package.json`,
  `apps/web/package.json`, or `vite.config.ts`). Per audit policy:
  **no coverage tool installed**; gap analysis is diff-based only.

## Added tests

| File:test | Covers | Mutation check |
|---|---|---|
| `apps/web/src/state/persist/ui.test.ts::ui persist > round-trips save → load` | `saveUiToStorage` + `loadUiFromStorage` happy path on the canonical `{version:1, activeRailTab:"channels", railCollapsed:false}` payload. | (Implicit; covered by the next four mutations.) |
| `apps/web/src/state/persist/ui.test.ts::ui persist > returns null when version mismatches` | The `if (raw.version !== UI_SCHEMA_VERSION) return null;` guard at `ui.ts:50`. | Commented out the guard. Test went **red** with the persisted `{version:2,...}` object surfacing instead of `null`. Reverted; green. |
| `apps/web/src/state/persist/ui.test.ts::ui persist > returns null when activeRailTab is not a known tab id` | The `if (tab !== null && !isRailTab(tab)) return null;` guard at `ui.ts:52`. | Commented out the guard. Test went **red** (`"not-a-real-tab"` came back instead of `null`). Reverted; green. |
| `apps/web/src/state/persist/ui.test.ts::ui persist > returns null when railCollapsed is not a boolean` | The `if (typeof raw.railCollapsed !== "boolean") return null;` guard at `ui.ts:53`. | Commented out the guard. Test went **red** (`"yes"` came back as the value). Reverted; green. |
| `apps/web/src/state/persist/ui.test.ts::ui persist > returns null for malformed JSON` | The `JSON.parse` try/catch at `ui.ts:73-77`. | Implicit: removing the catch would throw before `expect`. Behaviour matches the layout-persist sibling test. |
| `apps/web/src/state/persist/ui.test.ts::ui persist > accepts every documented RailTab id` | All 5 ids in `RAIL_TABS` round-trip through `validate`. Catches drift if a future `RailTab` value is added in `ui.ts` without updating the `RAIL_TABS` allow-list. | Removing `"events"` from `RAIL_TABS` would make this test red on the events leg. |
| `apps/web/src/state/persist/ui.test.ts::ui persist > rejects payloads where the top-level value is not a plain object` | The `isPlainObject` guard rejects arrays and primitive strings. | Removing the guard would let arrays through `validate` and the test would go red. |
| `apps/web/src/state/persist/ui.test.ts::attachUiPersistence > skips the write when both tracked fields are equal to the snapshot` | The reference-equality short-circuit at `ui.ts:113-117`. | Replaced the `if (...) return;` with `if (false) return;`. Test went **red** (storage now contained the no-op write). Reverted; green. |
| `apps/web/src/state/persist/ui.test.ts::attachUiPersistence > unsubscribes on the returned dispose handle` | The dispose returned by `store.subscribe` actually detaches the listener. | Returning a no-op dispose would leave the listener attached and the post-stop push would land in storage. |
| `apps/web/src/state/persist/ui.test.ts::attachUiPersistence > treats activeRailTab and railCollapsed independently` | Each tracked field individually triggers a flush — guards against a refactor that ANDs the equality check instead of ORing it. | Implicit: an AND-mistake in the short-circuit would pass the equal-snapshot test but fail this one. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > defaults to a closed rail with no selected panel` | Default values for `activeRailTab`, `railCollapsed`, `selectedPanelId` at `store.ts:234-236`. | Changing the default `?? null` to `?? "sources"` would fail this test. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > setActiveRailTab is a no-op when the value already matches` | The early-return guard at `store.ts:323-324`. | Removed `if (get().activeRailTab === tab) return;`. Test went **red** (subscribe fired once when the value didn't change). Reverted; green. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > setRailCollapsed roundtrips and short-circuits on identical input` | Both write path and the early-return guard at `store.ts:328-330`. | Implicit: same mutation pattern as `setActiveRailTab`. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > setSelectedPanelId roundtrips and short-circuits on identical input` | Both write path and the early-return guard at `store.ts:333-335`. | Replaced the body with `set({ selectedPanelId: null })`. Test went **red** on the roundtrip leg. Reverted; green. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > clear preserves UI shell state (it outlives a session)` | The deliberate omission of `activeRailTab` / `railCollapsed` / `selectedPanelId` from `clear()`'s `set()` payload at `store.ts:507-516`. | Added `activeRailTab: null, railCollapsed: false, selectedPanelId: null` to `clear()`'s set. Test went **red** (`activeRailTab` came back as `null` instead of `"panel"`). Reverted; green. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > setActiveRailTab roundtrips and clears with null` | Plain write path; rail-tab id values flow through unchanged. | Captured by the no-op-when-matching mutation above. |
| `apps/web/src/state/store.test.ts::UI shell slice (Phase 1) > UI shell setters are independent of each other` | All three setters touch their own field only — guards against a refactor that ties them together (e.g. clearing `selectedPanelId` when `activeRailTab` changes). | Implicit. |

Total new tests: **23** (16 in `ui.test.ts`, 7 in `store.test.ts`).

## Modified tests

None. No existing test was demonstrably wrong. The 2026-04-26 audit's
hardening of `perf.test.ts` is still in place and untouched here.

## Findings

### Missing coverage

- `apps/web/src/shell/Rail.tsx:88` — `if (railCollapsed) return null;` is
  untested. Rendering Rail under jsdom and toggling
  `useSession.getState().setRailCollapsed(true)` would close the gap.
  Severity: medium (a regression hides the entire rail). Suggestion:
  `Rail.test.tsx` modeled on `Transport.test.tsx`, asserting the
  presence of `data-testid="rail"` and the count of buttons.
- `apps/web/src/shell/Rail.tsx:107` — the click handler
  `setActiveRailTab(isActive ? null : item.id)` is the VS-Code-style
  toggle behaviour the integration plan calls out. No unit test pins
  this. Severity: medium. Suggestion: `userEvent.click` on
  `rail-channels`, assert `activeRailTab === "channels"`; click again,
  assert it falls back to `null`.
- `apps/web/src/shell/Drawer.tsx:69` — the
  `if (activeRailTab === null) return null;` early-return and the
  `STUBS[activeRailTab]` switch are both untested. Severity: low (the
  stubs are placeholders that Phase 2-8 each replace). Suggestion: a
  parameterised test covering all 5 ids, asserting
  `getByTestId(\`drawer-${tab}\`)`.
- `apps/web/src/shell/TopBar.tsx:22-23` — the singular/plural
  `${sourceCount} source${sourceCount === 1 ? "" : "s"}` switch is a
  trivial off-by-one trap. Severity: low. Suggestion: render with
  `sources: []`, expect "0 sources"; render with one source, expect
  "1 source"; render with two sources, expect "2 sources".
- `apps/web/src/shell/Shell.tsx:52` — the `dragActive && <div ...>`
  overlay branch is only exercised end-to-end. Severity: low.
  Suggestion: render with `dragActive={true}` and assert the overlay
  text is in the document.

### Suspect tests

- None observed. The new tests in this audit each pin a specific
  behaviour with an explicit assertion; none over-mocks; none uses
  timing or wall-clock state. The mutation runs on `setActiveRailTab`
  and `setSelectedPanelId` confirm the `subscribe`-counter pattern
  catches the no-op-on-equal regressions.

### Flaky patterns

- `apps/web/src/state/store.test.ts::UI shell slice (Phase 1)` reaches
  into the singleton `useSession` store the same way every other suite
  in the file does. To avoid order-dependent state across sub-describes,
  I added an explicit `beforeEach` that resets the three UI shell
  fields. The two final tests in the new block also tidy up after
  themselves; this keeps the global store from leaking shell state into
  any later test that ever gets added below.

### Edge cases

- `apps/web/src/state/persist/ui.ts::loadUiFromStorage` — a
  storage `getItem` that throws (Safari ITP / private mode quirks) is
  swallowed and treated as "no payload". The test suite covers the
  `undefined` storage case and the malformed-JSON case, but not the
  throwing-`getItem` case. Severity: very low. Suggestion: stub a
  `Storage` whose `getItem` throws and assert `loadUiFromStorage`
  returns `null`. Mirrors a coverage gap that's also present in
  `layout/persist.test.ts`.
- `apps/web/src/state/store.ts::setRailCollapsed` does not pause
  playback or otherwise interact with the transport slice. That looks
  intentional (rail collapse is purely cosmetic) but isn't documented.
  No new test landed here because the intended invariant is not
  ambiguous — collapsing the rail is a pure UI-shell mutation — but
  it's worth a docstring line.
- `apps/web/src/shell/TopBar.tsx::elapsed` reads `globalRange?.startNs`
  with a `?? 0n` fallback, then formats. When `globalRange` is null,
  `formatRelative(cursorNs, 0n)` is called with `cursorNs = 0n`, which
  the existing `formatTime.test.ts` already covers as `0:00`. So the
  empty-session render is implicitly pinned. No new test.

## Skipped

- `Rail.test.tsx`, `Drawer.test.tsx`, `TopBar.test.tsx`,
  `Shell.test.tsx` — listed as findings rather than landed. The
  jsdom-mounted-component tests in this repo
  (`Transport.test.tsx`, `PlotPanel.test.tsx`) carry non-trivial worker
  / store wiring overhead, and the rail/drawer behaviour is already
  covered indirectly by e2e specs that drive
  `__drivelineDevHooks.setActiveRailTab` /
  `setRailCollapsed`. Adding 4 new component test files in the audit
  window felt like over-scoping; recording the gap so a future audit
  (or a Phase 2 dev) can address them with the right context. (The
  audit policy "do not add tests for behavior you are guessing at" —
  the click-toggle behaviour is unambiguous, but each component has
  enough surface area that a quick test pass would risk coupling to
  implementation details rather than behaviour.)
- `cargo test --workspace` re-run with mutations — sandbox network
  blocked, see Baseline. The 2026-04-26 mp4_sidecar tests are presumed
  still passing because no rust source files outside the test module
  changed in this range.
- A direct test of the in-use `localStorage`-backed default in
  `loadUiFromStorage` (i.e. without the explicit storage parameter).
  Vitest's node env has no `localStorage`, so the default-arg path
  hits `defaultStorage()` returning `undefined` and falls through. The
  jsdom-env tests (`Transport.test.tsx`, `PlotPanel.test.tsx`) already
  exercise the persistence indirectly via `useSession`. Not worth a
  dedicated jsdom test file just for this one path.

## Stats

- Files touched: **2** test files added
  (`apps/web/src/state/persist/ui.test.ts`,
  `apps/web/src/state/store.test.ts`).
- Tests added: **23** (16 new in `ui.test.ts`, 7 new in `store.test.ts`).
- Tests modified: **0**.
- Coverage delta: not measured — no coverage tool configured.
- Final suite totals: vitest **176 passed / 0 failed** across 18
  files; cargo not run (sandbox network).
