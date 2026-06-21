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
// It presses Play and lets the scene replay as ONE continuous take while
// Playwright records the page to a .webm, then pauses and holds on the frame
// playback stopped on. There is deliberately no backward "hero" re-seek at the
// end: seeking backward flushes the video decoder and flashes black until the
// next keyframe, which would cut the take in two. The take is a single
// uninterrupted forward play with no cut to black.
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
// itself carries the CC BY-NC-SA 4.0 credit. (There is deliberately no
// full-screen title card: the demo opens straight into the live dashboard and
// the produced video shows only the scene playing — the multi-second
// point-cloud load that happens before playback is trimmed off in
// post-processing using the play-start marker the spec logs, see the README.)
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
                weight: 62,
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
      (json) => window.__drivelineDevHooks!.setLayoutJson(json),
      LAYOUT,
    );

    // Persistent licence/attribution banner (no title card — the finished
    // video opens straight on the live dashboard playing).
    await installCreditBanner(page);
    // Hide the dev-only video stats strip + perf HUD so they never leak into
    // the capture (advisory overlays, not part of the product story).
    await page.evaluate(() => {
      const s = document.createElement("style");
      s.textContent =
        '[data-testid="video-stats"],[data-testid="video-hud"]{display:none !important}';
      document.head.appendChild(s);
    });
    // Wall-clock origin of the recording. The point-cloud load + panel wiring +
    // density sweep below all happen before playback; we log the elapsed ms at
    // the moment Play is pressed so post-processing can trim everything before
    // it and keep only the scene playing.
    const recordStart = Date.now();

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
        ids.forEach((id, i) => {
          h.addPlotChannelBinding(pid, id);
          // yaw-rate (2nd signal) on its own y-axis so the turn spike pops
          // instead of being flattened onto the speed scale.
          if (i === 1) h.setPlotChannelAxis(pid, id, 1);
        });
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

    // Tilt the 3D scene off its near-top-down default toward a volumetric
    // 3/4 view (cosmetic for the capture). Drag on the scene canvas content —
    // never the tab header — so FlexLayout treats it as an orbit, not a move.
    // The renderer maps drag dy → camera elevation (`el += dy*0.006`, with
    // eye.z = dist*sin(el)); the default el≈0.5 rad (~29° above horizon). Drag
    // *up* (negative dy) to LOWER the elevation toward the horizon so the LiDAR
    // rings open into ellipses and vertical structure reads as 3D — dragging
    // *down* would instead push el toward the ~86° clamp (a flat top-down). A
    // modest 0.12·height lift lands el≈0.1 rad (~6°): a low, dramatic 3/4 that
    // stays above the horizon (no looking up at the cloud from underneath).
    // Defensive: if the canvas/testid isn't found, skip rather than fail.
    try {
      const sceneBox = await page
        .getByTestId("scene-canvas-host")
        .boundingBox();
      if (sceneBox) {
        const sx = sceneBox.x + sceneBox.width / 2;
        const sy = sceneBox.y + sceneBox.height / 2;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        await page.mouse.move(sx, sy - Math.round(sceneBox.height * 0.12), {
          steps: 14,
        });
        await page.mouse.up();
        await page.waitForTimeout(200);
      }
    } catch {
      /* orbit is cosmetic; ignore if the canvas isn't drag-targetable */
    }

    // Pick the overlay-densest moment (most LiDAR points painted on the
    // camera) so the reveal + hero land on the signature fusion shot rather
    // than the sparse open road. This sweep runs behind the title card, so it
    // costs no visible time in the capture.
    const overlayCountAt = async (f: number): Promise<number> => {
      await seekToTs(page, at(f));
      await page.waitForTimeout(450);
      return page.evaluate(
        (id) =>
          window.__drivelineDevHooks!.getVideoOverlaySync(id)
            .projectedVisibleCount,
        VIDEO_OVERLAY_PANEL,
      );
    };
    let bestFrac = 0.55;
    let bestCount = -1;
    for (const f of [0.35, 0.45, 0.55, 0.65, 0.75, 0.85]) {
      const c = await overlayCountAt(f);
      if (c > bestCount) {
        bestCount = c;
        bestFrac = f;
      }
    }
    console.log(
      `[demo] densest overlay frame: frac=${bestFrac} ` +
        `projectedVisibleCount=${bestCount}`,
    );

    // Reveal a beat BEFORE the densest moment, then make ONE smooth forward
    // pass straight through the dense + turning section to the end of the video
    // (no rewind): the opening is already well-painted and only gets denser.
    // Open ON the densest frame (minus ~1 frame of lead) so the very first
    // revealed frame is heavily painted with LiDAR — fusion "wow" up front, not
    // 5 s of sparse open road — then pass forward through the turn.
    const startFrac = Math.max(0.03, bestFrac - 0.05);
    // Stop ~0.5 s before the video source's ACTUAL coverage end — the channel's
    // own timeRange, i.e. the exact window VideoPanel uses to decide
    // "uncovered" (cursor > covEnd → the camera panel goes black with "no video
    // at this time"). The raw mp4-sidecar span we seek fractions against can run
    // slightly past that covered window (B-frame composition-order remap), so a
    // fraction near 1.0 lands in the black tail. Anchoring the stop to covEnd −
    // 0.5 s (margin absorbs the poll overshoot) guarantees the frame we end and
    // hold on is always a live, painted dashcam frame — never the black tail.
    const covEndNs = await page.evaluate((srcId) => {
      const src = window
        .__drivelineDevHooks!.listSources()
        .find((s) => s.id === srcId);
      return src ? src.timeRange.endNs : null;
    }, video!.sourceId);
    if (!covEndNs) throw new Error("video source timeRange not found");
    const stopNs = BigInt(covEndNs) - 500_000_000n;
    await seekToTs(page, at(startFrac));
    await page.waitForTimeout(700);

    // Mark the play-start offset (ms from the recording origin) so the trim in
    // post-processing keeps only the playback — no load, no setup, no card.
    const playStartMs = Date.now() - recordStart;
    await setPlaying(page, true);
    // Drive the cursor forward and STOP it the instant it reaches the last
    // in-video frame — never run past the video's data window into the no-video
    // tail. A fixed wall-time wait can't do this safely: above 1x it overshoots
    // into that black tail, below 1x it stops short. Poll the REAL cursor
    // instead, with a generous wall-time cap as a safety net (well under the
    // 240s test timeout). If the cap trips on a heavily gated software-decode
    // box, we pause wherever the cursor got to — still inside the video window,
    // so the held frame is live, never black.
    await page
      .waitForFunction(
        (tgt) =>
          BigInt(window.__drivelineDevHooks!.getSessionSnapshot().cursorNs) >=
          BigInt(tgt),
        String(stopNs),
        { timeout: 90_000, polling: 100 },
      )
      .catch(() => {});
    // PAUSE IMMEDIATELY, before doing anything else. The cursor is driven by the
    // playback rAF loop and keeps advancing at the live rate until the pause
    // actually lands — so any work between the stop-detect and the pause (e.g. a
    // telemetry round-trip) lets the cursor sail the remaining 0.5s margin past
    // covEnd, fire VideoPanel's uncovered paintBlack(), and freeze the held
    // frame on black. Pausing first pins the cursor safely inside coverage.
    await setPlaying(page, false);
    const playEndMs = Date.now() - recordStart;
    // Now sample the decode worker's frame-pacing telemetry. Safe to read after
    // the pause: pause does NOT reset the cadence window (only play-start / seek
    // do) and the hold below never seeks, so it is still fresh. This is the hard
    // smoothness number for this run: jitter, repeats/rushed, playback-rate,
    // blit-clock tick-gap health, and — critically — playerErrStdRegularMs,
    // which cancels out the ~12 fps source's own irregularity so it isolates
    // PLAYER judder from the data being steppy.
    const pacing = await page.evaluate(() => {
      const h = window.__drivelineDevHooks!;
      return { cadence: h.videoCadence(), hud: h.videoHudStats() };
    });
    console.log("[demo] PACING " + JSON.stringify(pacing));

    // Hold a beat on the frame playback STOPPED on — do NOT seek anywhere. A
    // backward seek to a "hero" frame would flush the video decoder and flash
    // black until the next keyframe, cutting the take in two; the whole point
    // here is ONE continuous forward play that ends on a live, already-painted
    // fusion frame. The forward pass runs straight through the turn (which only
    // gets denser), so the frame it lands on is itself a strong hero shot.
    // Brief settle wait after the pause so the recorder flushes the final
    // played frames — this is NOT shown in the shareable clip. We do NOT seek
    // anywhere (a backward "hero" seek would flush the decoder and flash black,
    // cutting the take in two). The clip is trimmed to [PLAY_START_MS,
    // PLAY_END_MS] — the continuous playing section only — so the held/paused
    // tail never appears: the video ends mid-motion on a live, painted fusion
    // frame with no freeze and no jump.
    await page.waitForTimeout(1500);

    // Emit the trim window for post-processing (see README). The shareable mp4
    // is built from [PLAY_START_MS, PLAY_END_MS] (continuous playback only, no
    // paused hold). hold_end_ms is logged only to recover the recorder's
    // lead-in offset (webm_duration - hold_end_ms), since the .webm keeps
    // running a moment past the pause.
    console.log(
      `[demo] TRIM_WINDOW play_start_ms=${playStartMs} ` +
        `play_end_ms=${playEndMs} hold_end_ms=${Date.now() - recordStart}`,
    );
  });
});
