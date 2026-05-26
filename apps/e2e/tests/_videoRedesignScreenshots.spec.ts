// Visual screenshot spec for the VideoPanel + onboarding UI/UX
// redesign (Agent C). Underscore prefix keeps it out of `pnpm e2e`'s
// default run; invoke explicitly with:
//
//   pnpm --filter e2e test _videoRedesignScreenshots
//
// Captures:
//   1. Empty state — rich "Try sample data" CTA, no fixtures loaded.
//   2. Loaded state — bound video panel showing frame border, HUD
//      pill (toggled on so the chrome is visible in the screenshot),
//      and the cursor-time burn-in.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function clip(
  page: import("@playwright/test").Page,
  testId: string,
  file: string,
): Promise<void> {
  const bbox = await page.getByTestId(testId).first().boundingBox();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, file),
    fullPage: false,
    clip: bbox
      ? {
          x: Math.max(0, bbox.x - 6),
          y: Math.max(0, bbox.y - 6),
          width: bbox.width + 12,
          height: bbox.height + 12,
        }
      : undefined,
  });
}

test.describe("video redesign", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("captures empty state and bound-panel chrome", async ({ page }) => {
    // 1. Empty state — no sources loaded, rich CTA visible.
    const emptyTestId = "video-panel-video-1-empty";
    await expect(page.getByTestId(emptyTestId).first()).toBeVisible();
    await clip(page, emptyTestId, "video-redesign-empty.png");

    // 2. Load the bundled sample data via the "Try sample data" path,
    //    then bind the panel to the mp4 video channel.
    await page.getByTestId("video-panel-try-sample").first().click();
    // Wait for ingestion to complete (button re-enables) and for at
    // least one video channel to be available in the session.
    await page.waitForFunction(
      () => {
        const hooks = window.__drivelineDevHooks;
        if (!hooks) return false;
        return hooks
          .listChannels()
          .some((c) => c.kind === "video");
      },
      undefined,
      { timeout: 60_000 },
    );

    // Bind the first video channel programmatically — picker UI lives
    // under the same `video-panel-*-empty` data-testid, but going
    // through the dev hook keeps the screenshot deterministic.
    await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks!;
      const videoCh = hooks.listChannels().find((c) => c.kind === "video");
      if (!videoCh) throw new Error("no video channel in sample data");
      hooks.setVideoChannelBinding("video-1", videoCh.id);
      // Turn the HUD on so the screenshot shows the redesigned pill.
      hooks.setSelectedPanelId("video-1");
    });
    // Flip the HUD on via the toggle for a deterministic capture.
    await page.getByTestId("video-hud-toggle").first().click();
    // Wait for first frame to land (loading overlay clears).
    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );
    // Step a few frames forward so the timestamp burn-in is clearly
    // non-zero in the capture (otherwise we'd ship a screenshot
    // showing "00:00.000" and lose the point of issue #20).
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(400);
    await clip(page, "video-panel-video-1", "video-redesign-loaded.png");

    // Capture a "clean" frame too — HUD off, so only the timestamp
    // burn-in and frame border are visible. This is the view a user
    // sees during normal playback; the absence of any "drop / lag /
    // q" junk text near the bottom is the #21 acceptance criterion.
    await page.getByTestId("video-hud-toggle").first().click();
    await page.waitForTimeout(300);
    await clip(page, "video-panel-video-1", "video-redesign-loaded-clean.png");
  });
});
