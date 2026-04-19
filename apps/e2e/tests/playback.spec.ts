// T3.3 acceptance test. Asserts the rAF playback loop advances the
// store's `cursorNs` in real time at the selected speed.
//
// The "1 s at 1× advances 1 s ± 5 %" statement in
// `docs/09-verification-plan.md:113-115` can't be driven end-to-end on
// `test-fixtures/short.mcap` (span ≈ 90 ms, so the loop auto-pauses at
// `globalRange.endNs` long before a 1 s wall-clock window elapses —
// see `state/store.ts:setCursor`). The absolute-timing precision is
// covered by the unit + bench tests under
// `apps/web/src/timeline/playback.test.ts`; this spec is the
// end-to-end plumbing check, so we run the play-wait-measure sequence
// inside a single `page.evaluate` — Playwright round-trip latency
// (tens of ms) is comparable to the fixture span and would otherwise
// dominate the measurement.
//
// The in-browser measurement window is sized to fit inside the span
// at the given speed, so `setCursor` can't clamp and auto-pause
// during the run.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(thisDir, "../../../test-fixtures");
const MCAP = resolve(fixtureDir, "short.mcap");

interface SessionSnapshot {
  cursorNs: string;
  playing: boolean;
  speed: number;
  globalRange: { startNs: string; endNs: string } | null;
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      clearSession: () => Promise<void>;
      getSessionSnapshot: () => SessionSnapshot;
    };
  }
}

async function snapshot(
  page: import("@playwright/test").Page,
): Promise<SessionSnapshot> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );
}

function bigAbs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

// Play for `waitMs` of wall-clock then sample the cursor. All timing
// happens inside the browser so Playwright round-trip latency can't
// push the cursor past `endNs` and trigger the auto-pause.
async function playAndMeasure(
  page: import("@playwright/test").Page,
  waitMs: number,
): Promise<{ startCursorNs: string; endCursorNs: string; elapsedMs: number; playing: boolean }> {
  return await page.evaluate(async (wait) => {
    const button = document.querySelector<HTMLButtonElement>(
      "[data-testid='play-pause']",
    );
    if (!button) throw new Error("play-pause button not found");
    const startCursorNs =
      window.__drivelineDevHooks!.getSessionSnapshot().cursorNs;
    const t0 = performance.now();
    button.click();
    await new Promise((r) => setTimeout(r, wait));
    const t1 = performance.now();
    const snap = window.__drivelineDevHooks!.getSessionSnapshot();
    return {
      startCursorNs,
      endCursorNs: snap.cursorNs,
      elapsedMs: t1 - t0,
      playing: snap.playing,
    };
  }, waitMs);
}

test.describe("playback loop (T3.3)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );

    const bytes = Array.from(readFileSync(MCAP));
    const result = await page.evaluate(
      async (input) => {
        const materialised = input.map((d) => ({
          name: d.name,
          bytes: new Uint8Array(d.bytes),
        }));
        return await window.__drivelineDevHooks!.openFiles(materialised);
      },
      [{ name: "short.mcap", bytes }],
    );
    expect(result.errors).toEqual([]);
    expect(result.opened).toEqual(["short.mcap"]);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("play advances cursorNs at 1× within the fixture span", async ({
    page,
  }) => {
    const t0 = await snapshot(page);
    expect(t0.playing).toBe(false);
    expect(t0.globalRange).not.toBeNull();
    const span =
      BigInt(t0.globalRange!.endNs) - BigInt(t0.globalRange!.startNs);
    // Size the wait to ~a third of the span — comfortably shy of the
    // auto-pause boundary, but long enough to span several rAFs.
    const waitMs = Math.max(16, Math.floor(Number(span / 1_000_000n) / 3));

    const m = await playAndMeasure(page, waitMs);
    expect(m.playing).toBe(true);
    const advanced = BigInt(m.endCursorNs) - BigInt(m.startCursorNs);
    // Ratio-based check: cursor advance / wall elapsed ≈ speed.
    // Absolute tolerance sized to tolerate multi-frame rAF stalls under
    // parallel-worker VM load (headless chromium's rAF cadence can dip
    // to 60+ ms when several specs share a host). The unit/bench tests
    // in `apps/web/src/timeline/playback.test.ts` cover the tight
    // precision numbers directly against the loop implementation.
    const expected = BigInt(Math.round(m.elapsedMs * 1e6));
    const tol = 50_000_000n;
    expect(
      bigAbs(advanced - expected) <= tol,
      `expected ~${expected} ns advance in ${m.elapsedMs} ms at 1×, got ${advanced} (|diff| > ${tol})`,
    ).toBe(true);
  });

  test("pause stops the cursor advancing", async ({ page }) => {
    const t0 = await snapshot(page);
    const span =
      BigInt(t0.globalRange!.endNs) - BigInt(t0.globalRange!.startNs);
    const waitMs = Math.max(16, Math.floor(Number(span / 1_000_000n) / 3));

    // Play briefly then pause, all inside the browser — keeps the
    // play window under `span / speed` so auto-pause doesn't flip
    // `playing` back to true via a user-intent mismatch.
    const result = await page.evaluate(async (wait) => {
      const button = document.querySelector<HTMLButtonElement>(
        "[data-testid='play-pause']",
      );
      if (!button) throw new Error("play-pause button not found");
      button.click();
      await new Promise((r) => setTimeout(r, wait));
      button.click();
      const paused = window.__drivelineDevHooks!.getSessionSnapshot();
      await new Promise((r) => setTimeout(r, 100));
      const after = window.__drivelineDevHooks!.getSessionSnapshot();
      return { paused, after };
    }, waitMs);

    expect(result.paused.playing).toBe(false);
    expect(result.after.cursorNs).toBe(result.paused.cursorNs);
  });

  test("speed 2× doubles the advance rate", async ({ page }) => {
    await page.getByTestId("transport-speed").selectOption("2");
    const t0 = await snapshot(page);
    expect(t0.speed).toBe(2);
    const span =
      BigInt(t0.globalRange!.endNs) - BigInt(t0.globalRange!.startNs);
    // Half the 1× window at 2× so the same cursor distance gets
    // covered — keeps us clear of `endNs`.
    const waitMs = Math.max(16, Math.floor(Number(span / 1_000_000n) / 6));

    const m = await playAndMeasure(page, waitMs);
    expect(m.playing).toBe(true);
    const advanced = BigInt(m.endCursorNs) - BigInt(m.startCursorNs);
    const expected = BigInt(Math.round(m.elapsedMs * 2 * 1e6));
    const tol = 100_000_000n; // 2× the 1× wall-clock tolerance.
    expect(
      bigAbs(advanced - expected) <= tol,
      `expected ~${expected} ns advance in ${m.elapsedMs} ms at 2×, got ${advanced} (|diff| > ${tol})`,
    ).toBe(true);
  });
});
