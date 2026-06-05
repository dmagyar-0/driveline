// Map panel lat/lon picker — drives the *real* drawer UI.
//
// panelKinds.spec binds the map through the setMapChannelBinding dev hook,
// which bypasses the picker entirely (and short.mcap has only one scalar
// channel, so that spec never actually exercises a two-axis bind). That
// gap hid a regression where the two pickers — filled one axis at a time —
// could never complete a binding: picking lat alone was written straight
// back as null because the store's MapBinding needs both axes. To the
// user, clicking a lat/lon channel did nothing.
//
// This spec clicks the actual "+ pick lat channel…" / "+ pick lon channel…"
// buttons and the channel checkboxes, asserting a half-pick is reflected
// immediately and the complete pair binds the map. The store allows the
// same channel on both axes, so with short.mcap's single scalar we bind it
// to both roles (a distinct second channel is used when the fixture has
// one). The polyline is meaningless — this tests the binding path.

import { test, expect, type Page } from "@playwright/test";

async function loadShortMcapScalars(page: Page): Promise<[string, string]> {
  const open = await page.evaluate(async () => {
    const r = await fetch("/sample-data/short.mcap");
    if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    return await window.__drivelineDevHooks!.openFiles([
      { name: "short.mcap", bytes },
    ]);
  });
  expect(open.errors).toEqual([]);

  const ids = await page.evaluate(() =>
    window
      .__drivelineDevHooks!.listChannels()
      .filter((c) => c.kind === "scalar")
      .map((c) => c.id),
  );
  expect(ids.length, "fixture needs at least one scalar channel").toBeGreaterThan(
    0,
  );
  // Distinct axes when the fixture offers two scalars; reuse the one it has
  // otherwise (the store accepts lat === lon).
  return [ids[0], ids[1] ?? ids[0]];
}

async function openMapDrawer(page: Page): Promise<void> {
  const mapId = await page.evaluate(() =>
    window.__drivelineDevHooks!.addMapPanel(),
  );
  expect(mapId).toBeTruthy();
  await page.evaluate(() =>
    window.__drivelineDevHooks!.setActiveRailTab("panel"),
  );
  await page.evaluate(
    (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
    mapId!,
  );
  await expect(page.getByTestId("drawer-panel-kind")).toHaveText("MAP");
}

test.describe("Map panel lat/lon picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("binds lat then lon one axis at a time through the drawer", async ({
    page,
  }) => {
    const [latId, lonId] = await loadShortMcapScalars(page);
    await openMapDrawer(page);

    await expect(page.getByTestId("map-empty")).toBeVisible();

    // Pick latitude. The click must register — the lat row (its × button)
    // appears. Before the fix this pick was discarded and nothing showed.
    await page.getByTestId("panel-map-pick-lat").click();
    await page.getByTestId(`pick-${latId}`).click();
    await expect(page.getByTestId("panel-map-remove-lat")).toBeVisible();
    // A half pair isn't committed, so the map is still empty.
    await expect(page.getByTestId("map-empty")).toBeVisible();

    // Pick longitude → the complete pair commits and the map binds.
    await page.getByTestId("panel-map-pick-lon").click();
    await page.getByTestId(`pick-${lonId}`).click();
    await expect(page.getByTestId("panel-map-remove-lon")).toBeVisible();
    await expect(page.getByTestId("map-container")).toBeVisible();
    await expect(page.getByTestId("map-empty")).toHaveCount(0);
  });

  test("binds when longitude is picked first (order independent)", async ({
    page,
  }) => {
    const [latId, lonId] = await loadShortMcapScalars(page);
    await openMapDrawer(page);

    // Longitude first.
    await page.getByTestId("panel-map-pick-lon").click();
    await page.getByTestId(`pick-${lonId}`).click();
    await expect(page.getByTestId("panel-map-remove-lon")).toBeVisible();
    await expect(page.getByTestId("map-empty")).toBeVisible();

    // Then latitude → binds.
    await page.getByTestId("panel-map-pick-lat").click();
    await page.getByTestId(`pick-${latId}`).click();
    await expect(page.getByTestId("panel-map-remove-lat")).toBeVisible();
    await expect(page.getByTestId("map-container")).toBeVisible();
  });
});
