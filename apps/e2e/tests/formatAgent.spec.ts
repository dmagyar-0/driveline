// Deterministic e2e for the Format Agent BYOK flow (docs/12 Phase 2).
//
// Drives the WHOLE consent + progress UI without any network: an engine-
// injection seam (`window.__drivelineFormatAgent.installFakeEngine`, DEV-only)
// swaps the real `ClientOrchestratedEngine` for a fake that emits a couple of
// progress events, runs the REAL local dry-run against the dropped file, then
// returns the committed `sample.acme.recipe.json` recipe. So the spec asserts
// the full journey deterministically:
//
//   drop sample.acme -> dialog -> "Decode with Claude" tab -> enter dummy key
//   -> consent shows the exact sample manifest + a hex preview -> run streams
//   progress + a validation verdict -> success -> Open registers the recipe
//   -> channels appear in the rail -> bind + plot renders real series.
//
// Screenshots land in screenshots/ for visual confirmation:
//   format-agent-consent.png  the consent manifest + hex/ASCII preview
//   format-agent-result.png   the decoded ACME signals plotted

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
    // Restore the real engine factory and drop any saved recipe / key so runs
    // stay isolated.
    try {
      await window.__drivelineFormatAgent?.resetEngine();
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem("driveline.formats.v1");
      localStorage.removeItem("driveline.anthropic.key");
    } catch {
      /* ignore */
    }
  });
});

test("Format Agent BYOK: consent → progress → recipe → plot", async ({
  page,
}) => {
  // 0. Install the fake engine (lazy-imports the llm/ chunk, no network). It
  //    emits a thinking line + a sandbox action, then the dialog's own logic
  //    runs the local dry-run and returns the committed recipe.
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    return r.text();
  });
  await page.evaluate(async (recipe) => {
    await window.__drivelineFormatAgent!.installFakeEngine(
      [
        {
          type: "thinking",
          text: "Probing container framing on the head slice.",
        },
        { type: "sandbox-action", text: "trying 32-byte fixed records, LE" },
        {
          type: "cost",
          tally: {
            inputTokens: 12000,
            outputTokens: 800,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            estimatedUsd: 0.08,
          },
        },
      ],
      recipe,
    );
  }, recipeJson);

  // 1. Drop the unknown ACME log -> Unknown-format dialog.
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

  // 2. Switch to the BYOK tab and enter a dummy key.
  await page.getByTestId("unknown-format-tab-byok").click();
  await expect(page.getByTestId("byok-key-step")).toBeVisible();
  await page.getByTestId("byok-key-input").fill("sk-ant-e2e-dummy");
  await page.getByTestId("byok-key-continue").click();

  // 3. Consent step renders the EXACT manifest + a hex/ASCII preview.
  await expect(page.getByTestId("byok-consent-step")).toBeVisible();
  const manifest = page.getByTestId("byok-manifest");
  await expect(manifest).toBeVisible();
  // sample.acme is small, so head+tail cover it — a single whole-file slice.
  await expect(manifest).toContainText("slice");
  const hex = page.getByTestId("byok-hex-preview");
  await expect(hex).toBeVisible();
  // The ACME magic "ACMELOG" lands in the head-slice ASCII gutter.
  await expect(hex).toContainText("ACMELOG");

  await page
    .getByTestId("unknown-format-dialog")
    .screenshot({ path: path.join(SHOTS, "format-agent-consent.png") });

  // 4. Consent -> run. The fake engine streams progress then the dialog's own
  //    logic runs the REAL local dry-run and converges. The run step is
  //    transient (the fake completes fast), so assert on the durable success
  //    surface, which carries the same dry-run report the run produced.
  await page.getByTestId("byok-consent-run").click();
  await expect(page.getByTestId("byok-success")).toBeVisible();

  // 5. The verdict came from the REAL dry-run over the full file: all 3000
  //    records decode cleanly.
  await expect(page.getByTestId("unknown-format-report")).toHaveAttribute(
    "data-ok",
    "true",
  );
  await expect(page.getByTestId("unknown-format-report")).toContainText(
    "3,000 records",
  );
  await page.getByTestId("byok-open").click();
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);

  // 6. Channels appear in the rail (same set the manual path registers).
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

  // 7. Bind a few channels and confirm the plot renders real series.
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

  await page
    .getByTestId("plot-panel")
    .screenshot({ path: path.join(SHOTS, "format-agent-result.png") });

  // 8. The verified recipe was saved to the registry (team-sharing story).
  const saved = await page.evaluate(() => {
    const raw = localStorage.getItem("driveline.formats.v1");
    return raw ? (JSON.parse(raw).recipes as unknown[]).length : 0;
  });
  expect(saved).toBe(1);
});

test("Format Agent BYOK: abort during a run is honest, not a crash", async ({
  page,
}) => {
  // A fake engine that hangs until aborted, so we can exercise the Abort button
  // and the failure surface.
  await page.evaluate(() =>
    window.__drivelineFormatAgent!.installHangingEngine(),
  );

  await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme");
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([
      { name: "sample.acme", bytes },
    ]);
  });

  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
  await page.getByTestId("unknown-format-tab-byok").click();
  await page.getByTestId("byok-key-input").fill("sk-ant-e2e-dummy");
  await page.getByTestId("byok-key-continue").click();
  await page.getByTestId("byok-consent-run").click();

  await expect(page.getByTestId("byok-run-step")).toBeVisible();
  await page.getByTestId("byok-abort").click();

  // Failure surface shows the honest "cancelled" copy, offers a clean restart.
  await expect(page.getByTestId("byok-failed")).toBeVisible();
  await expect(page.getByTestId("byok-failed")).toContainText("cancelled");
  await expect(page.getByTestId("byok-retry")).toBeVisible();
});
