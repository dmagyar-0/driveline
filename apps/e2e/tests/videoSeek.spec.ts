// T5.2 acceptance test.
//
// The plan (`docs/09-verification-plan.md:56,144`) asks for scrub-seek to
// settle <250 ms at five reference times. Achieving that end-to-end needs a
// real H.264 MCAP fixture; the one in `test-fixtures/short.mcap` is
// synthetic — SPS/IDR NAL headers only, no decodable payload — so the
// browser's `VideoDecoder` will emit `EncodingError` rather than frames.
//
// This spec exercises everything around the decoder that T5.2 actually
// adds: the `videoHudStats` dev hook shape, the HUD toggle (button +
// focus-scoped `h` key), and the seek plumbing (scrubber→store→debounced
// worker `seek()` call path). The pts-convergence assertion lives on a
// follow-up task that ships a real H.264 fixture.
//
// All five reference times are still driven through the scrubber; we
// assert the cursor commits into the store. A page-error listener catches
// regressions in the seek worker contract.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(thisDir, "../../../test-fixtures");
const MCAP = resolve(fixtureDir, "short.mcap");

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

  // Filter out the expected VideoDecoder error fired by the synthetic
  // fixture — decoding fails, but everything around it still has to work.
  const IGNORED_ERRORS = [
    /VideoDecoder error: EncodingError/,
    /VideoDecoder error: OperationError/,
  ];

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

    const bytes = Array.from(readFileSync(MCAP));
    const result = await page.evaluate(
      async (input) => {
        const materialised = input.map((d) => ({
          name: d.name,
          bytes: new Uint8Array(d.bytes),
        }));
        return await window.__drivelineDevHooks!.openFiles(materialised);
      },
      [{ name: "short.mcap", bytes }],
    );
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
    // blits). We don't require a frame here — the synthetic fixture never
    // produces one — so accept either.
    expect(h!.ptsNs === null || typeof h!.ptsNs === "string").toBe(true);
    // The worker derives the codec from the first keyframe's SPS inside
    // `open()`, which is async; the panel writes `codecRef` after the
    // promise resolves. Poll until the HUD snapshot reflects it.
    // `short.mcap`'s synthetic SPS codes to `avc1.42C01E`.
    await expect
      .poll(async () => (await hud(page))?.codec, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe("avc1.42C01E");
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

    // The fixture span is ~90 ms so the "5s / 7.5s / 10s - 1/30" references
    // from the verification plan all clamp to `endNs - 1`. We still drive
    // each one through the scrubber — the goal here is to exercise the
    // seek plumbing five times, not to land on distinct timestamps.
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

    // Surface any unexpected error that fired during the run. The
    // synthetic-fixture decoder error is filtered out in
    // `installConsoleGuard`.
    expect(guard.pageErrors).toEqual([]);
  });
});
