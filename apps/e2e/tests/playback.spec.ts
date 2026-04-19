// T3.3 acceptance test. Asserts the rAF playback loop advances the
// store's `cursorNs` in real time: 1 s of wall-clock at 1× speed must
// move the cursor by `1.0e9 ± 5e7` ns (the 5 % tolerance called out in
// `docs/09-verification-plan.md:113-115`).

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

  test("play advances cursorNs by ~1 s at 1× over 1 s of wall-clock", async ({
    page,
  }) => {
    const t0 = await snapshot(page);
    expect(t0.playing).toBe(false);
    const start = BigInt(t0.cursorNs);

    await page.getByTestId("play-pause").click();
    expect((await snapshot(page)).playing).toBe(true);

    await page.waitForTimeout(1000);

    const t1 = await snapshot(page);
    const advanced = BigInt(t1.cursorNs) - start;
    const expected = 1_000_000_000n;
    const tol = 50_000_000n; // 5 % per docs/09-verification-plan.md:113-115
    expect(
      bigAbs(advanced - expected) <= tol,
      `expected ~1e9 ns advance, got ${advanced} (|diff| > ${tol})`,
    ).toBe(true);
  });

  test("pause stops the cursor advancing", async ({ page }) => {
    await page.getByTestId("play-pause").click();
    await page.waitForTimeout(200);
    await page.getByTestId("play-pause").click();
    const paused = await snapshot(page);
    expect(paused.playing).toBe(false);

    await page.waitForTimeout(300);

    const after = await snapshot(page);
    expect(after.cursorNs).toBe(paused.cursorNs);
  });

  test("speed 2× doubles the advance rate", async ({ page }) => {
    await page.getByTestId("transport-speed").selectOption("2");
    const t0 = await snapshot(page);
    const start = BigInt(t0.cursorNs);
    expect(t0.speed).toBe(2);

    await page.getByTestId("play-pause").click();
    await page.waitForTimeout(1000);

    const t1 = await snapshot(page);
    const advanced = BigInt(t1.cursorNs) - start;
    const expected = 2_000_000_000n;
    // Same 5 % fractional tolerance, scaled to the 2× expectation.
    const tol = 100_000_000n;
    expect(
      bigAbs(advanced - expected) <= tol,
      `expected ~2e9 ns advance at 2×, got ${advanced} (|diff| > ${tol})`,
    ).toBe(true);
  });
});
