// End-to-end verification of the Format Agent / RecipeReader path
// (docs/12-format-agent.md): drop a file in an UNKNOWN binary format
// (`sample.acme`, a synthetic ACME telemetry log) -> the Unknown-format dialog
// appears -> paste the Ingest Recipe the agent derived for it -> Validate runs
// the live dry-run against the full local file and shows the decode report ->
// Open registers it as a `recipe` source whose channels plot on the timeline.
//
// This is the same recipe the modeling subagent produced from a hexdump sample,
// committed at sample-data/sample.acme.recipe.json — so the screenshot is the
// agent's output decoded by the real pipeline.
//
// Screenshots land in screenshots/ for visual confirmation:
//   recipe-dialog.png   the Unknown-format dialog with the validation report
//   recipe-plot.png     the decoded ACME signals plotted

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");

type Hooks = Record<string, (...a: unknown[]) => unknown>;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
    // Drop any recipe the test saved to the registry so runs stay isolated.
    try {
      localStorage.removeItem("driveline.formats.v1");
    } catch {
      /* ignore */
    }
  });
});

test("unknown format: recipe validates and the decoded signals plot", async ({
  page,
}) => {
  // 1. Drop the unknown ACME log. With no matching recipe in the registry it
  //    queues for the Format Agent dialog rather than erroring.
  await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme");
    if (!r.ok) throw new Error(`fetch sample.acme: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([
      { name: "sample.acme", bytes },
    ]);
  });

  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
  await expect(page.getByTestId("unknown-format-filename")).toContainText(
    "sample.acme",
  );

  // 2. Paste the agent-derived recipe and run the live dry-run validation.
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    return r.text();
  });
  await page.getByTestId("unknown-format-recipe-input").fill(recipeJson);
  await page.getByTestId("unknown-format-validate").click();

  // The report decodes all 3000 records cleanly.
  const report = page.getByTestId("unknown-format-report");
  await expect(report).toBeVisible();
  await expect(report).toHaveAttribute("data-ok", "true");
  await expect(report).toContainText("3,000 records");
  await expect(report).toContainText("100.0% coverage");

  await page
    .getByTestId("unknown-format-dialog")
    .screenshot({ path: path.join(SHOTS, "recipe-dialog.png") });

  // 3. Open the source. The dialog closes and the recipe channels register.
  await page.getByTestId("unknown-format-open").click();
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);

  const channels = await page.evaluate(() => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    return (h.listChannels() as { name: string; kind: string; id: string }[])
      .filter((c) => c.kind === "scalar")
      .map((c) => ({ name: c.name, id: c.id }));
  });
  const names = channels.map((c) => c.name).sort();
  expect(names).toEqual([
    "engine/rpm",
    "gps/latitude",
    "gps/longitude",
    "imu/accel_lateral",
    "transmission/gear",
    "vehicle/brake",
    "vehicle/speed",
    "vehicle/steering_angle",
  ]);

  // 4. Bind speed + steering + rpm to the default plot panel and confirm they
  //    render real series (non-empty), proving the decode + Arrow + plot path.
  const bind = channels.filter((c) =>
    ["vehicle/speed", "vehicle/steering_angle", "engine/rpm"].includes(c.name),
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
        return !!stats && stats.length === 3 && stats.every((s) => s.count > 0);
      },
      { timeout: 8000, intervals: [50, 100, 200, 400] },
    )
    .toBe(true);

  // 5. Timestamps decoded in the integer domain: 2024-01-01T00:00:00Z µs ->
  //    1_704_067_200_000_000_000 ns (beyond f64's exact-integer range).
  const range = await page.evaluate((panelId) => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    const snap = h.getPlotPanelSync(panelId) as {
      lastFetchedRange: { startNs: string; endNs: string } | null;
    } | null;
    return snap?.lastFetchedRange ?? null;
  }, "plot-1");
  expect(range).not.toBeNull();
  expect(BigInt(range!.startNs)).toBeLessThanOrEqual(
    1_704_067_200_000_000_000n,
  );
  expect(BigInt(range!.endNs)).toBeGreaterThan(1_704_067_200_000_000_000n);

  await page
    .getByTestId("plot-panel")
    .screenshot({ path: path.join(SHOTS, "recipe-plot.png") });
});

test("a saved recipe auto-matches the next drop (no dialog)", async ({
  page,
}) => {
  // Pre-seed the registry with the committed recipe, then drop the file: it
  // should open straight to a `recipe` source with no Unknown-format dialog.
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    return r.text();
  });
  await page.evaluate((json) => {
    const recipe = JSON.parse(json);
    localStorage.setItem(
      "driveline.formats.v1",
      JSON.stringify({ version: 1, recipes: [recipe] }),
    );
  }, recipeJson);

  await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme");
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([
      { name: "sample.acme", bytes },
    ]);
  });

  // No dialog — the registry matched and opened it directly.
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);
  const channelCount = await page.evaluate(() => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    return (h.listChannels() as unknown[]).length;
  });
  expect(channelCount).toBe(8);
});
