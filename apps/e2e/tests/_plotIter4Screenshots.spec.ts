// Iter4 plot panel screenshot spec.
//
// Underscore prefix keeps this out of the default `pnpm e2e` run; invoke
// explicitly when refreshing the iter4 critique screenshots:
//
//   pnpm --filter e2e test _plotIter4Screenshots
//
// Writes 2 screenshots under apps/e2e/tests/screenshots/:
//   plot-iter4-dual-axis-aligned.png — two unit groups, dual axes
//     sharing the same tick rows (iter4 #3), right axis label reading
//     bottom-to-top (iter4 #4), and the x-axis time labels spaced
//     apart (iter4 #1).
//   plot-iter4-chip-overflow.png — many bound channels so the chip
//     row exceeds the panel width, surfacing the `+N more` pill
//     (iter4 #5). Captured with the pill popover open so both surfaces
//     are visible in one frame.

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

async function moveCursorToFraction(
  page: import("@playwright/test").Page,
  fraction: number,
): Promise<void> {
  await page.evaluate((f) => {
    const snap =
      window.__drivelineDevHooks!.getSessionSnapshot() as unknown as {
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

test.describe("plot iter4 screenshots", () => {
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

  test("dual-axis aligned + spaced x-axis ticks + bottom-to-top labels", async ({
    page,
  }) => {
    // Load comma2k19 MCAP + MF4 — gives a cross-source view with at
    // least two unit groups.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const files = [
        {
          name: "comma2k19.mcap",
          path: "/sample-data/realworld/comma2k19.mcap",
        },
        {
          name: "comma2k19.mf4",
          path: "/sample-data/realworld/comma2k19.mf4",
        },
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

    // Pick at least two channels from different unit groups so two
    // axes appear and the dual-axis alignment path engages.
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      // Build one chip per (sourceId, unit) pair so we maximise the
      // chance of hitting ≥2 unit groups.
      const seen = new Set<string>();
      const picks: { id: string }[] = [];
      for (const c of scalars) {
        const key = `${c.sourceId}|${c.unit ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        picks.push({ id: c.id });
        if (picks.length >= 4) break;
      }
      return picks;
    });

    for (const p of picks) {
      await page.evaluate(
        (id) =>
          window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        p.id,
      );
    }
    await page.waitForTimeout(800);

    await moveCursorToFraction(page, 0.45);
    await expect(page.getByTestId("plot-cursor-gutter")).toBeVisible({
      timeout: 4000,
    });
    await screenshotPlotPanel(page, "plot-iter4-dual-axis-aligned.png");
  });

  test("chip overflow surfaces +N more pill", async ({ page }) => {
    // Load multiple files so we have plenty of scalar channels to
    // bind beyond what fits in one panel row.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const files = [
        {
          name: "comma2k19.mcap",
          path: "/sample-data/realworld/comma2k19.mcap",
        },
        {
          name: "comma2k19.mf4",
          path: "/sample-data/realworld/comma2k19.mf4",
        },
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

    // Bind up to 8 channels (the panel cap) so the chip row is forced
    // to overflow at typical panel widths.
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels
        .filter((c) => c.kind === "scalar")
        .slice(0, 8);
      return scalars.map((c) => ({ id: c.id }));
    });
    for (const p of picks) {
      await page.evaluate(
        (id) =>
          window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        p.id,
      );
    }
    await page.waitForTimeout(800);

    // 6+ chips trip the iter2 `CHIP_COLLAPSE_THRESHOLD` so chips are
    // hidden behind a "Show chips" pill — click it first so the chip
    // row materialises and the iter4 `+N more` overflow pill is the
    // surface under test.
    const collapseToggle = page.getByTestId("plot-chips-collapse");
    if (await collapseToggle.isVisible().catch(() => false)) {
      const label = await collapseToggle.textContent();
      if (label?.trim() === "Show chips") await collapseToggle.click();
      await page.waitForTimeout(300);
    }

    // Capture the chip row with the `+N more` pill in its default
    // (closed) state — the screenshot then frames the pill as a clean
    // edge affordance instead of competing with a popover panel
    // dropped over the canvas.
    await expect(page.getByTestId("plot-chips-overflow")).toBeVisible({
      timeout: 2000,
    });
    await moveCursorToFraction(page, 0.3);
    await screenshotPlotPanel(page, "plot-iter4-chip-overflow.png");
  });
});
