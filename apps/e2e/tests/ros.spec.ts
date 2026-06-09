// ROS1/ROS2 reader e2e — proves that dropping a ROS log file opens decoded
// channels that plot real numbers. Three committed fixtures are exercised:
//   - turtle.bag     ROS1 .bag (real turtlesim session, self-describing)
//   - synth_imu.mcap ROS2 MCAP with CDR-encoded sensor_msgs/Imu + Float64
//   - synth_imu.db3  ROS2 rosbag2 SQLite (same topics, typestore decode)
//
// The fixtures are NOT served by the dev server, so their bytes are read in
// Node with `fs` and handed to `page.evaluate`, mirroring lidar-pcd.spec.ts.
// Each test opens the file, asserts the expected ROS channel ids surface,
// binds a few scalar channels to the default plot panel ("plot-1"), polls the
// per-series stats until every bound series has decoded samples, sanity-checks
// the numeric range, and saves panel + full-page screenshots.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const FIXTURE_DIR = path.resolve(__dirname, "../../../test-fixtures/ros");

type Channel = {
  id: string;
  sourceId: string;
  name: string;
  kind: string;
  dtype: string | null;
  unit: string | null;
  sampleCount: number;
};

type SeriesStat = { channelId: string; min: number; max: number; count: number };

/** Read a committed fixture as a Uint8Array (Node side). */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** Drop one file's bytes into the app and assert it opened cleanly. */
async function openFixture(
  page: Page,
  name: string,
  bytes: Uint8Array,
): Promise<{ opened: string[]; errors: { name: string; reason: string }[] }> {
  const result = await page.evaluate(
    async ({ name, bytes }) =>
      window.__drivelineDevHooks!.openFiles([{ name, bytes }]),
    { name, bytes },
  );
  expect(
    result.errors,
    `openFiles(${name}) reported errors: ${JSON.stringify(result.errors)}`,
  ).toEqual([]);
  expect(result.opened, `opened should contain ${name}`).toContain(name);
  return result;
}

/** Enumerate channels via the dev hook. */
async function listChannels(page: Page): Promise<Channel[]> {
  return page.evaluate(
    () => window.__drivelineDevHooks!.listChannels() as unknown as Channel[],
  );
}

/** Bind ids to plot-1, then poll until every series has count > 0. */
async function bindAndAwaitStats(
  page: Page,
  ids: string[],
): Promise<SeriesStat[]> {
  await page.evaluate((ids) => {
    const h = window.__drivelineDevHooks!;
    for (const id of ids) h.addPlotChannelBinding("plot-1", id);
  }, ids);

  await expect
    .poll(
      async () => {
        const stats = await page.evaluate(
          () =>
            window.__drivelineDevHooks!.getPlotPanelSeriesStats(
              "plot-1",
            ) as unknown as SeriesStat[] | null,
        );
        if (!stats) return false;
        const bound = stats.filter((s) => ids.includes(s.channelId));
        return bound.length === ids.length && bound.every((s) => s.count > 0);
      },
      { timeout: 10_000, intervals: [100, 200, 400] },
    )
    .toBe(true);

  const stats = await page.evaluate(
    () =>
      window.__drivelineDevHooks!.getPlotPanelSeriesStats(
        "plot-1",
      ) as unknown as SeriesStat[] | null,
  );
  expect(stats).not.toBeNull();
  return stats!.filter((s) => ids.includes(s.channelId));
}

/** Find a channel whose id contains `needle`; throw with the full list if not. */
function findById(channels: Channel[], needle: string): Channel {
  const hit = channels.find((c) => c.id.includes(needle));
  if (!hit) {
    throw new Error(
      `no channel id containing "${needle}". Channels: ${JSON.stringify(
        channels.map((c) => c.id),
      )}`,
    );
  }
  return hit;
}

