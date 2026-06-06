// One-off visual-verification spec for a SECOND real-world source: KITTI
// raw drive 2011_09_26_drive_0001 (OXTS GPS/IMU + image_02 dashcam).
//
// Mirrors the two comma2k19 screenshot tests but proves the same pipeline
// works on a different dataset, so visual verification isn't always run
// against comma2k19. Fixtures built by the /tmp/kitti converters into
// sample-data/realworld/ (gitignored):
//   kitti.mcap   foxglove.Float64/Vector3 (speed, yaw_rate, accel, gyro, gnss)
//   kitti.mf4    Speed/YawRate + IMU + GNSS scalar channels
//   kitti_image02.mp4 (+ .mp4.timestamps)  108 frames @ ~10 fps H.264
//
// Run: pnpm --filter e2e exec playwright test _demo-kitti-video.spec.ts \
//        --project=chromium --reporter=list

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = {
  mcap: "realworld/kitti.mcap",
  mf4: "realworld/kitti.mf4",
  mp4: "realworld/kitti_image02.mp4",
  ts: "realworld/kitti_image02.mp4.timestamps",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const VIDEO_PANEL_ID = "video-1";
const PLOT_PANEL_ID = "plot-1";
const VIDEO_SOURCE_NAME = "kitti_image02.mp4";
const VIDEO_NATIVE_ID = "1/video";

async function seekToOneThirdOfRange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const range = window
      .__drivelineDevHooks!.getSessionSnapshot()
      .globalRange!;
    const start = BigInt(range.startNs);
    const end = BigInt(range.endNs);
    const target = start + (end - start) / 3n;
    const scrubber = document.querySelector<HTMLElement>(
      "[data-testid='scrubber']",
    );
    if (!scrubber) throw new Error("scrubber not found");
    const rect = scrubber.getBoundingClientRect();
    const ratio = Number(target - start) / Number(end - start);
    const x = rect.left + rect.width * ratio;
    const y = rect.top + rect.height / 2;
    const opts: PointerEventInit = {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    };
    scrubber.dispatchEvent(new PointerEvent("pointerdown", opts));
    scrubber.dispatchEvent(new PointerEvent("pointerup", opts));
  });
}

async function waitForVideoFrame(page: Page): Promise<void> {
  await page.getByTestId("video-panel-canvas").waitFor();
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => window.__drivelineDevHooks!.videoLastBlitPtsNs(),
        ),
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .not.toBeNull();
}

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

async function paintAndSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.waitForTimeout(800);
}

test.describe("KITTI dashcam + OXTS", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "KITTI fixtures missing — build them into sample-data/realworld/",
  );

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error("console:", m.text());
    });
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("renders dashcam frame alongside speed + yaw-rate plot", async ({
    page,
  }) => {
    const rels = { mcap: REL.mcap, mp4: REL.mp4, ts: REL.ts };
    const open = await page.evaluate(async (r) => {
      const descs = await Promise.all(
        Object.values(r).map(async (rel) => {
          const res = await fetch(`/sample-data/${rel}`);
          if (!res.ok) throw new Error(`fetch ${rel}: ${res.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await res.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, rels);
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining(["kitti.mcap", "kitti_image02.mp4"]),
    );

    const videoChId = await page.evaluate(
      ({ sourceName, nativeId }) =>
        window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
      { sourceName: VIDEO_SOURCE_NAME, nativeId: VIDEO_NATIVE_ID },
    );
    expect(videoChId, "video channel must resolve").not.toBeNull();
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_PANEL_ID, videoChId!],
    );

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const byName = new Map(channels.map((c) => [c.name, c]));
    const speed = byName.get("/vehicle/speed")!;
    const yaw = byName.get("/vehicle/yaw_rate")!;
    expect(speed, "/vehicle/speed channel").toBeTruthy();
    expect(yaw, "/vehicle/yaw_rate channel").toBeTruthy();
    await page.evaluate(
      ([panelId, sId, yId]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, sId);
        h.addPlotChannelBinding(panelId, yId);
      },
      [PLOT_PANEL_ID, speed.id, yaw.id],
    );

    await seekToOneThirdOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "kitti-video-plus-signals.png"),
    });
  });

  test("renders cross-source plot from MCAP and MF4 together", async ({
    page,
  }) => {
    test.skip(!existsSync(ABS.mf4), "kitti.mf4 missing");

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
    expect(open.opened).toEqual(
      expect.arrayContaining(["kitti.mcap", "kitti.mf4", "kitti_image02.mp4"]),
    );

    const videoChId = await page.evaluate(
      ({ sourceName, nativeId }) =>
        window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
      { sourceName: VIDEO_SOURCE_NAME, nativeId: VIDEO_NATIVE_ID },
    );
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_PANEL_ID, videoChId!],
    );

    const all = await page.evaluate(() =>
      window
        .__drivelineDevHooks!.listChannels()
        .map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    );
    const sourceNames = await page.evaluate(() =>
      Object.fromEntries(
        window.__drivelineDevHooks!.listSources().map((s) => [s.id, s.name]),
      ),
    );
    const find = (sourceMatch: RegExp, name: string) =>
      all.find(
        (c) =>
          c.name === name && sourceMatch.test(sourceNames[c.sourceId] ?? ""),
      );

    // /vehicle/speed comes from the MCAP; Speed (same vf forward velocity)
    // comes from the MF4. Plotting both on one panel proves the
    // cross-source merge ran — the two lines overlay because they are the
    // same physical signal routed through two different file formats.
    const mcapSpeed = find(/\.mcap/, "/vehicle/speed");
    const mf4Speed = find(/\.mf4/, "Speed");
    expect(mcapSpeed, "MCAP /vehicle/speed").toBeDefined();
    expect(mf4Speed, "MF4 Speed").toBeDefined();

    await page.evaluate(
      ([panelId, a, b]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, a);
        h.addPlotChannelBinding(panelId, b);
      },
      [PLOT_PANEL_ID, mcapSpeed!.id, mf4Speed!.id],
    );

    await seekToOneThirdOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    const stats = await page.evaluate(
      (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
      PLOT_PANEL_ID,
    );
    expect(stats).not.toBeNull();
    const seen = new Set(stats!.map((s) => s.channelId));
    expect(seen.has(mcapSpeed!.id)).toBe(true);
    expect(seen.has(mf4Speed!.id)).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "kitti-mcap-plus-mf4.png"),
    });
  });
});
