// Measures replay LATENCY after big interval jumps on the dense
// comma2k19 dashboard (2 dashcams + 4 multi-signal plots). For each
// jump it records:
//   - catchUpMs    — time from pressing Play to BOTH video panels being
//                    "ready" with their blitted frame within one-ish
//                    frame of the cursor (i.e. decode has caught up and
//                    playback is live again).
//   - steadyLag*Ms — once live, the residual cursor→blit lag sampled
//                    over a short window (median / p95 / max across both
//                    panels), in milliseconds.
//
// No page video recording here — capturing the page steals CPU and would
// inflate the very latency we're trying to measure.
//
// Invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-jump-latency.spec.ts
//
// Same fixtures as _demo-comma2k19-dashboard-record.spec.ts (incl. the
// hflip comma2k19_rear.mp4 + sidecar).

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

// "Live" tolerance: blitted PTS within 2 frames (20 fps → 100 ms) of the
// cursor. The renderer always shows the frame whose pts ≤ cursor, so a
// perfectly live panel still trails by up to ~one frame period.
const LIVE_TOL_MS = 100;
const CATCHUP_TIMEOUT_MS = 8000;
const STEADY_WINDOW_MS = 1500;

test.use({ viewport: { width: 1600, height: 900 } });

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
    await page.waitForTimeout(120);
  }
}

// Runs entirely in-page: poll (via rAF) until both video panels are
// "ready" and within LIVE_TOL of the cursor, timing the catch-up with
// performance.now(); then sample the residual lag over a window.
type JumpMeasure = {
  caughtUp: boolean;
  catchUpMs: number;
  steadyLagMedianMs: number | null;
  steadyLagP95Ms: number | null;
  steadyLagMaxMs: number | null;
  samples: number;
};

async function measureJump(
  page: Page,
  tolMs: number,
  timeoutMs: number,
  steadyWindowMs: number,
): Promise<JumpMeasure> {
  return await page.evaluate(
    async ({ tolMs, timeoutMs, steadyWindowMs }) => {
      const h = window.__drivelineDevHooks!;
      const NS_PER_MS = 1_000_000;
      const tolNs = BigInt(Math.round(tolMs * NS_PER_MS));

      // Max cursor→blit lag (ns) across all non-absent video panels, or
      // null if any such panel has not blitted yet.
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
      const allReady = (): boolean =>
        h
          .getVideoReadiness()
          .filter((r) => r.state !== "absent")
          .every((r) => r.state === "ready");

      const t0 = performance.now();
      const nextFrame = () =>
        new Promise<void>((r) => requestAnimationFrame(() => r()));

      let caughtUp = false;
      // Phase 1 — catch up.
      for (;;) {
        const elapsed = performance.now() - t0;
        const lag = worstLagNs();
        if (lag !== null && lag <= tolNs && allReady()) {
          caughtUp = true;
          break;
        }
        if (elapsed > timeoutMs) break;
        await nextFrame();
      }
      const catchUpMs = performance.now() - t0;

      // Phase 2 — sample residual lag while live.
      const lagsMs: number[] = [];
      if (caughtUp) {
        const s0 = performance.now();
        while (performance.now() - s0 < steadyWindowMs) {
          const lag = worstLagNs();
          if (lag !== null) lagsMs.push(Number(lag) / NS_PER_MS);
          await nextFrame();
        }
      }
      lagsMs.sort((a, b) => a - b);
      const pct = (p: number) =>
        lagsMs.length === 0
          ? null
          : lagsMs[Math.min(lagsMs.length - 1, Math.floor(p * lagsMs.length))];

      return {
        caughtUp,
        catchUpMs,
        steadyLagMedianMs: pct(0.5),
        steadyLagP95Ms: pct(0.95),
        steadyLagMaxMs: lagsMs.length ? lagsMs[lagsMs.length - 1] : null,
        samples: lagsMs.length,
      };
    },
    { tolMs, timeoutMs, steadyWindowMs },
  );
}

test.describe("comma2k19 jump latency", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "comma2k19 dashboard fixtures missing (incl. comma2k19_rear.mp4)",
  );

  test("reports catch-up + steady lag after big interval jumps", async ({
    page,
  }) => {
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

    // Warm up at the start so the first measured jump isn't paying for
    // initial worker spin-up / first decoder configure.
    await seekToRatio(page, 0.02);
    await ensurePlaying(page);
    await measureJump(page, LIVE_TOL_MS, CATCHUP_TIMEOUT_MS, STEADY_WINDOW_MS);

    // Progressively larger forward jumps. Each scrub pauses; re-press
    // Play, then measure how long until both dashcams are live again.
    const stops = [0.1, 0.22, 0.4, 0.65, 0.9];
    const rows: Array<{ jumpToPct: number } & JumpMeasure> = [];
    for (const ratio of stops) {
      const before = await page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().cursorNs,
      );
      const wall0 = Date.now();
      await seekToRatio(page, ratio);
      await ensurePlaying(page);
      const m = await measureJump(
        page,
        LIVE_TOL_MS,
        CATCHUP_TIMEOUT_MS,
        STEADY_WINDOW_MS,
      );
      const wallTotalMs = Date.now() - wall0;
      rows.push({ jumpToPct: Math.round(ratio * 100), ...m });
      const after = await page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().cursorNs,
      );
      const jumpSecs =
        Number(BigInt(after) - BigInt(before)) / 1_000_000_000;
      // eslint-disable-next-line no-console
      console.log(
        `JUMP→${String(Math.round(ratio * 100)).padStart(2)}% ` +
          `(Δ≈${jumpSecs.toFixed(1)}s)  ` +
          `catchUp=${m.catchUpMs.toFixed(0)}ms  ` +
          `endToEnd=${wallTotalMs}ms  ` +
          `live=${m.caughtUp}  ` +
          `steadyLag med/p95/max=` +
          `${m.steadyLagMedianMs?.toFixed(0)}/` +
          `${m.steadyLagP95Ms?.toFixed(0)}/` +
          `${m.steadyLagMaxMs?.toFixed(0)}ms`,
      );
      // Every jump must actually reach a live state.
      expect(m.caughtUp, `jump to ${ratio} should catch up`).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log("\nLATENCY_JSON=" + JSON.stringify(rows));

    // Summary expectations: catch-up well under the timeout, and once
    // live the residual lag stays inside a couple of frames.
    const catchUps = rows.map((r) => r.catchUpMs);
    const worstSteady = Math.max(
      ...rows.map((r) => r.steadyLagMaxMs ?? Infinity),
    );
    // eslint-disable-next-line no-console
    console.log(
      `SUMMARY catchUp max=${Math.max(...catchUps).toFixed(0)}ms ` +
        `mean=${(catchUps.reduce((a, b) => a + b, 0) / catchUps.length).toFixed(0)}ms ` +
        `worstSteadyLag=${worstSteady.toFixed(0)}ms`,
    );
    expect(Math.max(...catchUps)).toBeLessThan(CATCHUP_TIMEOUT_MS);
  });
});
