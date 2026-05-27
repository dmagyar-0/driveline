// Visual screenshot spec for the VideoPanel iter-5 polish cluster.
// Underscore prefix keeps it out of `pnpm e2e`'s default run; invoke
// explicitly with:
//
//   pnpm --filter e2e test _videoIter5Screenshots
//
// Captures (per the iter5 brief):
//   1. video-iter5-toolbar-hud.png — panel with the unified toolbar
//      (compact info chip + HUD/Change utility buttons + segmented
//      FIT/FILL) and the HUD overlay open so the "frame N / total"
//      line is visible.
//   2. video-iter5-cropped.png — FILL mode with the "Cropped" badge
//      surfaced in the toolbar so the user has an unmistakable cue
//      that pixels are being clipped at the panel edges.
//
// Uses the bundled comma2k19_seg10.mp4 + sidecar from `sample-data/`
// (served via the dev-server route) so the codec/resolution shown in
// the chip is the real 4K source the audit referenced.

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

/**
 * Fetch a sample-data file from the dev server and hand it to
 * `__drivelineDevHooks.openFiles` so the test exercises the same
 * ingestion path users see. Mirrors the helper in
 * `_demo-comma2k19-video.spec.ts` but inlined here so this spec
 * stays self-contained.
 */
async function loadComma2k19Seg10(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(async () => {
    const names = [
      "realworld/comma2k19_seg10.mp4",
      "realworld/comma2k19_seg10.mp4.timestamps",
    ];
    const descs: { name: string; bytes: ArrayBuffer }[] = [];
    for (const name of names) {
      const resp = await fetch(`/sample-data/${name}`);
      if (!resp.ok) throw new Error(`fetch /sample-data/${name}: ${resp.status}`);
      const bytes = await resp.arrayBuffer();
      descs.push({ name: name.split("/").pop()!, bytes });
    }
    await window.__drivelineDevHooks!.openFiles(descs);
  });
}

test.describe("video iter5 polish", () => {
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

  test("toolbar with unified buttons + HUD with frame counter", async ({
    page,
  }) => {
    await loadComma2k19Seg10(page);

    // Bind the mp4+sidecar video channel so the info chip + frame
    // counter have data.
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
      if (!videoCh) throw new Error("no video channel after load");
      hooks.setVideoChannelBinding("video-1", videoCh.id);
    });

    // Wait for the first frame to land so the info chip populates
    // (codec + resolution come from the decoded VideoFrame).
    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Step the cursor forward so the "frame N / total" line in the
    // HUD shows a non-trivial frame number (otherwise frame == 1).
    await page.getByTestId("video-frame-forward").first().click();
    await page.getByTestId("video-frame-forward").first().click();
    await page.getByTestId("video-frame-forward").first().click();
    await page.waitForTimeout(150);

    // Open the HUD via the toolbar toggle. iter5 #2 — the HUD button
    // now shares the .utilBtn family with Change.
    await page.getByTestId("video-hud-toggle").first().click();
    await page.waitForTimeout(300);

    // Sanity asserts before screenshot.
    const info = page.getByTestId("video-info-chip").first();
    // iter5 #1 — info chip never paints the raw "avc1." token; only
    // the family name. Tooltip carries the full breakdown.
    const infoText = await info.textContent();
    expect(infoText ?? "").not.toContain("avc1.");
    // Resolution should appear inside the chip once the first frame
    // has landed.
    expect(infoText ?? "").toMatch(/\d+×\d+/);
    // HUD overlay contains the frame counter line.
    const hud = page.getByTestId("video-hud").first();
    await expect(hud).toBeVisible();
    const hudText = await hud.textContent();
    // "frame N / total" — the sidecar PTS table size is the total.
    expect(hudText ?? "").toMatch(/frame\s+\d+\s+\/\s+\d+/);

    await clipTo(
      page,
      "video-panel-video-1",
      "video-iter5-toolbar-hud.png",
    );
  });

  test("FILL mode surfaces the 'Cropped' badge", async ({ page }) => {
    await loadComma2k19Seg10(page);

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
      if (!videoCh) throw new Error("no video channel after load");
      hooks.setVideoChannelBinding("video-1", videoCh.id);
    });

    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Switch to FILL — iter5 #4 — the Cropped chip should appear
    // immediately in the toolbar.
    await page.getByTestId("video-fit-segment-fill").first().click();
    await page.waitForTimeout(250);

    // Sanity assertion: Cropped badge is present + carries the
    // "switch to FIT" tooltip from the iter5 brief.
    const cropped = page.getByTestId("video-cropped-badge").first();
    await expect(cropped).toBeVisible();
    const title = await cropped.getAttribute("title");
    expect(title ?? "").toMatch(/FIT/);
    expect(title ?? "").toMatch(/clipped|crop/i);

    await clipTo(page, "video-panel-video-1", "video-iter5-cropped.png");
  });
});
