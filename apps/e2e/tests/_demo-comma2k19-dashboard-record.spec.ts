// Ad-hoc visual REPLAY recording for comma2k19 — pushed to a dense
// dashboard: TWO dashcam video panels (front + a mirrored second feed)
// stacked on the left, and a 2x2 grid of FOUR plot panels on the right,
// each bound to several signals (16 series total across MCAP + MF4).
//
// It presses Play, then seeks forward by increasingly larger intervals
// (dwelling at each stop so the replay is visible) while Playwright
// records the whole page to a .webm.
//
// Underscore prefix keeps this out of normal CI runs — invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-dashboard-record.spec.ts
//
// Requires (see verify-comma2k19 skill / sample-data/realworld/README.md):
//   comma2k19.mcap, comma2k19.mf4,
//   comma2k19_seg10.mp4 (+ .timestamps),
//   comma2k19_rear.mp4  (+ .timestamps)  — hflip of seg10, same clock.
//
// The second camera is a horizontally-flipped re-encode of the front
// dashcam (same fps / GOP / pix_fmt so WebCodecs still decodes it), and
// it reuses the front sidecar verbatim since frame count and timing are
// identical. Regenerate it from sample-data/realworld with:
//
//   ffmpeg -hide_banner -v error -y -i comma2k19_seg10.mp4 -vf hflip \
//     -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
//     -g 20 -keyint_min 20 -movflags +faststart -an comma2k19_rear.mp4
//   cp comma2k19_seg10.mp4.timestamps comma2k19_rear.mp4.timestamps

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REL = {
  mcap: "realworld/comma2k19.mcap",
  mf4: "realworld/comma2k19.mf4",
  frontMp4: "realworld/comma2k19_seg10.mp4",
  frontTs: "realworld/comma2k19_seg10.mp4.timestamps",
  rearMp4: "realworld/comma2k19_rear.mp4",
  rearTs: "realworld/comma2k19_rear.mp4.timestamps",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const VIDEO_FRONT_PANEL = "video-front";
const VIDEO_REAR_PANEL = "video-rear";
const FRONT_SOURCE = "comma2k19_seg10.mp4";
const REAR_SOURCE = "comma2k19_rear.mp4";

// Four plots, each carrying multiple signals. Resolved against the
// loaded channels by (source-pattern, channel-name).
const PLOTS: Array<{
  id: string;
  name: string;
  signals: Array<{ src: RegExp; name: string }>;
}> = [
  {
    id: "plot-speeds",
    name: "Speeds — vehicle + wheels (MCAP)",
    signals: [
      { src: /\.mcap/, name: "/vehicle/speed" },
      { src: /\.mcap/, name: "/vehicle/wheel_speed_fl" },
      { src: /\.mcap/, name: "/vehicle/wheel_speed_fr" },
      { src: /\.mcap/, name: "/vehicle/wheel_speed_rl" },
      { src: /\.mcap/, name: "/vehicle/wheel_speed_rr" },
    ],
  },
  {
    id: "plot-accel",
    name: "IMU accel X/Y/Z (MF4)",
    signals: [
      { src: /\.mf4/, name: "IMU_Accel_X" },
      { src: /\.mf4/, name: "IMU_Accel_Y" },
      { src: /\.mf4/, name: "IMU_Accel_Z" },
    ],
  },
  {
    id: "plot-gyro",
    name: "IMU gyro X/Y/Z (MF4)",
    signals: [
      { src: /\.mf4/, name: "IMU_Gyro_X" },
      { src: /\.mf4/, name: "IMU_Gyro_Y" },
      { src: /\.mf4/, name: "IMU_Gyro_Z" },
    ],
  },
  {
    id: "plot-steer",
    name: "Steering (MCAP) + wheel speeds (MF4)",
    signals: [
      { src: /\.mcap/, name: "/vehicle/steering_angle" },
      { src: /\.mf4/, name: "WheelSpeedFL" },
      { src: /\.mf4/, name: "WheelSpeedFR" },
      { src: /\.mf4/, name: "WheelSpeedRL" },
      { src: /\.mf4/, name: "WheelSpeedRR" },
    ],
  },
];

// Bigger canvas — six panels need the room.
test.use({
  video: { mode: "on", size: { width: 1600, height: 900 } },
  viewport: { width: 1600, height: 900 },
});

// Seek with a REAL mouse press on the scrubber (synthetic PointerEvents
// don't register an active pointer, so the Transport's setPointerCapture
// throws and the seek silently no-ops).
async function seekToRatio(page: Page, ratio: number): Promise<void> {
  const box = await page.getByTestId("scrubber").boundingBox();
  if (!box) throw new Error("scrubber not visible");
  await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function ensurePlaying(page: Page): Promise<void> {
  const playPause = page.getByTestId("play-pause");
  for (let attempt = 0; attempt < 3; attempt++) {
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (playing) return;
    await playPause.click();
    await page.waitForTimeout(150);
  }
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
      ),
    )
    .toBe(true);
}

