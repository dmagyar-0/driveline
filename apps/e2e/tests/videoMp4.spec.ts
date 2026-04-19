// T5.3 acceptance test.
//
// Mirrors `videoSeek.spec.ts` but drops the committed mp4 + sidecar pair
// (`short.mp4` + `short.mp4.ts.bin`) instead of the mcap fixture. Asserts
// that the mp4 path wires end-to-end: VideoPanel mounts, the codec string
// gets derived from the avcC-prepended first keyframe, and the scrub-seek
// pipeline commits the cursor for the same five reference times used by
// T5.2.
//
// Like T5.2, the bundled fixture is synthetic — placeholder NAL payloads
// rather than a decodable bitstream — so `VideoDecoder` will raise
// `EncodingError`. The pixel-compare assertion from
// `docs/10-task-breakdown.md` T5.3 is deferred to a real-fixture follow-up.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(thisDir, "../../../test-fixtures");
const MP4 = resolve(fixtureDir, "short.mp4");
const SIDECAR = resolve(fixtureDir, "short.mp4.ts.bin");

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
    };
  }
}

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

    const mp4Bytes = Array.from(readFileSync(MP4));
    const sidecarBytes = Array.from(readFileSync(SIDECAR));
    const result = await page.evaluate(
      async (input) => {
        const materialised = input.map((d) => ({
          name: d.name,
          bytes: new Uint8Array(d.bytes),
        }));
        return await window.__drivelineDevHooks!.openFiles(materialised);
      },
      [
        { name: "short.mp4", bytes: mp4Bytes },
        { name: "short.mp4.ts.bin", bytes: sidecarBytes },
      ],
    );
    expect(result.errors).toEqual([]);
    // The pair opens as a single `mp4+sidecar` source; `opened` reports the
    // mp4 filename.
    expect(result.opened).toContain("short.mp4");

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
    const names = await page.getByTestId("source-name").allTextContents();
    expect(names.some((n) => n.includes("short.mp4"))).toBe(true);
  });

  test("codec string is derived from the fixture's SPS", async ({ page }) => {
    // The fixture SPS from `crates/data-core/src/fixtures.rs::DUMMY_SPS`
    // starts with `0x67 0x64 0x00 0x1e …` — NAL header then
    // profile=High (0x64) / flags=0x00 / level_idc=0x1e. The reader
    // prepends this SPS onto the first chunk, so
    // `codecStringFromSps` resolves to exactly `avc1.64001E`.
    await expect
      .poll(async () => (await hud(page))?.codec, {
        timeout: 5_000,
        intervals: [50, 100, 200],
      })
      .toBe("avc1.64001E");
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
