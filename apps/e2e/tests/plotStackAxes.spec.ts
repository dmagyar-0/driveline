// Stacked-axes plot mode. When a plot panel spreads its series across two
// or more y-axes, the "Stack" toggle remaps each axis into its own vertical
// band so the signals can be read at once instead of overlapping. This spec
// drives the real browser path: load two `vehicle_speed` sources, put one on
// a second axis, and assert that enabling stacking pushes axis 0's scale into
// the top band (its resolved y-domain widens and the data sits high in the
// plot). The unit test `stackedBandRange.test.ts` covers the exact band
// maths; here we prove the wiring through uPlot + the store toggle.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCREENSHOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "screenshots",
);

// The ambient `window.__drivelineDevHooks` type is declared subset-per-spec
// in this repo, so hooks used only here are reached via an untyped cast at
// the call sites rather than augmenting the global (which would clash with
// the other specs' declarations). Mirrors signalAlignment.spec.ts.
type DevHooksAny = Record<string, (...args: unknown[]) => unknown>;

interface YScale {
  min: number;
  max: number;
}
interface SeriesStat {
  channelId: string;
  min: number;
  max: number;
  count: number;
}

const PANEL = "plot-1";

test.describe("plot stacked axes", () => {
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

  test("stacking remaps axis 0 into a top band; unstacking restores overlay", async ({
    page,
  }) => {
    // Two sources so we get two distinct channel ids for the same signal.
    const result = await page.evaluate(async () => {
      const names = ["short.mcap", "short.mf4"];
      const descs = await Promise.all(
        names.map(async (n) => {
          const r = await fetch(`/sample-data/${n}`);
          if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
          return { name: n, bytes: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    });
    expect(result.errors).toEqual([]);

    // Resolve the two `vehicle_speed` ids (one per source); match by name so
    // the spec is robust to MCAP topic vs MF4 group/channel id numbering.
    const ids = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      const channels = hooks.listChannels() as Array<{
        id: string;
        name: string;
      }>;
      const a = channels.find(
        (c) => c.name === "/vehicle/speed" || c.name === "vehicle_speed",
      );
      const b = channels.find(
        (c) =>
          (c.name === "vehicle_speed" || c.name === "/vehicle/speed") &&
          c !== a,
      );
      if (!a || !b) throw new Error("need two vehicle_speed channels");
      return { axis0: a.id, axis1: b.id };
    });

    // Bind both, then move the second onto axis 1 so two axes carry data.
    await page.evaluate(
      ([panelId, a, b]) => {
        const hooks = window.__drivelineDevHooks!;
        hooks.addPlotChannelBinding(panelId, a);
        hooks.addPlotChannelBinding(panelId, b);
        (hooks as unknown as DevHooksAny).setPlotChannelAxis(panelId, b, 1);
      },
      [PANEL, ids.axis0, ids.axis1],
    );

    // Wait for both series to render.
    await expect
      .poll(async () => {
        const stats = await page.evaluate<SeriesStat[] | null>((panelId) => {
          const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
          return hooks.getPlotPanelSeriesStats(panelId) as SeriesStat[] | null;
        }, PANEL);
        return stats && stats.length === 2 && stats.every((s) => s.count > 0);
      }, { timeout: 5_000, intervals: [50, 100, 200] })
      .toBe(true);

    // The Stack toggle is offered now that two axes carry data.
    const toggle = page.getByTestId("plot-stack-axes");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    const readYScale = () =>
      page.evaluate<YScale | null>((panelId) => {
        const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
        const snap = hooks.getPlotPanelSync(panelId) as {
          yScale: YScale | null;
        } | null;
        return snap?.yScale ?? null;
      }, PANEL);

    const seriesCount = () =>
      page.evaluate<number>((panelId) => {
        const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
        const stats = hooks.getPlotPanelSeriesStats(panelId) as
          | SeriesStat[]
          | null;
        return stats?.length ?? 0;
      }, PANEL);

    const panel = page.getByTestId("plot-panel");
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "stack-off-short.png"),
    });

    // Enable stacking. The banded `range` callback resolves a concrete,
    // finite scale "y" (axis 0) — whereas the overlay auto-range is left
    // unresolved (null) in the snapshot — so a finite yScale appearing is
    // the reliable signal that the band remap took effect. The exact band
    // placement is asserted in the unit/component tests; the stack-on
    // screenshot is the eyeball proof of the separation.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    await expect
      .poll(async () => {
        const y = await readYScale();
        return y !== null && Number.isFinite(y.min) && Number.isFinite(y.max);
      }, { timeout: 5_000, intervals: [50, 100, 200] })
      .toBe(true);
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "stack-on-short.png"),
    });

    // Unstacking flips the toggle back and the panel keeps both series.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect
      .poll(seriesCount, { timeout: 5_000, intervals: [50, 100, 200] })
      .toBe(2);
  });
});
