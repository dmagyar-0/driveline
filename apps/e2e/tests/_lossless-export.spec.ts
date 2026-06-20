// Lossless demo-clip export path — the artifact-free alternative to Playwright's
// default VP8 screencast (which fabricated ~46% false "back-and-forth" on
// high-motion footage; see docs/handoff-nuscenes-video-pacing.md).
//
// Instead of screen-recording the live compositor, this pulls each source frame
// at its real capture timestamp through the agent's playback-independent
// `captureVideoFrameAt` (a throwaway full-res decode → lossless PNG), then
// ffmpeg-encodes the PNGs back to an mp4 at the REAL per-frame cadence with a
// high-quality (near-lossless) encode. The frames are the clean source frames
// in order, so the export carries zero inter-frame VP8 motion artifacts.
//
//   MP4_REL=realworld/nuscenes_cam_front.mp4 OUT_TAG=nusc \
//     pnpm --filter e2e exec playwright test _lossless-export.spec.ts --project=chromium
//
// Output: apps/e2e/test-results/lossless-<tag>.mp4 (+ frames/ PNG dir). Verify
// with score-frame-order.py — it scores ~0% (FORWARD-ORDERED) vs the VP8 46%.

import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MP4_REL = process.env.MP4_REL ?? "synth/uneven.mp4";
const TS_REL = `${MP4_REL}.timestamps`;
const FIXTURE = path.resolve(__dirname, "../../../sample-data", MP4_REL);
const SIDECAR = path.resolve(__dirname, "../../../sample-data", TS_REL);
const TAG = process.env.OUT_TAG ?? "synth";
const OUT_DIR = path.resolve(__dirname, "../test-results");
const FRAMES_DIR = path.join(OUT_DIR, `lossless-${TAG}-frames`);
const OUT_MP4 = path.join(OUT_DIR, `lossless-${TAG}.mp4`);

test.use({ viewport: { width: 1280, height: 720 } });

test.describe("lossless frame-accurate export", () => {
  test.slow();
  test.skip(!existsSync(FIXTURE), `${MP4_REL} missing`);

  test("exports the clip at its real cadence with no recording artifacts", async ({
    page,
  }) => {
    page.on("pageerror", (e) => console.error("pageerror:", e.message));

    // ?agent=1 unlocks the mutating/capture ops (captureVideoFrameAt).
    await page.goto("/?agent=1");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });

    // Open the mp4+sidecar and resolve the video channel id.
    const open = await page.evaluate(async (rels: string[]) => {
      const descs = await Promise.all(
        rels.map(async (n) => {
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

    const channelId = await page.evaluate(() => {
      const ch = window
        .__drivelineDevHooks!.listChannels()
        .find((c) => c.kind === "video");
      return ch?.id ?? null;
    });
    expect(channelId, "video channel").not.toBeNull();

    // Real capture timestamps (ns) — one per frame, the authoritative grid.
    const ts = readFileSync(SIDECAR, "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("\t")[1]);

    rmSync(FRAMES_DIR, { recursive: true, force: true });
    mkdirSync(FRAMES_DIR, { recursive: true });

    // Pull each frame at its capture time via the playback-independent decoder.
    let captured = 0;
    for (let i = 0; i < ts.length; i++) {
      const cap = await page.evaluate(
        async ([cid, ns]) =>
          await window.__drivelineAgent!.captureVideoFrameAt(cid, ns),
        [channelId!, ts[i]] as const,
      );
      if (!cap) continue;
      const b64 = cap.dataUrl.replace(/^data:image\/png;base64,/, "");
      writeFileSync(
        path.join(FRAMES_DIR, `f_${String(i).padStart(5, "0")}.png`),
        Buffer.from(b64, "base64"),
      );
      captured++;
    }
    expect(captured, "captured most frames").toBeGreaterThan(ts.length * 0.95);

    // ffmpeg concat list with the REAL per-frame durations (last frame held a
    // nominal beat). Encodes at the source's own uneven cadence — faithful, but
    // artifact-free because the frames are the clean source pixels in order.
    const lines: string[] = [];
    for (let i = 0; i < ts.length; i++) {
      const png = path.join(FRAMES_DIR, `f_${String(i).padStart(5, "0")}.png`);
      if (!existsSync(png)) continue;
      lines.push(`file '${png}'`);
      const durNs =
        i + 1 < ts.length
          ? Number(BigInt(ts[i + 1]) - BigInt(ts[i]))
          : 100_000_000;
      lines.push(`duration ${(durNs / 1e9).toFixed(6)}`);
    }
    // concat demuxer needs the final file repeated to honour its duration.
    const lastPng = path.join(
      FRAMES_DIR,
      `f_${String(ts.length - 1).padStart(5, "0")}.png`,
    );
    if (existsSync(lastPng)) lines.push(`file '${lastPng}'`);
    const listPath = path.join(FRAMES_DIR, "concat.txt");
    writeFileSync(listPath, lines.join("\n") + "\n");

    // Near-lossless H.264 (crf 14, yuv420p for portability), VFR from the real
    // timestamps via -vsync vfr. No inter-frame motion-coding artifacts at this
    // quality, so the frame-order detector reads it as forward-ordered.
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-vsync",
        "vfr",
        "-c:v",
        "libx264",
        "-crf",
        "14",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        OUT_MP4,
      ],
      { stdio: "pipe" },
    );
    expect(existsSync(OUT_MP4)).toBe(true);
    console.log(
      "LOSSLESS_EXPORT " +
        JSON.stringify({ captured, frames: ts.length, out: OUT_MP4 }),
    );
  });
});
