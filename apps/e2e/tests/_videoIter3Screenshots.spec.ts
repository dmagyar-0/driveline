// Visual screenshot spec for the VideoPanel iter-3 toolbar polish.
// Underscore prefix keeps it out of `pnpm e2e`'s default run; invoke
// explicitly with:
//
//   pnpm --filter e2e test _videoIter3Screenshots
//
// Captures:
//   1. video-iter3-toolbar.png — full toolbar visible: transport
//      controls, decode-health badge with codec + fps, resolution
//      chip, fit/fill toggle, plus the dashcam frame.
//   2. video-iter3-fill-mode.png — the same panel after toggling
//      Fit -> Fill, so the letterbox bars are gone and the canvas
//      crops to fill the frame. Useful for the design audit's
//      "letterbox aesthetic" question.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function clipTo(
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

test.describe("video iter3 toolbar", () => {
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

  test("captures full toolbar + fit/fill comparison", async ({ page }) => {
    // Load the bundled sample data (mp4 + sidecar). The empty-state
    // CTA is the same path used by the prior video screenshot spec, so
    // it's a known-good fixture loader.
    await page.getByTestId("video-panel-try-sample").first().click();
    await page.waitForFunction(
      () => {
        const hooks = window.__drivelineDevHooks;
        if (!hooks) return false;
        return hooks.listChannels().some((c) => c.kind === "video");
      },
      undefined,
      { timeout: 60_000 },
    );

    // Bind the mp4+sidecar video channel specifically (frame stepping
    // only makes sense with a sidecar PTS table, and we want the
    // screenshot to show every toolbar button enabled).
    await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks!;
      const mp4Source = hooks
        .listSources()
        .find((s) => s.kind === "mp4+sidecar");
      const chs = hooks.listChannels();
      const videoCh =
        (mp4Source &&
          chs.find(
            (c) => c.kind === "video" && c.sourceId === mp4Source.id,
          )) ??
        chs.find((c) => c.kind === "video");
      if (!videoCh) throw new Error("no video channel in sample data");
      hooks.setVideoChannelBinding("video-1", videoCh.id);
    });

    // Wait for first frame to land so the resolution chip + health
    // badge can populate before the screenshot.
    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Step a few frames forward via the new frame-forward button so
    // the cursor moves off zero and the toolbar's badge has fresh
    // telemetry to display.
    for (let i = 0; i < 5; i++) {
      await page.getByTestId("video-frame-forward").first().click();
      await page.waitForTimeout(40);
    }
    // Let the rAF loop sample a stable FPS window before capturing.
    await page.waitForTimeout(1200);

    await clipTo(page, "video-panel-video-1", "video-iter3-toolbar.png");

    // Fit -> Fill comparison. Click the toggle, give it a beat to
    // re-layout, then screenshot the same region.
    await page.getByTestId("video-fit-toggle").first().click();
    await page.waitForTimeout(300);

    await clipTo(page, "video-panel-video-1", "video-iter3-fill-mode.png");
  });
});
