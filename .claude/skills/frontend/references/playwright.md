# Playwright recipes for driveline

The driveline e2e suite lives in `apps/e2e/`. Tests target a Vite dev
server with the wasm worker built. The pattern is **drive the app
through `window.__drivelineDevHooks`** — a deliberately small,
test-only API surface defined in `apps/web/src/App.tsx`. DOM selectors
are the fallback, not the primary tool.

Read this file before adding a new e2e or a new dev hook.

## Why hooks instead of selectors

The transport timestamp is rendered text: `"00:03.412 / 00:10.000"`.
Asserting that string is brittle (formatter changes break unrelated
tests) and slow (you wait for a paint). Asserting `cursorNs` via the
hook is one round trip and survives every formatting change.

Use a DOM signal when the assertion is genuinely about what the user
sees (focus ring visible, panel rendered, button disabled). Use a hook
when the assertion is about what the app *thinks* (cursor position,
playing flag, decode queue depth).

## The dev-hook contract

`window.__drivelineDevHooks` is set in `App.tsx`. Each hook is named for
the observation or action it enables, not the internal call. Current
surface (snapshot — re-read `App.tsx` if it has drifted):

| Hook | Purpose |
|---|---|
| `ping`, `pingVideo` | Worker liveness |
| `openFiles(files)` | The same path the real drop handler takes |
| `clearSession()` | Reset between tests |
| `openMf4(bytes)` / `closeMf4(handle)` / `mf4FetchRange(...)` | Direct data-core calls (worker contract) |
| `getSessionSnapshot()` | Transport state, BigInts as strings |
| `videoLastBlitPtsNs()` | Last frame painted by `<canvas>` blit |
| `videoHudStats()` | Decode queue depth, drops, codec — for seek perf |
| `getLayoutJson()` / `setLayoutJson()` | FlexLayout snapshot/restore |

When you need an observation that no hook provides, **add the hook
first**, in a separate commit, with a one-sentence explanation in the
JSDoc. Do not reach into React internals from the test.

### Adding a hook — the rules

- Name it for the observable, not the implementation
  (`videoHudStats`, not `getDecoderState`)
- Read state via the Zustand store's `getState()` — never via a React
  hook (the dev hook runs outside the React tree)
- Serialise BigInts as strings on the page side, never trust the
  default JSON serialiser to do it
- Return a plain object — no class instances, no functions, nothing
  Comlink-wrapped. `page.evaluate` structured-clones the return value.
- If the hook performs an action (not just reads), give it an
  imperative verb (`openFiles`, `clearSession`)

## BigInts across `page.evaluate`

`page.evaluate` cannot serialise `BigInt`. Always convert on the page
side and back in Node:

```ts
// page side (in the dev hook)
getSessionSnapshot: () => {
  const s = useSession.getState();
  return {
    cursorNs: s.cursorNs.toString(),
    playing: s.playing,
    speed: s.speed,
    globalRange: s.globalRange
      ? { startNs: s.globalRange.startNs.toString(), endNs: s.globalRange.endNs.toString() }
      : null,
  };
},

// node side (in the test)
const snap = await page.evaluate(() => window.__drivelineDevHooks!.getSessionSnapshot());
const cursorNs = BigInt(snap.cursorNs);
expect(cursorNs).toBeGreaterThan(0n);
```

## Recipe: arrange-via-hook, observe-via-hook

The default shape of a driveline test:

```ts
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('cursor advances during playback', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');     // wait for wasm + workers

  const fixture = readFileSync('test-fixtures/short.mf4');
  await page.evaluate(async (bytes) => {
    await window.__drivelineDevHooks!.openFiles([
      { name: 'short.mf4', bytes: new Uint8Array(bytes) },
    ]);
  }, Array.from(fixture));

  const before = await page.evaluate(() =>
    BigInt(window.__drivelineDevHooks!.getSessionSnapshot().cursorNs)
  );
  // ... trigger play, wait, snapshot again ...
});
```

## Recipe: arrange-via-hook, observe-via-DOM

When the assertion really is about what the user sees:

```ts
test('transport play button shows pause glyph while playing', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await loadFixture(page, 'short.mf4');

  await page.evaluate(() => window.__drivelineDevHooks!.play());
  await expect(page.getByRole('button', { name: /pause/i })).toBeVisible();
});
```

