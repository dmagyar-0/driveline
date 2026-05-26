// Visual screenshot spec for the Plot panel UI/UX overhaul.
// Underscore prefix keeps it out of the default `pnpm e2e` invocation;
// run explicitly when you want to refresh the screenshots:
//
//   pnpm --filter e2e test _plotRedesignScreenshots
//
// Captures (writes to apps/e2e/tests/screenshots/plot-redesign-*.png):
//   1. plot-redesign-empty.png       — Plot panel, no channels bound.
//   2. plot-redesign-single-unit.png — Channels bound, all same unit; no
//                                       Mixed-units warning.
//   3. plot-redesign-mixed-units.png — Channels with two units; left+
//                                       right Y-axes visible.
//   4. plot-redesign-many-units.png  — Three unit groups, Mixed-units
//                                       warning chip visible.
//   5. plot-redesign-cursor.png      — Cursor moved mid-range so the
//                                       under-plot value readout shows
//                                       resolved samples.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function screenshotPlotPanel(
  page: import("@playwright/test").Page,
  fileName: string,
): Promise<void> {
  const handle = page.getByTestId("plot-panel").first();
  await expect(handle).toBeVisible();
  // Use evaluate to grab the element's bounding rect so we capture
  // everything inside the section (including absolutely-positioned
  // descendants), then pad a bit.
  const bbox = await handle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, fileName),
    fullPage: false,
    clip: {
      x: Math.max(0, bbox.x - 4),
      y: Math.max(0, bbox.y - 4),
      width: bbox.width + 8,
      height: bbox.height + 8,
    },
  });
}

test.describe("plot redesign", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("captures the redesigned plot across states", async ({ page }) => {
    // 1. Empty state — empty-state copy visible, header just shows the
    //    Add channel button with `0 / 8 max`.
    await screenshotPlotPanel(page, "plot-redesign-empty.png");

    // Load fixtures: MCAP + MF4 give us a mix of units.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/short.mcap");
      const mf4 = await fetchBytes("/sample-data/short.mf4");
      await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes: mcap },
        { name: "short.mf4", bytes: mf4 },
      ]);
    });

    // Wait for the session to land.
    await page.waitForFunction(
      () =>
        (
          window.__drivelineDevHooks!.getSessionSnapshot() as {
            globalRange: unknown;
          }
        ).globalRange !== null,
    );

    // Discover live scalar channels grouped by unit, then plot two
    // channels that share a unit (single-axis case).
    const channelInfo = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      // Bucket by unit so the test can ask for two-from-same-unit and
      // one-with-a-different unit deterministically.
      const byUnit = new Map<string, typeof scalars>();
      for (const c of scalars) {
        const k = (c.unit ?? "").trim() || "(unitless)";
        const arr = byUnit.get(k) ?? [];
        arr.push(c);
        byUnit.set(k, arr);
      }
      return Array.from(byUnit.entries()).map(([unit, channels]) => ({
        unit,
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
      }));
    });

    // 2. Single-unit: pick the two largest-unit buckets and use only
    //    the most-populated one (so every chip shares an axis).
    const sortedByCount = [...channelInfo].sort(
      (a, b) => b.channels.length - a.channels.length,
    );
    const sameUnit = sortedByCount[0]?.channels.slice(0, 3) ?? [];
    if (sameUnit.length === 0) {
      throw new Error("no scalar channels available");
    }
    for (const c of sameUnit) {
      await page.evaluate(
        ({ id }) =>
          window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        c,
      );
    }
    await page.waitForTimeout(300);
    await screenshotPlotPanel(page, "plot-redesign-single-unit.png");

    // 3. Mixed units (2 groups) — add one channel from a different
    //    unit bucket so we render left + right axes without the
    //    Mixed-units warning.
    const otherBucket = sortedByCount.find(
      (b, i) => i > 0 && b.channels.length > 0,
    );
    if (otherBucket) {
      const idA = otherBucket.channels[0].id;
      await page.evaluate(
        (id) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        idA,
      );
      await page.waitForTimeout(300);
      await screenshotPlotPanel(page, "plot-redesign-mixed-units.png");
    }

    // 4. ≥3 unit groups — add a channel from a third unit bucket if
    //    one exists.
    const thirdBucket = sortedByCount.find(
      (b, i) => i > 0 && b !== otherBucket && b.channels.length > 0,
    );
    if (thirdBucket) {
      const idB = thirdBucket.channels[0].id;
      await page.evaluate(
        (id) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        idB,
      );
      await page.waitForTimeout(300);
      await screenshotPlotPanel(page, "plot-redesign-many-units.png");
    }

    // 5. Move the cursor a few seconds into the session so the
    //    cursor-value readout has live numbers. The scrubber wires
    //    ArrowLeft/ArrowRight to ±1s; focus it first so the press is
    //    captured rather than scrolling the page.
    await page.getByTestId("scrubber").focus();
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await page.waitForTimeout(200);

    // Sanity: the cursor-value readout strip must be in the DOM after
    // the cursor moves. If this fails the screenshot is meaningless.
    await expect(page.getByTestId("plot-cursor-readout")).toBeVisible();

    await screenshotPlotPanel(page, "plot-redesign-cursor.png");
  });
});
