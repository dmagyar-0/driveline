// Regression: the plot hover tooltip must stay inside the plot area.
//
// The tooltip (per-series value readout) used to be anchored at
// `left: pointerX + 12` with no edge handling, so hovering near the right
// edge rendered it entirely outside the panel — the "values going out of
// bounds on the plot" report. `tooltipPositionStyle` now flips the box to the
// far side of the pointer before it would overflow. This asserts the rendered
// tooltip's box stays within the plot area for hovers near each edge.
//
// Uses the always-present synthetic `short.mcap` (scalar `/vehicle/speed`),
// so it runs in normal CI without the gitignored comma2k19 fixtures.

import { test, expect, type Page } from "@playwright/test";

const PLOT = "plot-1";

async function plotAreaBox(page: Page) {
  const box = await page
    .getByRole("slider", { name: "Scrub cursor on plot" })
    .boundingBox();
  if (!box) throw new Error("plot area not visible");
  return box;
}

// Hover (no button) at an absolute viewport point and let the rAF-coalesced
// hover settle so the tooltip mounts/positions.
async function hoverAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.move(x + 1, y); // second move guarantees a pointermove
  await page.waitForTimeout(120);
}

test.describe("plot hover tooltip stays in bounds", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });

    const res = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mcap");
      if (!r.ok) throw new Error(`fetch mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(res.errors).toEqual([]);

    // Bind every scalar channel the fixture exposes (just `/vehicle/speed`).
    await page.evaluate((panelId) => {
      const h = window.__drivelineDevHooks!;
      for (const c of h.listChannels()) {
        if (c.kind === "scalar") h.addPlotChannelBinding(panelId, c.id);
      }
    }, PLOT);

    await expect
      .poll(
        () =>
          page.evaluate(
            (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p)?.length ?? 0,
            PLOT,
          ),
        { timeout: 15_000, intervals: [200, 400] },
      )
      .toBeGreaterThan(0);
  });

  test("tooltip near the right edge does not overflow the plot area", async ({
    page,
  }) => {
    const area = await plotAreaBox(page);
    // Hover just inside the right edge — the pre-fix overflow case.
    await hoverAt(page, area.x + area.width - 6, area.y + area.height * 0.6);

    const tip = await page.getByTestId("plot-hover-tooltip").boundingBox();
    expect(tip, "tooltip should be visible on hover").not.toBeNull();
    // Right and bottom edges stay within the plot area (1px rounding slack).
    expect(tip!.x + tip!.width).toBeLessThanOrEqual(area.x + area.width + 1);
    expect(tip!.y + tip!.height).toBeLessThanOrEqual(area.y + area.height + 1);
    // And it didn't get pushed off the left/top either.
    expect(tip!.x).toBeGreaterThanOrEqual(area.x - 1);
    expect(tip!.y).toBeGreaterThanOrEqual(area.y - 1);
  });

  test("tooltip near the left edge sits beside the pointer, inside the area", async ({
    page,
  }) => {
    const area = await plotAreaBox(page);
    await hoverAt(page, area.x + 8, area.y + area.height * 0.4);

    const tip = await page.getByTestId("plot-hover-tooltip").boundingBox();
    expect(tip).not.toBeNull();
    expect(tip!.x).toBeGreaterThanOrEqual(area.x - 1);
    expect(tip!.x + tip!.width).toBeLessThanOrEqual(area.x + area.width + 1);
  });
});
