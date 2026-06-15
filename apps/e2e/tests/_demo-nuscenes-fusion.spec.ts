// Ad-hoc visual DEMO recording for nuScenes — a camera + LiDAR *fusion*
// dashboard that shows the full set of capabilities Driveline can drive from
// the nuScenes converter's output (LIDAR_TOP point cloud + CAM_FRONT video +
// the LIDAR_TOP -> CAM_FRONT calibration):
//
//   - left  (58%): CAM_FRONT dashcam with the LiDAR point cloud projected onto
//                  the image via the calibration (point-cloud-on-video overlay)
//   - top-right  : the same LiDAR spin in the 3D Scene panel (orbit camera,
//                  turbo-coloured by intensity)
//   - bot-right  : a Plot panel of the ego signals (speed + yaw-rate) derived
//                  from the scene's ego_pose track
//
// NOTE: there is exactly ONE video panel on purpose. Two video panels bound to
// the *same* mp4 source contend for that source's single decoder, and the
// second one lags it by seconds (looks like a stuck/desynced camera). The repo
// pattern for two camera feeds is two separate files (see the comma2k19
// dashboard-record spec's hflipped second mp4); here the second right-hand slot
// is better spent on the signal plot anyway.
//
// It presses Play and lets the scene replay as one continuous take while
// Playwright records the page to a .webm, then pauses before the end and holds
// a hero frame.
//
// LICENCE: nuScenes is CC BY-NC-SA 4.0 (NonCommercial, ShareAlike). This
// recording is a derivative of that data, so a persistent on-screen credit
// banner is injected for the duration of the capture, and the produced video
// must be shared under the same licence with attribution (see the CREDITS file
// emitted alongside it). Use it to showcase the open-source tool only — not in
// any commercial/monetised context.
//
// Underscore prefix keeps this out of normal CI runs — invoke directly:
//   pnpm --filter e2e exec playwright test _demo-nuscenes-fusion.spec.ts
//
// Requires the four converter outputs copied into sample-data/realworld/ (the
// dir is gitignored except for README.md, so they never get committed):
//   nuscenes.lidar.parquet
//   nuscenes_cam_front.mp4 (+ .mp4.timestamps)
//   nuscenes_cam_front.calib.json
// Produce them with: python3 scripts/convert_nuscenes_to_driveline.py
// (see sample-data/realworld/README.md, "nuScenes" section).

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
const VIDEO_OVERLAY_PANEL = "video-overlay";
const SCENE_PANEL = "scene-lidar";
const PLOT_PANEL = "plot-ego";
// Ego signals to plot (derived by convert_nuscenes_signals_to_mcap.py). Speed
// (m/s) and yaw-rate (deg/s) sit on separate y-axes and tell the scene's story:
// the dip + heading swing as the car slows and turns through the intersection.
const PLOT_SIGNALS = ["/ego/speed", "/ego/yaw_rate"];

test.use({
  video: { mode: "on", size: { width: 1600, height: 900 } },
  viewport: { width: 1600, height: 900 },
});

// Seek to an ABSOLUTE timestamp by clicking the scrubber at the matching
// fraction of the global range. An absolute target (not a fixed ratio) is
// required because the calibration channel is a static config at ts 0, which
// pulls the global range start down to 0 while the real nuScenes data sits ~18
// digits up the timeline — a ratio of the whole range would land far from it.
async function seekToTs(page: Page, tsNs: bigint): Promise<void> {
  await page.evaluate((tgt) => {
    const range = window.__drivelineDevHooks!.getSessionSnapshot().globalRange;
    if (!range) throw new Error("no global range");
    const start = BigInt(range.startNs);
    const end = BigInt(range.endNs);
    const ratio = Number(BigInt(tgt) - start) / Number(end - start);
    const scrubber = document.querySelector<HTMLElement>(
      "[data-testid='scrubber']",
    );
    if (!scrubber) throw new Error("scrubber not found");
    const rect = scrubber.getBoundingClientRect();
    const x = rect.left + rect.width * Math.min(1, Math.max(0, ratio));
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
  }, String(tsNs));
}

