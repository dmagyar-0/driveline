// Iteration 4 screenshot spec for the Transport bar polish cluster.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly:
//
//   pnpm --filter e2e test _transportIter4Screenshots
//
// Captures two screenshots covering the iter3 → iter4 designer audit:
//
//   1. transport-iter4-played-region.png
//      Multi-segment comma2k19 session, cursor placed past the first
//      segment boundary so the high-contrast played region (issue
//      #1) reads against the muted unplayed remainder, and the
//      orange-bordered cursor badge (issue #2) sits at the boundary
//      of the two.
//
//   2. transport-iter4-hover-distinct.png
//      Cursor at 20 %, hover at 65 % so both the orange-bordered
//      cursor badge AND the iter4 hover chip (square corners,
//      outline-only, neutral) appear in the same frame. The chip
//      carries the inline "Segment N · <file>" sublabel from
//      issue #6.

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

test.describe("transport iter4 polish", () => {
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

  test("captures the iter4 transport bar across two key states", async ({
    page,
  }) => {
    // Load three comma2k19 segments so the scrubber has real
    // multi-segment structure (bands + tick marks + labels).
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

    // 1. Played region + cursor badge close-up. Cursor at ~ 40 % so
    //    the high-contrast `.trackFill` reads against the unplayed
    //    remainder AND the orange-bordered badge is well inside the
    //    frame.
    await page.evaluate(() => {
      const r = window.__drivelineDevHooks!.getGlobalRange();
      if (!r) return;
      const start = BigInt(r.startNs);
      const end = BigInt(r.endNs);
      const at = start + ((end - start) * 4n) / 10n;
      window.__drivelineDevHooks!.setCursorNs(at);
    });
    await page.waitForTimeout(80);
    await screenshotTransport(page, "transport-iter4-played-region.png");

    // 2. Hover chip rendered alongside the cursor badge. Cursor at
    //    20 %, hover at 65 % so both bubbles render simultaneously.
    //    Multi-segment session means the hover chip also carries the
    //    iter4 #6 segment sublabel.
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
    // Hover at 88 % — well inside segment S3 — so the hover chip
    // carries the iter4 #6 segment sublabel ("Segment 3 · <name>")
    // and the visual contrast against the cursor badge is obvious.
    await track.hover({
      position: {
        x: Math.round(box.width * 0.88),
        y: Math.round(box.height / 2),
      },
    });
    await page.waitForTimeout(120);
    await screenshotTransport(page, "transport-iter4-hover-distinct.png");
  });
});
