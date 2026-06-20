// Headless frame-pacing ("smoothness") MEASUREMENT harness for the nuScenes
// camera + LiDAR fusion dashboard. It exercises the new `CadenceSummary`
// telemetry the videoDecode worker now publishes on every blit (jitter, dwell
// distribution, repeats, backward steps, playback-rate ratio, smooth verdict)
// and surfaces it on the page via `window.__drivelineVideoCadence` /
// `window.__drivelineVideoHud.cadence`.
//
// This is a MEASUREMENT, not a gate: it loads the exact same five fusion
// outputs as `_fusion-frameloss.spec.ts`, lays out the same dashboard, plays
// the clip at 1× long enough for the worker's rolling dwell window to fill,
// then reads the cadence summary back and reports it. It asserts only that a
// summary was produced over a real number of paints — it does NOT yet assert
// smoothness. Underscore-prefixed so it stays out of the normal CI run; invoke
// directly against system Chrome:
//   pnpm --filter e2e exec playwright test _video-cadence.spec.ts \
//     --config=playwright.chrome.config.ts --project=chromium
//
// Requires the five nuScenes converter outputs in sample-data/realworld/
// (same set as _fusion-frameloss.spec.ts / _demo-nuscenes-fusion.spec.ts).

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same fixture set + relative paths as _fusion-frameloss.spec.ts.
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

// Where the machine-readable cadence result is written for a parent process.
const OUT_DIR = path.resolve(__dirname, "../test-results");
const OUT_FILE = path.join(OUT_DIR, "video-cadence.json");

// System Chrome — the bundled Chromium won't execute on this box (project
// note), and Chrome's HW H.264 decode is what we're actually exercising. This
// also lines up with playwright.chrome.config.ts.
test.use({
  channel: "chrome",
  viewport: { width: 1600, height: 900 },
});

// Mirror of the worker's CadenceSummary (all plain numbers + a boolean — no
// BigInt crosses the boundary, so the object survives page.evaluate as-is).
interface CadenceSummary {
  paints: number;
  sourceIntervalNs: number;
  idealDwellMs: number;
  p50DwellMs: number;
  p95DwellMs: number;
  maxDwellMs: number;
  minDwellMs: number;
  meanDwellMs: number;
  jitterMs: number;
  repeats: number;
  rushed: number;
  backwardSteps: number;
  playbackRateRatio: number;
  smooth: boolean;
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

// Read the live cadence summary off the page. Prefer the dedicated dev hook
// (falls back to the dedicated global and then the HUD snapshot's field), so
// the spec keeps working whichever surface a future refactor lands on.
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

test.describe("nuScenes fusion — frame-pacing (cadence) measurement", () => {
  test.slow();
  test.skip(
    !Object.values(ABS).every((p) => existsSync(p)),
    "nuScenes fixtures missing in sample-data/realworld/",
  );

  test("plays the clip and produces a cadence summary", async ({ page }) => {
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

    // Same dashboard layout as _fusion-frameloss.spec.ts.
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

    // Open all five outputs as one drop (identical to _fusion-frameloss).
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

    const { start, end } = await dataWindow(page);

    // Land near the start and let the decoder prime its lookahead before we
    // start playing, so the rolling cadence window measures continuous play.
    await seekToTs(page, start);
    await page.waitForTimeout(900);

    // Play the clip at 1×. Poll the cadence summary until the rolling dwell
    // window has filled (paints > 100) while keeping playback running for at
    // least ~15-20 s of wall clock. The clip auto-pauses at end-of-session; if
    // it ends before we hit the paint count we re-seek to the start and keep
    // playing so the window still fills.
    const spanMs = Number(end - start) / 1e6;
    await setPlaying(page, true);

    const deadline = Date.now() + 25_000;
    const minWallMs = 15_000;
    const playStartWall = Date.now();
    let cadence: CadenceSummary | null = null;
    while (Date.now() < deadline) {
      await page.waitForTimeout(500);
      // If the clip auto-paused at end-of-session before the window filled,
      // restart from the top and keep playing.
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

    const wallMs = Date.now() - playStartWall;
    const report = { clip: { spanMs: Math.round(spanMs), wallMs }, cadence };
    // Emit to stdout so a parent process can grep the line out, and persist a
    // machine-readable copy for downstream tooling.
    console.log("CADENCE_RESULT " + JSON.stringify(cadence));
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

    // Assertions: this spec MEASURES, it does not gate on smoothness yet.
    expect(cadence).not.toBeNull();
    expect(cadence!.paints).toBeGreaterThan(50);
  });
});
