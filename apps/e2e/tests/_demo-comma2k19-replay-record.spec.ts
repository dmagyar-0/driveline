// Ad-hoc visual REPLAY recording for the real-world comma2k19 segment 10.
//
// Unlike the screenshot specs in `_demo-comma2k19-video.spec.ts`, this
// one records a *video* of the running app: it lays out the dashcam +
// one multi-signal plot, presses Play, then seeks forward by
// increasingly larger intervals (waiting at each stop so the replay is
// visible). Playwright captures the whole page to a .webm.
//
// Underscore prefix keeps this out of normal CI runs — invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-replay-record.spec.ts
//
// Requires (see sample-data/realworld/README.md / verify-comma2k19 skill):
//   sample-data/realworld/comma2k19.mcap
//   sample-data/realworld/comma2k19_seg10.mp4
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REL = {
  mcap: "realworld/comma2k19.mcap",
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

// Five speed signals, all m/s, so they share one y-axis: chassis CAN
// speed plus the four corner wheel speeds. "Multiple signals on a plot."
const PLOT_CHANNELS = [
  "/vehicle/speed",
  "/vehicle/wheel_speed_fl",
  "/vehicle/wheel_speed_fr",
  "/vehicle/wheel_speed_rl",
  "/vehicle/wheel_speed_rr",
];

// Record the page. Viewport-sized webm written to the test output dir.
test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});

// Seek with a REAL mouse press on the scrubber. Synthetic
// dispatchEvent PointerEvents don't register an active pointer, so the
// Transport's setPointerCapture throws and the seek silently no-ops;
// driving page.mouse generates genuine pointer events that commit.
async function seekToRatio(page: Page, ratio: number): Promise<void> {
  const box = await page.getByTestId("scrubber").boundingBox();
  if (!box) throw new Error("scrubber not visible");
  const x = box.x + box.width * ratio;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

// Click Play and confirm the store latched `playing`. The button is a
// plain toggle, so if a prior seek failed to pause we could otherwise
// toggle ourselves back off — re-click until the snapshot agrees.
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

async function waitForVideoFrame(page: Page): Promise<void> {
  await page.getByTestId("video-panel-canvas").waitFor();
  await expect
    .poll(
      async () =>
        await page.evaluate(() =>
          window.__drivelineDevHooks!.videoLastBlitPtsNs(),
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
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

test.describe("comma2k19 replay recording", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "comma2k19 fixtures missing — see sample-data/realworld/README.md",
  );

  test("records replay with big interval jumps", async ({ page }) => {
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

    // Dashcam on the left (45%), one multi-signal plot on the right.
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
            weight: 45,
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
            type: "tabset",
            weight: 55,
            children: [
              {
                type: "tab",
                id: PLOT_PANEL_ID,
                name: "Speed + wheel speeds (m/s)",
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

    // Open the dashcam (mp4 + sidecar pair) and the full MCAP.
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
      expect.arrayContaining(["comma2k19.mcap", "comma2k19_seg10.mp4"]),
    );

    // Bind the dashcam.
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

    // Bind the five speed signals to the plot.
    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const byName = new Map(channels.map((c) => [c.name, c]));
    const plotIds = PLOT_CHANNELS.map((n) => {
      const c = byName.get(n);
      if (!c) throw new Error(`channel ${n} not found`);
      return c.id;
    });
    await page.evaluate(
      ([panelId, ...ids]) => {
        const h = window.__drivelineDevHooks!;
        for (const id of ids) h.addPlotChannelBinding(panelId, id);
      },
      [PLOT_PANEL_ID, ...plotIds],
    );

    // Land near the start, prove both panels have content, then play.
    await seekToRatio(page, 0.02);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, PLOT_CHANNELS.length);

    // Press Play and let the replay run for a beat.
    await ensurePlaying(page);
    await page.waitForTimeout(2500);

    // Jump forward by progressively larger intervals. Each scrub pauses
    // (store.setCursor sets playing:false), so we re-press Play, let the
    // dashcam catch up, and dwell so the replay is visible in the video.
    const stops = [0.1, 0.22, 0.4, 0.65, 0.95];
    for (const ratio of stops) {
      await seekToRatio(page, ratio);
      await waitForVideoFrame(page);
      // Re-arm playback (skip if we landed at the very end).
      if (ratio < 0.95) {
        await ensurePlaying(page);
      }
      await page.waitForTimeout(2500);
    }

    // Final dwell so the tail of the replay is captured before the
    // context closes and the video is flushed.
    await page.waitForTimeout(1000);
  });
});
