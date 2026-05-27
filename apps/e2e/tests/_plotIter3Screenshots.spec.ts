// Iter3 plot panel screenshot spec.
//
// Underscore prefix keeps this out of the default `pnpm e2e` run; invoke
// explicitly when refreshing the iter3 critique screenshots:
//
//   pnpm --filter e2e test _plotIter3Screenshots
//
// Writes 2 screenshots under apps/e2e/tests/screenshots/:
//   plot-iter3-cursor-gutter.png     — cursor at ~30% across the
//     timeline, right-side gutter showing per-channel values without
//     overlapping the traces (iter3 issue #1).
//   plot-iter3-dual-axis-gridlines.png — two unit groups bound from
//     two source files; left/right axes carry tinted gridlines (iter3
//     issue #5) and chips wear coloured source ribbons (iter3 issue #2).
//
// The cursor is moved to ~30% via the existing `setCursor` dev hook
// before each screenshot so the gutter values are populated.

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

test.describe("plot iter3 screenshots", () => {
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

  test("captures the iter3 plot states", async ({ page }) => {
    // Load comma2k19 MCAP + MF4 — gives a cross-source view with
    // distinct channel names so the source ribbons become useful.
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

    // Pick channels from both sources so the ribbon rule fires and at
    // least two unit groups appear (so the per-side tinted gridlines
    // light up).
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      const bySource = new Map<string, typeof scalars>();
      for (const c of scalars) {
        const arr = bySource.get(c.sourceId) ?? [];
        arr.push(c);
        bySource.set(c.sourceId, arr);
      }
      const picks: { id: string }[] = [];
      for (const [, list] of bySource.entries()) {
        const sorted = [...list].sort(
          (a, b) => (a.unit ? 0 : 1) - (b.unit ? 0 : 1),
        );
        for (const c of sorted.slice(0, 2)) picks.push({ id: c.id });
      }
      return picks.slice(0, 4);
    });

    for (const p of picks) {
      await page.evaluate(
        (id) =>
          window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        p.id,
      );
    }
    await page.waitForTimeout(800);

    // Screenshot #1 — cursor at 30%, gutter visible to the right of
    // the canvas; never overlaps the trace envelope.
    await moveCursorToFraction(page, 0.3);
    await expect(page.getByTestId("plot-cursor-gutter")).toBeVisible({
      timeout: 4000,
    });
    await screenshotPlotPanel(page, "plot-iter3-cursor-gutter.png");

    // Screenshot #2 — dual-axis with tinted gridlines + source ribbons
    // on chips. Pick a cursor position with active values so the
    // gutter is informative in the screenshot too.
    await moveCursorToFraction(page, 0.55);
    await screenshotPlotPanel(page, "plot-iter3-dual-axis-gridlines.png");
  });
});
