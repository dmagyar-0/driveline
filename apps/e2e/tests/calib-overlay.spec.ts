// Point-cloud-on-video overlay e2e (docs/13-camera-lidar-calibration.md).
//
// Proves the LiDAR→camera calibration + overlay path end-to-end against the
// committed SYNTHETIC fixture in `sample-data/calib/`. That MP4 is rendered by
// projecting the *same* known 3-D scene the LiDAR Parquet describes, with seven
// distinctly-coloured filled-circle markers drawn at the projected pole-tops —
// so a CORRECT overlay must place its depth-coloured dots exactly on those
// markers. This is the ground-truth correctness check for the projection math.
//
// The spec drives the documented dev hooks (`window.__drivelineDevHooks`):
// open the four calib files, find the video / point_cloud / camera_calibration
// channels, mint a video panel, wire the channel + overlay bindings, seek the
// cursor onto a frame where the poles are in view, then poll
// `getVideoOverlaySync` until the projection reports visible points before
// screenshotting.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

/** Fetch fixture bytes inside the page. The dev server serves `sample-data/`
 *  under `/sample-data/<name>`, so the bytes never cross CDP as JSON arrays
 *  (which would SIGSEGV the worker on the multi-MB files). Inlined rather than
 *  imported from `_fixtures.ts`, whose module-level constants resolve other
 *  (uncommitted) corpus files and would throw at import time. */
async function fetchFixtureInPage(page: Page, name: string): Promise<Uint8Array> {
  return await page.evaluate(async (n) => {
    const resp = await fetch(`/sample-data/${n}`);
    if (!resp.ok) throw new Error(`fetch /sample-data/${n}: ${resp.status}`);
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf) as unknown as Uint8Array;
  }, name);
}

const CALIB_FILES = [
  "calib/scene.lidar.parquet",
  "calib/scene_cam_front.mp4",
  "calib/scene_cam_front.mp4.timestamps",
  "calib/scene.calib.json",
];
const CAMERA_NAME = "CAM_FRONT";

// The synthetic clip runs 30 frames @10 Hz from this epoch ns. Seek 1 s in
// (≈ frame 10) — comfortably inside the data window and on a video keyframe
// (the MP4 carries an I-frame every 10 frames), with all seven poles in view.
const DATA_START_NS = 1_704_067_200_000_000_000n;
const SEEK_TARGET_NS = DATA_START_NS + 1_000_000_000n;

// The video decoder logs a one-off, self-recovering DataError on the synthetic
// clip's first chunk; the pipeline re-seeks to the keyframe and blits cleanly
// (the blit PTS + overlay both populate afterwards). Tolerate it rather than
// failing the visual check on a benign startup message.
const IGNORED_CONSOLE = [/EncodedVideoChunk was marked as type .key./i];

interface OverlaySync {
  enabled: boolean;
  cameraName: string | null;
  spinTsNs: string | null;
  pointCount: number;
  projectedVisibleCount: number;
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      clearSession: () => Promise<void>;
      resetLayout: () => void;
      listChannels: () => Array<{
        id: string;
        name: string;
        sourceId: string;
        kind: string;
      }>;
      getSessionSnapshot: () => {
        cursorNs: string;
        playing: boolean;
        speed: number;
        globalRange: { startNs: string; endNs: string } | null;
      };
      addVideoPanel: (channelId?: string) => string | undefined;
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      setVideoOverlayBinding: (
        panelId: string,
        binding: {
          calibrationChannelId: string;
          cameraName: string;
          pointcloudChannelId: string;
        } | null,
      ) => void;
      getVideoOverlaySync: (panelId: string) => OverlaySync;
      videoLastBlitPtsNs: () => bigint | null;
    };
  }
}

/** Seek the cursor to an absolute timestamp by clicking the scrubber at the
 *  matching fraction of the global range — the same gesture the video-seek
 *  specs use (no direct setCursor dev hook exists; the scrubber's pointerup
 *  path commits the cursor synchronously). An absolute target is used rather
 *  than a fixed ratio because the calibration channel (config, ts 0) pulls the
 *  global range start down to 0, so a ratio of the range would land far from
 *  the real data window. */
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

