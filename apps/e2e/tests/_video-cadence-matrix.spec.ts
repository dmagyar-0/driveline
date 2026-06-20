// Frame-pacing ("judder") ISOLATION matrix. Where `_video-cadence.spec.ts`
// measures the single heavy nuScenes fusion dashboard, this spec runs the SAME
// cadence telemetry (`window.__drivelineVideoCadence`, a `CadenceSummary`) across
// three deliberately-different configurations so the cause of any judder can be
// localised by comparison rather than guessed:
//
//   1. "fusion"     — nuScenes video + LiDAR scene + plot. Heaviest main-thread
//                     render load (identical layout/bindings to
//                     _video-cadence.spec.ts). Baseline.
//   2. "video-only" — the SAME nuScenes sources, but a layout containing ONLY
//                     the video panel: no scene panel, no plot panel, so the
//                     main thread is not rendering LiDAR or uPlot. Isolates
//                     main-thread render LOAD vs the video path itself.
//   3. "comma2k19"  — the comma2k19 dashcam clip (video + one plot), a UNIFORM
//                     20 fps (50 ms) source. A regularity control: a perfectly
//                     even source isolates the SOURCE's contribution to jitter.
//
// Comparing player-error spread (`playerErrStdMs` / `playerErrStdRegularMs`)
// and source jitter (`sourceJitterMs`) across the three tells whether residual
// judder is the main thread, the video path, or an irregular source — but THIS
// spec only records the numbers; it does not interpret them.
//
// MEASUREMENT, not a gate: each test asserts only that a summary was produced
// over a real number of paints. Underscore-prefixed so it stays out of normal
// CI. Invoke against system Chrome (serialized — the heavy GPU/decoder work
// doesn't share a box well):
//   pnpm exec playwright test --config=playwright.chrome.config.ts \
//     --headed --workers=1 _video-cadence-matrix.spec.ts
//
// Each test self-skips (and reports the skip) if its fixtures are absent.
// Per-key results are emitted two ways: a `CADENCE_RESULT_<key> {json}` stdout
// line a parent process can grep, and `test-results/cadence-<key>.json` on disk.

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SAMPLE_DATA = path.resolve(__dirname, "../../../sample-data");
const OUT_DIR = path.resolve(__dirname, "../test-results");

// nuScenes fusion fixture set + relative paths (same as _video-cadence.spec.ts
// / _fusion-frameloss.spec.ts). Shared by the "fusion" and "video-only" cases.
const NUSCENES_REL = {
  lidar: "realworld/nuscenes.lidar.parquet",
  mp4: "realworld/nuscenes_cam_front.mp4",
  ts: "realworld/nuscenes_cam_front.mp4.timestamps",
  calib: "realworld/nuscenes_cam_front.calib.json",
  signals: "realworld/nuscenes.signals.mcap",
};
const NUSCENES_CAMERA_NAME = "CAM_FRONT";
const NUSCENES_PLOT_SIGNALS = ["/ego/speed", "/ego/yaw_rate"];

// comma2k19 dashcam fixture set (model: _demo-comma2k19-video.spec.ts). The
// mp4 + sidecar pair as one source, the mcap as a second (signals from MCAP).
const COMMA_REL = {
  mcap: "realworld/comma2k19.mcap",
  mp4: "realworld/comma2k19_seg10.mp4",
  ts: "realworld/comma2k19_seg10.mp4.timestamps",
};
const COMMA_VIDEO_SOURCE_NAME = "comma2k19_seg10.mp4";
const COMMA_VIDEO_NATIVE_ID = "1/video";
const COMMA_PLOT_SIGNALS = ["/vehicle/speed", "/vehicle/steering_angle"];

const VIDEO_PANEL = "video-overlay";
const SCENE_PANEL = "scene-lidar";
const PLOT_PANEL = "plot-ego";

// Cadence telemetry crosses page.evaluate as plain numbers + a boolean (no
// BigInt), so the object survives as-is. We keep the type loose: this spec
// records whatever the worker publishes and re-serialises it verbatim, so it
// must not drift if the worker grows the summary. The fields the operator reads
// out (playerErrStdMs, sourceJitterMs, regularPairs, …) all live on it.
type CadenceSummary = Record<string, unknown> & { paints?: number };

function relToAbs(rel: Record<string, string>): string[] {
  return Object.values(rel).map((v) => path.resolve(SAMPLE_DATA, v));
}

// Read the live cadence summary off the page. Prefer the dedicated dev hook,
// then the dedicated global, then the HUD snapshot's field — mirrors the
// fallback chain in _video-cadence.spec.ts so it survives a surface refactor.
async function readCadence(page: Page): Promise<CadenceSummary | null> {
  return (await page.evaluate(() => {
    const w = window as unknown as {
      __drivelineDevHooks?: { videoCadence?: () => unknown };
      __drivelineVideoCadence?: unknown;
      __drivelineVideoHud?: { cadence?: unknown };
    };
    return (
      w.__drivelineDevHooks?.videoCadence?.() ??
      w.__drivelineVideoCadence ??
      w.__drivelineVideoHud?.cadence ??
      null
    );
  })) as CadenceSummary | null;
}

