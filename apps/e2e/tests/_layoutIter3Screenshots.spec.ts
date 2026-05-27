// Iter3 visual screenshot spec for the FlexLayout panel chrome polish
// cluster. Underscore prefix keeps it out of the default `pnpm e2e`
// invocation; run explicitly to refresh:
//
//   pnpm --filter e2e test _layoutIter3Screenshots
//
// Captures (writes to apps/e2e/tests/screenshots/layout-iter3-*.png):
//   1. layout-iter3-header-icons.png — single tabset close-up showing
//      the four PanelHeader buttons (rename / gear / maximize / close)
//      with their distinct glyphs and the lack of any duplicate ×.
//   2. layout-iter3-active-vs-inactive.png — workspace overview with
//      a tabset that has multiple tabs so the active-tab accent
//      underline + full opacity vs inactive-tab 0.6 opacity + no
//      underline is visible side-by-side.
//
// These shots back up the iter3 chrome review:
//   - distinct, labelled icons (no mystery sun)
//   - exactly one × in the header (tabset close + maximize buttons
//     are suppressed via Workspace.module.css)
//   - the active tab is the brightest member of its tabset.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test.describe("layout chrome iter3", () => {
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

  test("captures distinct header icons + active/inactive tab states", async ({
    page,
  }) => {
    // Inject a layout with a long custom tab name so the truncation
    // case is exercised, plus a multi-tab tabset so the active vs
    // inactive comparison is visible in a single shot.
    await page.evaluate(() => {
      window.__drivelineDevHooks!.setLayoutJson({
        global: {
          tabEnableClose: false,
          tabEnableRename: false,
          splitterSize: 4,
          borderEnableAutoHide: true,
        },
        borders: [],
        layout: {
          type: "row",
          weight: 100,
          children: [
            {
              type: "tabset",
              weight: 50,
              children: [
                {
                  type: "tab",
                  id: "video-1",
                  name: "Speeds (MCAP + MF4)",
                  component: "video",
                },
                {
                  type: "tab",
                  id: "map-1",
                  name: "Map",
                  component: "map",
                },
                {
                  type: "tab",
                  id: "table-1",
                  name: "Table",
                  component: "table",
                },
              ],
            },
            {
              type: "tabset",
              weight: 50,
              children: [
                {
                  type: "tab",
                  id: "plot-1",
                  name: "Steering + Gyro (MCAP + MF4)",
                  component: "plot",
                },
              ],
            },
          ],
        },
      });
    });
    await page.waitForTimeout(300);

    // Click the plot panel body so its tabset becomes the active one
    // (the focused-panel ring + the kind-accent underline at full
    // opacity light up on this tab).
    await page.evaluate(() => {
      const body = document.querySelector(
        '[data-testid^="panel-body-plot-"]',
      );
      const child = body?.firstElementChild as HTMLElement | null;
      child?.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });
    await page.waitForTimeout(200);

    // Screenshot 1 — header close-up. Crop to the workspace's top
    // strip so the four distinct icons (rename, gear, maximize,
    // close) and the truncated long title are the only thing visible.
    const workspace = page.getByTestId("workspace");
    await expect(workspace).toBeVisible();
    const box = await workspace.boundingBox();
    if (!box) throw new Error("workspace has no bounding box");
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "layout-iter3-header-icons.png"),
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: 48,
      },
    });

    // Screenshot 2 — full workspace so the active-vs-inactive tab
    // contrast is visible in one frame: the left tabset has three
    // tabs (Video is selected), the right tabset has the single
    // Plot tab which is the globally focused panel.
    await workspace.screenshot({
      path: path.join(SCREENSHOT_DIR, "layout-iter3-active-vs-inactive.png"),
    });
  });
});