/** Snap the plot panel + full app for the report. */
async function shoot(page: Page, kind: string): Promise<void> {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const panel = page.getByTestId("plot-panel");
  await panel.waitFor();
  await page.waitForTimeout(300); // let uPlot paint a frame
  await panel.screenshot({ path: path.join(SCREENSHOT_DIR, `ros-${kind}.png`) });
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, `ros-${kind}-full.png`),
  });
}

test.describe("ROS readers", () => {
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

  test("ROS1 .bag (turtlesim) decodes pose/cmd_vel scalars", async ({
    page,
  }) => {
    await openFixture(page, "turtle.bag", readFixture("turtle.bag"));

    const channels = await listChannels(page);
    console.log(
      "[ros-bag] channels:\n" +
        channels.map((c) => `  ${c.id} (${c.kind})`).join("\n"),
    );

    const poseX = findById(channels, "/turtle1/pose.x");
    const cmdVelX = findById(channels, "/turtle1/cmd_vel.linear.x");
    const poseTheta = findById(channels, "/turtle1/pose.theta");

    const ids = [poseX.id, cmdVelX.id, poseTheta.id];
    const stats = await bindAndAwaitStats(page, ids);
    console.log("[ros-bag] series stats:", JSON.stringify(stats));

    const px = stats.find((s) => s.channelId === poseX.id)!;
    // turtlesim canvas runs ~0..11; allow generous slack.
    expect(px.min).toBeGreaterThan(-1);
    expect(px.max).toBeLessThan(12);
    expect(Number.isNaN(px.min) || Number.isNaN(px.max)).toBe(false);

    await shoot(page, "bag");
  });

  test("ROS2 .mcap (CDR) decodes IMU + temperature", async ({ page }) => {
    await openFixture(page, "synth_imu.mcap", readFixture("synth_imu.mcap"));

    const channels = await listChannels(page);
    console.log(
      "[ros-mcap] channels:\n" +
        channels.map((c) => `  ${c.id} (${c.kind})`).join("\n"),
    );

    const accelZ = findById(channels, "/imu/data.linear_acceleration.z");
    const gyroZ = findById(channels, "/imu/data.angular_velocity.z");
    const temp = findById(channels, "/temperature.data");

    const ids = [accelZ.id, gyroZ.id, temp.id];
    const stats = await bindAndAwaitStats(page, ids);
    console.log("[ros-mcap] series stats:", JSON.stringify(stats));

    const az = stats.find((s) => s.channelId === accelZ.id)!;
    expect(az.min).toBeGreaterThan(5); // gravity ≈ 9.81
    expect(az.max).toBeLessThan(15);

    const t = stats.find((s) => s.channelId === temp.id)!;
    expect(t.min).toBeGreaterThan(10);
    expect(t.max).toBeLessThan(30);

    await shoot(page, "mcap");
  });

  test("ROS2 .db3 (rosbag2 SQLite) decodes IMU + temperature", async ({
    page,
  }) => {
    await openFixture(page, "synth_imu.db3", readFixture("synth_imu.db3"));

    const channels = await listChannels(page);
    console.log(
      "[ros-db3] channels:\n" +
        channels.map((c) => `  ${c.id} (${c.kind})`).join("\n"),
    );

    const accelZ = findById(channels, "/imu/data.linear_acceleration.z");
    const gyroZ = findById(channels, "/imu/data.angular_velocity.z");
    const temp = findById(channels, "/temperature.data");

    const ids = [accelZ.id, gyroZ.id, temp.id];
    const stats = await bindAndAwaitStats(page, ids);
    console.log("[ros-db3] series stats:", JSON.stringify(stats));

    const az = stats.find((s) => s.channelId === accelZ.id)!;
    expect(az.min).toBeGreaterThan(5);
    expect(az.max).toBeLessThan(15);

    const t = stats.find((s) => s.channelId === temp.id)!;
    expect(t.min).toBeGreaterThan(10);
    expect(t.max).toBeLessThan(30);

    await shoot(page, "db3");
  });
});
