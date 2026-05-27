// Visual screenshot spec for the VideoPanel iter-4 toolbar polish.
// Underscore prefix keeps it out of `pnpm e2e`'s default run; invoke
// explicitly with:
//
//   pnpm --filter e2e test _videoIter4Screenshots
//
// Captures (per the iter4 brief):
//   1. video-iter4-paused.png — paused state with the neutral health
//      badge (NOT red, NOT "0.0 fps") and the new 2-state segmented
//      FIT/FILL control both labels visible.
//   2. video-iter4-resized.png — same panel after a resize / fill
//      toggle, showing the video occupying more of the panel area now
//      that the absolutely-positioned HUD + Change-channel buttons
//      have moved into the toolbar (issue #4).

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

test.describe("video iter4 toolbar polish", () => {
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

  test("captures paused-neutral-health + segmented FIT-FILL", async ({
    page,
  }) => {
    // Load the bundled sample data (mp4 + sidecar).
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

    // Bind the mp4+sidecar video channel so the frame-step buttons and
    // resolution chip have data to display.
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

    // Wait for first frame so the resolution + badge populate.
    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Brief play burst, then pause — this matches the audit's exact
    // scenario: the dot should be GREEN while playing, then flip to
    // neutral GREY (not red) the instant we pause. The screenshot
    // captures the paused state.
    await page.getByTestId("video-play-pause").first().click();
    await page.waitForTimeout(800);
    await page.getByTestId("video-play-pause").first().click();
    // Settle the FPS rAF loop so the badge re-derives its tone with
    // `playing = false`.
    await page.waitForTimeout(600);

    // Sanity assertion before screenshot — the iter4 acceptance bar
    // for this screenshot is "data-tone is 'paused', not 'bad'".
    const badge = page.getByTestId("video-health-badge").first();
    await expect(badge).toHaveAttribute("data-tone", "paused");

    await clipTo(page, "video-panel-video-1", "video-iter4-paused.png");

    // Second screenshot: switch to Fill so the canvas occupies the
    // full panel area, demonstrating issue #4's reclaimed letterbox.
    await page.getByTestId("video-fit-segment-fill").first().click();
    await page.waitForTimeout(400);

    await clipTo(page, "video-panel-video-1", "video-iter4-resized.png");
  });
});
