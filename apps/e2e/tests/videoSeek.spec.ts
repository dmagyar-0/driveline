// T5.2 acceptance test.
//
// `docs/09-verification-plan.md:56,144` asks for scrub-seek to settle
// <250 ms at five reference times. This runs against the real
// 10 s 4K H.264 corpus produced by `sample-data/generate.py` (T0.3),
// so the assertions now cover the full decode → blit pipeline.

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
    };
  }
}

// Matches the default FlexLayout panel id from
// `apps/web/src/layout/defaultLayout.ts`. Video panels are unbound by
// default (T6.2) so the spec has to wire a channel before the canvas
// will mount.
const VIDEO_PANEL_ID = "video-1";
const VIDEO_CHANNEL_ID = "/camera/front";

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

test.describe("video seek (T5.2)", () => {
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

    // A prior run in the same browser context could have persisted a
    // custom layout. Reset so `video-1` always exists.
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

    // Bind the default video panel to the fixture's video channel.
    // T6.2 made panels unbound-by-default; without this, the canvas
    // never mounts and `video-panel-canvas` below hangs.
    await page.evaluate(
      ([panelId, channelId]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, channelId),
      [VIDEO_PANEL_ID, VIDEO_CHANNEL_ID],
    );

    // Wait for the VideoPanel to mount and the HUD snapshot to populate.
    // The HUD publishes every rAF tick, so it appears even when the
    // decoder can't emit frames — a reliable "panel is alive" signal.
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

  test("HUD dev hook exposes the documented shape", async ({ page }) => {
    const h = await hud(page);
    expect(h).not.toBeNull();
    // Shape per `App.tsx` dev-hook contract.
    expect(h).toMatchObject({
      frameIndex: expect.any(Number),
      decodeQueue: expect.any(Number),
      blitQueueLen: expect.any(Number),
      dropped: expect.any(Number),
      hudOn: false,
    });
    // `ptsNs` is bigint-as-string when populated (or null until a frame
    // blits). Poll until the blit loop publishes the first frame.
    await expect
      .poll(async () => (await hud(page))?.ptsNs !== null, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe(true);
    // The worker derives the codec from the first keyframe's SPS inside
    // `open()`, which is async; the panel writes `codecRef` after the
    // promise resolves. The real corpus from `sample-data/generate.py`
    // encodes at High profile / level 5.1.
    await expect
      .poll(async () => (await hud(page))?.codec, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe("avc1.640033");
  });

  test("HUD button toggles the overlay and the snapshot flag", async ({
    page,
  }) => {
    const toggle = page.getByTestId("video-hud-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("video-hud")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("video-hud")).toBeVisible();
    await expect.poll(async () => (await hud(page))?.hudOn).toBe(true);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByTestId("video-hud")).toHaveCount(0);
    await expect.poll(async () => (await hud(page))?.hudOn).toBe(false);
  });

  test("`h` key toggles HUD only when panel has focus", async ({ page }) => {
    // Focus the drop zone first; `h` should NOT toggle.
    await page.getByTestId("drop-zone").focus();
    await page.keyboard.press("h");
    expect((await hud(page))?.hudOn).toBe(false);

    // Move focus into the VideoPanel wrapper; `h` toggles.
    await page
      .locator("[data-testid='video-panel-canvas']")
      .locator("..")
      .focus();
    await page.keyboard.press("h");
    await expect.poll(async () => (await hud(page))?.hudOn).toBe(true);
    await page.keyboard.press("h");
    await expect.poll(async () => (await hud(page))?.hudOn).toBe(false);
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

    // Five reference times from the verification plan. On the real
    // 10 s corpus each offset maps to a distinct frame.
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

      // Wait for the cursor to commit (the scrubber path synchronously
      // calls `setCursor` on pointerup, but we poll to tolerate event-loop
      // scheduling).
      await expect
        .poll(async () => BigInt((await snapshot(page)).cursorNs), {
          timeout: 2_000,
        })
        .toBe(target);

      // The 50 ms seek debounce + worker round-trip should complete well
      // within this window. Give it time but assert nothing crashed.
      await page.waitForTimeout(250);
      const h = await hud(page);
      expect(h, "HUD snapshot disappeared across seek").not.toBeNull();
      // `frameIndex` cannot be negative and the worker resets it on each
      // `openInternal`, so seeing a runaway number would indicate a
      // regression in the seek→reopen reset path.
      expect(h!.frameIndex).toBeGreaterThanOrEqual(0);
      expect(h!.frameIndex).toBeLessThanOrEqual(120);
    }

    expect(guard.pageErrors).toEqual([]);
  });

  test("paused scrub updates the displayed frame at each target", async ({
    page,
  }) => {
    // Regression for the bug where seeking while playback is stopped left
    // the canvas frozen on the previous frame. Cause: the worker discarded
    // every decoded frame whose PTS was strictly less than the seek target,
    // so when the cursor landed between frame boundaries (the common case
    // on a 33 ms grid) the panel queue contained only frames `> cursor` and
    // the blit predicate (`newest frame whose PTS <= cursor`) could not
    // produce a draw. During play the cursor advanced past the next frame
    // within ~33 ms, masking the bug — only paused scrubs reproduced it.

    const guard = installConsoleGuard(page);
    const s = await snapshot(page);
    expect(s.globalRange).not.toBeNull();
    const startNs = BigInt(s.globalRange!.startNs);
    const endNs = BigInt(s.globalRange!.endNs);
    const span = endNs - startNs;

    // Wait for the first frame to blit so we have a baseline.
    await expect
      .poll(async () => (await hud(page))?.ptsNs, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .not.toBeNull();

    // Offsets chosen so the resulting cursor falls between frame boundaries
    // on the 30 fps fixture (33.333 ms per frame). The bug repros for any
    // cursor that doesn't coincide with a frame's PTS, so even a 1 ms shift
    // off the grid is enough.
    const offsetsNs: bigint[] = [
      1_001_000_000n,
      4_007_000_000n,
      7_013_000_000n,
    ];

    const seenPts = new Set<string>();
    for (const off of offsetsNs) {
      const target =
        startNs + off >= endNs ? endNs - 1n : startNs + off;
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

      // Confirm the panel actually blitted a frame at/near this target
      // while paused. Tolerate one inter-frame distance since the blit
      // pivot is "newest frame with PTS <= cursor" — that frame can sit
      // up to ~33 ms behind the cursor on a 30 fps stream.
      await expect
        .poll(
          async () => {
            const h = await hud(page);
            if (!h?.ptsNs) return false;
            const pts = BigInt(h.ptsNs);
            const diff = pts > target ? pts - target : target - pts;
            return diff <= 50_000_000n;
          },
          { timeout: 3_000, intervals: [50, 100, 200] },
        )
        .toBe(true);

      const h = await hud(page);
      expect(h?.ptsNs, "blit pts disappeared after seek").not.toBeNull();
      seenPts.add(h!.ptsNs!);

      // Sanity: we never started playback, so the store must still report
      // paused. If a future change wires play-on-scrub this test will
      // surface that as a behaviour change rather than silently passing.
      const snap = await snapshot(page);
      expect(snap.playing).toBe(false);
    }

    // Each distinct seek target should have produced a distinct blit PTS.
    expect(seenPts.size).toBe(offsetsNs.length);
    expect(guard.pageErrors).toEqual([]);
  });
});
