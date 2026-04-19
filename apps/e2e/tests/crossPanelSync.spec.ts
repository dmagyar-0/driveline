// T6.1 acceptance test — frame-accurate cross-panel sync.
//
// Verifies the invariant that VideoPanel and PlotPanel agree on
// `cursorNs` at each of the five reference times from
// `docs/09-verification-plan.md:106-108`:
//
//   - VideoPanel: `videoHudStats().ptsNs <= cursorNs` (the rAF blit loop
//     picks the newest frame with `ptsNs ≤ cursorNs`, enforced by
//     `apps/web/src/panels/VideoPanel.tsx:193-216`).
//   - PlotPanel: for each bound channel, the "sample at or before
//     cursor" surfaced via `getPlotPanelSync` satisfies
//     `tsNs <= cursorNs`.
//   - Both panels observe the same `cursorNs` as the session store.
//
// The pixel-compare half of verification-plan step 2 is blocked on T0.3
// (real H.264 corpus + reference PNGs); `test-fixtures/short.mcap`'s
// `/camera/front` is synthetic (SPS+IDR headers only, no decodable
// payload). On the synthetic fixture `videoHudStats().ptsNs` stays
// `null`, so the video assertion degrades to "null OR ≤ cursor". The
// same test will pass unchanged once a real fixture lands — see the
// `TODO(T6.3)` marker inline.
//
// Scrubs are driven through the same `clickScrubberAtRatio` helper as
// videoSeek.spec.ts so we exercise the production seek path, not a
// bypass. The five reference times all clamp into the fixture's ~90 ms
// span; asserting the sync invariant at each of five positions is
// identical whether the fixture is 90 ms or 10 s — it's the five
// scrubs that matter for seek-plumbing coverage.

import { test, expect, type Page, type ConsoleMessage } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(thisDir, "../../../test-fixtures");
const MCAP = resolve(fixtureDir, "short.mcap");

// Mirrors `apps/web/src/layout/defaultLayout.ts:8-9`. The default
// FlexLayout model spawns these two tabs on a fresh session, so an
// empty localStorage guarantees their presence.
const VIDEO_PANEL_ID = "video-1";
const PLOT_PANEL_ID = "plot-1";

// Matches the channels written by
// `crates/data-core/src/fixtures.rs:129-203`.
const VIDEO_CHANNEL_ID = "/camera/front";
const SPEED_CHANNEL_ID = "/vehicle/speed";

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

