// Iteration 5 screenshot spec for the Transport bar polish cluster.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly:
//
//   pnpm --filter e2e test _transportIter5Screenshots
//
// Captures two screenshots covering the iter4 → iter5 designer audit:
//
//   1. transport-iter5-segments.png
//      Multi-segment comma2k19 session, cursor past the first segment
//      boundary so the frame shows: the muted (~ 15 % accent) played
//      fill no longer dominating; the promoted segment bands with
//      clearly visible alternation + 2 px full-track-height boundary
//      ticks; the cursor badge with its new leader line to the
//      playhead dot; and the REL/ABS toggle now sitting between the
//      start/end labels under the track. Demonstrates issues #1, #2,
//      #3, #5.
//
//   2. transport-iter5-hover-terse.png
//      Cursor at 20 %, hover at 65 % so both the orange-bordered
//      cursor badge AND the iter5 hover chip appear in the same
//      frame. The chip is now a single short line (time only — the
//      verbose 3-line block from iter4 is gone). Demonstrates
//      issue #4.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

const COMMA2K19_SEGMENTS = [
  "comma2k19_seg4.mcap",
  "comma2k19_seg7.mcap",
  "comma2k19_seg10.mcap",
] as const;

async function screenshotTransport(
  page: import("@playwright/test").Page,
  fileName: string,
  padTop = 110,
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

test.describe("transport iter5 polish", () => {
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

  test("captures the iter5 transport bar across two key states", async ({
    page,
  }) => {
    await page.evaluate(async (names) => {
      const files: { name: string; bytes: Uint8Array }[] = [];
      for (const name of names) {
        const r = await fetch(`/sample-data/realworld/${name}`);
        if (!r.ok) throw new Error(`fetch ${name}: ${r.status}`);
        files.push({ name, bytes: new Uint8Array(await r.arrayBuffer()) });
      }
      await window.__drivelineDevHooks!.openFiles(files);
    }, COMMA2K19_SEGMENTS as unknown as string[]);

    await page.waitForFunction(
      () =>
        (
          window.__drivelineDevHooks!.getSessionSnapshot() as {
            globalRange: unknown;
          }
        ).globalRange !== null,
    );

    // 1. Frame the promoted segments + muted played fill + cursor
    //    badge leader line + relocated REL/ABS toggle. Cursor at
    //    ~ 40 % so the played fill spans across the first segment
    //    boundary, demonstrating that segment ticks read clearly
    //    even where the played tint crosses them.
    await page.evaluate(() => {
      const r = window.__drivelineDevHooks!.getGlobalRange();
      if (!r) return;
      const start = BigInt(r.startNs);
      const end = BigInt(r.endNs);
      const at = start + ((end - start) * 4n) / 10n;
      window.__drivelineDevHooks!.setCursorNs(at);
    });
    await page.waitForTimeout(80);
    await screenshotTransport(page, "transport-iter5-segments.png");

    // 2. Hover chip rendered alongside the cursor badge. Cursor at
    //    20 %, hover at 65 % so both bubbles render simultaneously.
    //    The iter5 chip is one short line (the time) — the iter4
    //    3-line block is gone.
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
    await page.waitForTimeout(120);
    await screenshotTransport(page, "transport-iter5-hover-terse.png");
  });
});