// The data window from the mp4 sidecar (one `<frame>\t<ts_ns>` line per frame).
async function dataWindow(page: Page): Promise<{ start: bigint; end: bigint }> {
  const text = await page.evaluate(async () => {
    const r = await fetch("/sample-data/realworld/nuscenes_cam_front.mp4.timestamps");
    if (!r.ok) throw new Error(`sidecar fetch: ${r.status}`);
    return await r.text();
  });
  const ts = text
    .trim()
    .split("\n")
    .map((l) => BigInt(l.split("\t")[1]));
  return { start: ts[0], end: ts[ts.length - 1] };
}

async function setPlaying(page: Page, want: boolean): Promise<void> {
  const playPause = page.getByTestId("play-pause");
  for (let attempt = 0; attempt < 3; attempt++) {
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (playing === want) return;
    await playPause.click();
    await page.waitForTimeout(150);
  }
}

// A persistent, non-interactive attribution + licence banner so the recording
// itself carries the CC BY-NC-SA 4.0 credit, plus a full-screen title card that
// covers the (multi-second) point-cloud load so the capture never shows the
// empty "no session" splash. The card is removed explicitly once content is
// ready (not on a timer), so the load is always hidden behind it.
async function installCreditBanner(page: Page): Promise<void> {
  await page.evaluate(() => {
    const banner = document.createElement("div");
    banner.id = "nuscenes-credit";
    Object.assign(banner.style, {
      position: "fixed",
      left: "0",
      right: "0",
      bottom: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      font: "12px/1.4 system-ui, sans-serif",
      color: "#e6e6e6",
      background: "rgba(0,0,0,0.55)",
      padding: "4px 10px",
      textAlign: "center",
      letterSpacing: "0.02em",
    } as CSSStyleDeclaration);
    banner.textContent =
      "Driveline — open-source multimodal log viewer  ·  " +
      "Data: nuScenes v1.0-mini (scene-0061) © Motional, " +
      "licensed CC BY-NC-SA 4.0  ·  non-commercial demo";
    document.body.appendChild(banner);
  });
}

async function showTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.createElement("div");
    card.id = "nuscenes-title";
    Object.assign(card.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      pointerEvents: "none",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: "14px",
      background: "#0a0c10",
      color: "#fff",
      font: "600 40px/1.2 system-ui, sans-serif",
      textAlign: "center",
      transition: "opacity 0.8s ease",
    } as CSSStyleDeclaration);
    card.innerHTML =
      "<div>Driveline · Camera + LiDAR fusion</div>" +
      "<div style='font:400 20px/1.4 system-ui,sans-serif;opacity:0.85'>" +
      "nuScenes dashcam · 3D point cloud · point-cloud-on-camera overlay" +
      "</div>";
    document.body.appendChild(card);
  });
}

async function hideTitleCard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const card = document.getElementById("nuscenes-title");
    if (!card) return;
    card.style.opacity = "0";
    setTimeout(() => card.remove(), 900);
  });
  await page.waitForTimeout(1000);
}

