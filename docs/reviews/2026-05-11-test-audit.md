# Test Audit — 2026-05-11

**Range:** `dec30b4..1afd5da` (5 commits)

## Summary

Audited the mp4 framing autodetect + decode-aware cursor gating changes
landed in `dc47875`, plus the merge/admin commits since the last audit.
Baseline was green (web 444 / cargo 67). The new code (`videoReadiness`,
`playback` gate, `detectMp4Framing`, `videoStreamOps` Annex-B branch)
already ships with thorough unit coverage including mutation-guard tests
on the binary search, refill watermark, and framing detector boundaries.
Added two boundary mutation guards on `detectMp4Framing` for the
inclusive endpoints of the valid `nal_unit_type` range (1 and 23) — the
existing tests covered 0, 5, 7, 9, 24, 31 but neither inclusive
boundary, leaving an off-by-one in the range predicate undetected. No
existing tests were modified. Full suite green after additions
(web 446 / cargo 67).

## Baseline

- `pnpm --filter web test --run` → **444 passed, 0 failed** across 38 files.
- `cargo test --workspace` → **67 passed, 0 failed** across 9 binaries.
- Coverage: **no coverage tool configured** in `package.json`,
  `Cargo.toml`, or `Makefile`. Falling back to diff-based gap analysis
  per audit policy.

## Added tests

| File | Test | Covers | Mutation check |
|---|---|---|---|
| `apps/web/src/workers/videoDecodeOps.test.ts` | `detectMp4Framing > returns annexb at the inclusive nal_type == 1 lower boundary (non-IDR slice)` | The lower-bound predicate `nalType === 0 → "avcc"`; nal_type 1 (P-slice) must classify as Annex-B. | Changed `=== 0` → `<= 1` in `videoDecodeOps.ts:351`; test failed `expected 'avcc' to be 'annexb'`. Reverted. |
| `apps/web/src/workers/videoDecodeOps.test.ts` | `detectMp4Framing > returns annexb at the inclusive nal_type == 23 upper boundary` | The upper-bound predicate `nalType > 23 → "avcc"`; nal_type 23 must classify as Annex-B (highest valid H.264 type). | Changed `> 23` → `>= 23` in `videoDecodeOps.ts:352`; test failed `expected 'avcc' to be 'annexb'`. Reverted. |

Both tests use the same byte-level fixture shape as the existing
boundary cases (`00 00 00 01 | <NAL header> | <payload>`), so they
are stylistically consistent and require no new helpers.

## Modified tests

None. The existing tests for the audited range are sound — no
demonstrably wrong assertions, no testing-removed-behavior, no
asserting-on-own-input patterns spotted.

## Findings

### Missing coverage (low severity)

- **`videoReadiness.ts:103` (`getReadinessSnapshot` returning a stable
  `Map` reference)** — the docstring asserts callers may treat the
  return as a stable handle, but no test pins this contract. A future
  refactor returning a defensive copy would silently break Transport
  consumers that expect to see live mutations through the same
  reference. *Suggestion:* assert `getReadinessSnapshot() ===
  getReadinessSnapshot()` after a write. (Skipped to avoid pinning an
  implementation detail that could legitimately change; flagging for
  review.)

- **`videoReadiness.ts:125` (`__resetReadinessForTests` listener
  cleanup)** — the test seam clears both `registry` and `listeners`,
  but the listener clear is not asserted. A regression that drops
  `listeners.clear()` would leak subscribers across vitest cases
  without failing assertions (each test uses a fresh `vi.fn()` so
  orphaned listeners are silent). *Suggestion:* register a subscriber,
  reset, then write a panel and assert the subscriber was not called.
  Severity is low because the leak is invisible to test outcomes.

- **`playback.ts:138-160` (gate skip when `bound=[]` but the registry
  has stale entries)** — the orphan-binding test covers the inverse
  (binding without registry entry). The bound-list-empty-but-registry-
  populated case is currently only covered indirectly. *Suggestion:*
  add a test that the gate ignores a "waiting" panel that isn't in
  the bound list. Skipped — in production, panel cleanup runs
  `clearPanelReadiness` so this state shouldn't persist; treat as
  defense-in-depth.

### Suspect tests

None. The added test file from `dc47875`
(`apps/web/src/panels/videoReadiness.test.ts`) explicitly tests the
"throws don't break the notify loop" contract via two real subscribers,
which is a clean way to validate the silent-catch in
`scheduleNotify`.

### Flaky patterns

None spotted. The added unit tests in this range avoid wall-clock and
real `requestAnimationFrame`:

- `videoReadiness.test.ts` stubs `requestAnimationFrame` synchronously.
- `playback.test.ts` injects a hand-rolled `FakeClock` and never
  consults `performance.now()` directly.
- `videoDecodeOps.test.ts` is pure-data — no timers, no I/O, no Comlink
  spawns.

### Edge cases

- `detectMp4Framing` boundary at the inclusive endpoints — addressed
  by the two added tests above.
- `videoStreamOps` mp4 path with an empty index (`ptsNs.length === 0`)
  — `pickStartCursor` returns 0, the `cursor < length` guard skips
  framing detection, and `buildAvccDescription` is invoked with empty
  SPS/PPS. The synthesised description for an empty SPS may not be a
  valid avcC record. Currently no test exercises this, but in
  production the wasm reader rejects a track with zero samples
  upstream of `videoStreamOps.open`, so the path is unreachable.
  Listed for review only.

## Skipped

- A "scratch object reuse across `setPanelReadiness` calls" test for
  `videoReadiness.ts:80-85` — the existing
  "notifies subscribers on first insert and on state transitions only"
  test already exercises the same code path with distinct objects per
  call and would fail if the `prevState` capture were removed. Adding
  a same-reference variant would be redundant.
- Tests for the `useDecodeWaiting` hook in `Transport.tsx` — the
  hysteresis logic is timer-driven (`WAITING_VISIBLE_DELAY_MS = 250`,
  `WAITING_MIN_VISIBLE_MS = 400`) and would require `vi.useFakeTimers`
  plus jsdom cleanup; the e2e suite already covers the visible
  affordance through `_record-mp4-annexb.spec.ts` and
  `decodeAwareCursor.spec.ts`.
- Tests for `App.tsx`'s `findChannelId` and `getVideoReadiness` /
  `getCursorGated` Playwright dev hooks — these only exist as
  `window.__driveline` integration seams; covered by the e2e suite.

## Stats

- Files touched: 1 test file (`apps/web/src/workers/videoDecodeOps.test.ts`).
- Tests added: 2.
- Tests modified: 0.
- Coverage delta: not measurable (no coverage tool configured).
- Web suite: 444 → **446** passing.
- Cargo suite: 67 → **67** passing (no Rust changes in range).
