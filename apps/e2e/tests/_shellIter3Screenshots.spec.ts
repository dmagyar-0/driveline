// Visual screenshot spec for the App-shell UI/UX iter3 follow-up
// (shell cluster). Underscore prefix keeps it out of the default
// `pnpm e2e` invocation; run explicitly when refreshing screenshots:
//
//   pnpm --filter e2e test _shellIter3Screenshots
//
// Captures (writes to apps/e2e/tests/screenshots/shell-iter3-*.png):
//   1. shell-iter3-sources-popover-search.png
//      — Sources popover with 4 seeded sources of mixed kinds, group
//        headings visible, search filter active.
//   2. shell-iter3-topbar.png
//      — Top bar with the iter3 cluster: brand zone, unified pill
//        chips, divider, help cluster. Cursor readout absent.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test.describe("shell iter3 screenshots", () => {
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

  test("captures iter3 topbar + sources popover with search active", async ({
    page,
  }) => {
    // Load 4 sources of mixed kinds so the popover exercises group
    // headings + filter. We re-fetch the same fixture under different
    // names so the per-source rows are realistic (different durations
    // would require distinct fixtures we don't have).
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/short.mcap");
      const mf4 = await fetchBytes("/sample-data/short.mf4");
      const mp4 = await fetchBytes("/sample-data/short.mp4");
      const ts = await fetchBytes("/sample-data/short.mp4.timestamps");
      // Different filenames so the rows are distinguishable. The
      // popover's filter is name-based, so the variety lets us
      // demonstrate the filter live.
      await window.__drivelineDevHooks!.openFiles([
        { name: "alpha-session.mcap", bytes: mcap },
        { name: "beta-prod.mcap", bytes: mcap },
        { name: "gamma-can.mf4", bytes: mf4 },
        { name: "front-cam.mp4", bytes: mp4 },
        { name: "front-cam.mp4.timestamps", bytes: ts },
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

    const topbar = page.getByTestId("topbar");
    await expect(topbar).toBeVisible();
    await expect(topbar).not.toContainText("v0.1");
    // iter3 #2 — the topbar cursor readout was dropped; verify nothing
    // matches the old data-testid in the topbar.
    expect(await topbar.locator("[data-testid='cursor-readout']").count()).toBe(
      0,
    );

    // 1. Top bar capture. Wait long enough for the auto-hide of the
    // "Ready" chip so the screenshot captures the steady-state cluster
    // (sources chip + help cluster only).
    await page.waitForTimeout(5500);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-iter3-topbar.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 60 },
    });

    // 2. Open sources popover (unfiltered) — confirms group headings
    //    render with mixed-kind sources, plus search + sort controls.
    await page.getByTestId("sources-chip").click();
    await expect(page.getByTestId("sources-popover")).toBeVisible();
    // Verify the group headings appear for the mixed-kind set.
    await expect(
      page.getByTestId("sources-popover-group-mcap"),
    ).toBeVisible();
    await expect(
      page.getByTestId("sources-popover-group-mp4+sidecar"),
    ).toBeVisible();

    // Now type a filter to demonstrate live search.
    await page.getByTestId("sources-popover-search").fill("cam");
    await page.waitForTimeout(150);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-iter3-sources-popover-search.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 540 },
    });
  });
});
