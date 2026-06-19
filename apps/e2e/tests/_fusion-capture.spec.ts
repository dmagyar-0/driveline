// Visual capture of the nuScenes fusion dashboard (video + LiDAR-on-video
// overlay + 3D LiDAR scene + ego plots) during 1x playback, for eyeballing that
// every modality renders. Pairs with _fusion-frameloss.spec.ts (which proves
// 0 frame loss + <100ms lag numerically). Saves full-page PNGs to
// apps/e2e/tests/screenshots/.

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");

const REL = {
  lidar: "realworld/nuscenes.lidar.parquet",
  mp4: "realworld/nuscenes_cam_front.mp4",
  ts: "realworld/nuscenes_cam_front.mp4.timestamps",
  calib: "realworld/nuscenes_cam_front.calib.json",
  signals: "realworld/nuscenes.signals.mcap",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const CAMERA_NAME = "CAM_FRONT";
const VIDEO_PANEL = "video-overlay";
const SCENE_PANEL = "scene-lidar";
const PLOT_PANEL = "plot-ego";
const PLOT_SIGNALS = ["/ego/speed", "/ego/yaw_rate"];

test.use({ channel: "chrome", viewport: { width: 1600, height: 900 } });

async function seekToTs(page: Page, tsNs: bigint): Promise<void> {
  await page.evaluate((tgt) => {
    const range = window.__drivelineDevHooks!.getSessionSnapshot().globalRange!;
    const start = BigInt(range.startNs);
    const end = BigInt(range.endNs);
    const ratio = Number(BigInt(tgt) - start) / Number(end - start);
    const s = document.querySelector<HTMLElement>("[data-testid='scrubber']")!;
    const rect = s.getBoundingClientRect();
    const x = rect.left + rect.width * Math.min(1, Math.max(0, ratio));
    const y = rect.top + rect.height / 2;
    const o: PointerEventInit = {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    };
    s.dispatchEvent(new PointerEvent("pointerdown", o));
    s.dispatchEvent(new PointerEvent("pointerup", o));
  }, String(tsNs));
}

test.describe("nuScenes fusion — visual capture", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "nuScenes fixtures missing",
  );

  test("renders video + overlay + 3D scene + plots", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });

    const LAYOUT = {
      global: {
        tabEnableClose: false,
        tabEnableRename: false,
        splitterSize: 4,
        borderEnableAutoHide: true,
      },
      borders: [],
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 58,
            children: [
              {
                type: "tab",
                id: VIDEO_PANEL,
                name: "CAM_FRONT · LiDAR overlay",
                component: "video",
              },
            ],
          },
          {
            type: "row",
            weight: 42,
            children: [
              {
                type: "tabset",
                weight: 62,
                children: [
                  {
                    type: "tab",
                    id: SCENE_PANEL,
                    name: "LiDAR point cloud",
                    component: "scene",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 38,
                children: [
                  {
                    type: "tab",
                    id: PLOT_PANEL,
                    name: "Ego speed · yaw-rate",
                    component: "plot",
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    await page.evaluate(
      (j) => window.__drivelineDevHooks!.setLayoutJson(j),
      LAYOUT,
    );

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        Object.values(rels).map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, REL);
    expect(open.errors).toEqual([]);

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const video = channels.find((c) => c.kind === "video")!;
    const pc = channels.find((c) => c.kind === "point_cloud")!;
    const calib = channels.find((c) => c.kind === "camera_calibration")!;
    await page.evaluate(
      ([p, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(p, id),
      [VIDEO_PANEL, video.id] as const,
    );
    await page.evaluate(
      ([p, c, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(p, {
          calibrationChannelId: c,
          cameraName: cam,
          pointcloudChannelId: pcId,
        }),
      [VIDEO_PANEL, calib.id, pc.id, CAMERA_NAME] as const,
    );
    await page.evaluate(
      ([p, id]) => window.__drivelineDevHooks!.setSceneChannelBinding(p, id),
      [SCENE_PANEL, pc.id] as const,
    );
    const plotIds = PLOT_SIGNALS.map(
      (n) => channels.find((c) => c.name === n)!.id,
    );
    await page.evaluate(
      ([p, ...ids]) => {
        const h = window.__drivelineDevHooks!;
        ids.forEach((id, i) => {
          h.addPlotChannelBinding(p, id);
          if (i === 1) h.setPlotChannelAxis(p, id, 1);
        });
      },
      [PLOT_PANEL, ...plotIds] as const,
    );

    // Data window from the sidecar.
    const { start, end } = await page.evaluate(async () => {
      const r = await fetch(
        "/sample-data/realworld/nuscenes_cam_front.mp4.timestamps",
      );
      const ts = (await r.text())
        .trim()
        .split("\n")
        .map((l) => BigInt(l.split("\t")[1]));
      return { start: ts[0].toString(), end: ts[ts.length - 1].toString() };
    });
    const s = BigInt(start),
      e = BigInt(end);
    const at = (f: number) => s + BigInt(Math.round(Number(e - s) * f));

    // Tilt the 3D scene to a 3/4 view.
    try {
      const box = await page.getByTestId("scene-canvas-host").boundingBox();
      if (box) {
        const cx = box.x + box.width / 2,
          cy = box.y + box.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.down();
        await page.mouse.move(cx, cy - Math.round(box.height * 0.12), {
          steps: 12,
        });
        await page.mouse.up();
      }
    } catch {
      /* cosmetic */
    }

    // Land on a dense frame; wait for all modalities to have content.
    await seekToTs(page, at(0.55));
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getVideoOverlaySync(id)
                .projectedVisibleCount,
            VIDEO_PANEL,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getScenePanelSync(id)?.pointCount ??
              0,
            SCENE_PANEL,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(1000);
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const st = window.__drivelineDevHooks!.getPlotPanelSeriesStats(id);
            return (
              st !== null && st.length === 2 && st.every((x) => x.count > 0)
            );
          }, PLOT_PANEL),
        { timeout: 30_000 },
      )
      .toBe(true);
    await page.waitForTimeout(800);

    await page.screenshot({ path: path.join(SHOTS, "fusion-frame-dense.png") });

    // Capture during live playback: press play, grab a couple of frames.
    await page.getByTestId("play-pause").click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SHOTS, "fusion-playing-1.png") });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(SHOTS, "fusion-playing-2.png") });
    await page.getByTestId("play-pause").click();

    // Report the live HUD/overlay/scene/plot state at capture time.
    const stateNow = await page.evaluate(
      (ids) => {
        const h = window.__drivelineDevHooks!;
        const [vp, sp, pp] = ids;
        return {
          video: h.videoHudStats(),
          overlay: h.getVideoOverlaySync(vp),
          scene: h.getScenePanelSync(sp),
          plot: h.getPlotPanelSeriesStats(pp),
        };
      },
      [VIDEO_PANEL, SCENE_PANEL, PLOT_PANEL] as const,
    );
    console.log("CAPTURE_STATE " + JSON.stringify(stateNow));
  });
});
