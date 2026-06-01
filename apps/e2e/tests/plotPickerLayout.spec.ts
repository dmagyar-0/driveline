// Regression test for two layout bugs on a right-docked PlotPanel:
//
//   1. The "+ Add channel" picker popover ran off the right edge of the
//      viewport. The add button sits at the right of the control bar, so
//      on a right-docked panel `left: anchorRect.left` pushed the 18rem
//      popover off-screen. ChannelPicker now clamps/flips into view.
//   2. uPlot's built-in legend rendered a table *below* the canvas (which
//      is sized to the full container height), overflowing the panel and
//      adding a scrollbar. The control-bar chips already act as the
//      legend, so it is now disabled.
//
// Visual proof: screenshots/plot-picker-right.png (popover fully on
// screen) and screenshots/plot-legend-right.png (no clipped legend row).
// The default layout puts the Plot panel on the right half, which is the
// reproducing condition.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

type DevHooksAny = Record<string, (...args: unknown[]) => unknown>;

test.use({ viewport: { width: 1280, height: 720 } });

test.describe("right-docked plot panel layout", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mf4");
      const bytes = new Uint8Array(await r.arrayBuffer());
      await window.__drivelineDevHooks!.openFiles([
        { name: "short.mf4", bytes },
      ]);
    });
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("channel picker stays inside the viewport", async ({ page }) => {
    await page.getByTestId("plot-add-channel").click();
    const picker = page.getByTestId("plot-channel-picker");
    await picker.waitFor();

    const vp = page.viewportSize()!;
    const box = (await picker.boundingBox())!;
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "plot-picker-right.png"),
    });

    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
  });

  test("bound legend does not force a panel scrollbar", async ({ page }) => {
    const ids = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      const all = hooks.listChannels() as Array<{ id: string; kind: string }>;
      return all
        .filter((c) => c.kind === "scalar")
        .slice(0, 8)
        .map((c) => c.id);
    });
    expect(ids.length).toBeGreaterThan(0);

    await page.evaluate(
      ([panelId, channelIds]) => {
        const hooks = window.__drivelineDevHooks!;
        for (const id of channelIds as string[]) {
          hooks.addPlotChannelBinding(panelId as string, id);
        }
      },
      ["plot-1", ids],
    );

    const panel = page.getByTestId("plot-panel");
    await panel.waitFor();
    // Let the (re)built uPlot instance settle.
    await page.waitForTimeout(300);

    const over = await page.evaluate(() => {
      const el = document.querySelector(
        '[data-testid="plot-panel"]',
      ) as HTMLElement | null;
      if (!el) return null;
      return { sh: el.scrollHeight, ch: el.clientHeight };
    });
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "plot-legend-right.png"),
    });

    expect(over).not.toBeNull();
    // Allow a 1px rounding slack; the panel must not be scrollable.
    expect(over!.sh).toBeLessThanOrEqual(over!.ch + 1);
  });
});
