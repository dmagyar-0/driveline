// Headless frame-loss + lag MEASUREMENT harness for the nuScenes camera +
// LiDAR fusion dashboard (video + LiDAR-on-video overlay + 3D LiDAR scene +
// two ego plots), all rendering simultaneously while playing the clip at 1×.
//
// Goal it verifies (the user's acceptance bar):
//   • 0 frame loss  — every decoded video frame in the played span is actually
//                     painted, and none is closed undrawn (cursor jump-skip).
//   • lag < 100 ms  — the on-canvas frame is never more than 100 ms behind the
//                     shared cursor during steady-state play (p95 budget).
//
// It is a MEASUREMENT, not a recording: it instruments the worker's exact
// `drawn` / `skipped` / `dropped` counters (added in videoDecode.worker.ts) and
// an in-page rAF sampler of (cursor − blitPts), plays the full clip once, and
// reports the distribution + asserts the budgets. Underscore-prefixed so it
// stays out of the normal CI run; invoke directly:
//   pnpm --filter e2e exec playwright test _fusion-frameloss.spec.ts --project=chromium
//
// Requires the five nuScenes converter outputs in sample-data/realworld/
// (same set as _demo-nuscenes-fusion.spec.ts).

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
const VIDEO_PANEL = "video-overlay";
const SCENE_PANEL = "scene-lidar";
const PLOT_PANEL = "plot-ego";
const PLOT_SIGNALS = ["/ego/speed", "/ego/yaw_rate"];

// System Chrome — the bundled Chromium won't execute on this box (project note),
// and Chrome's HW H.264 decode is what we're actually exercising.
test.use({
  channel: "chrome",
  viewport: { width: 1600, height: 900 },
});

interface HudStats {
  ptsNs: string | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  drawn: number;
  skipped: number;
  straggler: number;
  codec: string | null;
  hudOn: boolean;
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(
    s.length - 1,
    Math.max(0, Math.round((p / 100) * (s.length - 1))),
  );
  return s[i];
}

async function dataWindow(
  page: Page,
): Promise<{ start: bigint; end: bigint; ts: bigint[] }> {
  const text = await page.evaluate(async () => {
    const r = await fetch(
      "/sample-data/realworld/nuscenes_cam_front.mp4.timestamps",
    );
    if (!r.ok) throw new Error(`sidecar fetch: ${r.status}`);
    return await r.text();
  });
  const ts = text
    .trim()
    .split("\n")
    .map((l) => BigInt(l.split("\t")[1]));
  return { start: ts[0], end: ts[ts.length - 1], ts };
}

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

async function setPlaying(page: Page, want: boolean): Promise<void> {
  const playPause = page.getByTestId("play-pause");
  for (let attempt = 0; attempt < 4; attempt++) {
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (playing === want) return;
    await playPause.click();
    await page.waitForTimeout(120);
  }
}

async function hud(page: Page): Promise<HudStats> {
  const h = await page.evaluate(() =>
    window.__drivelineDevHooks!.videoHudStats(),
  );
  if (!h) throw new Error("video HUD snapshot missing");
  return h as HudStats;
}

