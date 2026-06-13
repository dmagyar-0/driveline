// Deterministic e2e for the Format Agent Phase-4 "polish" surface
// (docs/12 §3.4 Format Registry UI, §9 drafts + re-derive, §10 sandbox
// conversion). Everything runs through the DEV seams — no network, no key.
//
// Covers:
//   1. A non-converging BYOK run → "Save best attempt as draft" → the draft
//      opens read-only with the low-confidence banner, is listed in the
//      Formats drawer drafts section, and does NOT auto-match the next drop.
//   2. The Formats drawer: rename / delete / export of a saved recipe.
//   3. The open-time stale-recipe gate → the re-derive prompt.
//   4. The sandbox-conversion escape hatch: an "unsupported" failure offers
//      "Convert this file to MCAP", which ingests canned MCAP bytes as a
//      one-shot source labelled "converted copy".
//
// Screenshots (screenshots/):
//   format-registry-drawer.png  the Formats drawer listing a saved recipe
//   format-agent-draft.png      the failure surface with the draft affordance
//   format-agent-converted.png  the one-shot converted source in Sources

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");
const REPO = path.resolve(__dirname, "../../..");

type Hooks = Record<string, (...a: unknown[]) => unknown>;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    await window.__drivelineDevHooks!.clearSession();
    try {
      await window.__drivelineFormatAgent?.resetEngine();
      await window.__drivelineFormatAgent?.resetConverter();
    } catch {
      /* ignore */
    }
    try {
      localStorage.removeItem("driveline.formats.v1");
      localStorage.removeItem("driveline.formats.drafts.v1");
      localStorage.removeItem("driveline.anthropic.key");
    } catch {
      /* ignore */
    }
  });
});

