// T5.3 acceptance test.
//
// Mirrors `videoSeek.spec.ts` but drops the committed mp4 + sidecar
// pair (`short.mp4` + `short.mp4.timestamps`) instead of the mcap fixture.
// Runs against the real 10 s 4K H.264 corpus produced by
// `sample-data/generate.py` (T0.3).

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";

interface SessionSnapshot {
  cursorNs: string;
  playing: boolean;
  speed: number;
  globalRange: { startNs: string; endNs: string } | null;
}

interface HudStats {
  ptsNs: string | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  codec: string | null;
  hudOn: boolean;
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
      videoHudStats: () => HudStats | null;
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      resetLayout: () => void;
      listSources: () => Array<{ id: string; name: string }>;
      findChannelId: (q: { sourceName: string; nativeId: string }) =>
        string | null;
    };
  }
}

// Matches the default FlexLayout panel id from
// `apps/web/src/layout/defaultLayout.ts`. T6.2 made video panels
// unbound by default, so the spec binds the channel explicitly. The
// mp4-sidecar channel id is `"<track_id>/video"`; `short.mp4` is
// written with a single video track at `track_id = 1` (see
// `crates/data-core/src/fixtures.rs::short_mp4_bytes`).
const VIDEO_PANEL_ID = "video-1";
const VIDEO_NATIVE_ID = "1/video";
const VIDEO_SOURCE_NAME = "short.mp4";

async function snapshot(page: Page): Promise<SessionSnapshot> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );
}

async function hud(page: Page): Promise<HudStats | null> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.videoHudStats(),
  );
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

test.describe("video mp4 + sidecar (T5.3)", () => {
  test.slow();

  const IGNORED_ERRORS: RegExp[] = [];

  function installConsoleGuard(page: Page): { pageErrors: string[] } {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m: ConsoleMessage) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (IGNORED_ERRORS.some((re) => re.test(text))) return;
      pageErrors.push(`console.error: ${text}`);
    });
    return { pageErrors };
  }

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );

    // Reset any layout persisted from a prior run so `video-1` exists.
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

    const result = await page.evaluate(async () => {
      const names = ["short.mp4", "short.mp4.timestamps"];
      const descs = await Promise.all(
        names.map(async (n) => {
          const r = await fetch(`/sample-data/${n}`);
          if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
          return { name: n, bytes: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    });
    expect(result.errors).toEqual([]);
    // The pair opens as a single `mp4+sidecar` source; `opened` reports the
    // mp4 filename.
    expect(result.opened).toContain("short.mp4");

    // Bind the default video panel to the mp4's video channel. T6.2
    // made panels unbound by default; without this the canvas never
    // mounts. Resolve the qualified channel id at runtime — PR #84b08ee
    // changed `Channel.id` from the native form to
    // `qualifiedChannelId(sourceId, nativeId)`, so hardcoding the native
    // id no longer binds.
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

    await page.getByTestId("video-panel-canvas").waitFor();
    await expect
      .poll(async () => (await hud(page)) !== null, {
        timeout: 10_000,
        intervals: [50, 100, 200],
      })
      .toBe(true);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("source list shows the mp4 source", async ({ page }) => {
    const names = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources().map((s) => s.name),
    );
    expect(names.some((n) => n.includes("short.mp4"))).toBe(true);
  });

  test("codec string is derived from the fixture's SPS", async ({ page }) => {
    // The real corpus SPS (produced by `sample-data/generate.py` via x264
    // at 3840x2160) carries profile_idc=0x64 (High), flags=0x00, and
    // level_idc=0x33 (level 5.1, required for 4K). `codecStringFromSps`
    // renders that triplet as `avc1.640033`.
    await expect
      .poll(async () => (await hud(page))?.codec, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe("avc1.640033");
  });

  test("scrubber seek commits cursor to each of five reference times", async ({
    page,
  }) => {
    const guard = installConsoleGuard(page);

    const s = await snapshot(page);
    expect(s.globalRange).not.toBeNull();
    const startNs = BigInt(s.globalRange!.startNs);
    const endNs = BigInt(s.globalRange!.endNs);
    const span = endNs - startNs;
    expect(span).toBeGreaterThan(0n);

    // The mp4 fixture span is ~300 ms (10 frames @ 30 fps), so the larger
    // reference offsets clamp to `endNs - 1`. Still drive the scrubber five
    // times — we're exercising the seek plumbing, not landing on distinct
    // timestamps.
    const refOffsetsNs: bigint[] = [
      0n,
      2_500_000_000n,
      5_000_000_000n,
      7_500_000_000n,
      10_000_000_000n - 33_333_333n,
    ];
    const targets = refOffsetsNs.map((off) => {
      const t = startNs + off;
      return t >= endNs ? endNs - 1n : t;
    });

    for (const target of targets) {
      const ratio = Math.min(
        1,
        Math.max(0, Number(target - startNs) / Number(span)),
      );
      await clickScrubberAtRatio(page, ratio);

      await expect
        .poll(async () => BigInt((await snapshot(page)).cursorNs), {
          timeout: 2_000,
        })
        .toBe(target);

      await page.waitForTimeout(250);
      const h = await hud(page);
      expect(h, "HUD snapshot disappeared across seek").not.toBeNull();
      expect(h!.frameIndex).toBeGreaterThanOrEqual(0);
      expect(h!.frameIndex).toBeLessThanOrEqual(120);
    }

    expect(guard.pageErrors).toEqual([]);
  });
});
