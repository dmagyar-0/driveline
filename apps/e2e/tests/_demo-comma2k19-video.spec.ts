// Ad-hoc visualisation specs for the real-world comma2k19 segment 10.
//
// Two tests:
//   1. "renders video frame alongside speed + steering plot" — drops
//      mp4 + sidecar + mcap (signals from MCAP only).
//   2. "renders cross-source plot from MCAP and MF4 together" — same
//      drop plus comma2k19.mf4, with the plot panel bound to one
//      channel from each format.
//
// Underscore prefix keeps this out of normal CI runs — invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-video.spec.ts
//
// Requires (manual prep, see sample-data/realworld/README.md):
//   sample-data/realworld/comma2k19.mcap               (python3 scripts/convert_comma2k19_to_mcap.py)
//   sample-data/realworld/comma2k19.mf4                (python3 scripts/convert_comma2k19_to_mf4.py)
//   sample-data/realworld/comma2k19_seg10.mp4          (ffmpeg from HF compression_challenge HEVC)
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps  (one line per frame @ 20 fps anchored to segment start)

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = {
  mcap: "realworld/comma2k19.mcap",
  mf4: "realworld/comma2k19.mf4",
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
const PLOT_PANEL_ID = "plot-1";
const VIDEO_SOURCE_NAME = "comma2k19_seg10.mp4";
const VIDEO_NATIVE_ID = "1/video";

async function seekToOneSixthOfRange(page: Page): Promise<void> {
  await page.evaluate(() => {
    const range = window
      .__drivelineDevHooks!.getSessionSnapshot()
      .globalRange!;
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
        await page.evaluate(
          () => window.__drivelineDevHooks!.videoLastBlitPtsNs(),
        ),
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .not.toBeNull();
}

async function waitForPlotSeries(
  page: Page,
  panelId: string,
  expectedCount: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const s = await page.evaluate(
          (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
          panelId,
        );
        return (
          s !== null &&
          s.length === expectedCount &&
          s.every((x) => x.count > 0)
        );
      },
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .toBe(true);
}

async function paintAndSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.waitForTimeout(800);
}

test.describe("comma2k19 dashcam + CAN", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "comma2k19 fixtures missing — see sample-data/realworld/README.md",
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

  test("renders video frame alongside speed + steering plot", async ({
    page,
  }) => {
    const rels = { mcap: REL.mcap, mp4: REL.mp4, ts: REL.ts };
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
    }, rels);
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining(["comma2k19.mcap", "comma2k19_seg10.mp4"]),
    );

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

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const byName = new Map(channels.map((c) => [c.name, c]));
    const speed = byName.get("/vehicle/speed")!;
    const steer = byName.get("/vehicle/steering_angle")!;
    await page.evaluate(
      ([panelId, sId, stId]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, sId);
        h.addPlotChannelBinding(panelId, stId);
      },
      [PLOT_PANEL_ID, speed.id, steer.id],
    );

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-video-plus-signals.png"),
    });
  });

  test("renders cross-source plot from MCAP and MF4 together", async ({
    page,
  }) => {
    test.skip(
      !existsSync(ABS.mf4),
      "comma2k19.mf4 missing — run scripts/convert_comma2k19_to_mf4.py",
    );

    // All four files in one drop: mp4 + sidecar pair as one source, the
    // mcap as a second, the mf4 as a third. The UI status line ends up
    // reading "3 sources".
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
    expect(open.opened).toEqual(
      expect.arrayContaining([
        "comma2k19.mcap",
        "comma2k19.mf4",
        "comma2k19_seg10.mp4",
      ]),
    );

    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources().map((s) => s.name),
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.stringContaining("comma2k19.mcap"),
        expect.stringContaining("comma2k19.mf4"),
        expect.stringContaining("comma2k19_seg10.mp4"),
      ]),
    );

    const videoChId = await page.evaluate(
      ({ sourceName, nativeId }) =>
        window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
      { sourceName: VIDEO_SOURCE_NAME, nativeId: VIDEO_NATIVE_ID },
    );
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_PANEL_ID, videoChId!],
    );

    // Pick one scalar from each source and put them on the same plot.
    // /vehicle/speed (MCAP) is the chassis CAN speed in m/s; the four
    // wheel speeds in MF4 are in the same unit, so the legend sits on
    // a single y-axis and the lines tell the story (chassis ≈ wheels
    // outside of slip events).
    const all = await page.evaluate(() =>
      window
        .__drivelineDevHooks!.listChannels()
        .map((c) => ({ id: c.id, name: c.name, sourceId: c.sourceId })),
    );
    const sourceNames = await page.evaluate(() =>
      Object.fromEntries(
        window
          .__drivelineDevHooks!.listSources()
          .map((s) => [s.id, s.name]),
      ),
    );
    const find = (sourceMatch: RegExp, name: string) =>
      all.find(
        (c) =>
          c.name === name && sourceMatch.test(sourceNames[c.sourceId] ?? ""),
      );

    const mcapSpeed = find(/\.mcap/, "/vehicle/speed");
    const mf4Wheel = find(/\.mf4/, "WheelSpeedFL");
    expect(mcapSpeed, "MCAP /vehicle/speed").toBeDefined();
    expect(mf4Wheel, "MF4 WheelSpeedFL").toBeDefined();

    await page.evaluate(
      ([panelId, a, b]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, a);
        h.addPlotChannelBinding(panelId, b);
      },
      [PLOT_PANEL_ID, mcapSpeed!.id, mf4Wheel!.id],
    );

    await seekToOneSixthOfRange(page);
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, PLOT_PANEL_ID, 2);
    await paintAndSettle(page);

    // Per-series stats keyed by channel id — both ids must report
    // count > 0, which can only happen if the cross-source merge ran.
    const stats = await page.evaluate(
      (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
      PLOT_PANEL_ID,
    );
    expect(stats).not.toBeNull();
    const seen = new Set(stats!.map((s) => s.channelId));
    expect(seen.has(mcapSpeed!.id)).toBe(true);
    expect(seen.has(mf4Wheel!.id)).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-mcap-plus-mf4.png"),
    });
  });
});
