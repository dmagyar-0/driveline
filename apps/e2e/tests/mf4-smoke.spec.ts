import { test, expect } from "@playwright/test";

interface Mf4ChannelInfo {
  id: string;
  name: string;
  unit: string | null;
  sample_count: number;
  start_ns: bigint;
  end_ns: bigint;
}

interface Mf4Summary {
  start_ns: bigint;
  end_ns: bigint;
  channels: Mf4ChannelInfo[];
}

interface OpenMf4Result {
  handle: number;
  summary: Mf4Summary;
}

interface Mf4FetchResult {
  rows: number;
  tsSchema: string;
  valueSchema: string;
  firstTsNs: string;
  lastTsNs: string;
  valueSum: number;
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openMf4: (bytes: Uint8Array) => Promise<OpenMf4Result>;
      closeMf4: (handle: number) => Promise<void>;
      mf4FetchRange: (
        handle: number,
        channelId: string,
        startNs: bigint,
        endNs: bigint,
        includePrev: boolean,
      ) => Promise<Mf4FetchResult>;
    };
  }
}

test("openMf4 parses the short.mf4 fixture and fetch_range returns Arrow IPC", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

  const opened = await page.evaluate(async () => {
    const r = await fetch("/sample-data/short.mf4");
    if (!r.ok) throw new Error(`fetch mf4: ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    return await window.__drivelineDevHooks!.openMf4(buf);
  });

  // Real corpus from `sample-data/generate.py` exports three MF4
  // channels: `vehicle_speed` (100 Hz / 1000 samples),
  // `imu_accel` (1 kHz / 10000 samples), and sparse `control_mode`.
  expect(opened.summary.channels).toHaveLength(3);
  const names = opened.summary.channels.map((c) => c.name).sort();
  expect(names).toEqual(["control_mode", "imu_accel", "vehicle_speed"]);

  const speed = opened.summary.channels.find(
    (c) => c.name === "vehicle_speed",
  )!;
  expect(speed.sample_count).toBe(1000);

  const channelId = speed.id;
  const startNs = opened.summary.start_ns;
  const endNs = opened.summary.end_ns;

  const fetched = await page.evaluate(
    async (args) => {
      return await window.__drivelineDevHooks!.mf4FetchRange(
        args.handle,
        args.channelId,
        BigInt(args.startNs),
        BigInt(args.endNs),
        false,
      );
    },
    {
      handle: opened.handle,
      channelId,
      startNs: String(startNs),
      endNs: String(endNs),
    },
  );

  expect(fetched.rows).toBe(1000);
  // Schema from `docs/03-data-model.md`: `{ ts: Timestamp(ns, UTC), value: Float64 }`.
  expect(fetched.tsSchema).toMatch(/Timestamp/i);
  expect(fetched.valueSchema).toMatch(/Float64|float/i);
  // vehicle_speed = sin(2π·t/2) over 10 s at 100 Hz (5 full periods) —
  // the Riemann sum converges toward 0. Tolerance accommodates the
  // discrete end-point.
  expect(Math.abs(fetched.valueSum)).toBeLessThan(1.0);

  await page.evaluate(async (handle) => {
    await window.__drivelineDevHooks!.closeMf4(handle);
  }, opened.handle);
});
