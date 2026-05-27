// Iter5 plot panel screenshot spec.
//
// Underscore prefix keeps this out of the default `pnpm e2e` run; invoke
// explicitly when refreshing the iter5 critique screenshots:
//
//   pnpm --filter e2e test _plotIter5Screenshots
//
// Writes 3 screenshots under apps/e2e/tests/screenshots/:
//
//   plot-iter5-hierarchy-and-axes.png — bound across two unit groups
//     so the dual-axis chrome appears. Demonstrates iter5 #1 (live
//     value dominant in the gutter), #2 (chip L/R badges), #3 (denser
//     x-axis ladder), #4 (in-chart title + footer), and #5 (mixed-
//     units pill on the chart top-right).
//
//   plot-iter5-palette-and-dashes.png — ≥6 traces bound so iter5 #6
//     (Wong colourblind palette) shows distinct colours and #7 (dash
//     patterns at ≥4) shows solid/dashed/dotted/dash-dot textures.
//
//   plot-iter5-cursor-gutter.png — close-cropped gutter so the
//     hierarchy of live-value > channel-name > source-badge reads at
//     screenshot size.

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

async function screenshotCursorGutter(
  page: import("@playwright/test").Page,
  fileName: string,
): Promise<void> {
  const handle = page.getByTestId("plot-cursor-gutter");
  await expect(handle).toBeVisible();
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

async function moveCursorToFraction(
  page: import("@playwright/test").Page,
  fraction: number,
): Promise<void> {
  await page.evaluate((f) => {
    const snap = window.__drivelineDevHooks!.getSessionSnapshot() as unknown as {
      globalRange: { startNs: string; endNs: string } | null;
    };
    if (!snap.globalRange) throw new Error("no global range loaded");
    const startNs = BigInt(snap.globalRange.startNs);
    const endNs = BigInt(snap.globalRange.endNs);
    const target =
      startNs + ((endNs - startNs) * BigInt(Math.round(f * 1000))) / 1000n;
    window.__drivelineDevHooks!.setCursorNs(target);
  }, fraction);
  await page.waitForTimeout(200);
}

async function loadComma2k19(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.evaluate(async () => {
    const fetchBytes = async (p: string) => {
      const r = await fetch(p);
      if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const files = [
      { name: "comma2k19.mcap", path: "/sample-data/realworld/comma2k19.mcap" },
      { name: "comma2k19.mf4", path: "/sample-data/realworld/comma2k19.mf4" },
    ];
    const descs = [];
    for (const f of files) {
      descs.push({ name: f.name, bytes: await fetchBytes(f.path) });
    }
    await window.__drivelineDevHooks!.openFiles(descs);
  });

  await page.waitForFunction(
    () =>
      (
        window.__drivelineDevHooks!.getSessionSnapshot() as {
          globalRange: unknown;
        }
      ).globalRange !== null,
  );
}

test.describe("plot iter5 screenshots", () => {
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

  test("(a) hierarchy + L/R indicators + minor ticks + in-chart title", async ({
    page,
  }) => {
    await loadComma2k19(page);

    // Pick channels across at least two unit groups so the dual-axis
    // chrome (L/R chip badges, tinted ticks) materialises.
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      const seenUnits = new Set<string>();
      const picks: string[] = [];
      for (const c of scalars) {
        const u = c.unit ?? "";
        if (seenUnits.has(u)) continue;
        seenUnits.add(u);
        picks.push(c.id);
        if (picks.length >= 3) break;
      }
      return picks;
    });
    for (const id of picks) {
      await page.evaluate(
        (cid) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", cid),
        id,
      );
    }
    await page.waitForTimeout(800);
    await moveCursorToFraction(page, 0.45);
    await expect(page.getByTestId("plot-cursor-gutter")).toBeVisible({
      timeout: 4000,
    });
    await expect(page.getByTestId("plot-in-chart-title")).toBeVisible();
    await screenshotPlotPanel(page, "plot-iter5-hierarchy-and-axes.png");
  });

  test("(b) ≥6 traces — Wong palette + dash patterns", async ({ page }) => {
    await loadComma2k19(page);

    // Bind 6 channels so dash patterns engage (DASH_THRESHOLD = 4).
    // Pick channels with diverse names so the Wong palette wraps and
    // the dash patterns become the second discriminator.
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar").slice(0, 6);
      return scalars.map((c) => c.id);
    });
    for (const id of picks) {
      await page.evaluate(
        (cid) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", cid),
        id,
      );
    }
    await page.waitForTimeout(800);

    // ≥6 chips trip the collapse threshold — click "Show chips" so
    // the chip row materialises in the screenshot.
    const collapseToggle = page.getByTestId("plot-chips-collapse");
    if (await collapseToggle.isVisible().catch(() => false)) {
      const label = await collapseToggle.textContent();
      if (label?.trim() === "Show chips") await collapseToggle.click();
      await page.waitForTimeout(300);
    }
    await moveCursorToFraction(page, 0.5);
    await screenshotPlotPanel(page, "plot-iter5-palette-and-dashes.png");
  });

  test("(c) cursor gutter — live value dominant", async ({ page }) => {
    await loadComma2k19(page);

    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      const seenUnits = new Set<string>();
      const picks: string[] = [];
      for (const c of scalars) {
        const u = c.unit ?? "";
        if (seenUnits.has(u)) continue;
        seenUnits.add(u);
        picks.push(c.id);
        if (picks.length >= 4) break;
      }
      return picks;
    });
    for (const id of picks) {
      await page.evaluate(
        (cid) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", cid),
        id,
      );
    }
    await page.waitForTimeout(800);
    await moveCursorToFraction(page, 0.4);
    await expect(page.getByTestId("plot-cursor-gutter")).toBeVisible({
      timeout: 4000,
    });
    await screenshotCursorGutter(page, "plot-iter5-cursor-gutter.png");
  });
});