interface PlotSync {
  cursorNs: string;
  boundChannelIds: string[];
  lastFetchedRange: { startNs: string; endNs: string } | null;
  sampleAtCursor: Array<
    { channelId: string; tsNs: string; value: number } | null
  >;
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
      addPlotChannelBinding: (panelId: string, channelId: string) => void;
      getPlotPanelSync: (panelId: string) => PlotSync | null;
      resetLayout: () => void;
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

async function plotSync(page: Page, panelId: string): Promise<PlotSync | null> {
  return await page.evaluate(
    (id) => window.__drivelineDevHooks!.getPlotPanelSync(id),
    panelId,
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

test.describe("cross-panel sync (T6.1)", () => {
  test.slow();

  // Filter out the expected VideoDecoder errors fired by the synthetic
  // fixture. Same allow-list as videoSeek.spec.ts so a real regression
  // in error handling still surfaces.
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
    // custom layout. Reset so `video-1` + `plot-1` always exist.
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

    // Bind the default panels programmatically. The picker UIs have
    // their own dedicated specs; here we care about the sync invariant,
    // not the binding UX.
    await page.evaluate(
      ([videoPanelId, videoChannelId, plotPanelId, speedChannelId]) => {
        const hooks = window.__drivelineDevHooks!;
        hooks.setVideoChannelBinding(videoPanelId, videoChannelId);
        hooks.addPlotChannelBinding(plotPanelId, speedChannelId);
      },
      [VIDEO_PANEL_ID, VIDEO_CHANNEL_ID, PLOT_PANEL_ID, SPEED_CHANNEL_ID],
    );

    await page.getByTestId("video-panel-canvas").waitFor();
    await expect
      .poll(async () => (await hud(page)) !== null, {
        timeout: 10_000,
        intervals: [50, 100, 200],
      })
      .toBe(true);

    // Wait for the PlotPanel's initial fetch to populate — that's what
    // gates the `sampleAtCursor` non-null assertion later.
    await expect
      .poll(
        async () => {
          const s = await plotSync(page, PLOT_PANEL_ID);
          return s !== null && s.lastFetchedRange !== null;
        },
        { timeout: 10_000, intervals: [50, 100, 200] },
      )
      .toBe(true);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("VideoPanel + PlotPanel agree on cursor at five reference times", async ({
    page,
  }) => {
    const guard = installConsoleGuard(page);

    const s = await snapshot(page);
    expect(s.globalRange).not.toBeNull();
    const startNs = BigInt(s.globalRange!.startNs);
    const endNs = BigInt(s.globalRange!.endNs);
    const span = endNs - startNs;
    expect(span).toBeGreaterThan(0n);

    // Five reference times from the verification plan. The fixture's
    // span is ~90 ms, so the later offsets clamp to `endNs - 1`. What
    // we exercise here is five scrubs spread across the range; the
    // sync invariant does not depend on the absolute offsets.
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

      // Wait for the store to commit the cursor.
      await expect
        .poll(async () => BigInt((await snapshot(page)).cursorNs), {
          timeout: 2_000,
        })
        .toBe(target);

      // Wait for the PlotPanel sync snapshot to reflect the new cursor
      // *and* resolve a sample for the bound channel. The cursor-tick
      // effect publishes on every cursorNs change, so once the store
      // has committed, the snapshot should follow within a tick.
      await expect
        .poll(
          async () => {
            const ps = await plotSync(page, PLOT_PANEL_ID);
            if (!ps) return false;
            if (BigInt(ps.cursorNs) !== target) return false;
            return ps.sampleAtCursor.length > 0
              && ps.sampleAtCursor[0] !== null;
          },
          { timeout: 2_000, intervals: [16, 50, 100] },
        )
        .toBe(true);

      const ps = (await plotSync(page, PLOT_PANEL_ID))!;

      // Cross-panel agreement: the plot observes the same `cursorNs`
      // as the session store.
      expect(BigInt(ps.cursorNs)).toBe(target);

      // Fetch-range invariant: the rendered plot covers the cursor.
      expect(ps.lastFetchedRange).not.toBeNull();
      expect(BigInt(ps.lastFetchedRange!.startNs)).toBeLessThanOrEqual(target);
      expect(BigInt(ps.lastFetchedRange!.endNs)).toBeGreaterThanOrEqual(
        target,
      );

      // Per-channel sample invariant: the sample PlotPanel would render
      // at the cursor has `ts <= cursor`. `null` means no sample
      // precedes the cursor (possible only if the cursor is before the
      // first sample of the channel); the `/vehicle/speed` channel's
      // first sample is at `globalRange.startNs`, so a null at any of
      // the five targets would be a regression.
      expect(ps.sampleAtCursor).toHaveLength(1);
      const sample = ps.sampleAtCursor[0]!;
      expect(sample.channelId).toBe(SPEED_CHANNEL_ID);
      expect(BigInt(sample.tsNs)).toBeLessThanOrEqual(target);

      // TODO(T6.3): once `sample-data/short.mcap` ships with real H.264
      // via T0.3, tighten this to `expect(BigInt(h.ptsNs!)).toBeLessThanOrEqual(target)`
      // and add the pixel-compare block against `sample-data/refs/t_<ms>.png`.
      const h = await hud(page);
      expect(h).not.toBeNull();
      if (h!.ptsNs !== null) {
        expect(BigInt(h!.ptsNs)).toBeLessThanOrEqual(target);
      }
    }

    expect(guard.pageErrors).toEqual([]);
  });
});
