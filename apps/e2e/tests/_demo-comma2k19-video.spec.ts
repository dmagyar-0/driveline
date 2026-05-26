// Ad-hoc visualisation: load the real-world comma2k19 segment 10 as
// video + signals together (mp4 + sidecar + mcap) and screenshot the
// dashcam frame next to the speed/steering plot.
//
// Underscore prefix keeps this out of normal CI runs — invoke it
// directly with `pnpm --filter e2e exec playwright test _demo-comma2k19-video.spec.ts`.
//
// Requires (manual prep, see sample-data/realworld/README.md):
//   sample-data/realworld/comma2k19.mcap               (python3 scripts/convert_comma2k19_to_mcap.py)
//   sample-data/realworld/comma2k19_seg10.mp4          (ffmpeg from HF compression_challenge HEVC)
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps  (one line per frame @ 20 fps anchored to segment start)

import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const REL = {
  mcap: "realworld/comma2k19.mcap",
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

test.describe("comma2k19 dashcam + CAN", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
    "comma2k19 fixtures missing — see sample-data/realworld/README.md",
  );

  test("renders video frame alongside speed + steering plot", async ({
    page,
  }) => {
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

    // Pull all three files in the browser and open as one drop.
    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        Object.entries(rels).map(async ([, rel]) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          const name = rel.split("/").pop()!;
          return { name, bytes: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, REL);
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining(["comma2k19.mcap", "comma2k19_seg10.mp4"]),
    );

    // Bind video.
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

    // Bind plot channels.
    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const byName = new Map(channels.map((c) => [c.name, c]));
    const speed = byName.get("/vehicle/speed");
    const steer = byName.get("/vehicle/steering_angle");
    expect(speed, "speed channel").toBeDefined();
    expect(steer, "steering channel").toBeDefined();
    await page.evaluate(
      ([panelId, sId, stId]) => {
        const h = window.__drivelineDevHooks!;
        h.addPlotChannelBinding(panelId, sId);
        h.addPlotChannelBinding(panelId, stId);
      },
      [PLOT_PANEL_ID, speed!.id, steer!.id],
    );

    // Seek to ~10 s into the segment so the dashcam frame isn't the
    // black warmup. There's no dev hook for setCursor, so reach into
    // the store directly.
    await page.evaluate(() => {
      // @ts-expect-error: dev-only escape hatch
      const store = (window as unknown as { __useSession?: unknown })
        .__useSession;
      // Fall back to module-level access via the global the app installs
      // in dev hooks: easiest is to click the scrubber.
      void store;
    });
    await page.evaluate(() => {
      const range = window
        .__drivelineDevHooks!.getSessionSnapshot()
        .globalRange!;
      const start = BigInt(range.startNs);
      const end = BigInt(range.endNs);
      const target = start + (end - start) / 6n; // ~10 s in
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

    // Wait for video to decode a frame at the new cursor.
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

    // Wait for plot stats to populate.
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(
            (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
            PLOT_PANEL_ID,
          );
          return s && s.length === 2 && s.every((x) => x.count > 0);
        },
        { timeout: 15_000, intervals: [200, 400, 800] },
      )
      .toBe(true);

    // Two animation frames for uPlot to paint the line layer.
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    await page.waitForTimeout(800);

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "comma2k19-video-plus-signals.png"),
      fullPage: false,
    });
  });
});
