// Visual screenshot spec for the App-shell UI/UX overhaul (Agent E).
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly when you want to refresh the screenshots:
//
//   pnpm --filter e2e test _shellRedesignScreenshots
//
// Captures (writes to apps/e2e/tests/screenshots/shell-*.png):
//   1. shell-rail-active.png   — Rail expanded on focus with the
//                                 Channels tab active so the accent
//                                 bar + filled background is visible.
//   2. shell-sources-popover.png — Topbar's sources chip opened to
//                                 reveal the SourcesPopover with two
//                                 loaded sources.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function loadSampleSession(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const fetchBytes = async (p: string) => {
      const r = await fetch(p);
      if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const mcap = await fetchBytes("/sample-data/short.mcap");
    const mf4 = await fetchBytes("/sample-data/short.mf4");
    await window.__drivelineDevHooks!.openFiles([
      { name: "short.mcap", bytes: mcap },
      { name: "short.mf4", bytes: mf4 },
    ]);
  });
  await page.waitForFunction(
    () =>
      (
        window.__drivelineDevHooks!.getSessionSnapshot() as {
          globalRange: unknown;
        }
      ).globalRange !== null,
  );
}

test.describe("shell redesign", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
      window.__drivelineDevHooks!.setActiveRailTab(null);
    });
  });

  test("captures rail + topbar + sources popover", async ({ page }) => {
    await loadSampleSession(page);

    // 1. Rail expanded with Channels tab active. Hover the rail so the
    //    labels are visible in the screenshot.
    await page.evaluate(() => {
      window.__drivelineDevHooks!.setActiveRailTab("channels");
    });
    const rail = page.getByTestId("rail");
    await rail.hover();
    await page.waitForTimeout(300);
    {
      const bbox = await rail.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "shell-rail-active.png"),
        fullPage: false,
        clip: {
          x: Math.max(0, bbox.x),
          y: 0,
          width: bbox.width + 8,
          height: Math.min(540, bbox.y + bbox.height + 8),
        },
      });
    }

    // 2. Topbar + open sources popover. Close the channels drawer first
    //    so the popover isn't covered by anything.
    await page.evaluate(() => {
      window.__drivelineDevHooks!.setActiveRailTab(null);
    });
    await page.getByTestId("sources-chip").click();
    await expect(page.getByTestId("sources-popover")).toBeVisible();
    await page.waitForTimeout(200);

    // Capture the topbar region wide enough to include the popover.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-sources-popover.png"),
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: 1440,
        height: 420,
      },
    });
  });
});
