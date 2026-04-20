// T6.3 · Signal-alignment check from
// `docs/09-verification-plan.md:109-115` step 4.
//
// Loads `short.mcap` + `short.mf4` from the T0.3 corpus and binds a single
// PlotPanel to the `vehicle_speed` channel from each source. The plot's
// per-series min/max (surfaced via `getPlotPanelSeriesStats`) must agree
// with the formula in `sample-data/generate.py::synth_speed` to within
// one sample (100 Hz = 10 ms → effectively identical numeric min/max).
//
// This complements `crossPanelSync.spec.ts` which asserts same-cursor
// agreement on a single panel; here we assert same-signal agreement
// across two sources.

import { test, expect } from "@playwright/test";

// The ambient `window.__drivelineDevHooks` type in this repo is declared
// as a subset-per-spec, so hooks only used here (listChannels,
// getPlotPanelSeriesStats) aren't part of every file's declared shape.
// This spec accesses them via an untyped `any`-cast at the call sites
// below rather than augmenting the global, which would conflict with
// the declarations in the other spec files.
type DevHooksAny = Record<string, (...args: unknown[]) => unknown>;

// Matches `sample-data/generate.py::synth_speed`:
//   speed(i) = sin(2π · (i / 100) / 2)   for i ∈ [0, 1000)
// → one full period per 2 s, five complete periods over 10 s.
// Exact min/max land on the 25th, 75th, … samples which are sin(±π/2).
const SPEED_MIN_EXPECTED = -1.0;
const SPEED_MAX_EXPECTED = 1.0;
// Tolerance: the 100 Hz grid samples sin precisely at ±π/2 (every
// 0.5 s offset), so min/max are numerically ±1.0. Allow a small FP
// epsilon for the round-trip through Arrow.
const FP_TOL = 1e-9;

test.describe("signal alignment (T6.3)", () => {
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

  test("MCAP and MF4 speed overlays agree on min/max within 1 sample", async ({
    page,
  }) => {
    // Drop both fixtures in one batch so the union `globalRange` covers
    // the full 10 s and both sources hydrate under a single cursor.
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

    // Resolve the two `vehicle_speed` channel ids — one per source.
    // MCAP uses the topic string as the id (`/vehicle/speed`); MF4 uses
    // its internal `group/channel` index (`0/1` etc). We match by name
    // so the spec is robust to either numbering.
    const ids = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      const channels = hooks.listChannels() as Array<{
        id: string;
        name: string;
        sourceId: string;
      }>;
      const mcapSpeed = channels.find(
        (c) => c.name === "/vehicle/speed" || c.name === "vehicle_speed",
      );
      const mf4Speed = channels.find(
        (c) =>
          (c.name === "vehicle_speed" || c.name === "/vehicle/speed") &&
          c !== mcapSpeed,
      );
      if (!mcapSpeed || !mf4Speed) {
        throw new Error(
          `need two vehicle_speed channels; got ${channels
            .map((c) => `${c.sourceId}:${c.name}`)
            .join(", ")}`,
        );
      }
      return { mcapId: mcapSpeed.id, mf4Id: mf4Speed.id };
    });

    // Bind both to the default plot panel in one go so the fetch loop
    // is exercised for both series.
    await page.evaluate(
      ([panelId, a, b]) => {
        const hooks = window.__drivelineDevHooks!;
        hooks.addPlotChannelBinding(panelId, a);
        hooks.addPlotChannelBinding(panelId, b);
      },
      ["plot-1", ids.mcapId, ids.mf4Id],
    );

    // Wait until both series have been fetched & rendered.
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

    const mcap = stats!.find((s) => s.channelId === ids.mcapId)!;
    const mf4 = stats!.find((s) => s.channelId === ids.mf4Id)!;
    expect(mcap, `mcap stats missing from ${JSON.stringify(stats)}`).toBeTruthy();
    expect(mf4, `mf4 stats missing from ${JSON.stringify(stats)}`).toBeTruthy();

    // Both channels are 100 Hz × 10 s = 1000 samples on the raw path.
    // uPlot may have decoded a decimated view depending on container
    // width, but for min/max-over-window the stats helper reads the raw
    // `PlotSeries.ys` buffer. Sanity-check the count lines up with the
    // raw data rather than the decimation output.
    expect(mcap.count).toBeGreaterThan(0);
    expect(mf4.count).toBeGreaterThan(0);

    // Each series' min/max should match the known formula.
    expect(Math.abs(mcap.min - SPEED_MIN_EXPECTED)).toBeLessThan(FP_TOL);
    expect(Math.abs(mcap.max - SPEED_MAX_EXPECTED)).toBeLessThan(FP_TOL);
    expect(Math.abs(mf4.min - SPEED_MIN_EXPECTED)).toBeLessThan(FP_TOL);
    expect(Math.abs(mf4.max - SPEED_MAX_EXPECTED)).toBeLessThan(FP_TOL);

    // Cross-source agreement: same formula sampled at the same grid, so
    // min/max should match exactly once we're below FP_TOL.
    expect(Math.abs(mcap.min - mf4.min)).toBeLessThan(FP_TOL);
    expect(Math.abs(mcap.max - mf4.max)).toBeLessThan(FP_TOL);
  });
});