// At least `count` video panels must have blitted a real frame.
async function waitForVideoPanels(page: Page, count: number): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            window
              .__drivelineDevHooks!.getVideoReadiness()
              .filter((r) => r.lastBlitPtsNs !== null).length,
        ),
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBeGreaterThanOrEqual(count);
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
      { timeout: 25_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

test.describe("comma2k19 dense dashboard replay", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "comma2k19 dashboard fixtures missing (incl. comma2k19_rear.mp4) — " +
      "see verify-comma2k19 skill + the hflip step in the spec header",
  );

  test("records replay across 2 video + 4 plot panels", async ({ page }) => {
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

    // Left column: two dashcams stacked (a vertical row nested under the
    // horizontal root). Right area: a 2x2 plot grid (two vertical halves,
    // each split horizontally). FlexLayout alternates orientation by
    // nesting depth — root row is horizontal, depth-1 rows vertical,
    // depth-2 rows horizontal again.
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
            type: "row",
            weight: 30,
            children: [
              {
                type: "tabset",
                weight: 50,
                children: [
                  {
                    type: "tab",
                    id: VIDEO_FRONT_PANEL,
                    name: "Dashcam — front",
                    component: "video",
                  },
                ],
              },
              {
                type: "tabset",
                weight: 50,
                children: [
                  {
                    type: "tab",
                    id: VIDEO_REAR_PANEL,
                    name: "Dashcam — mirror",
                    component: "video",
                  },
                ],
              },
            ],
          },
          {
            type: "row",
            weight: 70,
            children: [
              {
                type: "row",
                weight: 50,
                children: [
                  {
                    type: "tabset",
                    weight: 50,
                    children: [
                      {
                        type: "tab",
                        id: PLOTS[0].id,
                        name: PLOTS[0].name,
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
                        id: PLOTS[1].id,
                        name: PLOTS[1].name,
                        component: "plot",
                      },
                    ],
                  },
                ],
              },
              {
                type: "row",
                weight: 50,
                children: [
                  {
                    type: "tabset",
                    weight: 50,
                    children: [
                      {
                        type: "tab",
                        id: PLOTS[2].id,
                        name: PLOTS[2].name,
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
                        id: PLOTS[3].id,
                        name: PLOTS[3].name,
                        component: "plot",
                      },
                    ],
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

    // Open all six files. The mp4 + sidecar pairs each open as one
    // source, so this is 4 sources: 2 video + mcap + mf4.
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
        FRONT_SOURCE,
        REAR_SOURCE,
      ]),
    );
    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources(),
    );
    expect(sources).toHaveLength(4);

    // Resolve & bind each dashcam to its panel. Video channels are
    // matched by (source name, kind=video) so we don't depend on the
    // exact native id.
    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const sourceById = new Map(sources.map((s) => [s.id, s.name]));
    const videoChannelFor = (sourceName: string): string => {
      const ch = channels.find(
        (c) =>
          c.kind === "video" &&
          (sourceById.get(c.sourceId) ?? "").includes(sourceName),
      );
      if (!ch) throw new Error(`no video channel for ${sourceName}`);
      return ch.id;
    };
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_FRONT_PANEL, videoChannelFor(FRONT_SOURCE)],
    );
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_REAR_PANEL, videoChannelFor(REAR_SOURCE)],
    );

    // Resolve & bind every plot's signals.
    const pick = (srcPattern: RegExp, name: string): string => {
      const ch = channels.find(
        (c) =>
          c.name === name &&
          srcPattern.test(sourceById.get(c.sourceId) ?? ""),
      );
      if (!ch) {
        throw new Error(`channel ${name} not found in source ${srcPattern}`);
      }
      return ch.id;
    };
    for (const plot of PLOTS) {
      const ids = plot.signals.map((s) => pick(s.src, s.name));
      await page.evaluate(
        ([panelId, ...chIds]) => {
          const h = window.__drivelineDevHooks!;
          for (const id of chIds) h.addPlotChannelBinding(panelId, id);
        },
        [plot.id, ...ids],
      );
    }

    // Land near the start; prove every panel has content before playing.
    await seekToRatio(page, 0.02);
    await waitForVideoPanels(page, 2);
    for (const plot of PLOTS) {
      await waitForPlotSeries(page, plot.id, plot.signals.length);
    }

    // Play, then jump forward by progressively larger intervals.
    await ensurePlaying(page);
    await page.waitForTimeout(3000);

    const stops = [0.1, 0.22, 0.4, 0.65, 0.95];
    for (const ratio of stops) {
      await seekToRatio(page, ratio);
      await waitForVideoPanels(page, 2);
      if (ratio < 0.95) await ensurePlaying(page);
      await page.waitForTimeout(3000);
    }

    // Tail dwell so the end of the replay is flushed into the video.
    await page.waitForTimeout(1200);
  });
});