Prefer `getByRole` and accessible-name selectors over class or
`data-testid`. If the role isn't queryable, the control is not
accessible — fix the component, not the test.

## Recipe: video seek perf budget

Video seek time is a budget we measure. Use `videoHudStats()` to assert
the queue drains and `videoLastBlitPtsNs()` to assert the painted frame
matches the requested seek:

```ts
test('seek to 5s settles within budget', async ({ page }) => {
  await loadFixture(page, 'short.mp4');

  const t0 = Date.now();
  await page.evaluate(() => window.__drivelineDevHooks!.seekNs('5000000000'));

  await expect.poll(async () => {
    const stats = await page.evaluate(() => window.__drivelineDevHooks!.videoHudStats());
    return stats?.decodeQueue ?? 99;
  }, { timeout: 1500, intervals: [50, 100, 200] }).toBeLessThanOrEqual(1);

  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(500);  // P95 budget
});
```

`expect.poll` with explicit `intervals` beats `waitForTimeout` —
it ends as soon as the condition holds.

## Recipe: layout persistence

```ts
test('layout survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => window.__drivelineDevHooks!.addPlotPanel());

  const before = await page.evaluate(() => window.__drivelineDevHooks!.getLayoutJson());

  await page.reload();
  await page.waitForLoadState('networkidle');

  const after = await page.evaluate(() => window.__drivelineDevHooks!.getLayoutJson());
  expect(after).toEqual(before);
});
```

## Recipe: console + page errors

Always register handlers **before** `page.goto`, otherwise you miss the
boot-time errors that matter most:

```ts
test('no console errors during golden path', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await loadFixture(page, 'short.mf4');
  await page.evaluate(() => window.__drivelineDevHooks!.play());
  await page.waitForTimeout(1000);

  expect(pageErrors).toEqual([]);
  // Filter known-noisy lines explicitly; never blanket-allow
  expect(consoleErrors.filter((l) => !l.includes('DevTools failed to load'))).toEqual([]);
});
```

## Recipe: reconnaissance before assertion

When you don't yet know the page structure (new feature, refactor),
take a screenshot and dump the discoverable controls before writing
selectors:

```ts
test.skip('recon — what is on this page', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const buttons = await page.getByRole('button').all();
  const labels = await Promise.all(buttons.map((b) => b.getAttribute('aria-label')));
  console.log('buttons:', labels);

  await page.screenshot({ path: '/tmp/recon.png', fullPage: true });
});
```

Delete the recon test once the real one is written. Don't ship a `.skip`.

## Things that go wrong (and the fix)

| Symptom | Cause | Fix |
|---|---|---|
| `window.__drivelineDevHooks is undefined` | Goto raced the React mount | Add `await page.waitForFunction(() => !!window.__drivelineDevHooks)` after `networkidle` |
| `BigInt is not serializable` | Returning a BigInt from `page.evaluate` | Convert to string on the page side |
| Test passes locally, fails in CI | Wasm load takes longer in CI | Replace `waitForTimeout` with `expect.poll` or `waitForFunction` |
| Flake on the first run only | Vite cold-builds the wasm import | The Playwright `webServer` config should `pnpm wasm:build` first; check `apps/e2e/playwright.config.ts` |
| Pixel diff fails on a font hint | Anti-aliasing differs across machines | Use a hook + DOM-state assertion; if you must pixel diff, `clip:` to the smallest meaningful region and mask text |

## Workflow when a Playwright test fails

1. **Read the trace, not the source first.** `pnpm --filter e2e test`
   produces `playwright-report/` — open the trace viewer; it shows
   network, console, DOM, and screenshots side by side.
2. **Reproduce with `--headed`** if the trace is ambiguous. The repo's
   `playwright.config.ts` honours `--headed` and `--debug`.
3. **Diagnose the root cause** before changing the test. A flaky test
   is almost always a missing `expect.poll` or a missing hook — not a
   reason to extend a `waitForTimeout`.
4. **Never `.skip` a failing test to unblock a PR** without filing the
   follow-up and explaining why in the PR body.