// Click the scrubber at the wall ratio for a given absolute ns timestamp.
// Identical mechanism to _video-cadence.spec.ts.
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

// Fetch the mp4 sidecar and return the [start, end] ns span of the video.
async function videoSpan(
  page: Page,
  sidecarRel: string,
): Promise<{ start: bigint; end: bigint }> {
  const text = await page.evaluate(async (rel) => {
    const r = await fetch(`/sample-data/${rel}`);
    if (!r.ok) throw new Error(`sidecar fetch: ${r.status}`);
    return await r.text();
  }, sidecarRel);
  const ts = text
    .trim()
    .split("\n")
    .map((l) => BigInt(l.split("\t")[1]));
  return { start: ts[0], end: ts[ts.length - 1] };
}

// Go to the worker-ready home page with an empty session + reset layout.
async function boot(page: Page): Promise<void> {
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
}

// Open a set of sample-data files as one drop (same fetch→openFiles dance the
// reference specs use). Returns the dev-hook OpenResult.
async function openSampleFiles(
  page: Page,
  rels: Record<string, string>,
): Promise<{ opened: string[]; errors: unknown[] }> {
  return (await page.evaluate(async (r) => {
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
  }, rels)) as { opened: string[]; errors: unknown[] };
}

// Drive the layout to its starting frame, play at 1×, and poll the cadence
// summary until the rolling dwell window has filled (paints > 100) AND ≥15 s of
// wall clock has elapsed (~25 s deadline). If the clip auto-pauses at
// end-of-session before the window fills, re-seek to the top and keep playing —
// so a short clip still produces a full window. Returns the last summary read.
async function playAndMeasure(
  page: Page,
  start: bigint,
): Promise<{ cadence: CadenceSummary | null; wallMs: number }> {
  await seekToTs(page, start);
  await page.waitForTimeout(900); // let the decoder prime its lookahead

  await setPlaying(page, true);
  const playStartWall = Date.now();
  const deadline = playStartWall + 25_000;
  const minWallMs = 15_000;
  let cadence: CadenceSummary | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const playing = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
    );
    if (!playing) {
      await seekToTs(page, start);
      await setPlaying(page, true);
    }
    cadence = await readCadence(page);
    const enoughPaints = (cadence?.paints ?? 0) > 100;
    const enoughWall = Date.now() - playStartWall >= minWallMs;
    if (enoughPaints && enoughWall) break;
  }
  await setPlaying(page, false);
  cadence = (await readCadence(page)) ?? cadence;
  return { cadence, wallMs: Date.now() - playStartWall };
}

// Emit a per-key result both ways: a greppable stdout line and a JSON file.
function recordResult(
  key: string,
  cadence: CadenceSummary | null,
  extra: Record<string, unknown>,
): void {
  console.log(`CADENCE_RESULT_${key} ` + JSON.stringify(cadence));
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, `cadence-${key}.json`),
    JSON.stringify({ key, ...extra, cadence }, null, 2),
  );
}

// Raw per-paint cadence trace (dwellMs/stepMs/leadDepth arrays). Pull-based:
// proxies the videoDecode worker's `getCadenceTrace` over the
// `window.__drivelineVideoCadenceTrace` dev hook. Written to
// `test-results/trace-<key>.json` for offline structure analysis. The hook is
// async and returns null when no video panel is mounted / the method is
// missing, so this records `null` rather than throwing in that case.
async function dumpTrace(page: Page, key: string): Promise<void> {
  const trace = await page.evaluate(() =>
    (
      window as unknown as {
        __drivelineVideoCadenceTrace?: () => Promise<{
          dwellMs: number[];
          stepMs: number[];
          leadDepth: number[];
        } | null>;
      }
    ).__drivelineVideoCadenceTrace?.(),
  );
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, `trace-${key}.json`),
    JSON.stringify(trace ?? null),
  );
}

test.use({
  channel: "chrome",
  viewport: { width: 1600, height: 900 },
});