test.describe("nuScenes fusion — frame-loss + lag measurement", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "nuScenes fixtures missing in sample-data/realworld/",
  );

  test("plays the full clip with 0 frame loss and lag < 100 ms", async ({
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
      (json) => window.__drivelineDevHooks!.setLayoutJson(json),
      LAYOUT,
    );

    // Open all five outputs as one drop.
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

    await page.evaluate(
      ([pid, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_PANEL, video!.id] as const,
    );
    await page.evaluate(
      ([pid, calibId, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(pid, {
          calibrationChannelId: calibId,
          cameraName: cam,
          pointcloudChannelId: pcId,
        }),
      [VIDEO_PANEL, calibration!.id, pointcloud!.id, CAMERA_NAME] as const,
    );
    await page.evaluate(
      ([pid, id]) =>
        window.__drivelineDevHooks!.setSceneChannelBinding(pid, id),
      [SCENE_PANEL, pointcloud!.id] as const,
    );
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
          if (i === 1) h.setPlotChannelAxis(pid, id, 1);
        });
      },
      [PLOT_PANEL, ...plotIds] as const,
    );

    const { start, end, ts } = await dataWindow(page);
    const at = (f: number): bigint =>
      start + BigInt(Math.round(Number(end - start) * f));

    // Prove all four panels have real content before we measure. Probe ~35%
    // into the window: the first LiDAR spin lands a beat after frame 0, so the
    // overlay is legitimately empty at the exact start — 35% in is dense.
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
        { timeout: 30_000, intervals: [300, 600, 1000] },
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
        { timeout: 30_000, intervals: [300, 600, 1000] },
      )
      .toBeGreaterThan(0);
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

    // Land near the start and let the decoder fully prime (build its lookahead)
    // BEFORE we snapshot the baseline — so the paused-priming reorder churn is
    // excluded from the measured deltas; we measure the continuous PLAY only.
    await seekToTs(page, start);
    await page.waitForTimeout(900);
    await page.evaluate(() => window.__drivelinePerf!.clear());
    const before = await hud(page);
    // The scrubber-click seek is coarse on this timeline (the calibration config
    // at ts 0 stretches the global range to ~1.5e18 ns, so one scrubber pixel is
    // ~1.6 s), so play actually starts ~10–20 frames in. Capture the REAL cursor
    // and measure every frame from there to the end.
    const playStartNs = BigInt(
      await page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().cursorNs,
      ),
    );

    // Install an in-page rAF sampler of (cursor, blitPts, wallClock). Cheap —
    // one small object per frame — and representative of an agent watching.
    await page.evaluate(() => {
      const w = window as unknown as {
        __fl?: {
          samples: { cMs: number; bMs: number | null; t: number }[];
          shown: Set<string>;
          stop: boolean;
        };
      };
      const state = {
        samples: [] as {
          cMs: number;
          bMs: number | null;
          t: number;
          bq: number;
          dq: number;
        }[],
        shown: new Set<string>(),
        stop: false,
      };
      w.__fl = state;
      const tick = () => {
        if (state.stop) return;
        const snap = window.__drivelineDevHooks!.getSessionSnapshot();
        const cMs = Number(BigInt(snap.cursorNs) / 1000n) / 1000;
        const bRaw = window.__drivelineVideoLastBlitPtsNs ?? null;
        const bMs = bRaw === null ? null : Number(bRaw / 1000n) / 1000;
        const h = window.__drivelineDevHooks!.videoHudStats();
        if (bRaw !== null) state.shown.add(bRaw.toString());
        state.samples.push({
          cMs,
          bMs,
          t: performance.now(),
          bq: h?.blitQueueLen ?? -1,
          dq: h?.decodeQueue ?? -1,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // Play the full clip at 1×. It auto-pauses at end-of-session; poll for that
    // (with a wall-clock safety cap a few seconds beyond the clip span).
    const spanMs = Number(end - start) / 1e6;
    await setPlaying(page, true);
    const playStartWall = Date.now();
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
          ),
        { timeout: Math.ceil(spanMs) + 12_000, intervals: [250, 500] },
      )
      .toBe(false);
    const playWallMs = Date.now() - playStartWall;
    await page.evaluate(() => {
      const w = window as unknown as { __fl?: { stop: boolean } };
      if (w.__fl) w.__fl.stop = true;
    });

    const after = await hud(page);
    const sampler = await page.evaluate(() => {
      const w = window as unknown as {
        __fl?: {
          samples: { cMs: number; bMs: number | null; t: number }[];
          shown: Set<string>;
        };
      };
      const fl = w.__fl!;
      return { samples: fl.samples, shown: Array.from(fl.shown) };
    });

    // ---- Frame-loss accounting (exact, from worker counters) ----------------
    const drawnDelta = after.drawn - before.drawn;
    const skippedDelta = after.skipped - before.skipped;
    const droppedDelta = after.dropped - before.dropped;
    const stragglerDelta = after.straggler - before.straggler;

    // Frames whose PTS lies inside the ACTUAL played span [playStart, end] — the
    // set that should have been painted during the clean forward pass. (The
    // frame at/just before playStart is shown at t0, so include one frame of
    // lead so it isn't counted as a miss.)
    const spanLo = playStartNs;
    const expectedFrames = ts.filter((t) => t >= spanLo && t <= end).length;
    const shownSet = new Set(sampler.shown);
    const distinctShown = shownSet.size;
    // Which expected frames never appeared, bucketed by position to separate a
    // startup transient from a systematic loss.
    const missing = ts.filter(
      (t) => t >= spanLo && t <= end && !shownSet.has(t.toString()),
    );
    const missFirst1s = missing.filter(
      (t) => t - spanLo < 1_000_000_000n,
    ).length;
    const missLast1s = missing.filter((t) => end - t < 1_000_000_000n).length;
    const missMiddle = missing.length - missFirst1s - missLast1s;
    const missingOffsetsMs = missing
      .slice(0, 30)
      .map((t) => Math.round(Number(t - spanLo) / 1e6));

    // ---- Lag distribution ---------------------------------------------------
    // Only count samples where a frame is on-canvas and the cursor is within the
    // data window (outside coverage there is legitimately no frame).
    const startMs = Number(spanLo) / 1e6;
    const endMs = Number(end) / 1e6;
    const lags: number[] = [];
    for (const s of sampler.samples) {
      if (s.bMs === null) continue;
      if (s.cMs < startMs - 1 || s.cMs > endMs + 1) continue;
      lags.push(s.cMs - s.bMs);
    }
    const lagP50 = pct(lags, 50);
    const lagP95 = pct(lags, 95);
    const lagP99 = pct(lags, 99);
    const lagMax = lags.length ? Math.max(...lags) : NaN;
    const negLags = lags.filter((l) => l < -1).length; // frame ahead of cursor (fine)

    // Queue depth during the in-window samples: are frames sitting in the blit
    // queue (cadence problem) or is the queue empty (delivery problem)?
    const inWin = sampler.samples.filter(
      (s) => s.bMs !== null && s.cMs >= startMs - 1 && s.cMs <= endMs + 1,
    );
    const blitQ = inWin.map((s) => s.bq);
    const decodeQ = inWin.map((s) => s.dq);
    const blitQzero = blitQ.filter((x) => x === 0).length;

    // ---- Cursor cadence (how coarse are the steps the worker blits against) -
    const perf = await page.evaluate(() => window.__drivelinePerf!.snapshot());
    const tickStarts = perf.entries
      .filter((e) => e.entryType === "mark" && e.name === "tick:start")
      .map((e) => e.startTime)
      .sort((a, b) => a - b);
    const tickGaps: number[] = [];
    for (let i = 1; i < tickStarts.length; i++)
      tickGaps.push(tickStarts[i] - tickStarts[i - 1]);
    const sceneFrame = perf.entries
      .filter((e) => e.entryType === "measure" && e.name === "scene-frame")
      .map((e) => e.duration);
    const overlayDraw = perf.entries
      .filter(
        (e) => e.entryType === "measure" && e.name === "video:overlay-draw",
      )
      .map((e) => e.duration);

    const report = {
      clip: { spanMs: Math.round(spanMs), playWallMs, expectedFrames },
      frameLoss: {
        drawnDelta,
        skippedDelta,
        droppedDelta,
        stragglerDelta,
        distinctShown,
      },
      missing: {
        total: missing.length,
        first1s: missFirst1s,
        last1s: missLast1s,
        middle: missMiddle,
        offsetsMs: missingOffsetsMs,
      },
      lagMs: {
        samples: lags.length,
        p50: +lagP50.toFixed(1),
        p95: +lagP95.toFixed(1),
        p99: +lagP99.toFixed(1),
        max: +lagMax.toFixed(1),
        negSamples: negLags,
      },
      queueDepth: {
        blitQp50: pct(blitQ, 50),
        blitQp95: pct(blitQ, 95),
        blitQmax: blitQ.length ? Math.max(...blitQ) : NaN,
        blitQzeroFrac: blitQ.length
          ? +(blitQzero / blitQ.length).toFixed(2)
          : NaN,
        decodeQp50: pct(decodeQ, 50),
        decodeQp95: pct(decodeQ, 95),
      },
      cursorCadenceMs: {
        ticks: tickGaps.length,
        p50: +pct(tickGaps, 50).toFixed(1),
        p95: +pct(tickGaps, 95).toFixed(1),
        max: tickGaps.length ? +Math.max(...tickGaps).toFixed(1) : NaN,
      },
      sceneFrameMs: {
        count: sceneFrame.length,
        p50: +pct(sceneFrame, 50).toFixed(1),
        p95: +pct(sceneFrame, 95).toFixed(1),
        max: sceneFrame.length ? +Math.max(...sceneFrame).toFixed(1) : NaN,
      },
      overlayDrawMs: {
        count: overlayDraw.length,
        p50: +pct(overlayDraw, 50).toFixed(1),
        p95: +pct(overlayDraw, 95).toFixed(1),
        max: overlayDraw.length ? +Math.max(...overlayDraw).toFixed(1) : NaN,
      },
    };
    console.log("FRAMELOSS_REPORT " + JSON.stringify(report, null, 2));

    // ---- Assertions (the user's bar) ----------------------------------------
    // 0 visualisation frame-loss, by exact worker-truth counters: nothing closed
    // undrawn (cursor jump-skip), nothing dropped by the queue, nothing dropped
    // as a reorder straggler — across the whole measured playthrough.
    expect(skippedDelta, "frames closed undrawn (cursor jump-skip)").toBe(0);
    expect(droppedDelta, "frames dropped by the queue-full policy").toBe(0);
    expect(stragglerDelta, "frames dropped as reorder stragglers").toBe(0);
    // Every frame in the span was actually painted. `drawnDelta` is the worker's
    // exact paint count; `distinctShown` is the independent in-page sampler.
    // Allow a 1-frame tolerance for the auto-pause boundary at end-of-clip.
    expect(
      drawnDelta,
      `frames painted vs ${expectedFrames} expected`,
    ).toBeGreaterThanOrEqual(expectedFrames - 1);
    expect(
      distinctShown,
      `distinct frames shown (sampler) vs ${expectedFrames}`,
    ).toBeGreaterThanOrEqual(expectedFrames - 2);
    // Lag budget: the on-canvas frame stays within 100 ms of the cursor (p95).
    expect(lags.length, "lag samples collected").toBeGreaterThan(50);
    expect(lagP95, "p95 lag (ms)").toBeLessThan(100);
  });
});
