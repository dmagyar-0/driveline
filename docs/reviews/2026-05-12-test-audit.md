# Test Audit — 2026-05-12

**Range:** `1afd5da..fa9641e` (7 commits)

## Summary

Material source change in range is one line: `apps/web/src/panels/videoReadiness.ts` swapped its silent `catch {}` for `catch (err) { console.warn("videoReadiness: subscriber threw", err); }`. The remaining `.ts` edits in `Transport.tsx` and `playback.ts` are comment-only. Two new boundary-pinning tests for `detectMp4Framing` (`nal_type == 1`, `nal_type == 23`) already landed in commit `b5b0918` as part of the daily-review fixups.

Added a single new test that pins the `console.warn` output of `scheduleNotify`'s catch block so a future refactor cannot silently re-swallow subscriber errors and reintroduce the "stuck readiness dot" failure mode the warn was added to expose. Mutation-checked by removing the `console.warn` and confirming the test fails (`expected "warn" to be called 1 times, but got 0 times`). Nothing else in the range warrants a new or modified test.

## Baseline

- `pnpm --filter web test --run` — **38 files / 446 tests passing** before changes; **38 files / 447 tests passing** after.
- `cargo test --workspace` — **67 tests passing** (50 + 2 + 3 + 4 + 3 + 5 across crates), 0 failed.
- Coverage tool: **no coverage tool configured** in `package.json`, `apps/web/package.json`, or `Cargo.toml`. Falling back to diff-based gap analysis only per the playbook.

## Added tests

| File | Test | What it covers | Mutation check |
|------|------|----------------|----------------|
| `apps/web/src/panels/videoReadiness.test.ts` | `videoReadiness registry > logs subscriber errors via console.warn so a swallowed-update regression is visible` | Asserts `scheduleNotify` calls `console.warn` exactly once with the literal message `"videoReadiness: subscriber threw"` and the thrown `Error` instance, after a registered subscriber throws. Pins the second argument so a "warn but drop the error" regression also fails. | **Passed.** Replaced `catch (err) { console.warn(...) }` with `catch {}` in `videoReadiness.ts`; new test failed (`expected "warn" to be called 1 times, but got 0 times`); reverted. |

## Modified tests

None. The pre-existing `subscriber callbacks that throw do not break the notify loop` test still asserts a different invariant (loop survives the throw) and is correct as-is, so it was left untouched per the modification bar.

## Findings

### Missing coverage

- _None of note._ The diff is a logging change and two comment edits; existing tests already exercise the surrounding state machine (`videoReadiness.test.ts:143` covers the survive-the-throw behavior, `Transport`'s waiting hysteresis and `playback.ts`'s gate flag are covered by `playback.test.ts` and the `decodeAwareCursor.spec.ts` e2e).

### Suspect tests

- `apps/web/src/panels/videoReadiness.test.ts:143` — the throw-survival test deliberately runs an un-mocked subscriber that throws. With today's source change, this test now prints `videoReadiness: subscriber threw Error: boom` to stderr during every run. The output is correct behavior, not a bug, but it is mildly noisy in CI logs. **Severity: low.** Suggestion (for a future tightening, not now): silence `console.warn` with a `vi.spyOn` at the top of that test if the noise becomes a problem.

### Flaky patterns

- _None observed._ All readiness, playback, and videoDecodeOps tests stub `requestAnimationFrame` and `setTimeout` deterministically; no wall-clock or network dependence in the range.

### Edge cases

- `apps/web/src/workers/videoDecodeOps.ts:337` (`detectMp4Framing`) — the two new boundary tests added in `b5b0918` cover the `nal_type` inclusive limits (`1` and `23`). The other plausible boundary — a forbidden_zero_bit set with an otherwise-valid `nal_type` in `1..=23` — is also covered (`apps/web/src/workers/videoDecodeOps.test.ts:345`). No further gaps here.
- `apps/web/src/panels/videoReadiness.ts:55` — the `if (typeof requestAnimationFrame === "function")` branch is exercised by every test via `vi.stubGlobal`; the `setTimeout` fallback branch is not directly tested. **Severity: low.** Concrete suggestion: a single test that calls `__resetReadinessForTests()`, deletes the rAF stub (`delete (globalThis as any).requestAnimationFrame`), uses `vi.useFakeTimers()`, calls `setPanelReadiness`, advances timers, and asserts the subscriber fired. Skipped this audit because the fallback exists for jsdom + Vitest node environments and is therefore *de facto* exercised by every test that mounts the registry; an explicit pin would be defense-in-depth, not a confirmed gap.

## Skipped

- A direct test of the `setTimeout` fallback in `scheduleNotify` (listed above) — not confident the test would survive a future refactor that switches to `queueMicrotask` or similar without losing its protective value. Left as a finding.
- Behavior of `playback.ts`'s `cursorGated` flag under concurrent loops (called out in the new JSDoc caveat) — the production assumption is one loop per module; writing a "two loops race" test would codify behavior the module explicitly does not support and would constrain future refactors. Left as documentation in the source.

## Stats

- Files touched: **1** (`apps/web/src/panels/videoReadiness.test.ts`)
- Tests added: **1**
- Tests modified: **0**
- Tests deleted: **0**
- Coverage delta: n/a (no coverage tool configured)
- Web suite: 446 → 447 passing
- Cargo suite: 67 → 67 passing
