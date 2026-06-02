// Ad-hoc visualisation specs for the real-world comma2k19 segment 10.
//
// Two tests:
//   1. "renders video frame alongside speed + steering plot" — drops
//      mp4 + sidecar + mcap (signals from MCAP only).
//   2. "renders cross-source plot from MCAP and MF4 together" — same
//      drop plus comma2k19.mf4, with the plot panel bound to one
//      channel from each format.
//
// Underscore prefix keeps this out of normal CI runs — invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-video.spec.ts
//
// Requires (manual prep, see sample-data/realworld/README.md):
//   sample-data/realworld/comma2k19.mcap               (python3 scripts/convert_comma2k19_to_mcap.py)
//   sample-data/realworld/comma2k19.mf4                (python3 scripts/convert_comma2k19_to_mf4.py)
//   sample-data/realworld/comma2k19_seg10.mp4          (ffmpeg from HF compression_challenge HEVC)
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps  (one line per frame @ 20 fps anchored to segment start)

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = {
  mcap: "realworld/comma2k19.mcap",
  mf4: "realworld/comma2k19.mf4",
  mp4: "realworld/comma2k19_seg10.mp4",
  ts: "realworld/comma2k19_seg10.mp4.timestamps",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const VIDEO_PANEL_ID = "video-1";
const PLOT_PANEL_ID = "plot-1";
const VIDEO_SOURCE_NAME = "comma2k19_seg10.mp4";
const VIDEO_NATIVE_ID = "1/video";

async function seekToOneSixthOfRange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const range = window
      .__drivelineDevHooks!.getSessionSnapshot()
      .globalRange!;
    const start = BigInt(range.startNs);
    const end = BigInt(range.endNs);
    const target = start + (end - start) / 6n;
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

test.describe("comma2k19 dashcam + CAN", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "comma2k19 fixtures missing — see sample-data/realworld/README.md",
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

  test("renders video frame alongside speed + steering plot", async ({
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
      expect.arrayContaining(["comma2k19.mcap", "comma2k19_seg10.mp4"]),
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
    const steer = byName.get("/vehicle/steering_angle")!;
    await page.evaluate(
      ([panelId, sId, stId]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, sId);
        h.addPlotChannelBinding(panelId, stId);
      },
      [PLOT_PANEL_ID, speed.id, steer.id],
    );

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-video-plus-signals.png"),
    });
  });

  test("renders cross-source plot from MCAP and MF4 together", async ({
    page,
  }) => {
    test.skip(
      !existsSync(ABS.mf4),
      "comma2k19.mf4 missing — run scripts/convert_comma2k19_to_mf4.py",
    );

    // All four files in one drop: mp4 + sidecar pair as one source, the
    // mcap as a second, the mf4 as a third. The UI status line ends up
    // reading "3 sources".
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
      expect.arrayContaining([
        "comma2k19.mcap",
        "comma2k19.mf4",
        "comma2k19_seg10.mp4",
      ]),
    );

    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources().map((s) => s.name),
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.stringContaining("comma2k19.mcap"),
        expect.stringContaining("comma2k19.mf4"),
        expect.stringContaining("comma2k19_seg10.mp4"),
      ]),
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

    // Pick one scalar from each source and put them on the same plot.
    // /vehicle/speed (MCAP) is the chassis CAN speed in m/s; the four
    // wheel speeds in MF4 are in the same unit, so the legend sits on
    // a single y-axis and the lines tell the story (chassis ≈ wheels
    // outside of slip events).
    const all = await page.evaluate(() =>
      window
        .__drivelineDevHooks!.listChannels()
        .map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    );
    const sourceNames = await page.evaluate(() =>
      Object.fromEntries(
        window
          .__drivelineDevHooks!.listSources()
          .map((s) => [s.id, s.name]),
      ),
    );
    const find = (sourceMatch: RegExp, name: string) =>
      all.find(
        (c) =>
          c.name === name && sourceMatch.test(sourceNames[c.sourceId] ?? ""),
      );

    const mcapSpeed = find(/\.mcap/, "/vehicle/speed");
    const mf4Wheel = find(/\.mf4/, "WheelSpeedFL");
    expect(mcapSpeed, "MCAP /vehicle/speed").toBeDefined();
    expect(mf4Wheel, "MF4 WheelSpeedFL").toBeDefined();

    await page.evaluate(
      ([panelId, a, b]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, a);
        h.addPlotChannelBinding(panelId, b);
      },
      [PLOT_PANEL_ID, mcapSpeed!.id, mf4Wheel!.id],
    );

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    // Per-series stats keyed by channel id — both ids must report
    // count > 0, which can only happen if the cross-source merge ran.
    const stats = await page.evaluate(
      (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
      PLOT_PANEL_ID,
    );
    expect(stats).not.toBeNull();
    const seen = new Set(stats!.map((s) => s.channelId));
    expect(seen.has(mcapSpeed!.id)).toBe(true);
    expect(seen.has(mf4Wheel!.id)).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-mcap-plus-mf4.png"),
    });
  });

  test("plots 3 MCAPs and 3 MF4s across two side-by-side panels", async ({
    page,
  }) => {
    // Drops six per-segment files (segments 4, 7, 10 of the
    // 2018-07-27--06-03-57 drive, each emitted as MCAP + MF4 with the
    // correct segment-start wall-clock so they line up on the unified
    // timeline rather than stacking at the drive root).
    // These are the OFFSET signal variants: each is anchored N*60 s past
    // the drive root (seg4 → +240 s, seg7 → +420 s, seg10 → +600 s) so the
    // three 60 s blocks tile the timeline without overlapping. The `_atNNNs`
    // suffix is load-bearing — the un-suffixed `comma2k19.mcap`/`.mf4` are
    // the ZERO-offset variants that align with the dashcam, and mixing the
    // two would land the signals 10 min away from the video (see README).
    const RELS = [
      "realworld/comma2k19_seg4_at240s.mcap",
      "realworld/comma2k19_seg4_at240s.mf4",
      "realworld/comma2k19_seg7_at420s.mcap",
      "realworld/comma2k19_seg7_at420s.mf4",
      "realworld/comma2k19_seg10_at600s.mcap",
      "realworld/comma2k19_seg10_at600s.mf4",
    ];
    test.skip(
      !RELS.every((r) =>
        existsSync(path.resolve(__dirname, "../../../sample-data", r)),
      ),
      "multi-segment comma2k19 fixtures missing — regenerate with " +
        "scripts/convert_comma2k19_to_{mcap,mf4}.py at offsets 240/420/600 " +
        "(output names carry the _atNNNs offset suffix)",
    );

    // Custom layout: two PlotPanel tabs side by side, stable ids so
    // bindings can target them by name. Defaults to a 50/50 split.
    const LAYOUT = {
      global: {
        tabEnableClose: true,
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
            weight: 50,
            children: [
              {
                type: "tab",
                id: "plot-1",
                name: "Speeds (MCAP + MF4)",
                component: "plot",
              },
            ],
          },
          {
            type: "tabset",
            weight: 50,
            children: [
              {
                type: "tab",
                id: "plot-2",
                name: "Steering + Gyro (MCAP + MF4)",
                component: "plot",
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

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        rels.map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, RELS);
    expect(open.errors).toEqual([]);
    expect(open.opened).toHaveLength(6);

    // Resolve each (sourceName, channelName) pair to a channel id.
    const all = await page.evaluate(() =>
      window
        .__drivelineDevHooks!.listChannels()
        .map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    );
    const sourceById = await page.evaluate(() =>
      Object.fromEntries(
        window
          .__drivelineDevHooks!.listSources()
          .map((s) => [s.id, s.name]),
      ),
    );
    const pick = (sourcePattern: RegExp, channelName: string) => {
      const ch = all.find(
        (c) =>
          c.name === channelName &&
          sourcePattern.test(sourceById[c.sourceId] ?? ""),
      );
      if (!ch) {
        throw new Error(
          `channel ${channelName} not found in source matching ${sourcePattern}`,
        );
      }
      return ch.id;
    };

    // Plot 1 — chassis CAN speed (MCAP) and front-left wheel speed
    // (MF4), one each per segment. Six series, all m/s.
    const plot1Ids = [
      pick(/seg4_at240s\.mcap/, "/vehicle/speed"),
      pick(/seg7_at420s\.mcap/, "/vehicle/speed"),
      pick(/seg10_at600s\.mcap/, "/vehicle/speed"),
      pick(/seg4_at240s\.mf4/, "WheelSpeedFL"),
      pick(/seg7_at420s\.mf4/, "WheelSpeedFL"),
      pick(/seg10_at600s\.mf4/, "WheelSpeedFL"),
    ];

    // Plot 2 — steering wheel angle (MCAP, deg) and yaw-rate gyro
    // (MF4, rad/s), one each per segment. The two units no longer
    // auto-split onto separate axes; we assign the gyro series to a
    // second y-axis explicitly below so the differing scales stay
    // readable.
    const plot2Ids = [
      pick(/seg4_at240s\.mcap/, "/vehicle/steering_angle"),
      pick(/seg7_at420s\.mcap/, "/vehicle/steering_angle"),
      pick(/seg10_at600s\.mcap/, "/vehicle/steering_angle"),
      pick(/seg4_at240s\.mf4/, "IMU_Gyro_Z"),
      pick(/seg7_at420s\.mf4/, "IMU_Gyro_Z"),
      pick(/seg10_at600s\.mf4/, "IMU_Gyro_Z"),
    ];
    // The gyro ids (last three) go on the right-hand axis (index 1).
    const plot2Axis2Ids = plot2Ids.slice(3);

    await page.evaluate(
      ({
        a,
        b,
        b2,
      }: {
        a: string[];
        b: string[];
        b2: string[];
      }) => {
        const h = window.__drivelineDevHooks!;
        for (const id of a) h.addPlotChannelBinding("plot-1", id);
        for (const id of b) h.addPlotChannelBinding("plot-2", id);
        for (const id of b2) h.setPlotChannelAxis("plot-2", id, 1);
      },
      { a: plot1Ids, b: plot2Ids, b2: plot2Axis2Ids },
    );

    await waitForPlotSeries(page, "plot-1", 6);
    await waitForPlotSeries(page, "plot-2", 6);
    await paintAndSettle(page);

    // Each plot must contain at least one series from an MCAP source
    // and one from an MF4 source — that's the multi-format claim.
    for (const panelId of ["plot-1", "plot-2"]) {
      const stats = await page.evaluate(
        (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
        panelId,
      );
      expect(stats, panelId).not.toBeNull();
      expect(stats!).toHaveLength(6);
      const formats = new Set(
        stats!.map((s) => {
          const id = s.channelId;
          const ch = all.find((c) => c.id === id);
          const src = sourceById[ch?.sourceId ?? ""];
          return src.endsWith(".mcap") ? "mcap" : "mf4";
        }),
      );
      expect(formats.has("mcap"), `${panelId} needs MCAP series`).toBe(true);
      expect(formats.has("mf4"), `${panelId} needs MF4 series`).toBe(true);
    }

    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "comma2k19-multi-segment-multi-panel.png",
      ),
    });
  });

  test("splits one segment across 4 files and plots them on 2 panels", async ({
    page,
  }) => {
    // Same 60 s window as the original test, but the segment's signals
    // are emitted into four topic-specific files by passing `--only`
    // to each converter. Proves Driveline can unify a fanned-out
    // recording (chassis CAN in one MCAP, wheel CAN in another, IMU
    // and GNSS each in their own MF4) on a single clock.
    const RELS = [
      "realworld/comma2k19_chassis.mcap",
      "realworld/comma2k19_wheels.mcap",
      "realworld/comma2k19_imu.mf4",
      "realworld/comma2k19_gnss.mf4",
    ];
    test.skip(
      !RELS.every((r) =>
        existsSync(path.resolve(__dirname, "../../../sample-data", r)),
      ),
      "split-by-topic fixtures missing — see sample-data/realworld/README.md",
    );

    const LAYOUT = {
      global: {
        tabEnableClose: true,
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
            weight: 50,
            children: [
              {
                type: "tab",
                id: "plot-1",
                name: "Speed & wheels (2 MCAP + 1 MF4)",
                component: "plot",
              },
            ],
          },
          {
            type: "tabset",
            weight: 50,
            children: [
              {
                type: "tab",
                id: "plot-2",
                name: "Steering / Gyro / GNSS (1 MCAP + 2 MF4)",
                component: "plot",
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

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        rels.map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, RELS);
    expect(open.errors).toEqual([]);
    expect(open.opened).toHaveLength(4);

    const all = await page.evaluate(() =>
      window
        .__drivelineDevHooks!.listChannels()
        .map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    );
    const sourceById = await page.evaluate(() =>
      Object.fromEntries(
        window
          .__drivelineDevHooks!.listSources()
          .map((s) => [s.id, s.name]),
      ),
    );
    const pick = (sourcePattern: RegExp, channelName: string) => {
      const ch = all.find(
        (c) =>
          c.name === channelName &&
          sourcePattern.test(sourceById[c.sourceId] ?? ""),
      );
      if (!ch) {
        throw new Error(
          `channel ${channelName} not in source matching ${sourcePattern}; ` +
            `have ${all.length} channels across ${
              Object.values(sourceById).length
            } sources`,
        );
      }
      return ch.id;
    };

    // Panel 1 — speed + IMU accel. Three files contribute: the chassis
    // MCAP (vehicle speed), the wheels MCAP (four corner speeds), the
    // IMU MF4 (three accel axes). Eight chips, the panel's max.
    const plot1Ids = [
      pick(/chassis\.mcap/, "/vehicle/speed"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_fl"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_fr"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_rl"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_rr"),
      pick(/imu\.mf4/, "IMU_Accel_X"),
      pick(/imu\.mf4/, "IMU_Accel_Y"),
      pick(/imu\.mf4/, "IMU_Accel_Z"),
    ];

    // Panel 2 — rotation + altitude. Three files contribute: the
    // chassis MCAP (steering angle in deg), the IMU MF4 (3-axis gyro
    // in rad/s), the GNSS MF4 (altitude in m). GNSS_Lat / GNSS_Lon
    // are deliberately omitted because their absolute deg values
    // (~40 and ~-120 for the CA-280 segment) squash every other
    // series on a shared y-axis.
    const plot2Ids = [
      pick(/chassis\.mcap/, "/vehicle/steering_angle"),
      pick(/imu\.mf4/, "IMU_Gyro_X"),
      pick(/imu\.mf4/, "IMU_Gyro_Y"),
      pick(/imu\.mf4/, "IMU_Gyro_Z"),
      pick(/gnss\.mf4/, "GNSS_Alt"),
    ];

    await page.evaluate(
      ({ a, b }: { a: string[]; b: string[] }) => {
        const h = window.__drivelineDevHooks!;
        for (const id of a) h.addPlotChannelBinding("plot-1", id);
        for (const id of b) h.addPlotChannelBinding("plot-2", id);
      },
      { a: plot1Ids, b: plot2Ids },
    );

    await waitForPlotSeries(page, "plot-1", 8);
    await waitForPlotSeries(page, "plot-2", 5);
    await paintAndSettle(page);

    // Each panel must carry series from at least 3 distinct source
    // files — the test's whole point is the cross-file fan-in.
    for (const panelId of ["plot-1", "plot-2"]) {
      const stats = await page.evaluate(
        (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
        panelId,
      );
      expect(stats, panelId).not.toBeNull();
      const files = new Set(
        stats!.map((s) => {
          const ch = all.find((c) => c.id === s.channelId);
          return sourceById[ch?.sourceId ?? ""] ?? "";
        }),
      );
      expect(files.size, `${panelId} files`).toBeGreaterThanOrEqual(3);
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-split-by-topic.png"),
    });
  });

  test("splits one segment + dashcam video across 3 panels", async ({
    page,
  }) => {
    // Same four signal files as the split-by-topic test, plus the
    // mp4 + sidecar pair. Layout: dashcam on the left, two plots
    // stacked on the right. Status line should read "5 sources" —
    // the mp4 + sidecar count as one.
    const SIGNAL_RELS = [
      "realworld/comma2k19_chassis.mcap",
      "realworld/comma2k19_wheels.mcap",
      "realworld/comma2k19_imu.mf4",
      "realworld/comma2k19_gnss.mf4",
    ];
    const VIDEO_RELS = [REL.mp4, REL.ts];
    const ALL_RELS = [...SIGNAL_RELS, ...VIDEO_RELS];
    test.skip(
      !ALL_RELS.every((r) =>
        existsSync(path.resolve(__dirname, "../../../sample-data", r)),
      ),
      "split-by-topic + video fixtures missing — see sample-data/realworld/README.md",
    );

    // Nested rows: a horizontal split at the root puts the video on
    // the left (weight 40); the right column is a row-inside-a-row
    // which FlexLayout interprets as a vertical split, stacking
    // plot-1 over plot-2 (50/50).
    const LAYOUT = {
      global: {
        tabEnableClose: true,
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
            weight: 40,
            children: [
              {
                type: "tab",
                id: VIDEO_PANEL_ID,
                name: "Dashcam",
                component: "video",
              },
            ],
          },
          {
            type: "row",
            weight: 60,
            children: [
              {
                type: "tabset",
                weight: 50,
                children: [
                  {
                    type: "tab",
                    id: "plot-1",
                    name: "Speed + IMU accel (2 MCAP + 1 MF4)",
                    component: "plot",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 50,
                children: [
                  {
                    type: "tab",
                    id: "plot-2",
                    name: "Steering / Gyro / GNSS (1 MCAP + 2 MF4)",
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

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        rels.map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, ALL_RELS);
    expect(open.errors).toEqual([]);
    // mp4 + sidecar pair opens as one source; signals open as four more.
    expect(open.opened).toEqual(
      expect.arrayContaining([
        "comma2k19_chassis.mcap",
        "comma2k19_wheels.mcap",
        "comma2k19_imu.mf4",
        "comma2k19_gnss.mf4",
        "comma2k19_seg10.mp4",
      ]),
    );
    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources(),
    );
    expect(sources).toHaveLength(5);

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
    const sourceById = Object.fromEntries(sources.map((s) => [s.id, s.name]));
    const pick = (sourcePattern: RegExp, channelName: string) => {
      const ch = all.find(
        (c) =>
          c.name === channelName &&
          sourcePattern.test(sourceById[c.sourceId] ?? ""),
      );
      if (!ch) {
        throw new Error(
          `channel ${channelName} not in source matching ${sourcePattern}`,
        );
      }
      return ch.id;
    };

    const plot1Ids = [
      pick(/chassis\.mcap/, "/vehicle/speed"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_fl"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_fr"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_rl"),
      pick(/wheels\.mcap/, "/vehicle/wheel_speed_rr"),
      pick(/imu\.mf4/, "IMU_Accel_X"),
      pick(/imu\.mf4/, "IMU_Accel_Y"),
      pick(/imu\.mf4/, "IMU_Accel_Z"),
    ];
    const plot2Ids = [
      pick(/chassis\.mcap/, "/vehicle/steering_angle"),
      pick(/imu\.mf4/, "IMU_Gyro_X"),
      pick(/imu\.mf4/, "IMU_Gyro_Y"),
      pick(/imu\.mf4/, "IMU_Gyro_Z"),
      pick(/gnss\.mf4/, "GNSS_Alt"),
    ];
    await page.evaluate(
      ({ a, b }: { a: string[]; b: string[] }) => {
        const h = window.__drivelineDevHooks!;
        for (const id of a) h.addPlotChannelBinding("plot-1", id);
        for (const id of b) h.addPlotChannelBinding("plot-2", id);
      },
      { a: plot1Ids, b: plot2Ids },
    );

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, "plot-1", 8);
    await waitForPlotSeries(page, "plot-2", 5);
    await paintAndSettle(page);

    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "comma2k19-split-by-topic-with-video.png",
      ),
    });
  });
});
