// T2.4 acceptance test. Drops the three M2 fixtures into the page via the
// `__drivelineDevHooks.openFiles` path (same store action the real onDrop
// handler uses) and asserts the rendered session summary matches:
//
// - three sources listed
// - mcap=4 channels, mf4=1 channel, mp4+sidecar=1 channel
// - global range is the union of all three per-source ranges
//
// Raw DataTransfer drops are unreliable across headless-chromium versions;
// driving the production store action through a dev hook is both simpler
// and covers the exact code path that real drops exercise after the
// `onDrop` handler converts the `FileList`.

import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(thisDir, "../../../test-fixtures");
const MCAP = resolve(fixtureDir, "short.mcap");
const MF4 = resolve(fixtureDir, "short.mf4");
const MP4 = resolve(fixtureDir, "short.mp4");
const SIDECAR = resolve(fixtureDir, "short.mp4.ts.bin");

interface DevFileDesc {
  name: string;
  bytes: number[]; // serialisable across page.evaluate
}
interface DevOpenResult {
  opened: string[];
  errors: { name: string; reason: string }[];
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<DevOpenResult>;
      clearSession: () => Promise<void>;
    };
  }
}

test("drop three fixtures: UI shows sources, counts, and global range", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

  const descs: DevFileDesc[] = [
    { name: "short.mcap", bytes: Array.from(readFileSync(MCAP)) },
    { name: "short.mf4", bytes: Array.from(readFileSync(MF4)) },
    { name: "short.mp4", bytes: Array.from(readFileSync(MP4)) },
    { name: "short.mp4.ts.bin", bytes: Array.from(readFileSync(SIDECAR)) },
  ];

  const result = await page.evaluate(async (input) => {
    const materialised = input.map((d) => ({
      name: d.name,
      bytes: new Uint8Array(d.bytes),
    }));
    return await window.__drivelineDevHooks!.openFiles(materialised);
  }, descs);

  expect(result.errors).toEqual([]);
  expect(result.opened.sort()).toEqual(["short.mcap", "short.mf4", "short.mp4"]);

  await expect(page.getByTestId("source-count")).toHaveText("Sources: 3");

  const mcapSource = page.getByTestId("source-short.mcap");
  const mf4Source = page.getByTestId("source-short.mf4");
  const mp4Source = page.getByTestId("source-short.mp4");

  await expect(mcapSource.getByTestId("channel-count")).toHaveText(
    "4 channels",
  );
  await expect(mf4Source.getByTestId("channel-count")).toHaveText("1 channel");
  await expect(mp4Source.getByTestId("channel-count")).toHaveText("1 channel");

  // The mp4 fixture uses base ns 1_700_000_000_000_000_000 with a 30 fps
  // step; its per-sample ns values exceed Number.MAX_SAFE_INTEGER, so this
  // also validates the BigInt-coercion path end-to-end.
  const parseRange = (text: string | null): [bigint, bigint] => {
    const m = text!.match(/\[(\d+), (\d+)\)/);
    if (!m) throw new Error(`bad range text: ${text}`);
    return [BigInt(m[1]), BigInt(m[2])];
  };

  const [globalStart, globalEnd] = parseRange(
    await page.getByTestId("global-range").textContent(),
  );
  const [mcapStart, mcapEnd] = parseRange(
    await mcapSource.getByTestId("source-range").textContent(),
  );
  const [mf4Start, mf4End] = parseRange(
    await mf4Source.getByTestId("source-range").textContent(),
  );
  const [mp4Start, mp4End] = parseRange(
    await mp4Source.getByTestId("source-range").textContent(),
  );

  // Global range must be the union of the three per-source ranges.
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  expect(globalStart).toBe(min(min(mcapStart, mf4Start), mp4Start));
  expect(globalEnd).toBe(max(max(mcapEnd, mf4End), mp4End));

  // And the mp4 source's ns values must survive the JS/WASM boundary intact.
  // 1.7e18 exceeds Number.MAX_SAFE_INTEGER, so this fails if the
  // Rust→JS→store pipeline ever lossy-casts through `number`.
  expect(mp4Start).toBe(1_700_000_000_000_000_000n);
  expect(mp4End).toBe(1_700_000_000_000_000_000n + 9n * 33_333_333n + 1n);

  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
  });
  await expect(page.getByTestId("source-count")).toHaveText("Sources: 0");
});
