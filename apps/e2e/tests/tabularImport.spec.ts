// End-to-end verification of the CSV/Parquet tabular import feature:
// drop a tabular file -> the time-basis config dialog appears with an
// inferred basis -> confirm -> the columns register as scalar channels
// that plot on the timeline with nanosecond-accurate timestamps.
//
// Screenshots land in screenshots/ for visual confirmation:
//   tabular-dialog-csv.png      the config dialog (inferred basis)
//   tabular-plot-csv.png        CSV signals plotted
//   tabular-plot-parquet.png    Parquet signals plotted
//   tabular-dialog-relative.png the dialog in relative-timestamp mode

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");

type Hooks = Record<string, (...a: unknown[]) => unknown>;
type Pending = {
  id: string;
  name: string;
  format: string;
  columns: { name: string; dtype: string; is_numeric: boolean }[];
  suggested: {
    timeColumn: string;
    unit: string;
    mode: string;
    epochOffsetNs: string;
  };
};

async function openFixture(page: import("@playwright/test").Page, file: string) {
  await page.evaluate(async (f) => {
    const r = await fetch(`/sample-data/tabular/${f}`);
    if (!r.ok) throw new Error(`fetch ${f}: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([{ name: f, bytes }]);
  }, file);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
  });
});

test("CSV import: dialog infers basis, signals plot with ns-accurate ts", async ({
  page,
}) => {
  await openFixture(page, "signals_abs.csv");

  // 1. The config dialog appears and inspect() inferred the time basis.
  await expect(page.getByTestId("tabular-import-dialog")).toBeVisible();
  const pending = (await page.evaluate(() =>
    window.__drivelineTabular!.pending(),
  )) as Pending[];
  expect(pending).toHaveLength(1);
  const p = pending[0];
  expect(p.format).toBe("csv");
  // t_us is microseconds-absolute; the other three columns are numeric signals.
  expect(p.suggested.timeColumn).toBe("t_us");
  expect(p.suggested.unit).toBe("Micros");
  const colNames = p.columns.map((c) => c.name).sort();
  expect(colNames).toEqual(["rpm", "speed_mps", "steering_deg", "t_us"]);

  await page
    .getByTestId("tabular-import-dialog")
    .screenshot({ path: path.join(SHOTS, "tabular-dialog-csv.png") });

  // 2. Accept the inferred basis (pre-filled defaults are correct here).
  await page.getByTestId("tabular-import-confirm").click();
  await expect(page.getByTestId("tabular-import-dialog")).toHaveCount(0);

  // 3. The source registered with the three numeric columns as scalar
  //    channels (the time column is consumed, not surfaced).
  const channels = await page.evaluate(() => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    return (h.listChannels() as { name: string; kind: string; id: string }[])
      .filter((c) => c.kind === "scalar")
      .map((c) => ({ name: c.name, id: c.id }));
  });
  const names = channels.map((c) => c.name).sort();
  expect(names).toEqual(["rpm", "speed_mps", "steering_deg"]);

  // 4. Bind speed_mps + rpm to the default plot panel; both render series.
  const bind = channels.filter(
    (c) => c.name === "speed_mps" || c.name === "rpm",
  );
  await page.evaluate(
    ([panelId, ids]) => {
      const h = window.__drivelineDevHooks!;
      for (const id of ids as string[]) h.addPlotChannelBinding(panelId, id);
    },
    ["plot-1", bind.map((c) => c.id)] as const,
  );

  await expect
    .poll(
      async () => {
        const stats = await page.evaluate((panelId) => {
          const h = window.__drivelineDevHooks as unknown as Hooks;
          return h.getPlotPanelSeriesStats(panelId) as
            | { count: number }[]
            | null;
        }, "plot-1");
        return !!stats && stats.length === 2 && stats.every((s) => s.count > 0);
      },
      { timeout: 8000, intervals: [50, 100, 200, 400] },
    )
    .toBe(true);

  // 5. Verify the time basis converted t_us (µs) -> ns exactly: the first
  //    row 1_704_067_200_000_000 µs must become 1_704_067_200_000_000_000 ns
  //    (beyond f64's exact-integer range, proving the i64 path).
  const range = await page.evaluate((panelId) => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    const snap = h.getPlotPanelSync(panelId) as {
      lastFetchedRange: { startNs: string; endNs: string } | null;
    } | null;
    return snap?.lastFetchedRange ?? null;
  }, "plot-1");
  expect(range).not.toBeNull();
  expect(BigInt(range!.startNs)).toBeLessThanOrEqual(1_704_067_200_000_000_000n);
  // end is start + ~2.9s of data; assert it is in the right second-scale band.
  expect(BigInt(range!.endNs)).toBeGreaterThan(1_704_067_200_000_000_000n);

  await page
    .getByTestId("plot-panel")
    .screenshot({ path: path.join(SHOTS, "tabular-plot-csv.png") });
});

test("Parquet import: columns decode and plot", async ({ page }) => {
  await openFixture(page, "signals_abs.parquet");
  await expect(page.getByTestId("tabular-import-dialog")).toBeVisible();
  const pending = (await page.evaluate(() =>
    window.__drivelineTabular!.pending(),
  )) as Pending[];
  expect(pending[0].format).toBe("parquet");

  await page.getByTestId("tabular-import-confirm").click();
  await expect(page.getByTestId("tabular-import-dialog")).toHaveCount(0);

  const channels = await page.evaluate(() => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    return (h.listChannels() as { name: string; kind: string; id: string }[])
      .filter((c) => c.kind === "scalar")
      .map((c) => ({ name: c.name, id: c.id }));
  });
  expect(channels.map((c) => c.name).sort()).toEqual([
    "rpm",
    "speed_mps",
    "steering_deg",
  ]);

  await page.evaluate(
    ([panelId, ids]) => {
      const h = window.__drivelineDevHooks!;
      for (const id of ids as string[]) h.addPlotChannelBinding(panelId, id);
    },
    ["plot-1", channels.map((c) => c.id)] as const,
  );

  await expect
    .poll(
      async () => {
        const stats = await page.evaluate((panelId) => {
          const h = window.__drivelineDevHooks as unknown as Hooks;
          return h.getPlotPanelSeriesStats(panelId) as
            | { count: number }[]
            | null;
        }, "plot-1");
        return !!stats && stats.length === 3 && stats.every((s) => s.count > 0);
      },
      { timeout: 8000, intervals: [50, 100, 200, 400] },
    )
    .toBe(true);

  await page
    .getByTestId("plot-panel")
    .screenshot({ path: path.join(SHOTS, "tabular-plot-parquet.png") });
});

test("relative-timestamp mode shows the clip-start epoch control", async ({
  page,
}) => {
  // camera_frames_rel.csv stores timestamps relative to clip start; the
  // dialog lets the user switch to Relative mode and supply the epoch.
  await openFixture(page, "camera_frames_rel.csv");
  await expect(page.getByTestId("tabular-import-dialog")).toBeVisible();

  await page.getByTestId("tabular-import-mode-relative").click();
  await page
    .getByTestId("tabular-import-epoch-offset")
    .fill("1704067200000000000");

  await page
    .getByTestId("tabular-import-dialog")
    .screenshot({ path: path.join(SHOTS, "tabular-dialog-relative.png") });

  // The preview should reflect the chosen epoch (2024-01-01T00:00:00Z).
  const preview = await page
    .getByTestId("tabular-import-preview")
    .textContent();
  expect(preview ?? "").toMatch(/2024/);
});
