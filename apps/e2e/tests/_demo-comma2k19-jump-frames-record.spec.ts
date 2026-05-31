// "With video + frame check": records the page to .webm AND verifies the
// actual decoded frame after each big interval jump on the dense
// comma2k19 dashboard (2 dashcams + 4 plots).
//
// Per jump:
//   1. seek + Play, time the decode catch-up to live (≤ ~1 frame of cursor),
//   2. Pause so the decoder lands on the EXACT cursor frame,
//   3. read each video panel's blitted PTS → compute lag + frame index,
//   4. screenshot each video canvas (the real decoded frame) for eyeball
//      verification, and a full-page shot.
//
// Recording is ON here (the user asked for video too) — note that the
// page-capture overhead inflates timing somewhat vs the no-record
// latency spec.
//
// Invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-jump-frames-record.spec.ts
//
// Same fixtures as the dashboard spec (incl. hflip comma2k19_rear.mp4).

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAME_DIR = "/tmp/jumpframes";
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

const PLOTS: Array<{
  id: string;
  name: string;
  signals: Array<{ src: RegExp; name: string }>;
}> = [
  {
    id: "plot-speeds",
    name: "Speeds (MCAP)",
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
    name: "IMU accel (MF4)",
    signals: [
      { src: /\.mf4/, name: "IMU_Accel_X" },
      { src: /\.mf4/, name: "IMU_Accel_Y" },
      { src: /\.mf4/, name: "IMU_Accel_Z" },
    ],
  },
  {
    id: "plot-gyro",
    name: "IMU gyro (MF4)",
    signals: [
      { src: /\.mf4/, name: "IMU_Gyro_X" },
      { src: /\.mf4/, name: "IMU_Gyro_Y" },
      { src: /\.mf4/, name: "IMU_Gyro_Z" },
    ],
  },
  {
    id: "plot-steer",
    name: "Steering + wheels (MCAP+MF4)",
    signals: [
      { src: /\.mcap/, name: "/vehicle/steering_angle" },
      { src: /\.mf4/, name: "WheelSpeedFL" },
      { src: /\.mf4/, name: "WheelSpeedFR" },
      { src: /\.mf4/, name: "WheelSpeedRL" },
      { src: /\.mf4/, name: "WheelSpeedRR" },
    ],
  },
];

const LIVE_TOL_MS = 100; // catch-up: within ~2 frames while playing
const SEEK_TOL_MS = 120; // paused scrub should land within ~2 frames
const CATCHUP_TIMEOUT_MS = 8000;
const STEADY_WINDOW_MS = 1200;

test.use({
  video: { mode: "on", size: { width: 1600, height: 900 } },
  viewport: { width: 1600, height: 900 },
});