test.describe("video cadence matrix — judder isolation", () => {
  test.slow();

  // ── 1. fusion: video + scene(lidar) + plot (heaviest main-thread load) ──
  test("cadence [fusion] nuScenes video + scene + plot", async ({ page }) => {
    test.skip(
      !relToAbs(NUSCENES_REL).every((p) => existsSync(p)),
      "nuScenes fusion fixtures missing in sample-data/realworld/ — skipping [fusion]",
    );

    await boot(page);

    // Same dashboard layout as _video-cadence.spec.ts: video left, scene +
    // plot stacked right.
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

    const open = await openSampleFiles(page, NUSCENES_REL);
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
      ([pid, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_PANEL, video!.id] as const,
    );
    await page.evaluate(
      ([pid, calibId, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(pid, {
          calibrationChannelId: calibId,
          cameraName: cam,
          pointcloudChannelId: pcId,
        }),
      [VIDEO_PANEL, calibration!.id, pointcloud!.id, NUSCENES_CAMERA_NAME] as const,
    );
    await page.evaluate(
      ([pid, id]) => window.__drivelineDevHooks!.setSceneChannelBinding(pid, id),
      [SCENE_PANEL, pointcloud!.id] as const,
    );
    const plotIds = NUSCENES_PLOT_SIGNALS.map((name) => {
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

    const { start, end } = await videoSpan(page, NUSCENES_REL.ts);
    const { cadence, wallMs } = await playAndMeasure(page, start);

    recordResult("fusion", cadence, {
      config: "nuScenes video + scene(lidar) + plot",
      headed: !!test.info().project.use.headless === false,
      clip: { spanMs: Math.round(Number(end - start) / 1e6), wallMs },
    });
    await dumpTrace(page, "fusion");

    expect(cadence).not.toBeNull();
    expect(cadence!.paints ?? 0).toBeGreaterThan(50);
  });

  // ── 2. video-only: SAME nuScenes sources, ONLY the video panel ──
  // No scene panel and no plot panel → the main thread renders neither LiDAR
  // nor uPlot. The video channel + overlay bindings are still set (allowed),
  // but with no scene/plot panel to consume them the main-thread render load is
  // isolated away. Comparing this to [fusion] separates main-thread render LOAD
  // from the video path itself.
  test("cadence [video-only] nuScenes video panel alone", async ({ page }) => {
    test.skip(
      !relToAbs(NUSCENES_REL).every((p) => existsSync(p)),
      "nuScenes fusion fixtures missing in sample-data/realworld/ — skipping [video-only]",
    );

    await boot(page);

    // Single-panel layout: just the video. No scene, no plot.
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
            weight: 100,
            children: [
              {
                type: "tab",
                id: VIDEO_PANEL,
                name: "CAM_FRONT",
                component: "video",
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

    const open = await openSampleFiles(page, NUSCENES_REL);
    expect(open.errors).toEqual([]);

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const video = channels.find((c) => c.kind === "video");
    const pointcloud = channels.find((c) => c.kind === "point_cloud");
    const calibration = channels.find((c) => c.kind === "camera_calibration");
    expect(video, "video channel").toBeTruthy();

    await page.evaluate(
      ([pid, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_PANEL, video!.id] as const,
    );
    // Overlay binding is still set (the prompt allows it) — but there is no
    // SCENE panel and no PLOT panel, so the main thread isn't rendering LiDAR
    // point clouds or uPlot series.
    if (pointcloud && calibration) {
      await page.evaluate(
        ([pid, calibId, pcId, cam]) =>
          window.__drivelineDevHooks!.setVideoOverlayBinding(pid, {
            calibrationChannelId: calibId,
            cameraName: cam,
            pointcloudChannelId: pcId,
          }),
        [
          VIDEO_PANEL,
          calibration.id,
          pointcloud.id,
          NUSCENES_CAMERA_NAME,
        ] as const,
      );
    }

    const { start, end } = await videoSpan(page, NUSCENES_REL.ts);
    const { cadence, wallMs } = await playAndMeasure(page, start);

    recordResult("video-only", cadence, {
      config: "nuScenes video panel only (no scene, no plot)",
      headed: !!test.info().project.use.headless === false,
      clip: { spanMs: Math.round(Number(end - start) / 1e6), wallMs },
    });

    expect(cadence).not.toBeNull();
    expect(cadence!.paints ?? 0).toBeGreaterThan(50);
  });

  // ── 3. comma2k19: uniform 20 fps source (video + plot) — regularity control ──
  test("cadence [comma2k19] dashcam video + plot", async ({ page }) => {
    test.skip(
      !relToAbs(COMMA_REL).every((p) => existsSync(p)),
      "comma2k19 fixtures missing in sample-data/realworld/ — skipping [comma2k19]",
    );

    await boot(page);

    // Video left, one plot right.
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
            weight: 62,
            children: [
              {
                type: "tab",
                id: VIDEO_PANEL,
                name: "Dashcam",
                component: "video",
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
                name: "Speed · steering",
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

    const open = await openSampleFiles(page, COMMA_REL);
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining(["comma2k19.mcap", "comma2k19_seg10.mp4"]),
    );

    const videoChId = await page.evaluate(
      ({ sourceName, nativeId }) =>
        window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
      { sourceName: COMMA_VIDEO_SOURCE_NAME, nativeId: COMMA_VIDEO_NATIVE_ID },
    );
    expect(videoChId, "video channel must resolve").not.toBeNull();
    await page.evaluate(
      ([pid, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_PANEL, videoChId!] as const,
    );

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const byName = new Map(channels.map((c) => [c.name, c]));
    const plotIds = COMMA_PLOT_SIGNALS.map((name) => {
      const ch = byName.get(name);
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

    const { start, end } = await videoSpan(page, COMMA_REL.ts);
    const { cadence, wallMs } = await playAndMeasure(page, start);

    recordResult("comma2k19", cadence, {
      config: "comma2k19 dashcam video + plot (uniform 20 fps source)",
      headed: !!test.info().project.use.headless === false,
      clip: { spanMs: Math.round(Number(end - start) / 1e6), wallMs },
    });
    await dumpTrace(page, "comma2k19");

    expect(cadence).not.toBeNull();
    expect(cadence!.paints ?? 0).toBeGreaterThan(50);
  });
});
