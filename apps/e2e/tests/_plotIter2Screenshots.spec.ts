// Iter2 plot panel screenshot spec.
//
// Underscore prefix keeps this out of the default `pnpm e2e` run; invoke
// explicitly when refreshing the iter2 plot critique screenshots:
//
//   pnpm --filter e2e test _plotIter2Screenshots
//
// Writes 3 screenshots under apps/e2e/tests/screenshots/:
//   plot-iter2-cursor-tooltip.png  — cursor at ~30% across the timeline,
//     tooltip floating beside the playhead with per-channel values.
//   plot-iter2-dual-axis-source-badges.png — two unit groups bound from
//     two source files; colour-coded left/right axes + source badges.
//   plot-iter2-segment-bands.png   — multi-segment recording (seeded via
//     the dev hook the transport agent already exposed) showing one
//     shaded band per segment with the S<n> label.
//
// The cursor is moved to ~30% via the existing `setCursor` dev hook
// before each screenshot so the floating tooltip is visible to the
// next round of reviewers without manual stepping.

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

// Move the cursor to a fraction of the loaded global range so the
// floating tooltip is visible mid-canvas (the critic complained the
// previous round's screenshots showed the playhead at t=0 with no
// values to read). 30% is far enough from either edge to exercise the
// "anchor to the right of the cursor" branch without overlapping the
// chip row.
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
    // Use the existing `setCursorNs` dev hook installed by App.tsx;
    // accepts a bigint or number and forwards to the store's setCursor.
    window.__drivelineDevHooks!.setCursorNs(target);
  }, fraction);
  await page.waitForTimeout(200);
}

test.describe("plot iter2 screenshots", () => {
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

  test("captures the iter2 plot states", async ({ page }) => {
    // Load comma2k19 MCAP + MF4 — gives a cross-source view with
    // distinct channel names so the source badges become useful.
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

    // Pick channels from both sources so the badge rule fires.
    const picks = await page.evaluate(() => {
      const channels = window.__drivelineDevHooks!.listChannels();
      const scalars = channels.filter((c) => c.kind === "scalar");
      // Bucket by sourceId, then take up to 2 from each so the dual-
      // axis branch lights up when the units differ.
      const bySource = new Map<string, typeof scalars>();
      for (const c of scalars) {
        const arr = bySource.get(c.sourceId) ?? [];
        arr.push(c);
        bySource.set(c.sourceId, arr);
      }
      const picks: { id: string }[] = [];
      for (const [, list] of bySource.entries()) {
        // Prefer channels with a non-empty unit so we land in the
        // mixed-units case at least some of the time.
        const sorted = [...list].sort((a, b) =>
          (a.unit ? 0 : 1) - (b.unit ? 0 : 1),
        );
        for (const c of sorted.slice(0, 2)) picks.push({ id: c.id });
      }
      return picks.slice(0, 6);
    });

    for (const p of picks) {
      await page.evaluate(
        (id) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        p.id,
      );
    }
    // Let the fetch + render settle.
    await page.waitForTimeout(800);

    // Screenshot #1 — cursor at 30%, tooltip visible.
    await moveCursorToFraction(page, 0.3);
    await expect(page.getByTestId("plot-cursor-tooltip")).toBeVisible({
      timeout: 4000,
    });
    await screenshotPlotPanel(page, "plot-iter2-cursor-tooltip.png");

    // Screenshot #2 — dual-axis + source badges. The same canvas
    // already has both axes coloured (issue #3) and source badges
    // (issue #2) so we just need a second frame at a different cursor.
    await moveCursorToFraction(page, 0.55);
    await screenshotPlotPanel(page, "plot-iter2-dual-axis-source-badges.png");

    // Screenshot #3 — segment bands. Load the three real comma2k19
    // segment fixtures (seg4, seg7, seg10) which carry distinct
    // timeRanges and real scalar channels, so the SegmentBands overlay
    // has both bbox geometry (driven by bound channels) and ≥2 sources
    // to draw bands for.
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        return new Uint8Array(await r.arrayBuffer());
      };
      const files = [
        { name: "seg4.mcap", path: "/sample-data/realworld/comma2k19_seg4.mcap" },
        { name: "seg7.mcap", path: "/sample-data/realworld/comma2k19_seg7.mcap" },
        { name: "seg10.mcap", path: "/sample-data/realworld/comma2k19_seg10.mcap" },
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
    // Bind one channel per segment so traces visibly span all three
    // bands and bbox geometry becomes known. With ≥2 sources the
    // SegmentBands overlay activates.
    const segPicks = await page.evaluate(() => {
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
        if (list.length > 0) picks.push({ id: list[0].id });
      }
      return picks.slice(0, 3);
    });
    for (const p of segPicks) {
      await page.evaluate(
        (id) => window.__drivelineDevHooks!.addPlotChannelBinding("plot-1", id),
        p.id,
      );
    }
    await page.waitForTimeout(700);
    await moveCursorToFraction(page, 0.5);
    await screenshotPlotPanel(page, "plot-iter2-segment-bands.png");
  });
});