test.describe("nuScenes camera + LiDAR fusion demo", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "nuScenes fixtures missing in sample-data/realworld/ — run " +
      "scripts/convert_nuscenes_to_driveline.py and copy the four outputs " +
      "there (see the spec header).",
  );

  test("records a fusion dashboard replay", async ({ page }) => {
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

    // Big overlay video on the left; 3D scene over raw dashcam on the right.
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
                id: VIDEO_OVERLAY_PANEL,
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
                weight: 55,
                children: [
                  {
                    type: "tab",
                    id: SCENE_PANEL,
                    name: "LiDAR point cloud (LIDAR_TOP)",
                    component: "scene",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 45,
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
      (json) => window.__drivelineDevHooks!.setLayoutJson(json),
      LAYOUT,
    );

    // Title card up *before* the load so the multi-second point-cloud open is
    // hidden behind it (no empty splash in the capture).
    await installCreditBanner(page);
    await showTitleCard(page);
    await page.waitForTimeout(2200);

    // Open the four converter outputs as one drop (mp4 + sidecar pair = one
    // source, so this is 3 sources: video, point cloud, calibration).
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

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const video = channels.find((c) => c.kind === "video");
    const pointcloud = channels.find((c) => c.kind === "point_cloud");
    const calibration = channels.find((c) => c.kind === "camera_calibration");
    expect(video, "video channel").toBeTruthy();
    expect(pointcloud, "point_cloud channel").toBeTruthy();
    expect(calibration, "camera_calibration channel").toBeTruthy();

    // Wire the overlay video panel: camera feed + the projected point cloud.
    await page.evaluate(
      ([pid, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_OVERLAY_PANEL, video!.id] as const,
    );
    await page.evaluate(
      ([pid, calibId, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(pid, {
          calibrationChannelId: calibId,
          cameraName: cam,
          pointcloudChannelId: pcId,
        }),
      [VIDEO_OVERLAY_PANEL, calibration!.id, pointcloud!.id, CAMERA_NAME] as const,
    );

    // The 3D scene panel: the raw LiDAR spin.
    await page.evaluate(
      ([pid, id]) =>
        window.__drivelineDevHooks!.setSceneChannelBinding(pid, id),
      [SCENE_PANEL, pointcloud!.id] as const,
    );

    // The plot panel: the ego signals from the MCAP, bound by topic name.
    const plotIds = PLOT_SIGNALS.map((name) => {
      const ch = channels.find((c) => c.name === name);
      if (!ch) throw new Error(`signal channel not found: ${name}`);
      return ch.id;
    });
    await page.evaluate(
      ([pid, ...ids]) => {
        const h = window.__drivelineDevHooks!;
        for (const id of ids) h.addPlotChannelBinding(pid, id);
      },
      [PLOT_PANEL, ...plotIds] as const,
    );

    // Land near the start and prove the overlay + scene have real content
    // before we start the replay.
    const { start, end } = await dataWindow(page);
    const at = (f: number): bigint =>
      start + BigInt(Math.round(Number(end - start) * f));
    await seekToTs(page, at(0.04));
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getVideoOverlaySync(id)
                .projectedVisibleCount,
            VIDEO_OVERLAY_PANEL,
          ),
        { timeout: 30_000, intervals: [300, 600, 1000] },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getScenePanelSync(id)?.pointCount ?? 0,
            SCENE_PANEL,
          ),
        { timeout: 30_000, intervals: [300, 600, 1000] },
      )
      .toBeGreaterThan(1000);
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const s = window.__drivelineDevHooks!.getPlotPanelSeriesStats(id);
            return s !== null && s.length === 2 && s.every((x) => x.count > 0);
          }, PLOT_PANEL),
        { timeout: 30_000, intervals: [300, 600, 1000] },
      )
      .toBe(true);

    // Content is ready behind the card — reveal the loaded dashboard.
    await hideTitleCard(page);
    await page.waitForTimeout(1200);

    // One clean continuous pass with real playback: press Play and let the
    // dashcam, overlay, 3D cloud, and plot cursor all advance together as a
    // single take. (This used to sawtooth — the cursor jumped back to the play
    // origin again and again — because the decode-aware gate re-anchored only
    // the wall clock when it engaged mid-play; fixed in timeline/playback.ts so
    // a hold/release resumes forward from the live cursor.) The decode gate may
    // still briefly hold the cursor while the 4K frames catch up, so ~16 s of
    // wall time covers most of the ~19 s scene without ever reaching the very
    // end — we PAUSE before the LiDAR's last spin, which sits ~35 ms past the
    // final camera frame (that frame has no video → "no video at this time").
    await seekToTs(page, at(0.02));
    await setPlaying(page, true);
    await page.waitForTimeout(16000);
    await setPlaying(page, false);
    await page.waitForTimeout(400);

    // Finish on a strong mid-scene hero frame.
    await seekToTs(page, at(0.5));
    await page.waitForTimeout(2200);
  });
});
