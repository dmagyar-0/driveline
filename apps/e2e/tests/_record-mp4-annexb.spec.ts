// Manual diagnostic: load both the canonical AVCC short.mp4 and the
// hand-rolled Annex-B variant (`scripts/video/make_annexb_mp4.py`),
// hit Play for ~11 s on each, and save a .webm recording + a JSON
// stats sidecar. The Annex-B variant exercises the path that was
// removed in commit e2f63a0 (mp4 samples carrying start codes
// instead of length prefixes are now expected to fail).
//
// Skipped unless explicitly invoked with RECORD_LABEL=<name>.
//
// Run:
//   RECORD_LABEL=annexb pnpm --filter e2e exec playwright test \
//     tests/_record-mp4-annexb.spec.ts --project=chromium

import { test } from "@playwright/test";
import { promises as fs } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REC_DIR = resolve(HERE, "..", "recordings");

const LABEL = process.env.RECORD_LABEL ?? "";

test.skip(
  !process.env.RECORD_LABEL,
  "Set RECORD_LABEL=<name> to capture an mp4 Annex-B playback recording.",
);

interface VideoHud {
  ptsNs: bigint | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  codec: string | null;
}

interface SessionSnapshot {
  cursorNs: string;
  playing: boolean;
  speed: number;
  globalRange: { startNs: string; endNs: string } | null;
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
      videoHudStats: () => {
        ptsNs: string | null;
        frameIndex: number;
        decodeQueue: number;
        blitQueueLen: number;
        dropped: number;
        codec: string | null;
        hudOn: boolean;
      } | null;
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      resetLayout: () => void;
      listSources: () => Array<{ id: string; name: string }>;
    };
    __drivelineVideoHud?: VideoHud;
  }
}

test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});

interface ScenarioResult {
  scenario: string;
  hud: VideoHud | null;
  pageErrors: string[];
  consoleErrors: string[];
  cursorAdvancedNs: string;
  openErrors: { name: string; reason: string }[];
}

async function runScenario(
  page: import("@playwright/test").Page,
  scenario: "avcc" | "annexb",
  fixtureName: string,
  sidecarName: string,
): Promise<ScenarioResult> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  await page.goto("/");
  await page.getByTestId("worker-status").waitFor({ timeout: 30_000 });
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

  const open = await page.evaluate(
    async ([mp4, sidecar]) => {
      const fetchOne = async (n: string) => {
        const r = await fetch(`/sample-data/${n}`);
        if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
        return { name: n, bytes: new Uint8Array(await r.arrayBuffer()) };
      };
      const descs = [await fetchOne(mp4), await fetchOne(sidecar)];
      return await window.__drivelineDevHooks!.openFiles(descs);
    },
    [fixtureName, sidecarName],
  );

  // The channel id is `qualifiedChannelId(sourceId, "1/video")` — a
  // synthetic envelope. The simplest way to bind without re-deriving
  // it here is to click the in-panel picker button rendered by
  // `VideoPanelContainer` for any candidate video channel.
  const pick = page.locator('[data-testid^="video-pick-"]').first();
  await pick.waitFor({ timeout: 30_000 });
  await pick.click();

  await page.getByTestId("video-panel-canvas").waitFor({ timeout: 30_000 });

  // Wait briefly for codec config (broken path will time out).
  let codec: string | null = null;
  try {
    await page.waitForFunction(
      () => Boolean(window.__drivelineVideoHud?.codec),
      null,
      { timeout: 10_000 },
    );
    codec = await page.evaluate(
      () => window.__drivelineVideoHud?.codec ?? null,
    );
  } catch {
    // codec stays null
  }
  try {
    await page.getByTestId("video-hud-toggle").click({ timeout: 2_000 });
  } catch {
    // hud toggle may not exist; ignore
  }

  const startSnap = await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );

  await page.getByTestId("play-pause").click();
  await page.waitForTimeout(11_000);

  const hud = await page.evaluate<VideoHud | null>(() => {
    const h = window.__drivelineVideoHud;
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

  const endSnap = await page.evaluate(() =>
    window.__drivelineDevHooks!.getSessionSnapshot(),
  );
  const cursorAdvancedNs = (
    BigInt(endSnap.cursorNs) - BigInt(startSnap.cursorNs)
  ).toString();

  return {
    scenario,
    hud: hud ? { ...hud, codec } : { ptsNs: null, frameIndex: 0, decodeQueue: 0, blitQueueLen: 0, dropped: 0, codec },
    pageErrors,
    consoleErrors,
    cursorAdvancedNs,
    openErrors: open.errors,
  };
}

async function saveRecording(
  page: import("@playwright/test").Page,
  filename: string,
): Promise<void> {
  const video = page.video();
  await page.close();
  if (video) {
    await fs.mkdir(REC_DIR, { recursive: true });
    await video.saveAs(resolve(REC_DIR, filename));
  }
}

async function writeStats(name: string, body: unknown): Promise<void> {
  await fs.mkdir(REC_DIR, { recursive: true });
  await fs.writeFile(
    resolve(REC_DIR, `${LABEL}-${name}-stats.json`),
    JSON.stringify(body, null, 2),
  );
}

test(`AVCC mp4 baseline (${LABEL})`, async ({ page }) => {
  test.setTimeout(120_000);
  const r = await runScenario(
    page,
    "avcc",
    "short.mp4",
    "short.mp4.timestamps",
  );
  // eslint-disable-next-line no-console
  console.log("AVCC:", JSON.stringify(r));
  await writeStats("avcc-mp4", r);
  await saveRecording(page, `${LABEL}-avcc-mp4.webm`);
});

test(`Annex-B mp4 (non-standard, expected to fail) (${LABEL})`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const r = await runScenario(
    page,
    "annexb",
    "short.annexb.mp4",
    "short.annexb.mp4.timestamps",
  );
  // eslint-disable-next-line no-console
  console.log("ANNEXB:", JSON.stringify(r));
  await writeStats("annexb-mp4", r);
  await saveRecording(page, `${LABEL}-annexb-mp4.webm`);
});
