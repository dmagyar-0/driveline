// Iteration 2 screenshot spec for the Transport bar overhaul.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly:
//
//   pnpm --filter e2e test _transportIter2Screenshots
//
// Captures three screenshots covering the post-iter2 designer audit:
//   1. transport-iter2-loaded.png   — single source, cursor mid-track
//      so the tall track + integrated playhead + time badge are visible.
//   2. transport-iter2-segments.png — three synthetic segments seeded
//      via the `seedSegmentsForScreenshot` dev hook so the segment
//      bands + per-segment labels show. Cursor lands inside segment 2
//      to demonstrate the "active band" tint.
//   3. transport-iter2-hover.png    — single source, hover at mid-track
//      to show the hover ghost line + time tooltip.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function screenshotTransport(
  page: import("@playwright/test").Page,
  fileName: string,
  padTop = 80,
): Promise<void> {
  const bbox = await page.getByTestId("transport").boundingBox();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, fileName),
    fullPage: false,
    clip: bbox
      ? {
          x: Math.max(0, bbox.x - 6),
          // Pull the clip up so the playhead badge (which sits above the
          // track) is included in the frame.
          y: Math.max(0, bbox.y - padTop),
          width: bbox.width + 12,
          height: bbox.height + padTop + 12,
        }
      : undefined,
  });
}

test.describe("transport iter2 redesign", () => {
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

  test("captures the iter2 transport bar across three states", async ({
    page,
  }) => {
    // 1. Single source loaded + cursor in the middle so the playhead
    //    badge + handle are visible.
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
    // Place the cursor at ~40 % of the range so the badge + handle
    // are well inside the bar (not pinned to the edges).
    await page.evaluate(() => {
      const r = window.__drivelineDevHooks!.getGlobalRange();
      if (!r) return;
      const start = BigInt(r.startNs);
      const end = BigInt(r.endNs);
      const mid = start + ((end - start) * 4n) / 10n;
      window.__drivelineDevHooks!.setCursorNs(mid);
    });
    await page.waitForTimeout(50);
    await screenshotTransport(page, "transport-iter2-loaded.png");

    // 2. Three synthetic segments. Seed offset ranges so the gap
    //    between bands shows; place the cursor inside segment 2 so
    //    the "active band" highlight is on.
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
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
      // Land the cursor mid-S2, but biased to the right so the badge
      // doesn't fully eclipse the "S2" label above the band.
      const cursor = startNs + 165n * sec;
      window.__drivelineDevHooks!.setCursorNs(cursor);
    });
    await page.waitForTimeout(50);
    await screenshotTransport(page, "transport-iter2-segments.png", 100);

    // 3. Hover ghost line + tooltip. Reload the short.mcap so the
    //    track has a deterministic length, then dispatch a synthetic
    //    pointerenter + pointermove at mid-track. The Transport's
    //    hover state lands once per rAF; a short wait covers that.
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
      const r = await fetch("/sample-data/short.mcap");
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
    // Move the cursor to ~ 20 % so the hover preview at 65 % is
    // visually distinct from the playhead.
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
    // hover() emits pointerenter + pointermove; the component reads
    // them and paints the tooltip on the next rAF.
    await track.hover({
      position: {
        x: Math.round(box.width * 0.65),
        y: Math.round(box.height / 2),
      },
    });
    await page.waitForTimeout(50);
    await screenshotTransport(page, "transport-iter2-hover.png", 100);
  });
});
