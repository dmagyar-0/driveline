// Agent interface v2 — layout write ops e2e (docs/12 §7 visualisation
// bootstrap, docs/11 §`window.__drivelineAgent` v2).
//
// Drives `window.__drivelineAgent`'s createPanel / bindChannels /
// setMapBinding / closePanel against the LIVE FlexLayout model (the unit
// test in apps/web/src/agent/agentApi.test.ts stands in a fake bridge;
// this proves the real Workspace bridge wiring). The ACME recipe fixture is
// reused because it exposes `gps/latitude` + `gps/longitude` channels, so the
// map binding has real lat/lon to bind.
//
// Flow: pre-seed the format registry so the ACME drop opens with no dialog →
// agent mints a plot panel + binds three scalars → mints a map panel + binds
// lat/lon → closes the plot → assert the layout JSON reflects every step →
// screenshot.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentApi } from "../../web/src/agent/agentApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");

// Other specs declare their own `__drivelineDevHooks` shape; re-declaring it
// here would conflict (TS2717), so reach the dev hooks through a loose cast
// (the recipeImport.spec.ts pattern) and only declare the agent surface.
type Hooks = {
  openFiles: (descs: { name: string; bytes: Uint8Array }[]) => Promise<{
    opened: string[];
    errors: { name: string; reason: string }[];
  }>;
  clearSession: () => Promise<void>;
  resetLayout: () => void;
  getLayoutJson: () => string;
};

declare global {
  interface Window {
    __drivelineAgent?: AgentApi;
  }
}

async function seedRegistryAndOpenAcme(page: Page): Promise<void> {
  const recipeJson = await page.evaluate(async () => {
    const r = await fetch("/sample-data/sample.acme.recipe.json");
    if (!r.ok) throw new Error(`fetch recipe: ${r.status}`);
    return r.text();
  });
  // Pre-seed the registry so the drop auto-matches (no Unknown-format dialog).
  await page.evaluate((json) => {
    const recipe = JSON.parse(json);
    localStorage.setItem(
      "driveline.formats.v1",
      JSON.stringify({ version: 1, recipes: [recipe] }),
    );
  }, recipeJson);
  const result = await page.evaluate(async () => {
    const h = window.__drivelineDevHooks as unknown as Hooks;
    const r = await fetch("/sample-data/sample.acme");
    if (!r.ok) throw new Error(`fetch sample.acme: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await h.openFiles([{ name: "sample.acme", bytes }]);
  });
  expect(result.errors).toEqual([]);
  await expect(page.getByTestId("unknown-format-dialog")).toHaveCount(0);
}

async function layoutContains(page: Page, needle: string): Promise<boolean> {
  const json = await page.evaluate(() =>
    (window.__drivelineDevHooks as unknown as Hooks).getLayoutJson(),
  );
  return json.includes(needle);
}

test.describe("agent v2 layout write ops", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?agent=1");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() =>
      (window.__drivelineDevHooks as unknown as Hooks).resetLayout(),
    );
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await (window.__drivelineDevHooks as unknown as Hooks).clearSession();
      try {
        localStorage.removeItem("driveline.formats.v1");
      } catch {
        /* ignore */
      }
    });
  });

  test("creates panels, binds channels + a map, closes a panel", async ({
    page,
  }) => {
    await seedRegistryAndOpenAcme(page);

    // The agent surface installs in DEV / under ?agent — version 2.
    const version = await page.evaluate(() => window.__drivelineAgent!.version);
    expect(version).toBe(2);

    // 1. Mint a plot panel and bind three scalar channels through the agent.
    const plot = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const channels = agent.listChannels();
      const pick = (name: string) =>
        channels.find((c) => c.name === name)?.id ?? null;
      const ids = [
        pick("vehicle/speed"),
        pick("vehicle/steering_angle"),
        pick("engine/rpm"),
      ].filter((id): id is string => id !== null);
      const panelId = agent.createPanel("plot");
      const bound = panelId ? agent.bindChannels(panelId, ids) : false;
      // Unknown channel id must be rejected wholesale.
      const rejected = panelId
        ? agent.bindChannels(panelId, ["does-not-exist"])
        : true;
      return { panelId, ids, bound, rejected };
    });
    expect(plot.panelId).not.toBeNull();
    expect(plot.ids).toHaveLength(3);
    expect(plot.bound).toBe(true);
    expect(plot.rejected).toBe(false);
    expect(plot.panelId!.startsWith("plot-")).toBe(true);
    expect(await layoutContains(page, plot.panelId!)).toBe(true);

    // The plot renders the three bound series (proves the binding took).
    await expect(page.getByTestId(`panel-body-${plot.panelId}`)).toBeVisible();

    // 2. Mint a map panel and bind lat/lon through the agent.
    const map = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const channels = agent.listChannels();
      const lat = channels.find((c) => c.name === "gps/latitude")?.id ?? null;
      const lon = channels.find((c) => c.name === "gps/longitude")?.id ?? null;
      const panelId = agent.createPanel("map");
      const bound =
        panelId && lat && lon ? agent.setMapBinding(panelId, lat, lon) : false;
      // A plot-kind id can't take a map binding (and this one doesn't exist).
      const wrongKind =
        lat && lon
          ? agent.setMapBinding("plot-does-not-exist", lat, lon)
          : true;
      return { panelId, lat, lon, bound, wrongKind };
    });
    expect(map.panelId).not.toBeNull();
    expect(map.lat).not.toBeNull();
    expect(map.lon).not.toBeNull();
    expect(map.bound).toBe(true);
    expect(map.wrongKind).toBe(false);
    expect(map.panelId!.startsWith("map-")).toBe(true);
    expect(await layoutContains(page, '"component":"map"')).toBe(true);
    await expect(page.getByTestId(`panel-body-${map.panelId}`)).toBeVisible();

    // Capture the laid-out workspace before we tear a panel down.
    await page
      .getByTestId("workspace")
      .screenshot({ path: path.join(SHOTS, "agent-layout-ops.png") });

    // 3. Close the plot panel through the agent; the tab leaves the layout.
    const closed = await page.evaluate((id) => {
      const agent = window.__drivelineAgent!;
      return {
        ok: agent.closePanel(id),
        ghost: agent.closePanel("plot-not-real"),
      };
    }, plot.panelId!);
    expect(closed.ok).toBe(true);
    expect(closed.ghost).toBe(false);
    expect(await layoutContains(page, plot.panelId!)).toBe(false);
    // The map panel survives the plot close.
    expect(await layoutContains(page, map.panelId!)).toBe(true);
  });
});
