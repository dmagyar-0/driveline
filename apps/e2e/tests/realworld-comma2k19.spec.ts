// End-to-end smoke for a real-world ADAS dataset (comma2k19).
//
// `scripts/convert_comma2k19_to_mcap.py` produces
// `sample-data/realworld/comma2k19.mcap` from the public
// huggingface.co/datasets/commaai/comma2k19 demo parquet (1.26 MB,
// ~38 k messages, 60 s of California highway driving).
//
// This spec proves the file loads through Driveline's existing MCAP
// reader, channels are inferred correctly, and PlotPanel renders real
// per-series stats (count > 0, plausible min/max).

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const MCAP_REL = "realworld/comma2k19.mcap";
const MCAP_ABS = path.resolve(__dirname, "../../../sample-data", MCAP_REL);

test.describe("real-world ADAS dataset (comma2k19)", () => {
  test.skip(
    !existsSync(MCAP_ABS),
    `comma2k19 fixture missing: ${MCAP_ABS} — run \`python3 scripts/convert_comma2k19_to_mcap.py\``,
  );

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

  test("opens, infers channels, and plots speed + IMU", async ({ page }) => {
    const result = await page.evaluate(async (rel) => {
      const r = await fetch(`/sample-data/${rel}`);
      if (!r.ok) throw new Error(`fetch mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "comma2k19.mcap", bytes },
      ]);
    }, MCAP_REL);
    expect(result.errors).toEqual([]);
    expect(result.opened).toHaveLength(1);

    const channels = await page.evaluate(() => {
      return window.__drivelineDevHooks!.listChannels();
    });

    // Topics emitted by the converter — see scripts/convert_comma2k19_to_mcap.py.
    // wheel_speed_rr is registered lazily by the converter only when
    // the upstream parquet actually ships a 4-element wheel-speed
    // vector; comma2k19's demo parquet does, so the channel is
    // expected here and carries real (non-synthesised) RR samples.
    const byTopic = new Map(channels.map((c) => [c.name, c]));
    for (const topic of [
      "/vehicle/speed",
      "/vehicle/steering_angle",
      "/vehicle/wheel_speed_fl",
      "/vehicle/wheel_speed_fr",
      "/vehicle/wheel_speed_rl",
      "/vehicle/wheel_speed_rr",
      "/imu/accel",
      "/imu/gyro",
      "/gnss/ublox",
    ]) {
      const ch = byTopic.get(topic);
      expect(ch, `missing topic ${topic}`).toBeDefined();
    }

    const speed = byTopic.get("/vehicle/speed")!;
    const steer = byTopic.get("/vehicle/steering_angle")!;
    const accel = byTopic.get("/imu/accel")!;
    const gnss = byTopic.get("/gnss/ublox")!;

    // Schema-driven kind inference. foxglove.Float64 → scalar, Vector3 → vector.
    expect(speed.kind).toBe("scalar");
    expect(steer.kind).toBe("scalar");
    expect(accel.kind).toBe("vector");
    expect(gnss.kind).toBe("vector");

    // Real-world counts (one CA-280 segment, ~60 s):
    //   speed  ~80 Hz × 60 s ~= 4 973
    //   accel ~110 Hz × 60 s ~= 6 614
    expect(speed.sampleCount).toBeGreaterThan(4_000);
    expect(accel.sampleCount).toBeGreaterThan(6_000);

    // Bind both scalars to the SAME plot panel. The two CAN signals
    // come from different mailboxes, so their timestamps interleave
    // rather than coincide. `mergeSeries` therefore emits `null` for
    // every union row where the other channel has a sample. With the
    // pre-fix `spanGaps:false` this collapsed each trace to invisible
    // 1-pixel dots; with `spanGaps:true` (PlotPanel.tsx series opts)
    // each trace is connected through its own samples and both lines
    // render normally.
    await page.evaluate(
      ([panelId, speedId, steerId]) => {
        const hooks = window.__drivelineDevHooks!;
        hooks.addPlotChannelBinding(panelId, speedId);
        hooks.addPlotChannelBinding(panelId, steerId);
      },
      ["plot-1", speed.id, steer.id],
    );

    await expect
      .poll(
        async () => {
          const stats = await page.evaluate(
            (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
            "plot-1",
          );
          return (
            stats &&
            stats.length === 2 &&
            stats.every((s) => s.count > 0)
          );
        },
        { timeout: 10_000, intervals: [100, 200, 500] },
      )
      .toBe(true);

    const stats = (await page.evaluate(
      (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p)!,
      "plot-1",
    )) as Array<{ channelId: string; min: number; max: number; count: number }>;

    // Highway driving on the 280: speed range ~25–35 m/s (90–125 km/h).
    const speedStats = stats.find((s) => s.channelId === speed.id)!;
    expect(speedStats.count).toBeGreaterThan(4_000);
    expect(speedStats.min).toBeGreaterThan(0);
    expect(speedStats.max).toBeGreaterThan(20);
    expect(speedStats.max).toBeLessThan(60);

    // Steering wheel angle in degrees on this CAN bus. Highway driving
    // means small lane corrections — well within ±90°.
    const steerStats = stats.find((s) => s.channelId === steer.id)!;
    expect(steerStats.count).toBeGreaterThan(4_000);
    expect(Math.abs(steerStats.min)).toBeLessThan(90);
    expect(Math.abs(steerStats.max)).toBeLessThan(90);

    // Two animation frames so uPlot's bound canvas paints the freshly
    // fetched 60 s of data — without the wait, the chips and axes are
    // up but the line layer is still empty.
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    await page.waitForTimeout(800);

    const panel = page.getByTestId("plot-panel");
    await expect(panel).toHaveCount(1);
    await panel.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-multi-channel.png"),
    });

    // Whole-app screenshot for the report.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-full.png"),
      fullPage: true,
    });
  });
});
