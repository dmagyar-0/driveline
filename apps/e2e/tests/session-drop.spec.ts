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

  const result = await page.evaluate(async () => {
    const names = ["short.mcap", "short.mf4", "short.mp4", "short.mp4.ts.bin"];
    const descs = await Promise.all(
      names.map(async (n) => {
        const r = await fetch(`/sample-data/${n}`);
        if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
        return { name: n, bytes: new Uint8Array(await r.arrayBuffer()) };
      }),
    );
    return await window.__drivelineDevHooks!.openFiles(descs);
  });

  expect(result.errors).toEqual([]);
  expect(result.opened.sort()).toEqual(["short.mcap", "short.mf4", "short.mp4"]);

  await expect(page.getByTestId("source-count")).toHaveText("Sources: 3");

  const mcapSource = page.getByTestId("source-short.mcap");
  const mf4Source = page.getByTestId("source-short.mf4");
  const mp4Source = page.getByTestId("source-short.mp4");

  // Real T0.3 corpus: MCAP has /camera/front + /vehicle/speed +
  // /imu/accel + /control/mode; MF4 has vehicle_speed + imu_accel +
  // control_mode; MP4+sidecar has a single video track.
  await expect(mcapSource.getByTestId("channel-count")).toHaveText(
    "4 channels",
  );
  await expect(mf4Source.getByTestId("channel-count")).toHaveText(
    "3 channels",
  );
  await expect(mp4Source.getByTestId("channel-count")).toHaveText("1 channel");

  // The mp4 sidecar encodes per-frame ns timestamps starting at
  // `START_NS = 1_704_067_200_000_000_000` (exceeds
  // Number.MAX_SAFE_INTEGER), validating the BigInt-coercion path.
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

  // The mp4 source's ns values must survive the JS/WASM boundary
  // intact. 1.704e18 exceeds Number.MAX_SAFE_INTEGER, so this fails
  // if the Rust→JS→store pipeline ever lossy-casts through `number`.
  const START_NS = 1_704_067_200_000_000_000n;
  const FRAME_NS = 33_333_333n;
  const TOTAL_FRAMES = 300n;
  expect(mp4Start).toBe(START_NS);
  expect(mp4End).toBe(START_NS + (TOTAL_FRAMES - 1n) * FRAME_NS + 1n);

  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
  });
  await expect(page.getByTestId("source-count")).toHaveText("Sources: 0");
});
