// Raw NVIDIA Alpamayo LiDAR e2e — proves the dataset's *native* Draco-compressed
// LiDAR parquet drops onto the app and renders in the 3D Scene panel with NO
// pre-conversion: the parquet is content-sniffed (its `draco_encoded_pointcloud`
// column), routed to the point-cloud pipeline, and each spin's Draco blob is
// decoded in-browser by Google's reference decoder (loaded lazily) before the
// existing PointCloudReader takes over.
//
// The Alpamayo dataset is license-restricted (NVIDIA PhysicalAI-AV: no public
// hosting/redistribution), so the fixture is NOT committed. Extract a few spins
// of a clip's `<clip>.lidar_top_360fov.parquet` into the repo `sample-data/`
// dir (default path below) or point ALPAMAYO_FIXTURE at one; the spec skips
// cleanly when it's absent (so CI without the data stays green).

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");
const FIXTURE_NAME = "alpamayo_raw_lidar_test.parquet";
const FIXTURE_PATH =
  process.env.ALPAMAYO_FIXTURE ??
  path.resolve(__dirname, "../../../sample-data", FIXTURE_NAME);

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
        spinCount: number;
        frameTsNs: string | null;
        glOk: boolean;
        error: string | null;
      } | null;
    };
  }
}

test.describe("raw Alpamayo LiDAR", () => {
  test.skip(
    !fs.existsSync(FIXTURE_PATH),
    `raw Alpamayo fixture not present at ${FIXTURE_PATH} (license: not committed)`,
  );

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

  test("decodes Draco spins in-browser and renders them in the Scene panel", async ({
    page,
  }) => {
    // Fetch the fixture from the dev server's /sample-data mount rather than
    // ping-ponging ~10 MB through CDP, then drive the real openFiles drop path
    // (which content-sniffs + routes the raw Alpamayo parquet).
    const result = await page.evaluate(async (name) => {
      const buf = new Uint8Array(
        await (await fetch(`/sample-data/${name}`)).arrayBuffer(),
      );
      return window.__drivelineDevHooks!.openFiles([{ name, bytes: buf }]);
    }, FIXTURE_NAME);
    expect(result.errors).toEqual([]);
    expect(result.opened).toContain(FIXTURE_NAME);

    const panelId = await page.evaluate(() => {
      const h = window.__drivelineDevHooks!;
      const pc = h.listChannels().find((c) => c.kind === "point_cloud");
      if (!pc) {
        throw new Error(
          "no point_cloud channel after opening raw Alpamayo lidar",
        );
      }
      const id = h.addScenePanel();
      if (!id) throw new Error("addScenePanel returned no id");
      h.setSceneChannelBinding(id, pc.id);
      h.setSelectedPanelId(id);
      return id;
    });

    // Geometry reaches the GPU once the active spin is Draco-decoded, fetched,
    // and uploaded. Native Alpamayo density is ~247k points/spin.
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) =>
              window.__drivelineDevHooks!.getScenePanelSync(id)?.pointCount ??
              0,
            panelId,
          ),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(100_000);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    // The fixture carries 8 spins; the first sits at 89971 µs × 1000 = 89971000 ns.
    expect(sync?.spinCount).toBe(8);
    expect(sync?.frameTsNs).toBe("89971000");

    await page.waitForTimeout(300); // let the renderer paint a frame
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "alpamayo-lidar-scene.png"),
    });
  });

  test("opens the same raw clip when named *.lidar.parquet", async ({
    page,
  }) => {
    // The natural name for lidar is `*.lidar.parquet`, which routes to the
    // Driveline-schema reader — it would choke on raw Draco columns. So a raw
    // clip under that name must still be content-sniffed and sent to the
    // in-browser Draco path, not fail. (Filename-agnostic routing.)
    const result = await page.evaluate(async (servedName) => {
      const buf = new Uint8Array(
        await (await fetch(`/sample-data/${servedName}`)).arrayBuffer(),
      );
      return window.__drivelineDevHooks!.openFiles([
        { name: "clip.lidar.parquet", bytes: buf },
      ]);
    }, FIXTURE_NAME);
    expect(result.errors).toEqual([]);
    expect(result.opened).toContain("clip.lidar.parquet");

    const kind = await page.evaluate(
      () =>
        window
          .__drivelineDevHooks!.listChannels()
          .find((c) => c.kind === "point_cloud")?.kind ?? null,
    );
    expect(kind).toBe("point_cloud");
  });
});
