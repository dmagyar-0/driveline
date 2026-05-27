// Iteration 3 — capture the multi-segment view so the segment label
// tooltips (issue #5) and the removed "N segments" centre text (issue
// #6) are visible. Underscored to keep out of default `pnpm e2e`.
//
//   pnpm --filter e2e test _transportIter3Segments

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test("transport iter3 multi-segment view", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText(
    "workers ready",
  );
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  await page.evaluate(() => {
    const startMs = Date.UTC(2018, 6, 27, 6, 4, 0, 0);
    const startNs = BigInt(startMs) * 1_000_000n;
    const sec = 1_000_000_000n;
    const seg = [
      {
        start: Number(startNs),
        end: Number(startNs + 60n * sec),
        name: "segment-04.mcap",
      },
      {
        start: Number(startNs + 120n * sec),
        end: Number(startNs + 180n * sec),
        name: "segment-07.mcap",
      },
      {
        start: Number(startNs + 240n * sec),
        end: Number(startNs + 300n * sec),
        name: "segment-10.mcap",
      },
    ];
    window.__drivelineDevHooks!.seedSegmentsForScreenshot(seg);
    const cursor = startNs + 165n * sec;
    window.__drivelineDevHooks!.setCursorNs(cursor);
  });
  await page.waitForTimeout(50);

  const bbox = await page.getByTestId("transport").boundingBox();
  if (!bbox) throw new Error("transport bbox missing");
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, "transport-iter3-segments.png"),
    fullPage: false,
    clip: {
      x: Math.max(0, bbox.x - 6),
      y: Math.max(0, bbox.y - 110),
      width: bbox.width + 12,
      height: bbox.height + 122,
    },
  });

  // The faint "3 segments" centre text from iter2 should be gone from
  // visible chrome — the sr-only span is the only carrier now. We
  // verify by checking the element is clipped to 1×1 (sr-only
  // technique), not by Playwright's visibility heuristic which
  // considers any sized box visible.
  const count = page.getByTestId("transport-segment-count");
  await expect(count).toHaveText("3 segments");
  const box = await count.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(2);
  expect(box?.height).toBeLessThanOrEqual(2);
});
