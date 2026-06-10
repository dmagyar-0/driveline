// Visual verification for the video pan/zoom feature.
//
// Loads the comma2k19 dashcam (mp4 + sidecar), seeks to a frame, then:
//   1. zooms in with wheel events and asserts the canvas transform +
//      the `Reset zoom` button appear, screenshots the magnified frame.
//   2. clicks `Reset zoom` and asserts the zoom returns to 1× and the
//      button disappears, screenshots the restored frame.
//
// Underscore prefix keeps this out of normal CI — invoke directly:
//   pnpm --filter e2e exec playwright test _zoom-video.spec.ts
//
// Requires (see sample-data/realworld/README.md):
//   sample-data/realworld/comma2k19_seg10.mp4
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = {
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
const VIDEO_SOURCE_NAME = "comma2k19_seg10.mp4";
const VIDEO_NATIVE_ID = "1/video";

declare global {
  interface Window {
    __drivelineVideoZoom?: number;
  }
}

async function seekToOneSixthOfRange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const range = window.__drivelineDevHooks!.getSessionSnapshot().globalRange!;
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
        await page.evaluate(() =>
          window.__drivelineDevHooks!.videoLastBlitPtsNs(),
        ),
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .not.toBeNull();
}

async function paintAndSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.waitForTimeout(400);
}

// Dispatch a wheel-up on the canvas to zoom in. The panel registers a
// native, non-passive wheel listener on the canvas, so a synthetic
// WheelEvent drives the same code path a trackpad/mouse wheel would.
async function wheelZoom(page: Page, steps: number): Promise<void> {
  await page.evaluate((n) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      "[data-testid='video-panel-canvas']",
    );
    if (!canvas) throw new Error("canvas not found");
    const rect = canvas.getBoundingClientRect();
    // Anchor off-centre so the resulting pan is visible in the screenshot.
    const cx = rect.left + rect.width * 0.35;
    const cy = rect.top + rect.height * 0.4;
    for (let i = 0; i < n; i++) {
      canvas.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -120,
          clientX: cx,
          clientY: cy,
        }),
      );
    }
  }, steps);
}

test.describe("video pan/zoom", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "comma2k19 video fixtures missing — see sample-data/realworld/README.md",
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

  test("zooms the dashcam and resets back to fit", async ({ page }) => {
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
    }, REL);
    expect(open.errors).toEqual([]);

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

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await paintAndSettle(page);

    // Baseline: not zoomed, no reset button.
    await expect(page.getByTestId("video-zoom-reset")).toHaveCount(0);

    // Zoom in.
    await wheelZoom(page, 5);
    await paintAndSettle(page);

    const zoom = await page.evaluate(() => window.__drivelineVideoZoom ?? 1);
    expect(zoom, "wheel should magnify the frame").toBeGreaterThan(1.5);

    const transform = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>(
        "[data-testid='video-panel-canvas']",
      );
      return c?.style.transform ?? "";
    });
    expect(transform).toContain("scale(");

    await expect(page.getByTestId("video-zoom-reset")).toBeVisible();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "video-zoom-in.png"),
    });

    // Reset back to fit.
    await page.getByTestId("video-zoom-reset").click();
    await paintAndSettle(page);

    const zoomAfter = await page.evaluate(
      () => window.__drivelineVideoZoom ?? 1,
    );
    expect(zoomAfter, "reset returns to 1x").toBe(1);
    await expect(page.getByTestId("video-zoom-reset")).toHaveCount(0);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "video-zoom-reset.png"),
    });
  });
});
