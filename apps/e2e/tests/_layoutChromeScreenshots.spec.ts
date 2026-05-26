// Visual screenshot spec for the FlexLayout panel chrome UX overhaul.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly to refresh:
//
//   pnpm --filter e2e test _layoutChromeScreenshots
//
// Captures (writes to apps/e2e/tests/screenshots/layout-chrome-*.png):
//   1. layout-chrome-headers.png  — multi-panel workspace with per-kind
//                                    icons and accent bands visible.
//   2. layout-chrome-focused.png  — focused-panel ring on the plot tab.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test.describe("layout chrome", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("captures the panel chrome across kinds + focused state", async ({
    page,
  }) => {
    // Load the short.mcap fixture so panels have content to identify.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string): Promise<Uint8Array> => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/short.mcap");
      await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes: mcap },
      ]);
    });

    // Add a couple more panels so the chrome variety is visible.
    await page.evaluate(() => {
      window.__drivelineDevHooks!.addMapPanel?.();
      window.__drivelineDevHooks!.addTablePanel?.();
    });

    // Give FlexLayout a beat to lay out the new tabs.
    await page.waitForTimeout(300);

    // Screenshot 1 — workspace overview with every kind's chrome visible.
    const workspace = page.getByTestId("workspace");
    await expect(workspace).toBeVisible();
    await workspace.screenshot({
      path: path.join(SCREENSHOT_DIR, "layout-chrome-headers.png"),
    });

    // Click the plot panel's tab name so the focused-panel ring shows.
    // `panel-body-*` uses `display: contents` so it has no layout box;
    // dispatch a pointerdown on the inner plot body instead, then click
    // the tab name to put focus on the chrome.
    await page.evaluate(() => {
      const body = document.querySelector(
        '[data-testid^="panel-body-plot-"]',
      );
      if (!body) return;
      // The wrapper has `display: contents`; its first real child is the
      // actual panel root. Fire pointerdown there so the store-level
      // `selectedPanelId` gets set the same way a real click would.
      const child = body.firstElementChild as HTMLElement | null;
      child?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await page.waitForTimeout(200);

    // Screenshot 2 — focused tab state.
    await workspace.screenshot({
      path: path.join(SCREENSHOT_DIR, "layout-chrome-focused.png"),
    });
  });
});
