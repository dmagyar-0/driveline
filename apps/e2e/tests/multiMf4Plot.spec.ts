// Regression test for multi-MF4 plot binding: when two MF4 files are
// loaded, both contain channels with the same wasm-internal ids
// (`{group}/{channel}`). Without source-qualified channel ids, the
// PlotPanel's `channelMap` collapsed both channels into one entry and
// the picker / fetch loop silently picked the wrong source.
//
// The visual proof lives in the screenshots dropped alongside this
// spec at `screenshots/multi-mf4-{before,after}.png`. Functional
// proof: bind `vehicle_speed` from each of two copies of `short.mf4`
// to a single plot panel, then assert that the PlotSyncSnapshot
// contains two distinct series (one per source).
//
// The two channels share the same `name`, but the bound IDs must be
// different — otherwise the PlotPanel would only render one series.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

type DevHooksAny = Record<string, (...args: unknown[]) => unknown>;

test.describe("multi-MF4 plot binding", () => {
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

  test("two MF4 sources expose distinct channel ids on the same name", async ({
    page,
  }) => {
    // Drop the same MF4 twice. The store's `uniqueSourceId` differentiates
    // the two SourceMeta records by name (`short.mf4`, `short.mf4 (2)`),
    // but per-source `Channel.id` values must also be distinct so plot
    // bindings do not collide.
    const result = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mf4");
      if (!r.ok) throw new Error(`fetch mf4: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mf4", bytes },
        { name: "short.mf4", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);
    expect(result.opened).toHaveLength(2);

    const channels = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      return hooks.listChannels() as Array<{
        id: string;
        name: string;
        sourceId: string;
        kind: string;
      }>;
    });

    const speeds = channels.filter(
      (c) => c.name === "vehicle_speed" && c.kind === "scalar",
    );
    expect(
      speeds,
      `expected two vehicle_speed channels, got ${JSON.stringify(channels)}`,
    ).toHaveLength(2);
    // Source ids differ (uniqueSourceId(...) appends "(2)") and channel
    // ids must be globally unique once the bug is fixed.
    expect(speeds[0].sourceId).not.toBe(speeds[1].sourceId);
    expect(speeds[0].id).not.toBe(speeds[1].id);
  });

  test("plot panel renders both series when bound to same-named channels from two MF4s", async ({
    page,
  }) => {
    const open = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mf4");
      if (!r.ok) throw new Error(`fetch mf4: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mf4", bytes },
        { name: "short.mf4", bytes },
      ]);
    });
    expect(open.errors).toEqual([]);

    const ids = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      const all = hooks.listChannels() as Array<{
        id: string;
        name: string;
        sourceId: string;
        kind: string;
      }>;
      const speeds = all
        .filter((c) => c.name === "vehicle_speed" && c.kind === "scalar")
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
      return { a: speeds[0].id, b: speeds[1].id };
    });

    await page.evaluate(
      ([panelId, a, b]) => {
        const hooks = window.__drivelineDevHooks!;
        hooks.addPlotChannelBinding(panelId, a);
        hooks.addPlotChannelBinding(panelId, b);
      },
      ["plot-1", ids.a, ids.b],
    );

    // The panel snapshot exposes per-series stats keyed by the bound
    // channel id. Both ids must show up with non-zero sample counts —
    // which can only happen if `channelMap` retained both channels.
    await expect
      .poll(
        async () => {
          const stats = await page.evaluate<
            Array<{ channelId: string; min: number; max: number; count: number }> | null
          >((panelId) => {
            const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
            return hooks.getPlotPanelSeriesStats(panelId) as Array<{
              channelId: string;
              min: number;
              max: number;
              count: number;
            }> | null;
          }, "plot-1");
          return stats && stats.length === 2 && stats.every((s) => s.count > 0);
        },
        { timeout: 5_000, intervals: [50, 100, 200] },
      )
      .toBe(true);

    const stats = await page.evaluate<
      Array<{ channelId: string; min: number; max: number; count: number }> | null
    >((panelId) => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      return hooks.getPlotPanelSeriesStats(panelId) as Array<{
        channelId: string;
        min: number;
        max: number;
        count: number;
      }> | null;
    }, "plot-1");
    expect(stats).not.toBeNull();
    expect(stats!).toHaveLength(2);
    const seenIds = new Set(stats!.map((s) => s.channelId));
    expect(seenIds.has(ids.a)).toBe(true);
    expect(seenIds.has(ids.b)).toBe(true);

    // Snap a screenshot of the panel for visual confirmation. Both
    // legend chips should appear; with the bug only one ever did.
    const panel = page.getByTestId("plot-panel");
    await panel.waitFor();
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "multi-mf4-after.png"),
    });
    const chipCount = await page
      .getByTestId("plot-chips")
      .locator('[data-testid^="chip-"]')
      .count();
    expect(chipCount).toBe(2);
  });
});
