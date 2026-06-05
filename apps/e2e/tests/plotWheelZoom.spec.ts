// Real-browser proof of the PlotPanel mouse-wheel zoom (and its reset
// affordance). Loads the MF4 corpus, binds a scalar channel to plot-1,
// then drives actual `wheel` events at different spots and asserts the
// resolved scales (read via `getPlotPanelSync`) respond per the contract:
//
//   - over the drawing area  → both x and y narrow;
//   - over the x-axis gutter → only x narrows;
//   - over the y-axis gutter → only y narrows;
//   - the "Reset zoom" button appears while zoomed and clears it.
//
// uPlot's resolved-scale geometry only exists in a real browser (jsdom
// doesn't drive the redraw/auto-range pipeline), so the hit-testing +
// re-scale round-trip is verified here rather than in the unit tests.

import { test, expect, type Page } from "@playwright/test";

const PLOT_PANEL_ID = "plot-1";

interface Scale {
  min: number;
  max: number;
}
interface PlotSync {
  xScaleSec: Scale | null;
  yScale: Scale | null;
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{ opened: string[]; errors: { name: string }[] }>;
      clearSession: () => Promise<void>;
      resetLayout: () => void;
      listChannels: () => Array<{ id: string; name: string; kind: string }>;
      addPlotChannelBinding: (panelId: string, channelId: string) => void;
      getPlotPanelSync: (panelId: string) => PlotSync | null;
      getPlotPanelSeriesStats: (
        panelId: string,
      ) => Array<{ count: number }> | null;
    };
  }
}

async function getSync(page: Page): Promise<PlotSync> {
  return await page.evaluate(
    (id) => window.__drivelineDevHooks!.getPlotPanelSync(id)!,
    PLOT_PANEL_ID,
  );
}

const span = (s: Scale): number => s.max - s.min;

test.describe("PlotPanel wheel zoom", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

    // Load the MF4 corpus and bind its first scalar channel to plot-1.
    await page.evaluate(async (panelId) => {
      const r = await fetch("/sample-data/short.mf4");
      const bytes = new Uint8Array(await r.arrayBuffer());
      const res = await window.__drivelineDevHooks!.openFiles([
        { name: "short.mf4", bytes },
      ]);
      if (res.errors.length) throw new Error("open failed");
      const ch = window.__drivelineDevHooks!
        .listChannels()
        .find((c) => c.kind === "scalar");
      if (!ch) throw new Error("no scalar channel");
      window.__drivelineDevHooks!.addPlotChannelBinding(panelId, ch.id);
    }, PLOT_PANEL_ID);

    // Wait for the fetch to land (a series with samples).
    await expect
      .poll(async () =>
        page.evaluate(
          (id) =>
            (
              window.__drivelineDevHooks!.getPlotPanelSeriesStats(id) ?? []
            ).some((s) => s.count > 0),
          PLOT_PANEL_ID,
        ),
      )
      .toBe(true);

    // The sync snapshot's *resolved* x/y scales only refresh on a publish
    // that runs after uPlot's post-setData microtask. A single scrub click
    // moves the cursor, which triggers that publish — giving a stable
    // baseline to compare the wheel against.
    await page.getByTestId("plot-panel").getByRole("slider").click();
    await expect
      .poll(async () => {
        const s = await getSync(page);
        return s.xScaleSec !== null && s.yScale !== null;
      })
      .toBe(true);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(() => window.__drivelineDevHooks!.clearSession());
  });

  test("wheel over the drawing area zooms both axes; reset clears it", async ({
    page,
  }) => {
    const before = await getSync(page);
    const area = page.getByTestId("plot-panel").getByRole("slider");
    const box = (await area.boundingBox())!;

    await expect(page.getByTestId("plot-reset-zoom")).toHaveCount(0);

    // Scroll up over the centre of the drawing area → zoom in on both axes.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);

    await expect
      .poll(async () => span((await getSync(page)).xScaleSec!))
      .toBeLessThan(span(before.xScaleSec!) - 1e-9);
    const after = await getSync(page);
    expect(span(after.yScale!)).toBeLessThan(span(before.yScale!) - 1e-9);

    // The reset affordance appears and snaps every scale back to fit.
    const reset = page.getByTestId("plot-reset-zoom");
    await expect(reset).toBeVisible();
    await reset.click();
    await expect(reset).toHaveCount(0);

    await expect
      .poll(async () => (await getSync(page)).xScaleSec!.max)
      .toBeCloseTo(before.xScaleSec!.max, 5);
  });

  test("wheel over the x-axis gutter zooms only x", async ({ page }) => {
    const before = await getSync(page);
    const area = page.getByTestId("plot-panel").getByRole("slider");
    const box = (await area.boundingBox())!;

    // Near the bottom edge → the x-axis gutter.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 4);
    await page.mouse.wheel(0, -240);

    await expect
      .poll(async () => span((await getSync(page)).xScaleSec!))
      .toBeLessThan(span(before.xScaleSec!) - 1e-9);
    // y is untouched.
    expect(span((await getSync(page)).yScale!)).toBeCloseTo(
      span(before.yScale!),
      6,
    );
  });

  test("wheel over the y-axis gutter zooms only that y-axis", async ({
    page,
  }) => {
    const before = await getSync(page);
    const area = page.getByTestId("plot-panel").getByRole("slider");
    const box = (await area.boundingBox())!;

    // Near the left edge → the (single) y-axis gutter.
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.wheel(0, -240);

    await expect
      .poll(async () => span((await getSync(page)).yScale!))
      .toBeLessThan(span(before.yScale!) - 1e-9);
    // x is untouched.
    expect(span((await getSync(page)).xScaleSec!)).toBeCloseTo(
      span(before.xScaleSec!),
      6,
    );
  });
});
