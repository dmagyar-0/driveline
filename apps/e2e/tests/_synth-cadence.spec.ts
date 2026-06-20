// Self-contained pacing-fidelity reproduction for the "video going back and
// forth" investigation. Plays a SYNTHETIC clip whose frames carry a KNOWN,
// UNEVEN capture-timestamp grid (nuScenes-like 50/100/150 ms via the
// uneven.mp4.timestamps sidecar) and reads back GROUND TRUTH from the worker:
//
//   1. the per-paint cadence trace (dwellMs/stepMs) — the worker's own record
//      of which frame stayed on screen for how long, and
//   2. a dense rAF sampler of window.__drivelineVideoLastBlitPtsNs — the actual
//      PTS on screen at ~vsync resolution.
//
// No VP8 screen-recording, no perceptual similarity: we read the painted PTS
// directly, so the order question ("does the frame ever go backward?") is
// answered by the bytes, not by a codec. Fixture lives in sample-data/synth/
// (gitignored); auto-skips if absent.
//
//   pnpm --filter e2e exec playwright test _synth-cadence.spec.ts --project=chromium

import { test, expect, type Page } from "@playwright/test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Which mp4+sidecar pair to drive (relative to sample-data/). Defaults to the
// synthetic clip; set MP4_REL=realworld/nuscenes_cam_front.mp4 for real data.
const MP4_REL = process.env.MP4_REL ?? "synth/uneven.mp4";
const TS_REL = `${MP4_REL}.timestamps`;
const FIXTURE = path.resolve(__dirname, "../../../sample-data", MP4_REL);
const PLAY_DEADLINE_MS = Number(process.env.PLAY_DEADLINE_MS ?? 16_000);
const PAINT_TARGET = Number(process.env.PAINT_TARGET ?? 76);
const OUT_DIR = path.resolve(__dirname, "../test-results");
const OUT_FILE = path.join(
  OUT_DIR,
  `synth-cadence${process.env.OUT_TAG ? "-" + process.env.OUT_TAG : ""}.json`,
);

const VIDEO_PANEL_ID = "video-1";

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

test.use({
  viewport: { width: 1280, height: 720 },
  video: { mode: "on", size: { width: 1280, height: 720 } },
});

test.describe("synthetic uneven-cadence pacing fidelity", () => {
  test.slow();
  test.skip(!existsSync(FIXTURE), "sample-data/synth/uneven.mp4 missing");

  test("plays one pass at 1x and records painted-PTS ground truth", async ({
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

    const open = await page.evaluate(async (rels: string[]) => {
      const names = rels;
      const descs = await Promise.all(
        names.map(async (n) => {
          const r = await fetch(`/sample-data/${n}`);
          if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
          return {
            name: n.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, [MP4_REL, TS_REL]);
    expect(open.errors).toEqual([]);

    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const video = channels.find((c) => c.kind === "video");
    expect(video, "video channel").toBeTruthy();
    await page.evaluate(
      ([pid, id]) => window.__drivelineDevHooks!.setVideoChannelBinding(pid, id),
      [VIDEO_PANEL_ID, video!.id] as const,
    );
    await page.getByTestId("video-panel-canvas").waitFor();
    await expect
      .poll(async () => (await page.evaluate(() =>
        window.__drivelineDevHooks!.videoHudStats(),
      )) !== null, { timeout: 10_000 })
      .toBe(true);

    // Land on the very start and let the decoder prime its lookahead.
    await clickScrubberAtRatio(page, 0);
    await page.waitForTimeout(900);

    // Install a dense rAF sampler of the actual on-screen PTS.
    await page.evaluate(() => {
      const w = window as unknown as {
        __synthSamples?: { t: number; pts: string | null }[];
        __synthSampling?: boolean;
        __drivelineVideoLastBlitPtsNs?: bigint | null;
      };
      w.__synthSamples = [];
      w.__synthSampling = true;
      const tick = () => {
        if (!w.__synthSampling) return;
        const p = w.__drivelineVideoLastBlitPtsNs;
        w.__synthSamples!.push({
          t: performance.now(),
          pts: p === null || p === undefined ? null : String(p),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    // Play one continuous pass at 1x.
    const playStart = Date.now();
    await page.getByTestId("play-pause").click();
    const deadline = Date.now() + PLAY_DEADLINE_MS;
    while (Date.now() < deadline) {
      await page.waitForTimeout(400);
      const playing = await page.evaluate(
        () => window.__drivelineDevHooks!.getSessionSnapshot().playing,
      );
      const paints =
        (await page.evaluate(
          () => window.__drivelineVideoCadence?.paints ?? 0,
        )) ?? 0;
      // Auto-pauses at end-of-session; stop once it ends (one full pass) or we
      // have the target number of inter-frame paints.
      if (!playing && Date.now() - playStart > 2000) break;
      if (paints >= PAINT_TARGET) break;
    }
    const wallMs = Date.now() - playStart;

    // Capture the video-panel canvas rectangle so the recorded webm can be
    // cropped to exactly the dashcam region for the frame-order detector.
    const canvasRect = await page.evaluate(() => {
      const c = document.querySelector<HTMLElement>(
        "[data-testid='video-panel-canvas']",
      );
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });

    // Stop sampler, harvest everything.
    const samples = await page.evaluate(() => {
      const w = window as unknown as {
        __synthSamples?: { t: number; pts: string | null }[];
        __synthSampling?: boolean;
      };
      w.__synthSampling = false;
      return w.__synthSamples ?? [];
    });
    const trace = await page.evaluate(async () => {
      const w = window as unknown as {
        __drivelineVideoCadenceTrace?: () => Promise<{
          dwellMs: number[];
          stepMs: number[];
          leadDepth: number[];
          clamped: boolean[];
        } | null>;
      };
      return w.__drivelineVideoCadenceTrace
        ? await w.__drivelineVideoCadenceTrace()
        : null;
    });
    const summary = await page.evaluate(
      () => window.__drivelineVideoCadence ?? null,
    );

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      OUT_FILE,
      JSON.stringify({ wallMs, canvasRect, summary, trace, samples }, null, 2),
    );
    console.log(
      "SYNTH_RESULT " +
        JSON.stringify({
          wallMs,
          paints: summary?.paints ?? null,
          backwardSteps: summary?.backwardSteps ?? null,
          jitterMs: summary?.jitterMs ?? null,
          playbackRateRatio: summary?.playbackRateRatio ?? null,
          repeats: summary?.repeats ?? null,
          rushed: summary?.rushed ?? null,
          smooth: summary?.smooth ?? null,
          denseSamples: samples.length,
        }),
    );

    expect(trace, "cadence trace present").not.toBeNull();
    expect((trace!.stepMs?.length ?? 0), "enough paints").toBeGreaterThan(40);
  });
});
