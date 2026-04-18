import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(thisDir, "../../../test-fixtures/short.mf4");

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

  const bytes = readFileSync(fixturePath);
  const byteArray = Array.from(bytes);

  const opened = await page.evaluate(async (data) => {
    const buf = new Uint8Array(data);
    return await window.__drivelineDevHooks!.openMf4(buf);
  }, byteArray);

  expect(opened.summary.channels).toHaveLength(1);
  expect(opened.summary.channels[0].name).toBe("speed");
  expect(opened.summary.channels[0].sample_count).toBe(10);

  const channelId = opened.summary.channels[0].id;
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

  expect(fetched.rows).toBe(10);
  // Schema from `docs/03-data-model.md`: `{ ts: Timestamp(ns, UTC), value: Float64 }`.
  expect(fetched.tsSchema).toMatch(/Timestamp/i);
  expect(fetched.valueSchema).toMatch(/Float64|float/i);
  // Values are `i * 2` for `i in 0..10` → sum == 90.
  expect(fetched.valueSum).toBeCloseTo(90.0, 9);

  await page.evaluate(async (handle) => {
    await window.__drivelineDevHooks!.closeMf4(handle);
  }, opened.handle);
});
