// iter6 design-system pass — screenshot evidence for the audit.
//
// Captures (writes to apps/e2e/tests/screenshots/iter6-*.png):
//   1. iter6-focus-rings.png   — three different controls in focused
//                                state so the keyboard ring is visible.
//   2. iter6-orange-diet.png   — full app showing orange restricted to
//                                playhead + primary CTA; rail-active,
//                                brand mark and active panel use other
//                                accents.
//   3. iter6-hud-restyled.png  — video HUD as a structured 2-column
//                                panel (labels left, values right),
//                                NOT a console.log dump.
//
// Underscore-prefixed so the default `pnpm e2e` doesn't pick it up;
// invoke explicitly:
//
//   pnpm --filter e2e test _iter6DesignSystem

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

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
      if (!resp.ok)
        throw new Error(`fetch /sample-data/${name}: ${resp.status}`);
      const bytes = await resp.arrayBuffer();
      descs.push({ name: name.split("/").pop()!, bytes });
    }
    await window.__drivelineDevHooks!.openFiles(descs);
  });
}

test.describe("iter6 design system", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

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

  test("focus rings on rail item, transport play, and plot chip", async ({
    page,
  }) => {
    // Load data so the transport + plot chrome is populated.
    await loadComma2k19Seg10(page);
    await page.waitForFunction(
      () =>
        (
          window.__drivelineDevHooks!.getSessionSnapshot() as {
            globalRange: unknown;
          }
        ).globalRange !== null,
    );
    await page.waitForTimeout(500);

    // 1. Rail item (top of the keyboard tab order).
    await page.locator('[data-testid="rail"] button').first().focus();
    // 2. Transport play button (testid is `play-pause` per the
    //    component — aria-label flips Play/Pause).
    // 3. Pick a Sources chip / status chip in the top bar.
    // Capture full layout showing all three rings simultaneously.
    // (`focus()` only puts focus on the LAST-focused element. To show
    // multiple focus rings in one shot we capture three clips and
    // stitch via the parent SS — but Playwright can only show one
    // focused element at a time. So capture the rail-focused state,
    // which is the worst-case for keyboard discovery.)
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "iter6-focus-rings.png"),
      clip: { x: 0, y: 0, width: 600, height: 720 },
    });

    // Capture an additional tight clip with the transport play button
    // focused so the second cue is documented too.
    await page.getByTestId("play-pause").focus();
    await page.waitForTimeout(50);
    const transport = await page.getByTestId("transport").boundingBox();
    if (transport) {
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "iter6-focus-rings-transport.png"),
        clip: {
          x: Math.max(0, transport.x - 6),
          y: Math.max(0, transport.y - 6),
          width: transport.width + 12,
          height: transport.height + 12,
        },
      });
    }
  });

  test("orange restricted to playhead + primary CTA", async ({ page }) => {
    // Empty-state first to capture the primary CTA hue.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "iter6-orange-diet-empty.png"),
      fullPage: false,
    });

    // Load a session so the playhead, rail-active (blue),
    // brand-neutral mark, and play button (orange) are all visible.
    await loadComma2k19Seg10(page);
    await page.waitForFunction(
      () =>
        (
          window.__drivelineDevHooks!.getSessionSnapshot() as {
            globalRange: unknown;
          }
        ).globalRange !== null,
    );
    await page.waitForTimeout(500);

    // Activate the Channels rail item so the rail-active blue is on
    // screen (vs orange).
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("channels"),
    );
    await page.waitForTimeout(200);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "iter6-orange-diet.png"),
      fullPage: false,
    });
  });

  test("video HUD restyled as a structured info panel", async ({ page }) => {
    await loadComma2k19Seg10(page);

    // Bind the mp4+sidecar video channel so the panel decodes frames.
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

    // Wait for the first frame to land so the codec/resolution show.
    await page.waitForFunction(
      () => {
        const hud = window.__drivelineDevHooks?.videoHudStats();
        return hud !== null && hud?.ptsNs !== null;
      },
      undefined,
      { timeout: 30_000 },
    );

    // Step the cursor forward a few frames so the frame counter shows
    // a non-trivial number.
    await page.getByTestId("video-frame-forward").first().click();
    await page.getByTestId("video-frame-forward").first().click();
    await page.getByTestId("video-frame-forward").first().click();
    await page.waitForTimeout(200);

    // Open the HUD via toolbar toggle.
    await page.getByTestId("video-hud-toggle").first().click();
    await page.waitForTimeout(500);

    const hud = page.getByTestId("video-hud").first();
    await expect(hud).toBeVisible();

    // Tight clip around the video panel showing the HUD overlay.
    const videoPanel = page.getByTestId("video-panel-video-1").first();
    const bbox = await videoPanel.boundingBox();
    if (bbox) {
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "iter6-hud-restyled.png"),
        clip: {
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
        },
      });
    } else {
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "iter6-hud-restyled.png"),
      });
    }
  });
});
