// Visual screenshot spec for the Transport UI/UX overhaul (issues
// #6-#9). Underscore prefix keeps it from running in the default
// `pnpm e2e` invocation; run explicitly:
//
//   pnpm --filter e2e test _transportRedesignScreenshots
//
// Captures:
//   1. Transport in the default (empty session) state — disabled, so
//      the new readout slot reads "--:--.---".
//   2. Transport with a single source loaded — the readout shows
//      "elapsed / total" in the new big mono.
//   3. Transport with three synthetic offset segments injected so the
//      segment ticks + "3 segments" badge are visible.
//   4. Transport in absolute mode — segmented control toggled so the
//      readout flips to wall-clock and the start/end labels become
//      HH:MM:SS.
//   5. A wider clip including the workspace so the segment ticks
//      can be eyeballed against the buffered/range strip.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

async function screenshotTransport(
  page: import("@playwright/test").Page,
  fileName: string,
  padTop = 6,
): Promise<void> {
  const bbox = await page.getByTestId("transport").boundingBox();
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, fileName),
    fullPage: false,
    clip: bbox
      ? {
          x: Math.max(0, bbox.x - 6),
          y: Math.max(0, bbox.y - padTop),
          width: bbox.width + 12,
          height: bbox.height + padTop + 6,
        }
      : undefined,
  });
}

test.describe("transport redesign", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("captures the redesigned transport across states", async ({ page }) => {
    // 1. Empty state.
    await expect(page.getByTestId("transport")).toBeVisible();
    await screenshotTransport(page, "transport-redesign-empty.png");

    // 2. Single source loaded — readout shows elapsed / total.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/short.mcap");
      await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes: mcap },
      ]);
    });
    await page.waitForFunction(
      () =>
        (window.__drivelineDevHooks!.getSessionSnapshot() as {
          globalRange: unknown;
        }).globalRange !== null,
    );
    await screenshotTransport(page, "transport-redesign-loaded.png");

    // 3. Three synthetic offset segments. We don't have multi-segment
    //    comma2k19 fixtures pre-built, so seed `sources` directly to
    //    exercise the segment-tick path.
    await page.evaluate(() => {
      type W = Window & {
        __zustandStore?: {
          setState: (s: unknown) => void;
          getState: () => unknown;
        };
      };
      // Access the store via the global devHooks → patched indirect.
      // We use a tiny escape hatch added below for tests.
      const w = window as unknown as W & {
        __drivelineDevHooks?: Record<string, (...a: unknown[]) => unknown>;
      };
      const seed = w.__drivelineDevHooks!.seedSegmentsForScreenshot as
        | undefined
        | ((segments: { start: number; end: number; name: string }[]) => void);
      if (!seed) {
        throw new Error("seedSegmentsForScreenshot dev hook missing");
      }
      const startMs = Date.UTC(2018, 6, 27, 6, 4, 0, 0);
      const startNs = BigInt(startMs) * 1_000_000n;
      const sec = 1_000_000_000n;
      const seg = [
        {
          start: Number(startNs),
          end: Number(startNs + 60n * sec),
          name: "segment-04.mcap",
        },
        {
          start: Number(startNs + 120n * sec),
          end: Number(startNs + 180n * sec),
          name: "segment-07.mcap",
        },
        {
          start: Number(startNs + 240n * sec),
          end: Number(startNs + 300n * sec),
          name: "segment-10.mcap",
        },
      ];
      seed(seg);
    });
    await screenshotTransport(page, "transport-redesign-segments.png");

    // 4. Absolute mode — flip the segmented control.
    await page.getByTestId("transport-mode-absolute").click();
    await screenshotTransport(page, "transport-redesign-absolute.png");

    // 5. Wide view including the workspace beneath so the segment
    //    ticks read against the rest of the app chrome.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "transport-redesign-wide.png"),
      fullPage: false,
    });
  });
});
