// Cross-dataset frame-loss + lag MEASUREMENT for the NVIDIA Alpamayo fusion
// (camera_front_wide_120fov fisheye + LiDAR overlay + 3D LiDAR scene + ego
// plots). Same acceptance bar as _fusion-frameloss.spec.ts (0 frame loss, p95
// lag < 100 ms), on a DIFFERENT camera (f-theta fisheye, different codec/res)
// and a denser native LiDAR — proves the fix isn't nuScenes-specific.
//
//   pnpm --filter e2e exec playwright test _fusion-frameloss-alpamayo.spec.ts --config=playwright.chrome.config.ts

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REL = {
  mp4: "realworld/alpamayo/camera_front_wide_120fov.mp4",
  ts: "realworld/alpamayo/camera_front_wide_120fov.mp4.timestamps",
  calib: "realworld/alpamayo/calibration.calib.json",
  lidar: "realworld/alpamayo/lidar_top_360fov.lidar.parquet",
  ego: "realworld/alpamayo/egomotion.mf4",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const CAMERA_NAME = "camera_front_wide_120fov";
const VIDEO_PANEL = "video-overlay";
const SCENE_PANEL = "scene-lidar";
const PLOT_PANEL = "plot-ego";

test.use({ channel: "chrome", viewport: { width: 1600, height: 900 } });

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[
    Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  ];
}

