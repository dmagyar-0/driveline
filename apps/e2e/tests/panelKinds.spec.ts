// Phase 6 · Panel-kinds e2e.
//
// Exercises the four new panel kinds end-to-end:
//   1. LayoutDrawer add buttons mint scene/map/table/enum panels and
//      the layout JSON gains the new component string.
//   2. PanelDrawer renders the kind-specific body (kind pill text and
//      a kind-specific testid).
//   3. Reload survives the new layout via the v3 persistence path.

import { test, expect, type Page } from "@playwright/test";

interface MapBinding {
  latChannelId: string;
  lonChannelId: string;
}

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      clearSession: () => Promise<void>;
      resetLayout: () => void;
      addScenePanel: () => string | undefined;
      addMapPanel: () => string | undefined;
      addTablePanel: () => string | undefined;
      addEnumPanel: () => string | undefined;
      setSceneChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      setMapChannelBinding: (
        panelId: string,
        binding: MapBinding | null,
      ) => void;
      addTableChannelBinding: (panelId: string, channelId: string) => void;
      addEnumChannelBinding: (panelId: string, channelId: string) => void;
      setActiveRailTab: (tab: string | null) => void;
      setSelectedPanelId: (id: string | null) => void;
      getLayoutJson: () => string;
      listChannels: () => Array<{
        id: string;
        name: string;
        sourceId: string;
        kind: string;
      }>;
    };
  }
}

async function layoutContains(page: Page, needle: string): Promise<boolean> {
  const json = await page.evaluate(() =>
    window.__drivelineDevHooks!.getLayoutJson(),
  );
  return json.includes(needle);
}

test.describe("Panel kinds (Phase 6)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("LayoutDrawer mints all four new panel kinds", async ({ page }) => {
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("layout"),
    );
    for (const testid of [
      "add-scene-panel",
      "add-map-panel",
      "add-table-panel",
      "add-enum-panel",
    ]) {
      await page.getByTestId(testid).click();
    }
    expect(await layoutContains(page, '"component":"scene"')).toBe(true);
    expect(await layoutContains(page, '"component":"map"')).toBe(true);
    expect(await layoutContains(page, '"component":"table"')).toBe(true);
    expect(await layoutContains(page, '"component":"enum"')).toBe(true);
  });

  test("scene panel renders empty state and PanelDrawer shows SCENE pill", async ({
    page,
  }) => {
    const id = await page.evaluate(() =>
      window.__drivelineDevHooks!.addScenePanel(),
    );
    expect(id).toBeTruthy();
    await expect(page.getByTestId("scene-panel")).toBeVisible();
    await expect(page.getByTestId("scene-empty")).toBeVisible();

    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (panelId) => window.__drivelineDevHooks!.setSelectedPanelId(panelId),
      id!,
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("SCENE");
    await expect(page.getByTestId("panel-scene-status")).toBeVisible();
  });

  test("table panel binds via dev hook and PanelDrawer shows TABLE pill", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const r = await fetch(`/sample-data/short.mcap`);
      if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);

    const tableId = await page.evaluate(() =>
      window.__drivelineDevHooks!.addTablePanel(),
    );
    expect(tableId).toBeTruthy();

    const channelId = await page.evaluate(() => {
      const list = window.__drivelineDevHooks!.listChannels();
      const scalar = list.find((c) => c.kind === "scalar");
      return scalar?.id ?? null;
    });
    expect(channelId).not.toBeNull();

    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.addTableChannelBinding(panelId, id),
      [tableId!, channelId!],
    );

    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
      tableId!,
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("TABLE");
    await expect(
      page.getByTestId(`panel-table-remove-${channelId}`),
    ).toBeVisible();
  });

  test("enum panel binds via dev hook and PanelDrawer shows ENUM pill", async ({
    page,
  }) => {
    const result = await page.evaluate(async () => {
      const r = await fetch(`/sample-data/short.mcap`);
      if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);

    const enumId = await page.evaluate(() =>
      window.__drivelineDevHooks!.addEnumPanel(),
    );
    expect(enumId).toBeTruthy();

    const channelId = await page.evaluate(() => {
      const list = window.__drivelineDevHooks!.listChannels();
      const scalar = list.find((c) => c.kind === "scalar");
      return scalar?.id ?? null;
    });
    expect(channelId).not.toBeNull();

    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.addEnumChannelBinding(panelId, id),
      [enumId!, channelId!],
    );

    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
      enumId!,
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("ENUM");
    await expect(page.getByTestId("enum-panel")).toBeVisible();
    await expect(page.getByTestId("enum-channel-name")).toBeVisible();
  });

  test("map panel renders bound state with two channels", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const r = await fetch(`/sample-data/short.mcap`);
      if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);

    const mapId = await page.evaluate(() =>
      window.__drivelineDevHooks!.addMapPanel(),
    );
    expect(mapId).toBeTruthy();

    // The fixture might not have lat/lon channels; reuse any two scalar
    // channels just to exercise the bound-state branch. The polyline
    // will be nonsensical but the panel container still renders.
    const channelIds = await page.evaluate(() => {
      const list = window.__drivelineDevHooks!.listChannels();
      const scalars = list.filter((c) => c.kind === "scalar");
      return scalars.slice(0, 2).map((c) => c.id);
    });
    if (channelIds.length < 2) {
      // No scalars to bind; the map empty state is the expected branch.
      await expect(page.getByTestId("map-empty")).toBeVisible();
      return;
    }

    await page.evaluate(
      ([panelId, lat, lon]) =>
        window.__drivelineDevHooks!.setMapChannelBinding(panelId, {
          latChannelId: lat,
          lonChannelId: lon,
        }),
      [mapId!, channelIds[0], channelIds[1]],
    );

    await expect(page.getByTestId("map-container")).toBeVisible();
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
      mapId!,
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("MAP");
  });

  test("layout v3 persistence survives reload", async ({ page }) => {
    await page.evaluate(() =>
      window.__drivelineDevHooks!.addScenePanel(),
    );
    await page.evaluate(() =>
      window.__drivelineDevHooks!.addEnumPanel(),
    );
    expect(await layoutContains(page, '"component":"scene"')).toBe(true);
    expect(await layoutContains(page, '"component":"enum"')).toBe(true);

    await page.reload();
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    expect(await layoutContains(page, '"component":"scene"')).toBe(true);
    expect(await layoutContains(page, '"component":"enum"')).toBe(true);
  });
});
