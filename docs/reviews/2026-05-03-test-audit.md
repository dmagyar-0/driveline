# Test Audit — 2026-05-03

**Range:** `2d1a833..d405b47` (9 commits)

## Summary

Two merges landed since the last audit: PR #79 (`fix(plot): qualify
channel ids with sourceId so multi-MF4 plots don't collide`) and PR #80
(docs sync for the lazy-load mp4 refactor). #79 introduced a new
exported pure helper `qualifiedChannelId(sourceId, nativeId)` plus a
`Channel.nativeId` field, and rewired `VideoPanelContainer` and
`fetchChannelRange` to route through native ids. The PR shipped with
substantial test additions (`memoryBudget.test.ts`, transport
seek-epoch coverage in `store.test.ts`, `videoDecodeOps.test.ts`, plus
`nativeId` updates in five panel test fixtures).

This audit pinned the two regression seams that the new code
introduced but did not directly cover at the unit level:

1. The length-prefix collision-resistance invariant on
   `qualifiedChannelId` — documented in the source comment but only
   tested indirectly via a "two MF4s with same native id stay distinct"
   integration test that would also pass with a naive
   `${sourceId}|${nativeId}` formatter.
2. `VideoPanelContainer`'s routing of `nativeId` to `VideoPanel` — the
   actual one-line fix in #79. Reverting it does not change any DOM
   output, so without a focused mock-the-peer test the regression can
   only be caught by an end-to-end video playback run.

Both new test files passed mutation checks against the code they
cover. No findings flagged for human review; no existing tests modified.

## Baseline

- `pnpm --filter web test --run`: 35 files / 385 tests passed
- `cargo test --workspace`: 62 tests passed across 9 binaries
- Coverage tool: **no coverage tool configured** in `package.json`,
  `apps/web/package.json`, or `Cargo.toml`. Per the audit policy, no
  tooling installed; falling back to diff-based gap analysis.

## Added tests

| File | Test | What it covers | Mutation result |
|---|---|---|---|
| `apps/web/src/state/qualifiedChannelId.test.ts` | `formats as <nativeId.length>\|<nativeId>\|<sourceId>` | Pins the wire format so a parser can recover the nativeId from the composed string | both mutations failed (drop length prefix → 3/9 fail; naive `${src}\|${nat}` → 4/9 fail) |
| ` ` | `encodes the nativeId byte length, not the concatenated length` | Distinguishes `nativeId.length` from a hypothetical "total length" prefix | covered by mutation #1 |
| ` ` | `handles an empty nativeId without producing an empty prefix` | Guards the `nativeId === ""` edge so the encoding stays unambiguous | both mutations failed |
| ` ` | `produces distinct ids when only the sourceId differs` | Double-drop case: same wasm channel id, different `uniqueSourceId` suffix | covered by mutation #1 |
| ` ` | `produces distinct ids when only the nativeId differs` | Trivial direction; pins the basic (sourceId, nativeId) injectivity | covered by mutation #1 |
| ` ` | `collision-resistant against a \| embedded in the sourceId` | Pathological case proving the length prefix earns its keep | covered by mutation #1 |
| ` ` | `collision-resistant against a \| embedded in the nativeId` | Mirror of the above | both mutations failed |
| ` ` | `collision-resistant when the nativeId contains the source name` | Pathological alias attempt with no `\|` involved | covered by mutation #1 |
| ` ` | `is deterministic across repeated calls with the same inputs` | Pure function: required so layout restore matches a freshly-rebuilt session | structural — failed on mutation #1 |
| `apps/web/src/panels/VideoPanelContainer.test.tsx` | `forwards the channel's nativeId (not the qualified id) to VideoPanel` | Pins the PR #79 fix at the unit level — reverting it lets the qualified envelope reach the videoDecode worker | reverting `nativeId` → `id` failed this test (`'7\|1/video\|clip.mp4'` !== `'1/video'`) |
| ` ` | `forwards the source's handle and the resolved sourceKind` | Catches a refactor that drops `sourceHandle`, `sourceKind`, or `panelId` | structural |
| ` ` | `renders the picker when the binding does not resolve to a video channel` | Negative-render guard so the routing test cannot pass on stale prop state from an earlier render | structural |

## Modified tests

None. The seek-epoch additions in `store.test.ts` and the new
`memoryBudget.test.ts` / `videoDecodeOps.test.ts` files that landed in
PR #79 already meet the mutation-fitness bar; no existing test
qualified for the "demonstrably wrong + fix is unambiguous" gate.

## Findings

### Missing coverage

- **Cleared (this audit).** `qualifiedChannelId` and the
  `VideoPanelContainer` `nativeId` routing — both addressed by the
  newly-added tests above.

### Suspect tests

None observed in the changed range. The seek-epoch tests in
`store.test.ts:445-567` are well-anchored — every assertion
distinguishes the `setCursor` (epoch bump) and `advanceCursor`
(no-bump) seams with explicit before/after counters and includes the
hard-to-spot edge case where `setCursor` returns early on no-session
(no bump even though the action was called).

### Flaky patterns

None. New tests are wall-clock-free: `memoryBudget.test.ts` stubs
`performance.memory` via `Object.defineProperty`;
`videoDecodeOps.test.ts` uses `vi.fn()`-backed worker stubs;
`store.test.ts` uses synthetic bigints in place of timestamps.

### Edge cases

- The new `Mp4SampleCache` budget tests exercise the boundary at
  exactly `0.8` (`memoryBudget.test.ts:81-91`) and the divide-by-zero
  case (`memoryBudget.test.ts:102-112`); both are explicit. Good.
- `pickStartCursor` (`videoDecodeOps.test.ts:382-403`) sweeps a
  64-sample GOP grid checking `idx.isSync[r] === 1` and
  `pickedPts <= target`, which is a strong mutation guard for the
  underlying binary search.

## Skipped

- **Coverage instrumentation.** No `cargo llvm-cov`, `vitest --coverage`,
  or `c8` configured in the repo. Per audit policy, did not install or
  configure new tooling.
- **`VideoPanelContainer` empty-state picker click handlers.** The
  `setVideoBinding(panelId, channel.id)` call in the picker
  (`VideoPanelContainer.tsx:111`) intentionally writes the *qualified*
  id (so the binding can later resolve back through `find((c) => c.id
  === channelId)`). Skipped a focused test for it because the existing
  `setVideoBinding` round-trip in `store.test.ts:667-689` already
  covers the storage side, and the picker-click → store-write path is
  rendered-but-not-asserted in two of the new
  `VideoPanelContainer.test.tsx` cases.
- **mcap-source path through `VideoPanelContainer`.** Same wiring as
  the mp4 path tested above — `resolveBinding` only branches on
  `source.kind` to derive `sourceKind`. Adding a duplicate test for
  the mcap kind would mostly duplicate the existing `sourceKind`
  assertion; flagged as low-value follow-up rather than added.

## Stats

- Files touched: 2 added (`apps/web/src/state/qualifiedChannelId.test.ts`,
  `apps/web/src/panels/VideoPanelContainer.test.tsx`)
- Tests added: 12 (9 in `qualifiedChannelId.test.ts`,
  3 in `VideoPanelContainer.test.tsx`)
- Tests modified: 0
- Coverage delta: not measurable (no tooling); diff-based — every
  exported function added in PR #79 now has at least one direct unit
  test, and the one-line container fix has a peer-mocked regression
  guard.
- Final suite: 397 web tests pass, 62 rust tests pass.
