// Regression: picking a (re)bound video track mid-session must blit the
// frame at the CURRENT cursor, not the session start.
//
// Bug: a VideoPanel is keyed by source:channel, so changing the bound channel
// remounts it. The mount effect opened the decoder at `globalRange.startNs`
// instead of `cursorNs`, so after parking the cursor mid-timeline and picking
// a track the panel showed frame 0 and only "caught up" once playback advanced
// the cursor far enough for the worker to reach it. The fix opens at the
// current cursor.
//
// Runs against the real 10 s 4K H.264 corpus from `sample-data/generate.py`
// (served at `/sample-data/short.mcap`), the same fixture `videoSeek.spec.ts`
// uses, so the assertion exercises the full decode → blit pipeline.

import { test, expect, type Page } from "@playwright/test";

interface SessionSnapshot {
  cursorNs: string;
  playing: boolean;
  speed: number;
  globalRange: { startNs: string; endNs: string } | null;
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
      getSessionSnapshot: () => SessionSnapshot;
      videoLastBlitPtsNs: () => string | null;
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      resetLayout: () => void;
      findChannelId: (q: { sourceName: string; nativeId: string }) =>
        | string
        | null;
    };
  }
}

const VIDEO_PANEL_ID = "video-1";
const VIDEO_NATIVE_ID = "/camera/front";
const VIDEO_SOURCE_NAME = "short.mcap";

// How close the blitted frame must sit to the cursor to count as "synced".
// The worker blits the newest frame whose PTS <= cursor, so on a 30 fps grid
// the on-screen frame trails the cursor by < one inter-frame distance. Allow
// 100 ms (mirrors READY_EPSILON_NS in the panel) for scheduling slop.
const SYNC_EPSILON_NS = 100_000_000n;

async function snapshot(page: Page): Promise<SessionSnapshot> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );
}

async function blitPtsNs(page: Page): Promise<bigint | null> {
  const s = await page.evaluate(() =>
    window.__drivelineDevHooks!.videoLastBlitPtsNs(),
  );
  return s === null ? null : BigInt(s);
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

async function clickScrubberAtRatio(page: Page, ratio: number): Promise<void> {
  await page.evaluate((r) => {
    const scrubber = document.querySelector<HTMLElement>(
      "[data-testid='scrubber']",
    );
    if (!scrubber) throw new Error("scrubber not found");
    const rect = scrubber.getBoundingClientRect();
    const x = rect.left + rect.width * r;
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
  }, ratio);
}

async function bindVideo(page: Page): Promise<void> {
  const channelId = await page.evaluate(
    ({ sourceName, nativeId }) =>
      window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
    { sourceName: VIDEO_SOURCE_NAME, nativeId: VIDEO_NATIVE_ID },
  );
  expect(channelId, "video channel must resolve").not.toBeNull();
  await page.evaluate(
    ([panelId, id]) =>
      window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
    [VIDEO_PANEL_ID, channelId!],
  );
}

test.describe("video track re-pick resyncs to cursor", () => {
  test.slow();

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

    const result = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mcap");
      if (!r.ok) throw new Error(`fetch mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);
    expect(result.opened).toEqual(["short.mcap"]);

    await bindVideo(page);
    await page.getByTestId("video-panel-canvas").waitFor();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("re-picking the track blits the cursor frame, not frame 0", async ({
    page,
  }, testInfo) => {
    // Wait for the initial frame at the session start to blit.
    await expect
      .poll(async () => (await blitPtsNs(page)) !== null, { timeout: 8_000 })
      .toBe(true);

    const s = await snapshot(page);
    expect(s.globalRange).not.toBeNull();
    const startNs = BigInt(s.globalRange!.startNs);
    const endNs = BigInt(s.globalRange!.endNs);
    const span = endNs - startNs;
    expect(span).toBeGreaterThan(5_000_000_000n); // a real multi-second corpus

    // Park the cursor ~halfway through the timeline (a frame far from start).
    await clickScrubberAtRatio(page, 0.5);
    await expect
      .poll(async () => BigInt((await snapshot(page)).cursorNs), {
        timeout: 3_000,
      })
      .not.toBe(startNs);
    const cursorNs = BigInt((await snapshot(page)).cursorNs);
    // Sanity: the parked cursor is well away from the start (so "frame 0 vs
    // cursor frame" is an unambiguous, multi-second difference).
    expect(absDiff(cursorNs, startNs)).toBeGreaterThan(2_000_000_000n);

    // The seek should land the displayed frame at the cursor before we re-pick.
    await expect
      .poll(
        async () => {
          const p = await blitPtsNs(page);
          return p !== null && absDiff(p, cursorNs) <= SYNC_EPSILON_NS;
        },
        { timeout: 8_000, intervals: [50, 100, 200] },
      )
      .toBe(true);
    // Let the OffscreenCanvas composite the blitted frame before capturing.
    await page.waitForTimeout(250);
    await page
      .getByTestId(`video-panel-${VIDEO_PANEL_ID}`)
      .screenshot({ path: testInfo.outputPath("01-before-repick.png") });

    // --- Re-pick the track exactly as the UI does: clear the binding (the
    // "Change channel" button), which unmounts the panel, then bind again. ---
    await page.evaluate(
      (panelId) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, null),
      VIDEO_PANEL_ID,
    );
    await page.getByTestId(`video-panel-${VIDEO_PANEL_ID}-empty`).waitFor();
    await bindVideo(page);
    await page.getByTestId("video-panel-canvas").waitFor();

    // The cursor has not moved — re-picking a track only remounts the panel.
    expect(BigInt((await snapshot(page)).cursorNs)).toBe(cursorNs);
    expect((await snapshot(page)).playing).toBe(false);

    // THE FIX: the freshly mounted panel must blit the frame at the cursor
    // without any playback. On the old code it opened at `startNs` and the
    // blit PTS sat near 0 until play advanced the cursor.
    await expect
      .poll(
        async () => {
          const p = await blitPtsNs(page);
          return p !== null && absDiff(p, cursorNs) <= SYNC_EPSILON_NS;
        },
        { timeout: 8_000, intervals: [50, 100, 200] },
      )
      .toBe(true);

    const after = await blitPtsNs(page);
    expect(after, "blit pts present after re-pick").not.toBeNull();
    // Explicit anti-regression: the displayed frame is NOT the session start.
    expect(absDiff(after!, startNs)).toBeGreaterThan(2_000_000_000n);
    expect(absDiff(after!, cursorNs)).toBeLessThanOrEqual(SYNC_EPSILON_NS);

    // Let the OffscreenCanvas composite the blitted frame before capturing.
    await page.waitForTimeout(250);
    await page
      .getByTestId(`video-panel-${VIDEO_PANEL_ID}`)
      .screenshot({ path: testInfo.outputPath("02-after-repick.png") });
  });
});