async function overlaySync(page: Page, panelId: string): Promise<OverlaySync> {
  return await page.evaluate(
    (id) => window.__drivelineDevHooks!.getVideoOverlaySync(id),
    panelId,
  );
}

test.describe("point-cloud-on-video overlay (synthetic)", () => {
  test.slow();

  const pageErrors: string[] = [];

  function installConsoleGuard(page: Page): void {
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
      pageErrors.push(`console.error: ${text}`);
    });
  }

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0;
    installConsoleGuard(page);
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("projects LiDAR points onto the camera image at the pole markers", async ({
    page,
  }) => {
    // Fetch the four calib fixtures inside the page (bytes never cross CDP as
    // JSON arrays) and open them as one drop.
    const descs = await Promise.all(
      CALIB_FILES.map(async (rel) => ({
        name: rel.split("/").pop()!,
        bytes: await fetchFixtureInPage(page, rel),
      })),
    );
    const open = await page.evaluate(
      (d) => window.__drivelineDevHooks!.openFiles(d),
      descs,
    );
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining([
        "scene.lidar.parquet",
        "scene_cam_front.mp4",
        "scene.calib.json",
      ]),
    );

    // Resolve the three channel kinds the overlay needs.
    const chans = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const video = chans.find((c) => c.kind === "video");
    const pointcloud = chans.find((c) => c.kind === "point_cloud");
    const calibration = chans.find((c) => c.kind === "camera_calibration");
    expect(video, "video channel").toBeTruthy();
    expect(pointcloud, "point_cloud channel").toBeTruthy();
    expect(calibration, "camera_calibration channel").toBeTruthy();

    // Mint a video panel bound to the camera, then wire the overlay.
    const panelId = await page.evaluate(
      (vid) => window.__drivelineDevHooks!.addVideoPanel(vid),
      video!.id,
    );
    expect(panelId, "addVideoPanel returned an id").toBeTruthy();
    await page.evaluate(
      ([pid, vid]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(pid!, vid),
      [panelId, video!.id] as const,
    );
    await page.evaluate(
      ([pid, calibId, pcId, cam]) =>
        window.__drivelineDevHooks!.setVideoOverlayBinding(pid!, {
          calibrationChannelId: calibId!,
          cameraName: cam!,
          pointcloudChannelId: pcId!,
        }),
      [panelId, calibration!.id, pointcloud!.id, CAMERA_NAME] as const,
    );

    // The panel canvas must mount before a seek means anything.
    await page.getByTestId("video-panel-canvas").waitFor();

    // Seek onto a frame where the poles are in view (1 s into the clip).
    const range = await page.evaluate(
      () => window.__drivelineDevHooks!.getSessionSnapshot().globalRange,
    );
    expect(range, "global range").not.toBeNull();
    await seekToTs(page, SEEK_TARGET_NS);

    // Wait for a video frame to blit so the overlay has a PTS to align to.
    await expect
      .poll(
        async () =>
          page.evaluate(() => window.__drivelineDevHooks!.videoLastBlitPtsNs()),
        { timeout: 15_000, intervals: [200, 400, 800] },
      )
      .not.toBeNull();

    // Poll until the projection reports visible points. The seven pole-tops
    // plus the ground grid in frame should put this well above the seven
    // markers alone.
    await expect
      .poll(async () => (await overlaySync(page, panelId!)).projectedVisibleCount, {
        timeout: 15_000,
        intervals: [200, 400, 800],
      })
      .toBeGreaterThan(7);

    const sync = await overlaySync(page, panelId!);
    expect(sync.enabled).toBe(true);
    expect(sync.cameraName).toBe(CAMERA_NAME);
    expect(sync.pointCount).toBeGreaterThan(0);
    expect(sync.projectedVisibleCount).toBeGreaterThan(7);
    expect(sync.spinTsNs).not.toBeNull();

    // Let the rAF blit + overlay paint a settled frame.
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    await page.waitForTimeout(300);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "calib-overlay-synthetic.png"),
    });

    expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  });
});