async function seekToTs(page: Page, tsNs: bigint): Promise<void> {
  await page.evaluate((tgt) => {
    const range = window.__drivelineDevHooks!.getSessionSnapshot().globalRange!;
    const start = BigInt(range.startNs),
      end = BigInt(range.endNs);
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

async function setPlaying(page: Page, want: boolean): Promise<void> {
  const b = page.getByTestId("play-pause");
  for (let i = 0; i < 4; i++) {
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (playing === want) return;
    await b.click();
    await page.waitForTimeout(120);
  }
}

interface Hud {
  drawn: number;
  skipped: number;
  straggler: number;
  dropped: number;
  frameIndex: number;
}
async function hud(page: Page): Promise<Hud> {
  const h = await page.evaluate(() =>
    window.__drivelineDevHooks!.videoHudStats(),
  );
  if (!h) throw new Error("no hud");
  return h as unknown as Hud;
}

test.describe("Alpamayo fusion — frame-loss + lag", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "Alpamayo fixtures missing",
  );

  test("plays the clip with 0 frame loss and lag < 100 ms", async ({
    page,
  }) => {
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
                name: "front_wide · LiDAR overlay",
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
                    name: "Ego signals",
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
    const video = channels.find((c) => c.kind === "video");
    const pc = channels.find((c) => c.kind === "point_cloud");
    const calib = channels.find((c) => c.kind === "camera_calibration");
    expect(video, "video").toBeTruthy();
    expect(pc, "point_cloud").toBeTruthy();
    expect(calib, "calibration").toBeTruthy();
    const scalars = channels.filter((c) => c.kind === "scalar").slice(0, 2);
    expect(scalars.length, "≥1 scalar for plot").toBeGreaterThan(0);

    await page.evaluate(
      ([p, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(p, id),
      [VIDEO_PANEL, video!.id] as const,
    );
    await page.evaluate(
      ([p, c, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(p, {
          calibrationChannelId: c,
          cameraName: cam,
          pointcloudChannelId: pcId,
        }),
      [VIDEO_PANEL, calib!.id, pc!.id, CAMERA_NAME] as const,
    );
    await page.evaluate(
      ([p, id]) => window.__drivelineDevHooks!.setSceneChannelBinding(p, id),
      [SCENE_PANEL, pc!.id] as const,
    );
    await page.evaluate(
      ([p, ...ids]) => {
        const h = window.__drivelineDevHooks!;
        ids.forEach((id, i) => {
          h.addPlotChannelBinding(p, id);
          if (i === 1) h.setPlotChannelAxis(p, id, 1);
        });
      },
      [PLOT_PANEL, ...scalars.map((s) => s.id)] as const,
    );

    const { start, end, ts } = await page.evaluate(async () => {
      const r = await fetch(
        "/sample-data/realworld/alpamayo/camera_front_wide_120fov.mp4.timestamps",
      );
      const arr = (await r.text())
        .trim()
        .split("\n")
        .map((l) => l.split("\t")[1]);
      return { start: arr[0], end: arr[arr.length - 1], ts: arr };
    });
    const s = BigInt(start),
      e = BigInt(end);
    const tsB = ts.map((x) => BigInt(x));
    const at = (f: number) => s + BigInt(Math.round(Number(e - s) * f));

    // Content precondition at ~35% in.
    await seekToTs(page, at(0.35));
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getScenePanelSync(id)?.pointCount ??
              0,
            SCENE_PANEL,
          ),
        { timeout: 40_000, intervals: [400, 800] },
      )
      .toBeGreaterThan(1000);
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getVideoOverlaySync(id)
                .projectedVisibleCount,
            VIDEO_PANEL,
          ),
        { timeout: 40_000, intervals: [400, 800] },
      )
      .toBeGreaterThan(0);
    await expect
      .poll(
        async () =>
          page.evaluate((id) => {
            const st = window.__drivelineDevHooks!.getPlotPanelSeriesStats(id);
            return (
              st !== null && st.length >= 1 && st.every((x) => x.count > 0)
            );
          }, PLOT_PANEL),
        { timeout: 40_000, intervals: [400, 800] },
      )
      .toBe(true);

    // Settle on a frame ~10% in, fully prime, then measure the play.
    await seekToTs(page, at(0.1));
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.__drivelinePerf!.clear());
    const before = await hud(page);
    const playStartNs = BigInt(
      await page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().cursorNs,
      ),
    );

    await page.evaluate(() => {
      const w = window as unknown as {
        __fl?: {
          samples: { cMs: number; bMs: number | null }[];
          shown: Set<string>;
          stop: boolean;
        };
      };
      const st = {
        samples: [] as { cMs: number; bMs: number | null }[],
        shown: new Set<string>(),
        stop: false,
      };
      w.__fl = st;
      const tick = () => {
        if (st.stop) return;
        const snap = window.__drivelineDevHooks!.getSessionSnapshot();
        const cMs = Number(BigInt(snap.cursorNs) / 1000n) / 1000;
        const bRaw = window.__drivelineVideoLastBlitPtsNs ?? null;
        const bMs = bRaw === null ? null : Number(bRaw / 1000n) / 1000;
        if (bRaw !== null) st.shown.add(bRaw.toString());
        st.samples.push({ cMs, bMs });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const spanMs = Number(e - playStartNs) / 1e6;
    await setPlaying(page, true);
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
          ),
        { timeout: Math.ceil(spanMs) + 15_000, intervals: [300, 600] },
      )
      .toBe(false);
    await page.evaluate(() => {
      const w = window as unknown as { __fl?: { stop: boolean } };
      if (w.__fl) w.__fl.stop = true;
    });

    const after = await hud(page);
    const sampler = await page.evaluate(() => {
      const w = window as unknown as {
        __fl?: {
          samples: { cMs: number; bMs: number | null }[];
          shown: Set<string>;
        };
      };
      const fl = w.__fl!;
      return { samples: fl.samples, shown: Array.from(fl.shown) };
    });

    const drawnDelta = after.drawn - before.drawn;
    const skippedDelta = after.skipped - before.skipped;
    const droppedDelta = after.dropped - before.dropped;
    const stragglerDelta = after.straggler - before.straggler;
    const expectedFrames = tsB.filter((t) => t >= playStartNs && t <= e).length;
    const shownSet = new Set(sampler.shown);
    const distinctShown = shownSet.size;

    const startMs = Number(playStartNs) / 1e6,
      endMs = Number(e) / 1e6;
    const lags: number[] = [];
    for (const sm of sampler.samples) {
      if (sm.bMs === null) continue;
      if (sm.cMs < startMs - 1 || sm.cMs > endMs + 1) continue;
      lags.push(sm.cMs - sm.bMs);
    }
    const lagP50 = pct(lags, 50),
      lagP95 = pct(lags, 95),
      lagMax = lags.length ? Math.max(...lags) : NaN;

    const report = {
      clip: { spanMs: Math.round(spanMs), expectedFrames, frames: tsB.length },
      frameLoss: {
        drawnDelta,
        skippedDelta,
        droppedDelta,
        stragglerDelta,
        distinctShown,
      },
      lagMs: {
        samples: lags.length,
        p50: +lagP50.toFixed(1),
        p95: +lagP95.toFixed(1),
        max: +lagMax.toFixed(1),
      },
    };
    console.log("ALPAMAYO_FRAMELOSS " + JSON.stringify(report, null, 2));

    expect(skippedDelta, "skipped").toBe(0);
    expect(droppedDelta, "dropped").toBe(0);
    expect(stragglerDelta, "straggler").toBe(0);
    // `drawnDelta` (the worker's exact paint count) is the authoritative 0-loss
    // proof. `distinctShown` is the in-page rAF sampler — at 30 fps it can't
    // observe every 33 ms frame (a frame shown for < a sample interval is
    // missed), so it's checked with a tolerance, not 1:1.
    expect(drawnDelta, `painted vs ${expectedFrames}`).toBeGreaterThanOrEqual(
      expectedFrames - 1,
    );
    expect(
      distinctShown,
      `distinct shown (sampler) vs ${expectedFrames}`,
    ).toBeGreaterThanOrEqual(Math.floor(expectedFrames * 0.95));
    expect(lags.length, "lag samples").toBeGreaterThan(50);
    expect(lagP95, "p95 lag").toBeLessThan(100);
  });
});
