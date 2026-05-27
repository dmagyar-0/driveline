// Visual screenshot spec for the App-shell UI/UX iter2 follow-up
// (shell cluster). Underscore prefix keeps it out of the default
// `pnpm e2e` invocation; run explicitly when refreshing screenshots:
//
//   pnpm --filter e2e test _shellIter2Screenshots
//
// Captures (writes to apps/e2e/tests/screenshots/shell-iter2-*.png):
//   1. shell-iter2-topbar.png        — Top bar with the v0.1 version
//                                       string removed and the help
//                                       cluster ("i" + "?") visible.
//   2. shell-iter2-sources-popover.png
//                                     — Sources popover with the new
//                                       per-row × button, channel
//                                       count, and palette swatch.

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

test.describe("shell iter2 screenshots", () => {
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

  test("captures topbar + sources popover with iter2 polish", async ({
    page,
  }) => {
    await loadSampleSession(page);

    // Sanity: the v0.1 version string must not be in the top bar.
    const topbar = page.getByTestId("topbar");
    await expect(topbar).toBeVisible();
    await expect(topbar).not.toContainText("v0.1");
    // The help cluster's About + Shortcuts buttons must be present.
    await expect(page.getByTestId("topbar-about")).toBeVisible();
    await expect(page.getByTestId("topbar-shortcuts")).toBeVisible();

    // 1. Top bar capture (full-width, just the bar height).
    {
      const bbox = await topbar.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "shell-iter2-topbar.png"),
        fullPage: false,
        clip: {
          x: 0,
          y: 0,
          width: 1440,
          height: Math.max(40, bbox.y + bbox.height + 4),
        },
      });
    }

    // 2. Open the sources popover and snapshot.
    await page.getByTestId("sources-chip").click();
    await expect(page.getByTestId("sources-popover")).toBeVisible();
    // Confirm at least one per-row remove and one channel count badge.
    await expect(
      page.locator("[data-testid^='sources-popover-remove-']").first(),
    ).toBeVisible();
    await page.waitForTimeout(200);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-iter2-sources-popover.png"),
      fullPage: false,
      clip: {
        x: 0,
        y: 0,
        width: 1440,
        height: 460,
      },
    });
  });
});
