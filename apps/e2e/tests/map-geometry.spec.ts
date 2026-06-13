// Road-network map-geometry e2e — proves an OpenDRIVE `.xodr` (and the simple
// `drivelineMap` JSON) ingests as a `map_geometry` source and renders road
// polylines coloured by feature type in the 3D Scene panel. Map geometry is
// STATIC (a single frame at ts=0), so — unlike trajectory/bounding-box — the
// geometry paints as soon as the channel is bound, without scrubbing the
// cursor. Mirrors `trajectory.spec.ts`: fixture bytes → openFiles → find the
// channel → addScenePanel → bind → wait for the features to reach the GPU →
// screenshot the WebGL canvas.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "..",
  "screenshots",
  "map-geometry",
);
const FIXTURE_DIR = path.resolve(__dirname, "../../../test-fixtures");

// A small curved/straight OpenDRIVE road with lane borders, committed alongside
// the simple-JSON fixture by the Rust layer.
const XODR_FILE = "map_opendrive.xodr";
const JSON_FILE = "map_simple.json";

declare global {
  interface Window {
    __drivelineDevHooks?: {
      openFiles: (descs: { name: string; bytes: Uint8Array }[]) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      clearSession: () => Promise<void>;
      resetLayout: () => void;
      addScenePanel: () => string | undefined;
      setSceneChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      setSelectedPanelId: (id: string | null) => void;
      listChannels: () => Array<{
        id: string;
        name: string;
        sourceId: string;
        kind: string;
      }>;
      getScenePanelSync: (panelId: string) => {
        boundChannelId: string | null;
        pointCount: number;
        boxCount: number;
        trajectoryPathCount: number;
        roadFeatureCount: number;
        frameTsNs: string | null;
        spinIndex: number;
        spinCount: number;
        glOk: boolean;
        error: string | null;
      } | null;
    };
  }
}

/** Read a committed map-geometry fixture from disk as raw bytes (Node scope). */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** Open `bytes` as a map-geometry file, mint a Scene panel, bind its
 *  `map_geometry` channel, and return the panel id. Mirrors the trajectory
 *  `openTrajectoryIntoScene` helper. */
async function openMapIntoScene(
  page: Page,
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const result = await page.evaluate(
    async ({ n, b }) =>
      window.__drivelineDevHooks!.openFiles([{ name: n, bytes: b }]),
    { n: name, b: bytes },
  );
  expect(result.errors).toEqual([]);
  expect(result.opened).toContain(name);

  return page.evaluate(() => {
    const h = window.__drivelineDevHooks!;
    const ch = h.listChannels().find((c) => c.kind === "map_geometry");
    if (!ch) throw new Error("no map_geometry channel after opening file");
    const panelId = h.addScenePanel();
    if (!panelId) throw new Error("addScenePanel returned no id");
    h.setSceneChannelBinding(panelId, ch.id);
    h.setSelectedPanelId(panelId);
    return panelId;
  });
}

/** Poll the per-panel sync snapshot until the road features are on the GPU. */
async function waitForFeatures(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) =>
            window.__drivelineDevHooks!.getScenePanelSync(id)
              ?.roadFeatureCount ?? 0,
          panelId,
        ),
      { timeout: 15_000, intervals: [150, 300, 600] },
    )
    .toBeGreaterThan(0);
}

test.describe("Road-network map geometry", () => {
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

  test("renders an OpenDRIVE road network without scrubbing", async ({
    page,
  }) => {
    const panelId = await openMapIntoScene(
      page,
      XODR_FILE,
      readFixture(XODR_FILE),
    );

    // Map geometry is static: the features should reach the GPU on bind, with
    // no cursor scrub required.
    await waitForFeatures(page, panelId);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    expect(sync?.roadFeatureCount).toBeGreaterThan(0);

    await expect(page.getByTestId("scene-road-count")).toBeVisible();

    await page.waitForTimeout(400);
    const host = page.getByTestId("scene-canvas-host");
    await expect(host).toBeVisible();
    await host.screenshot({
      path: path.join(SCREENSHOT_DIR, "opendrive-roads.png"),
    });
  });

  test("renders a simple drivelineMap JSON road network", async ({ page }) => {
    const panelId = await openMapIntoScene(
      page,
      JSON_FILE,
      readFixture(JSON_FILE),
    );

    await waitForFeatures(page, panelId);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    expect(sync?.roadFeatureCount).toBeGreaterThan(0);

    await page.waitForTimeout(400);
    await page.getByTestId("scene-canvas-host").screenshot({
      path: path.join(SCREENSHOT_DIR, "drivelinemap-roads.png"),
    });
  });
});
