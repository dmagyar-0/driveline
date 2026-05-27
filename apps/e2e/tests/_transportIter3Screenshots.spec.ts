// Iteration 3 screenshot spec for the Transport bar polish cluster.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly:
//
//   pnpm --filter e2e test _transportIter3Screenshots
//
// Captures two screenshots covering the iter2 → iter3 designer audit:
//
//   1. transport-iter3-cursor-badge.png
//      Single source, cursor mid-track so the iter3 playhead badge
//      shows a single canonical format paired with the total readout
//      ("current / total"). Demonstrates issues #1 + #3.
//
//   2. transport-iter3-hover-distinct.png
//      Cursor at 20 %, hover at 65 %. Renders both the iter3 cursor
//      badge (orange-bordered, bold) AND the iter3 hover chip
//      (neutral border, dual-line with the alternate convention) in
//      the same frame so the visual distinction is obvious.
//      Demonstrates issue #2.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function screenshotTransport(
  page: import("@playwright/test").Page,
  fileName: string,
  padTop = 100,
): Promise<void> {
  const bbox = await page.getByTestId("transport").boundingBox();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, fileName),
    fullPage: false,
    clip: bbox
      ? {
          x: Math.max(0, bbox.x - 6),
          // Pull the clip up so the playhead badge (which sits above
          // the track) is included in the frame.
          y: Math.max(0, bbox.y - padTop),
          width: bbox.width + 12,
          height: bbox.height + padTop + 12,
        }
      : undefined,
  });
}

test.describe("transport iter3 polish", () => {
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

  test("captures the iter3 transport bar across two key states", async ({
    page,
  }) => {
    // 1. Cursor badge with the single canonical format + total beside
    //    it. Load the short.mcap fixture; place the cursor at ~ 40 %
    //    so the badge is well inside the frame and shows non-trivial
    //    digits.
    await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mcap");
      if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
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
    await page.evaluate(() => {
      const r = window.__drivelineDevHooks!.getGlobalRange();
      if (!r) return;
      const start = BigInt(r.startNs);
      const end = BigInt(r.endNs);
      const mid = start + ((end - start) * 4n) / 10n;
      window.__drivelineDevHooks!.setCursorNs(mid);
    });
    await page.waitForTimeout(50);
    await screenshotTransport(page, "transport-iter3-cursor-badge.png");

    // 2. Hover chip rendered alongside the cursor badge. The cursor
    //    sits at 20 %; the pointer hovers at 65 %. Both bubbles appear
    //    simultaneously so the contrast (orange-bordered "where I am"
    //    vs neutral "where my mouse is") is visible in one frame.
    await page.evaluate(() => {
      const r = window.__drivelineDevHooks!.getGlobalRange();
      if (!r) return;
      const start = BigInt(r.startNs);
      const end = BigInt(r.endNs);
      const at = start + ((end - start) * 2n) / 10n;
      window.__drivelineDevHooks!.setCursorNs(at);
    });
    const track = page.getByTestId("scrubber");
    const box = await track.boundingBox();
    if (!box) throw new Error("scrubber bbox missing");
    await track.hover({
      position: {
        x: Math.round(box.width * 0.65),
        y: Math.round(box.height / 2),
      },
    });
    await page.waitForTimeout(80);
    await screenshotTransport(page, "transport-iter3-hover-distinct.png");
  });
});
