// Visual check for the stacked-axes plot mode on real comma2k19 signals.
//
// Binds several CAN signals of very different magnitudes (speed, steering
// angle, a wheel speed) across three y-axes of one plot, then screenshots
// the panel both OVERLAID (the default — traces pile up across the full
// height) and STACKED (each axis gets its own vertical band). The pair of
// PNGs is the eyeball proof for the "Stack" toggle.
//
// Underscore prefix keeps this out of normal CI — invoke via the
// verify-visually skill (it builds the comma2k19 fixtures first):
//   pnpm --filter e2e exec playwright test _demo-comma2k19-stack.spec.ts
//
// Requires (built by the verify-visually skill's build-fixtures stage):
//   sample-data/realworld/comma2k19.mcap
//   sample-data/realworld/comma2k19.mf4

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = { mcap: "realworld/comma2k19.mcap", mf4: "realworld/comma2k19.mf4" };
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const PLOT = "plot-1";

// Preferred signals (distinct magnitudes); falls back to whatever scalar
// channels exist so the spec stays robust to converter naming changes.
const PREFERRED = [
  "/vehicle/speed",
  "/vehicle/steering_angle",
  "WheelSpeedFL",
  "WheelSpeedFR",
];

async function waitForPlotSeries(
  page: Page,
  panelId: string,
  expectedCount: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(
          (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
          panelId,
        );
        return (
          s !== null &&
          s.length === expectedCount &&
          s.every((x) => x.count > 0)
        );
      },
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.waitForTimeout(600);
}

test.describe("comma2k19 stacked axes", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mf4),
    "comma2k19 fixtures missing — run the verify-visually skill first",
  );

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("stacking separates signals that overlap when overlaid", async ({
    page,
  }) => {
    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        Object.values(rels).map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, REL);
    expect(open.errors).toEqual([]);

    // Pick up to three scalar channels: the preferred named ones first, then
    // pad from whatever scalar channels exist.
    const picks = await page.evaluate((preferred) => {
      const all = window.__drivelineDevHooks!.listChannels();
      const scalars = all.filter((c) => c.kind === "scalar");
      const byName = new Map(scalars.map((c) => [c.name, c]));
      const chosen: { id: string; name: string }[] = [];
      for (const n of preferred) {
        const c = byName.get(n);
        if (c && !chosen.some((x) => x.id === c.id)) {
          chosen.push({ id: c.id, name: c.name });
        }
        if (chosen.length === 3) break;
      }
      for (const c of scalars) {
        if (chosen.length === 3) break;
        if (!chosen.some((x) => x.id === c.id)) {
          chosen.push({ id: c.id, name: c.name });
        }
      }
      return chosen;
    }, PREFERRED);
    expect(picks.length).toBeGreaterThanOrEqual(2);

    // Bind each on its own axis (0, 1, 2 …) so every signal gets a band.
    await page.evaluate(
      ([panelId, chosen]) => {
        const h = window.__drivelineDevHooks!;
        (chosen as { id: string }[]).forEach((c, i) => {
          h.addPlotChannelBinding(panelId as string, c.id);
          if (i > 0) h.setPlotChannelAxis(panelId as string, c.id, i);
        });
      },
      [PLOT, picks] as const,
    );
    await waitForPlotSeries(page, PLOT, picks.length);
    await settle(page);

    const panel = page.getByTestId("plot-panel");
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-stack-off.png"),
    });

    // Flip the toggle on and screenshot the stacked result.
    const toggle = page.getByTestId("plot-stack-axes");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await settle(page);
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-stack-on.png"),
    });

    // Sanity: stacking resolves a concrete, finite scale "y" (the banded
    // `range` callback), whereas the overlay auto-range is left null in the
    // snapshot. Poll since the resolve lands on the post-toggle rebuild.
    await expect
      .poll(
        async () => {
          const y = await page.evaluate(
            (p) =>
              window.__drivelineDevHooks!.getPlotPanelSync(p)?.yScale ?? null,
            PLOT,
          );
          return y !== null && Number.isFinite(y.min) && Number.isFinite(y.max);
        },
        { timeout: 10_000, intervals: [100, 200, 400] },
      )
      .toBe(true);
  });
});
