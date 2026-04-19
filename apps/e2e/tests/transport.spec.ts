// T3.2 acceptance test. Drives the transport bar end-to-end:
// play/pause button, scrubber drag, Space/Home/End keyboard shortcuts,
// and the speed dropdown. Store state is read through the existing
// `__drivelineDevHooks.getSessionSnapshot` seam (bigints serialised as
// strings so they survive `page.evaluate`).

import { test, expect } from "@playwright/test";

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
      ) => Promise<{ opened: string[]; errors: { name: string; reason: string }[] }>;
      clearSession: () => Promise<void>;
      getSessionSnapshot: () => SessionSnapshot;
    };
  }
}

async function snapshot(page: import("@playwright/test").Page): Promise<SessionSnapshot> {
  return await page.evaluate(() => window.__drivelineDevHooks!.getSessionSnapshot());
}

test.describe("transport bar (T3.2)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

    const result = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mcap");
      if (!r.ok) throw new Error(`fetch mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);
    expect(result.opened).toEqual(["short.mcap"]);

    const s0 = await snapshot(page);
    expect(s0.globalRange).not.toBeNull();
    expect(s0.playing).toBe(false);
    expect(s0.speed).toBe(1);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("play button toggles the store's playing flag", async ({ page }) => {
    const playBtn = page.getByTestId("play-pause");
    await expect(playBtn).toBeEnabled();

    // Batch both clicks inside a single `page.evaluate` so Playwright
    // round-trip latency can't push the cursor past the ~90 ms fixture
    // span between toggles — the auto-pause at `endNs` would flip the
    // second click's effect (pause→play) and break the assertion.
    const { afterFirst, afterSecond } = await page.evaluate(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        "[data-testid='play-pause']",
      );
      if (!btn) throw new Error("play-pause button not found");
      btn.click();
      const afterFirst =
        window.__drivelineDevHooks!.getSessionSnapshot().playing;
      btn.click();
      const afterSecond =
        window.__drivelineDevHooks!.getSessionSnapshot().playing;
      return { afterFirst, afterSecond };
    });
    expect(afterFirst).toBe(true);
    expect(afterSecond).toBe(false);
  });

  test("scrubber click at 75 % lands cursor within tolerance", async ({ page }) => {
    const scrubber = page.getByTestId("scrubber");
    const box = await scrubber.boundingBox();
    expect(box).not.toBeNull();
    const { width, height } = box!;

    await scrubber.click({ position: { x: Math.round(width * 0.75), y: Math.round(height / 2) } });

    const s = await snapshot(page);
    const start = BigInt(s.globalRange!.startNs);
    const end = BigInt(s.globalRange!.endNs);
    const span = end - start;
    const expected = start + (span * 3n) / 4n;
    const actual = BigInt(s.cursorNs);
    // 2 % of span tolerance to cover pixel rounding and sub-pixel click
    // positions in headless chromium.
    const tol = span / 50n;
    const diff = actual > expected ? actual - expected : expected - actual;
    expect(diff <= tol, `cursor ${actual} not within ${tol} ns of ${expected}`).toBe(true);
  });

  test("scrubber drag commits the final pointer position", async ({ page }) => {
    const scrubber = page.getByTestId("scrubber");
    const box = await scrubber.boundingBox();
    expect(box).not.toBeNull();
    const { x, y, width, height } = box!;
    const cy = y + height / 2;

    await page.mouse.move(x + width * 0.1, cy);
    await page.mouse.down();
    await page.mouse.move(x + width * 0.25, cy, { steps: 4 });
    await page.mouse.move(x + width * 0.5, cy, { steps: 4 });
    await page.mouse.move(x + width * 0.9, cy, { steps: 4 });
    await page.mouse.up();

    // Give the rAF-throttled commit a moment to flush.
    await page.waitForTimeout(50);

    const s = await snapshot(page);
    const start = BigInt(s.globalRange!.startNs);
    const end = BigInt(s.globalRange!.endNs);
    const span = end - start;
    const expected = start + (span * 9n) / 10n;
    const actual = BigInt(s.cursorNs);
    const tol = span / 50n;
    const diff = actual > expected ? actual - expected : expected - actual;
    expect(diff <= tol, `cursor ${actual} not within ${tol} ns of ${expected}`).toBe(true);
  });

  test("Space toggles play/pause when no input is focused", async ({ page }) => {
    await page.locator("body").click(); // ensure focus is off any button

    // Same batching rationale as "play button toggles …": back-to-back
    // `keyboard.press()` calls each round-trip to the driver, and the
    // fixture span is short enough that an auto-pause between them
    // would invert the second toggle's expected effect.
    const { afterFirst, afterSecond } = await page.evaluate(() => {
      function dispatchSpace() {
        const opts = {
          key: " ",
          code: "Space",
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true,
        } as const;
        document.dispatchEvent(new KeyboardEvent("keydown", opts));
        document.dispatchEvent(new KeyboardEvent("keyup", opts));
      }
      dispatchSpace();
      const afterFirst =
        window.__drivelineDevHooks!.getSessionSnapshot().playing;
      dispatchSpace();
      const afterSecond =
        window.__drivelineDevHooks!.getSessionSnapshot().playing;
      return { afterFirst, afterSecond };
    });
    expect(afterFirst).toBe(true);
    expect(afterSecond).toBe(false);
  });

  test("Home jumps the cursor to globalRange.startNs", async ({ page }) => {
    // First move cursor off start by clicking mid-track.
    const scrubber = page.getByTestId("scrubber");
    const box = (await scrubber.boundingBox())!;
    await scrubber.click({
      position: { x: Math.round(box.width / 2), y: Math.round(box.height / 2) },
    });
    expect((await snapshot(page)).cursorNs).not.toBe(
      (await snapshot(page)).globalRange!.startNs,
    );

    await page.locator("body").click();
    await page.keyboard.press("Home");

    const s = await snapshot(page);
    expect(s.cursorNs).toBe(s.globalRange!.startNs);
  });

  test("End jumps the cursor to globalRange.endNs and auto-pauses", async ({
    page,
  }) => {
    // Put us in the playing state so the End-auto-pause invariant is
    // visible.
    await page.getByTestId("play-pause").click();
    expect((await snapshot(page)).playing).toBe(true);

    await page.locator("body").click();
    await page.keyboard.press("End");

    const s = await snapshot(page);
    expect(s.cursorNs).toBe(s.globalRange!.endNs);
    expect(s.playing).toBe(false);
  });

  test("speed dropdown writes through to the store", async ({ page }) => {
    const speed = page.getByTestId("transport-speed");
    await speed.selectOption("2");
    expect((await snapshot(page)).speed).toBe(2);

    await speed.selectOption("0.25");
    expect((await snapshot(page)).speed).toBe(0.25);
  });
});
