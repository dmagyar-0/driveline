// T2.4 acceptance test. Drops the three M2 fixtures into the page via the
// `__drivelineDevHooks.openFiles` path (same store action the real onDrop
// handler uses) and asserts the loaded session matches:
//
// - three sources reported by `listSources()`
// - mcap=4 channels, mf4=3 channels, mp4+sidecar=1 channel (via channelIds
//   on each source)
// - global range is the union of all three per-source ranges
//
// Phase 2 of the V1-shell migration replaced the legacy `SessionSummary`
// off-screen shim with the Sources drawer; e2e assertions read state via
// the new `listSources` / `getGlobalRange` dev hooks rather than DOM
// testids (frontend-skill "hook over selector" rule).

import { test, expect } from "@playwright/test";

interface DevOpenResult {
  opened: string[];
  errors: { name: string; reason: string }[];
}

interface DevSource {
  id: string;
  kind: "mcap" | "mf4" | "mp4+sidecar";
  name: string;
  timeRange: { startNs: string; endNs: string };
  channelIds: string[];
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<DevOpenResult>;
      clearSession: () => Promise<void>;
      listSources: () => DevSource[];
      getGlobalRange: () => { startNs: string; endNs: string } | null;
    };
  }
}

test("drop three fixtures: sources, channel counts, global range", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

  const result = await page.evaluate(async () => {
    const names = ["short.mcap", "short.mf4", "short.mp4", "short.mp4.timestamps"];
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

  const sourcesAfter = await page.evaluate(() =>
    window.__drivelineDevHooks!.listSources(),
  );
  expect(sourcesAfter).toHaveLength(3);

  const byId = new Map(sourcesAfter.map((s) => [s.id, s]));
  // Real T0.3 corpus: MCAP has /camera/front + /vehicle/speed + /imu/accel
  // + /control/mode; MF4 has vehicle_speed + imu_accel + control_mode;
  // MP4+sidecar has a single video track.
  expect(byId.get("short.mcap")?.channelIds).toHaveLength(4);
  expect(byId.get("short.mf4")?.channelIds).toHaveLength(3);
  expect(byId.get("short.mp4")?.channelIds).toHaveLength(1);

  const gr = await page.evaluate(() =>
    window.__drivelineDevHooks!.getGlobalRange(),
  );
  if (!gr) throw new Error("expected globalRange after drop");
  const globalStart = BigInt(gr.startNs);
  const globalEnd = BigInt(gr.endNs);
  const mcapStart = BigInt(byId.get("short.mcap")!.timeRange.startNs);
  const mcapEnd = BigInt(byId.get("short.mcap")!.timeRange.endNs);
  const mf4Start = BigInt(byId.get("short.mf4")!.timeRange.startNs);
  const mf4End = BigInt(byId.get("short.mf4")!.timeRange.endNs);
  const mp4Start = BigInt(byId.get("short.mp4")!.timeRange.startNs);
  const mp4End = BigInt(byId.get("short.mp4")!.timeRange.endNs);

  // Global range must be the union of the three per-source ranges.
  const min = (a: bigint, b: bigint) => (a < b ? a : b);
  const max = (a: bigint, b: bigint) => (a > b ? a : b);
  expect(globalStart).toBe(min(min(mcapStart, mf4Start), mp4Start));
  expect(globalEnd).toBe(max(max(mcapEnd, mf4End), mp4End));

  // The mp4 sidecar encodes per-frame ns timestamps starting at
  // `START_NS = 1_704_067_200_000_000_000` (exceeds
  // Number.MAX_SAFE_INTEGER), validating the BigInt-coercion path through
  // the JS/WASM/store boundary.
  const START_NS = 1_704_067_200_000_000_000n;
  const FRAME_NS = 33_333_333n;
  const TOTAL_FRAMES = 300n;
  expect(mp4Start).toBe(START_NS);
  expect(mp4End).toBe(START_NS + (TOTAL_FRAMES - 1n) * FRAME_NS + 1n);

  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
  });
  const cleared = await page.evaluate(() =>
    window.__drivelineDevHooks!.listSources(),
  );
  expect(cleared).toEqual([]);
});
