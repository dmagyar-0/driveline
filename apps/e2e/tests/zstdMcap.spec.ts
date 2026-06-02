// Visual proof that driveline can read a zstd-compressed MCAP. Real-world
// MCAP files (Foxglove's testdata, ROS 2 default storage) almost always
// use chunk-level zstd compression. The lazy ranged `McapReader` in
// `crates/data-core/src/mcap.rs` decodes those chunks on demand with the
// pure-Rust `ruzstd` decoder, so they open and plot without pulling in the
// C `zstd-sys` library the wasm target can't link.
//
// This spec loads `sample-data/short.zstd.mcap` — same four-channel
// corpus as `short.mcap`, just with `CompressionType.ZSTD` chunks per
// `sample-data/generate.py::write_mcap` — through the `openFiles` dev
// hook, binds `/vehicle/speed` (foxglove.Float64) to a plot panel, and
// asserts the panel's series-stats snapshot matches `synth_speed`'s
// expected min/max. A screenshot drops to
// `screenshots/zstd-mcap-plot.png` for the human-eye "the line is a
// clean sine wave" check.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

type DevHooksAny = Record<string, (...args: unknown[]) => unknown>;

// `synth_speed(i) = sin(2π · (i / 100) / 2)` over 100 Hz × 10 s = 1000
// samples, exactly matching the assertions in `signalAlignment.spec.ts`
// (which consumes the uncompressed twin `short.mcap`). Exact min/max
// land on `sin(±π/2) = ±1.0`.
const SPEED_MIN_EXPECTED = -1.0;
const SPEED_MAX_EXPECTED = 1.0;
const SPEED_COUNT_EXPECTED = 1000;
const FP_TOL = 1e-9;

test.describe("zstd-compressed MCAP read + plot", () => {
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

  test("opens short.zstd.mcap and plots /vehicle/speed end-to-end", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.zstd.mcap");
      if (!r.ok) throw new Error(`fetch short.zstd.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.zstd.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);
    expect(result.opened).toHaveLength(1);

    // Resolve the /vehicle/speed channel id (MCAP uses the topic string).
    const speedId = await page.evaluate(() => {
      const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
      const channels = hooks.listChannels() as Array<{
        id: string;
        name: string;
        kind: string;
      }>;
      const speed = channels.find(
        (c) => c.name === "/vehicle/speed" && c.kind === "scalar",
      );
      if (!speed) {
        throw new Error(
          `/vehicle/speed not found among ${JSON.stringify(channels)}`,
        );
      }
      return speed.id;
    });

    await page.evaluate(
      ([panelId, id]) => {
        window.__drivelineDevHooks!.addPlotChannelBinding(panelId, id);
      },
      ["plot-1", speedId],
    );

    await expect
      .poll(
        async () => {
          const stats = await page.evaluate<
            Array<{
              channelId: string;
              min: number;
              max: number;
              count: number;
            }> | null
          >((panelId) => {
            const hooks = window.__drivelineDevHooks as unknown as DevHooksAny;
            return hooks.getPlotPanelSeriesStats(panelId) as Array<{
              channelId: string;
              min: number;
              max: number;
              count: number;
            }> | null;
          }, "plot-1");
          return stats && stats.length === 1 && stats[0].count > 0;
        },
        { timeout: 5_000, intervals: [50, 100, 200] },
      )
      .toBe(true);

    const stats = await page.evaluate<
      Array<{
        channelId: string;
        min: number;
        max: number;
        count: number;
      }> | null
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
    expect(stats!).toHaveLength(1);
    const s = stats![0];
    expect(s.channelId).toBe(speedId);
    expect(s.count).toBe(SPEED_COUNT_EXPECTED);
    expect(Math.abs(s.min - SPEED_MIN_EXPECTED)).toBeLessThan(FP_TOL);
    expect(Math.abs(s.max - SPEED_MAX_EXPECTED)).toBeLessThan(FP_TOL);

    const panel = page.getByTestId("plot-panel");
    await panel.waitFor();
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "zstd-mcap-plot.png"),
    });
  });
});