async function dropAcme(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme");
    if (!r.ok) throw new Error(`fetch sample.acme: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    await window.__drivelineDevHooks!.openFiles([
      { name: "sample.acme", bytes },
    ]);
  });
}

test("draft: a non-converging run saves a low-confidence draft", async ({
  page,
}) => {
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    return r.text();
  });

  // A fake engine that validates the best attempt then fails with iteration-cap.
  await page.evaluate(
    (recipe) =>
      window.__drivelineFormatAgent!.installFailingEngine("iteration-cap", recipe),
    recipeJson,
  );

  await dropAcme(page);
  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
  await page.getByTestId("unknown-format-tab-byok").click();
  await page.getByTestId("byok-key-input").fill("sk-ant-e2e-dummy");
  await page.getByTestId("byok-key-continue").click();
  await page.getByTestId("byok-consent-run").click();

  // The run fails; the draft affordance appears (best attempt validated).
  await expect(page.getByTestId("byok-failed")).toBeVisible();
  const draftBlock = page.getByTestId("byok-draft-block");
  await expect(draftBlock).toBeVisible();
  await page
    .getByTestId("unknown-format-dialog")
    .screenshot({ path: path.join(SHOTS, "format-agent-draft.png") });

  // Save the draft → it opens read-only, low-confidence.
  await page.getByTestId("byok-save-draft").click();
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);

  // Opening a (draft) recipe source surfaces the layout proposal (docs/12 §7);
  // skip it so it doesn't intercept later clicks.
  await page.getByTestId("layout-proposal-skip").click();
  await expect(page.getByTestId("layout-proposal-dialog")).toHaveCount(0);

  // The opened source carries the low-confidence banner (Sources drawer).
  await page.getByTestId("rail-sources").click();
  await expect(
    page.locator('[data-testid^="source-low-confidence-"]'),
  ).toBeVisible();

  // The draft is in the drafts shard, NOT the real registry.
  const shardState = await page.evaluate(() => ({
    registry: localStorage.getItem("driveline.formats.v1"),
    drafts: localStorage.getItem("driveline.formats.drafts.v1"),
  }));
  expect(shardState.registry).toBeNull();
  expect(shardState.drafts).not.toBeNull();
  expect(JSON.parse(shardState.drafts!).drafts.length).toBe(1);

  // The Formats drawer lists it under Drafts.
  await page.getByTestId("rail-formats").click();
  await expect(page.getByTestId("formats-drafts")).toBeVisible();

  // A draft never auto-matches the next drop of the same format — dropping
  // sample.acme again re-queues the Unknown-format dialog rather than opening.
  await dropAcme(page);
  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
});

test("registry drawer: rename, export, delete a saved recipe", async ({
  page,
}) => {
  // Pre-seed the registry with the committed recipe.
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
    // A per-format cost so the drawer shows "last derivation".
    localStorage.setItem(
      "driveline.formats.drafts.v1",
      JSON.stringify({
        version: 1,
        drafts: [],
        costs: {
          [recipe.name]: {
            inputTokens: 12800,
            outputTokens: 800,
            estimatedUsd: 0.1,
          },
        },
      }),
    );
  }, recipeJson);

  await page.getByTestId("rail-formats").click();
  await expect(page.getByTestId("drawer-formats")).toBeVisible();
  await expect(page.getByTestId("formats-count-pill")).toHaveText("1");

  const name = "ACME Vehicle Telemetry Log";
  await expect(page.getByTestId(`format-row-${name}`)).toBeVisible();
  await expect(page.getByTestId(`format-cost-${name}`)).toContainText(
    "12,800 in / 800 out",
  );
  await page
    .getByTestId("drawer-formats")
    .screenshot({ path: path.join(SHOTS, "format-registry-drawer.png") });

  // Export → assert a download fires with the right filename.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId(`format-export-${name}`).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    "acme-vehicle-telemetry-log.driveline-recipe.json",
  );

  // Rename.
  await page.getByTestId(`format-rename-${name}`).click();
  const input = page.getByTestId(`format-rename-input-${name}`);
  await input.fill("ACME v4");
  await input.press("Enter");
  await expect(page.getByTestId("format-row-ACME v4")).toBeVisible();

  // Delete.
  await page.getByTestId("format-delete-ACME v4").click();
  await expect(page.getByTestId("formats-empty")).toBeVisible();
  const remaining = await page.evaluate(() => {
    const raw = localStorage.getItem("driveline.formats.v1");
    return raw ? JSON.parse(raw).recipes.length : 0;
  });
  expect(remaining).toBe(0);
});

test("stale-recipe gate prompts a re-derive at open time", async ({ page }) => {
  // Pre-seed a recipe whose `recordSizeBytes` is wrong for sample.acme so the
  // open-time dry-run gate fails (low coverage / framing errors).
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    return r.text();
  });
  await page.evaluate((json) => {
    const recipe = JSON.parse(json);
    recipe.name = "ACME (stale)";
    // Corrupt the framing so the recipe matches by extension but decodes badly:
    // an oversized record consumes only a fraction of the file → low coverage,
    // tripping the open-time stale gate (coverage < 0.99).
    recipe.container.recordSizeBytes = 50000;
    localStorage.setItem(
      "driveline.formats.v1",
      JSON.stringify({ version: 1, recipes: [recipe] }),
    );
  }, recipeJson);

  await dropAcme(page);

  // Instead of opening garbage, the Unknown-format dialog surfaces with the
  // re-derive prompt (docs/12 §9), defaulting to the BYOK tab.
  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
  await expect(page.getByTestId("unknown-format-rederive")).toContainText(
    "ACME (stale)",
  );
  await expect(page.getByTestId("byok-key-step")).toBeVisible();
  // No source opened — the old recipe is kept until replaced.
  const sources = await page.evaluate(
    () => (window.__drivelineDevHooks as unknown as Hooks).listChannels() as [],
  );
  expect(sources.length).toBe(0);
});

test("escape hatch: convert to MCAP ingests a one-shot source", async ({
  page,
}) => {
  // Canned MCAP bytes from the committed tiny fixture (read in Node, injected
  // into the fake converter so the ingestion path runs with no network).
  const mcap = fs.readFileSync(path.join(REPO, "test-fixtures/short.mcap"));
  const mcapArray = Array.from(mcap);

  await page.evaluate(
    (bytes) =>
      window.__drivelineFormatAgent!.installFakeConverter(
        new Uint8Array(bytes as number[]),
      ),
    mcapArray,
  );
  await page.evaluate(() =>
    window.__drivelineFormatAgent!.installFailingEngine("unsupported"),
  );

  await dropAcme(page);
  await expect(page.getByTestId("unknown-format-dialog")).toBeVisible();
  await page.getByTestId("unknown-format-tab-byok").click();
  await page.getByTestId("byok-key-input").fill("sk-ant-e2e-dummy");
  await page.getByTestId("byok-key-continue").click();
  await page.getByTestId("byok-consent-run").click();

  // The unsupported failure offers the conversion escape hatch.
  await expect(page.getByTestId("byok-failed")).toBeVisible();
  await expect(page.getByTestId("byok-convert-block")).toBeVisible();
  await page.getByTestId("byok-convert").click();

  // The dialog closes after ingestion; a one-shot converted source appears.
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);
  await page.getByTestId("rail-sources").click();
  const oneShot = page.locator('[data-testid^="source-one-shot-"]');
  await expect(oneShot).toBeVisible();
  await expect(oneShot).toContainText("Converted copy");
  await page
    .getByTestId("drawer-sources")
    .screenshot({ path: path.join(SHOTS, "format-agent-converted.png") });

  // It is NEVER registered in the format registry.
  const registered = await page.evaluate(
    () => localStorage.getItem("driveline.formats.v1"),
  );
  expect(registered).toBeNull();
});
