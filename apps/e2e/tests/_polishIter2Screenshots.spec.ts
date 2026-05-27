// Visual screenshot spec for the iter2 polish pass (tonal hierarchy,
// foreground contrast lifts, accent split). Underscore prefix keeps it
// out of the default `pnpm e2e` invocation; run explicitly:
//
//   pnpm --filter e2e test _polishIter2Screenshots
//
// Captures (writes to apps/e2e/tests/screenshots/polish-iter2-*.png):
//   1. polish-iter2-app.png         — full-app shot showing chrome
//                                     (TopBar / Rail / Transport / PanelHeader)
//                                     sitting one step LIGHTER than the
//                                     panel bodies — the new tonal
//                                     hierarchy at a glance.
//   2. polish-iter2-transport-text.png — close-up of the Transport bar so
//                                     small labels (TIME / SPEED / start
//                                     date) can be eyeballed for the
//                                     fg-3/-4/-5 contrast lift.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test.describe("polish iter2 — tonal hierarchy + a11y lifts", () => {
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

  test("captures tonal hierarchy + small-text contrast", async ({ page }) => {
    // Load the comma2k19 demo so the chrome shows real source labels +
    // a populated transport bar (date readout, total, speed selector).
    await page.evaluate(async () => {
      const fetchBytes = async (p: string): Promise<Uint8Array> => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/realworld/comma2k19.mcap");
      await window.__drivelineDevHooks!.openFiles([
        { name: "comma2k19.mcap", bytes: mcap },
      ]);
    });

    // Let the workspace settle.
    await page.waitForTimeout(500);

    // Screenshot 1 — full app. Chrome (top bar, rail, transport, panel
    // headers) should be visibly lighter than the panel bodies after the
    // bg-2 ↔ bg-3 swap in tokens.css.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "polish-iter2-app.png"),
      fullPage: false,
    });

    // Screenshot 2 — Transport close-up. The TIME / SPEED / start-date /
    // playhead-sub labels were the worst offenders for fg-5 contrast in
    // the audit; the lifted fg-5 (#969ba4) should clear them.
    const transport = page.locator('[class*="Transport_bar"]').first();
    if ((await transport.count()) > 0) {
      await transport.screenshot({
        path: path.join(SCREENSHOT_DIR, "polish-iter2-transport-text.png"),
      });
    } else {
      // Fallback — bottom 120 px slice of the viewport.
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "polish-iter2-transport-text.png"),
        clip: { x: 0, y: 780, width: 1440, height: 120 },
      });
    }
  });
});