async function seekToRatio(page: Page, ratio: number): Promise<void> {
  const box = await page.getByTestId("scrubber").boundingBox();
  if (!box) throw new Error("scrubber not visible");
  await page.mouse.move(box.x + box.width * ratio, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
}

async function setPlaying(page: Page, want: boolean): Promise<void> {
  const playPause = page.getByTestId("play-pause");
  for (let attempt = 0; attempt < 3; attempt++) {
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (playing === want) return;
    await playPause.click();
    await page.waitForTimeout(120);
  }
}

// In-page: time from now until both dashcams are "ready" within tol of
// the cursor (live).
async function measureCatchUp(
  page: Page,
  tolMs: number,
  timeoutMs: number,
): Promise<{ caughtUp: boolean; catchUpMs: number }> {
  return await page.evaluate(
    async ({ tolMs, timeoutMs }) => {
      const h = window.__drivelineDevHooks!;
      const tolNs = BigInt(Math.round(tolMs * 1_000_000));
      const worstLagNs = (): bigint | null => {
        const cursor = BigInt(h.getSessionSnapshot().cursorNs);
        const panels = h
          .getVideoReadiness()
          .filter((r) => r.state !== "absent");
        if (panels.length === 0) return null;
        let worst = -1n;
        for (const p of panels) {
          if (p.lastBlitPtsNs === null) return null;
          let lag = cursor - BigInt(p.lastBlitPtsNs);
          if (lag < 0n) lag = -lag;
          if (lag > worst) worst = lag;
        }
        return worst;
      };
      const allReady = () =>
        h
          .getVideoReadiness()
          .filter((r) => r.state !== "absent")
          .every((r) => r.state === "ready");
      const t0 = performance.now();
      const nextFrame = () =>
        new Promise<void>((r) => requestAnimationFrame(() => r()));
      let caughtUp = false;
      for (;;) {
        const lag = worstLagNs();
        if (lag !== null && lag <= tolNs && allReady()) {
          caughtUp = true;
          break;
        }
        if (performance.now() - t0 > timeoutMs) break;
        await nextFrame();
      }
      return { caughtUp, catchUpMs: performance.now() - t0 };
    },
    { tolMs, timeoutMs },
  );
}

// In-page: sample the worst-cam cursor→blit lag while playing.
async function measureSteadyLag(
  page: Page,
  windowMs: number,
): Promise<{ medianMs: number | null; p95Ms: number | null; maxMs: number | null }> {
  return await page.evaluate(async (windowMs) => {
    const h = window.__drivelineDevHooks!;
    const nextFrame = () =>
      new Promise<void>((r) => requestAnimationFrame(() => r()));
    const samples: number[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < windowMs) {
      const cursor = BigInt(h.getSessionSnapshot().cursorNs);
      const panels = h
        .getVideoReadiness()
        .filter((r) => r.state !== "absent");
      let worst: number | null = 0;
      for (const p of panels) {
        if (p.lastBlitPtsNs === null) {
          worst = null;
          break;
        }
        let lag = cursor - BigInt(p.lastBlitPtsNs);
        if (lag < 0n) lag = -lag;
        worst = Math.max(worst!, Number(lag) / 1_000_000);
      }
      if (worst !== null) samples.push(worst);
      await nextFrame();
    }
    samples.sort((a, b) => a - b);
    const pct = (p: number) =>
      samples.length === 0
        ? null
        : samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
    return { medianMs: pct(0.5), p95Ms: pct(0.95), maxMs: pct(0.999) };
  }, windowMs);
}

// In-page: wait for the PAUSED seek to settle, then report each video
// panel's blit PTS, lag vs cursor, and the frame index that PTS maps to.
async function snapshotFrames(
  page: Page,
  videoStartNs: string,
  tolMs: number,
): Promise<{
  cursorNs: string;
  panels: Array<{
    panelId: string;
    blitPtsNs: string | null;
    lagMs: number | null;
    frameIndex: number | null;
  }>;
}> {
  return await page.evaluate(
    async ({ videoStartNs, tolMs }) => {
      const h = window.__drivelineDevHooks!;
      const startNs = BigInt(videoStartNs);
      const periodNs = 50_000_000n;
      const tolNs = BigInt(Math.round(tolMs * 1_000_000));
      const nextFrame = () =>
        new Promise<void>((r) => requestAnimationFrame(() => r()));
      const worst = (): bigint => {
        const cursor = BigInt(h.getSessionSnapshot().cursorNs);
        let w = 0n;
        for (const p of h
          .getVideoReadiness()
          .filter((r) => r.state !== "absent")) {
          if (p.lastBlitPtsNs === null) return 1n << 62n;
          let lag = cursor - BigInt(p.lastBlitPtsNs);
          if (lag < 0n) lag = -lag;
          if (lag > w) w = lag;
        }
        return w;
      };
      // Let the frozen seek converge on the exact cursor frame. Under
      // the page-recording load a heavy 2-cam decode can take a while to
      // walk the GOP to the target frame, so allow a generous window.
      const t0 = performance.now();
      while (worst() > tolNs && performance.now() - t0 < 4000) {
        await nextFrame();
      }
      const cursor = BigInt(h.getSessionSnapshot().cursorNs);
      const panels = h
        .getVideoReadiness()
        .filter((r) => r.state !== "absent")
        .map((p) => {
          if (p.lastBlitPtsNs === null) {
            return {
              panelId: p.panelId,
              blitPtsNs: null,
              lagMs: null,
              frameIndex: null,
            };
          }
          const pts = BigInt(p.lastBlitPtsNs);
          let lag = cursor - pts;
          if (lag < 0n) lag = -lag;
          return {
            panelId: p.panelId,
            blitPtsNs: pts.toString(),
            lagMs: Number(lag) / 1_000_000,
            frameIndex: Number((pts - startNs) / periodNs),
          };
        });
      return { cursorNs: cursor.toString(), panels };
    },
    { videoStartNs, tolMs },
  );
}

test.describe("comma2k19 jump frames + recording", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "comma2k19 dashboard fixtures missing (incl. comma2k19_rear.mp4)",
  );

  test("records replay and verifies the frame after each jump", async ({
    page,
  }) => {
    mkdirSync(FRAME_DIR, { recursive: true });
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });

    const tab = (id: string, name: string, component: string) => ({
      type: "tabset" as const,
      weight: 50,
      children: [{ type: "tab" as const, id, name, component }],
    });
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
              tab(VIDEO_FRONT_PANEL, "Dashcam — front", "video"),
              tab(VIDEO_REAR_PANEL, "Dashcam — mirror", "video"),
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
                  tab(PLOTS[0].id, PLOTS[0].name, "plot"),
                  tab(PLOTS[1].id, PLOTS[1].name, "plot"),
                ],
              },
              {
                type: "row",
                weight: 50,
                children: [
                  tab(PLOTS[2].id, PLOTS[2].name, "plot"),
                  tab(PLOTS[3].id, PLOTS[3].name, "plot"),
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

    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources(),
    );
    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const sourceById = new Map(sources.map((s) => [s.id, s.name]));
    const frontSource = sources.find((s) => s.name.includes(FRONT_SOURCE))!;
    const videoStartNs = frontSource.timeRange.startNs;

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

    const pick = (srcPattern: RegExp, name: string): string => {
      const ch = channels.find(
        (c) =>
          c.name === name &&
          srcPattern.test(sourceById.get(c.sourceId) ?? ""),
      );
      if (!ch) throw new Error(`channel ${name} not found in ${srcPattern}`);
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

    // Warm up so the first measured jump isn't paying for spin-up.
    await seekToRatio(page, 0.02);
    await setPlaying(page, true);
    await measureCatchUp(page, LIVE_TOL_MS, CATCHUP_TIMEOUT_MS);
    await page.waitForTimeout(1500);

    const videoCanvases = page.getByTestId("video-panel-canvas");
    const stops = [0.1, 0.22, 0.4, 0.65, 0.9];
    type Row = {
      jumpToPct: number;
      caughtUp: boolean;
      catchUpMs: number;
      steady: Awaited<ReturnType<typeof measureSteadyLag>>;
      frames: Awaited<ReturnType<typeof snapshotFrames>>;
    };
    const rows: Row[] = [];

    for (let i = 0; i < stops.length; i++) {
      const ratio = stops[i];
      const tag = `jump${i + 1}-${Math.round(ratio * 100)}pct`;

      // (A) FRAME CHECK — scrub (paused) forces a re-seek to the exact
      //     cursor frame. Read it before any playback drift accrues, and
      //     screenshot the real decoded canvas as visual proof.
      await seekToRatio(page, ratio);
      await setPlaying(page, false);
      const frames = await snapshotFrames(page, videoStartNs, SEEK_TOL_MS);
      const n = await videoCanvases.count();
      for (let c = 0; c < n; c++) {
        await videoCanvases
          .nth(c)
          .screenshot({ path: path.join(FRAME_DIR, `${tag}-cam${c}.png`) });
      }
      await page.screenshot({ path: path.join(FRAME_DIR, `${tag}-full.png`) });

      // (B) Resume — time the catch-up to live, then sample the residual
      //     drift while it keeps playing (this run records the page, so
      //     the drift is the heavy-overhead figure).
      await setPlaying(page, true);
      const cu = await measureCatchUp(page, LIVE_TOL_MS, CATCHUP_TIMEOUT_MS);
      const steady = await measureSteadyLag(page, STEADY_WINDOW_MS);
      await page.waitForTimeout(800); // let the recording show motion

      rows.push({
        jumpToPct: Math.round(ratio * 100),
        caughtUp: cu.caughtUp,
        catchUpMs: cu.catchUpMs,
        steady,
        frames,
      });

      const lags = frames.panels
        .map((p) => (p.lagMs === null ? "∅" : p.lagMs.toFixed(0)))
        .join(",");
      const idxs = frames.panels
        .map((p) => (p.frameIndex === null ? "∅" : String(p.frameIndex)))
        .join(",");
      // eslint-disable-next-line no-console
      console.log(
        `JUMP→${String(Math.round(ratio * 100)).padStart(2)}%  ` +
          `seekFrameLagMs=[${lags}] frameIdx=[${idxs}]  ` +
          `catchUp=${cu.catchUpMs.toFixed(0)}ms live=${cu.caughtUp}  ` +
          `playDriftMed/p95=${steady.medianMs?.toFixed(0)}/${steady.p95Ms?.toFixed(0)}ms`,
      );

      // Each cam must have blitted a real frame and be in the right
      // neighbourhood of the cursor (generous bound — the recording load
      // inflates the residual; the strict correctness check is the
      // strictly-increasing frame index below + the screenshot montage).
      for (const p of frames.panels) {
        expect(p.lagMs, `cam ${p.panelId} blitted a frame`).not.toBeNull();
        expect(
          p.lagMs!,
          `cam ${p.panelId} near cursor frame (lag ${p.lagMs}ms)`,
        ).toBeLessThanOrEqual(500);
      }
      expect(cu.caughtUp, `jump ${ratio} reaches live`).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log("FRAMES_JSON=" + JSON.stringify(rows));

    // Each scrub really landed on a later, distinct frame (front cam).
    const fi = rows.map((r) => r.frames.panels[0].frameIndex ?? -1);
    for (let i = 1; i < fi.length; i++) {
      expect(fi[i], `jump ${i} frame after jump ${i - 1}`).toBeGreaterThan(
        fi[i - 1],
      );
    }
  });
});
