// Records a video of 4K MCAP playback so we can eyeball the lag the
// user is reporting and capture rAF/HUD telemetry alongside the file.
//
// Output:
//   apps/e2e/recordings/<label>-4k-playback.webm
//   plus rAF tick stats + HUD snapshot printed to stdout
//
// Run with `RECORD_LABEL=baseline pnpm --filter e2e exec playwright test \
//   tests/_record-4k.spec.ts --project=chromium --headed=false`.

import { test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REC_DIR = resolve(HERE, "..", "recordings");

const LABEL = process.env.RECORD_LABEL ?? "baseline";

// This file is a manual diagnostic, not part of the regression suite.
// Skip unless explicitly invoked with `RECORD_LABEL=<name>` so a plain
// `pnpm --filter e2e test` doesn't waste 15 s recording videos.
test.skip(
  !process.env.RECORD_LABEL,
  "Set RECORD_LABEL=<name> to capture a 4K playback recording.",
);

interface VideoHud {
  ptsNs: bigint | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  codec: string | null;
}

interface PerfEntry {
  name: string;
  duration: number;
  entryType: string;
}

test.use({
  video: { mode: "on", size: { width: 1600, height: 900 } },
  viewport: { width: 1600, height: 900 },
});

test(`record 4K playback (${LABEL})`, async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/");
  await page.getByTestId("worker-status").waitFor({ timeout: 30_000 });

  await page.evaluate(async () => {
    const r = await fetch("/sample-data/short.mcap");
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([
      { name: "short.mcap", bytes },
    ]);
    // Resolve the qualified channel id at runtime — PR #84b08ee
    // changed `Channel.id` to `qualifiedChannelId(sourceId, nativeId)`.
    const id = window.__drivelineDevHooks!.findChannelId({
      sourceName: "short.mcap",
      nativeId: "/camera/front",
    });
    if (!id) throw new Error("video channel must resolve");
    window.__drivelineDevHooks!.setVideoChannelBinding("video-1", id);
  });

  await page.getByTestId("video-panel-canvas").waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      (
        window as unknown as {
          __drivelineVideoHud?: { codec: string | null };
        }
      ).__drivelineVideoHud?.codec,
    null,
    { timeout: 30_000 },
  );

  // Toggle HUD on so the recording shows the live telemetry.
  await page.getByTestId("video-hud-toggle").click();

  // Reset perf marks so we measure the playback window only.
  await page.evaluate(() => window.__drivelinePerf!.clear());

  // Play 11 s of the 10 s fixture (auto-pauses at end).
  await page.getByTestId("play-pause").click();
  await page.waitForTimeout(11_000);

  const hud = await page.evaluate<VideoHud | null>(() => {
    const h = (
      window as unknown as { __drivelineVideoHud?: VideoHud }
    ).__drivelineVideoHud;
    if (!h) return null;
    return {
      ptsNs: null,
      frameIndex: h.frameIndex,
      decodeQueue: h.decodeQueue,
      blitQueueLen: h.blitQueueLen,
      dropped: h.dropped,
      codec: h.codec,
    };
  });

  const tickStats = await page.evaluate(() => {
    const snap = window.__drivelinePerf!.snapshot();
    const ticks = snap.entries.filter(
      (e: PerfEntry) => e.entryType === "measure" && e.name === "tick",
    );
    if (ticks.length === 0) return null;
    const ds = ticks
      .map((t: PerfEntry) => t.duration)
      .sort((a: number, b: number) => a - b);
    const pct = (q: number): number =>
      ds[Math.min(ds.length - 1, Math.floor(q * ds.length))];
    return {
      n: ds.length,
      min: Number(ds[0].toFixed(2)),
      p50: Number(pct(0.5).toFixed(2)),
      p90: Number(pct(0.9).toFixed(2)),
      p95: Number(pct(0.95).toFixed(2)),
      p99: Number(pct(0.99).toFixed(2)),
      max: Number(ds[ds.length - 1].toFixed(2)),
    };
  });

  console.log(`HUD (${LABEL}):`, JSON.stringify(hud));
  console.log(`tick (${LABEL}):`, JSON.stringify(tickStats));

  // Save a JSON sidecar with stats for diffing across runs.
  await fs.mkdir(REC_DIR, { recursive: true });
  await fs.writeFile(
    resolve(REC_DIR, `${LABEL}-stats.json`),
    JSON.stringify({ label: LABEL, hud, tickStats }, null, 2),
  );

  // Save the recording to a stable path. `page.video()?.saveAs(...)`
  // is the documented way to capture a finalised .webm regardless of
  // whether the test passes; it closes the page first to flush, then
  // moves the file. We must close the page explicitly here because
  // Playwright will otherwise tear down the context after the test
  // body returns and clean up the output dir.
  const dest = resolve(REC_DIR, `${LABEL}-4k-playback.webm`);
  const video = page.video();
  await page.close();
  if (video) {
    await video.saveAs(dest);
  }
});
