// LiDAR PCD e2e — proves a PCL/ROS `.pcd` file drops onto the app and renders
// in the 3D Scene panel through the same point-cloud pipeline as a
// `.lidar.parquet`. The cloud is generated inline (a recognisable LiDAR-style
// scene: a ground plane, a "vehicle" box, and two poles, coloured by
// intensity), so the test is self-contained — no committed binary fixture — and
// doubles as the worked example referenced in tools/README.md.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

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
        glOk: boolean;
        error: string | null;
      } | null;
    };
  }
}

/** Build an ASCII PCD describing a small LiDAR-style scene with x/y/z + an
 *  `intensity` field. Returns the file bytes. */
function makeScenePcd(): Uint8Array {
  const pts: Array<[number, number, number, number]> = [];

  // Ground plane: a 40 m x 40 m grid at z = 0, intensity falling with range so
  // the turbo colormap reads as a radial gradient out from the sensor.
  for (let x = -20; x <= 20; x += 0.5) {
    for (let y = -20; y <= 20; y += 0.5) {
      const r = Math.hypot(x, y);
      pts.push([x, y, 0, Math.max(0, 1 - r / 30)]);
    }
  }
  // A "vehicle": a hollow box 4 m x 2 m x 1.5 m sitting ahead of the sensor.
  for (let x = 5; x <= 9; x += 0.15) {
    for (let y = -1; y <= 1; y += 0.15) {
      for (let z = 0; z <= 1.5; z += 0.15) {
        const onShell =
          x < 5.2 || x > 8.8 || y < -0.85 || y > 0.85 || z < 0.15 || z > 1.35;
        if (onShell) pts.push([x, y, z, 0.95]);
      }
    }
  }
  // Two vertical poles (lamp posts) flanking the road.
  for (const px of [-6, 6]) {
    for (let z = 0; z <= 6; z += 0.1) {
      pts.push([px, 12, z, 0.6]);
    }
  }

  const header =
    `# .PCD v0.7 - Point Cloud Data file format\n` +
    `VERSION 0.7\n` +
    `FIELDS x y z intensity\n` +
    `SIZE 4 4 4 4\n` +
    `TYPE F F F F\n` +
    `COUNT 1 1 1 1\n` +
    `WIDTH ${pts.length}\n` +
    `HEIGHT 1\n` +
    `VIEWPOINT 0 0 0 1 0 0 0\n` +
    `POINTS ${pts.length}\n` +
    `DATA ascii\n`;
  const body = pts.map(([x, y, z, i]) => `${x} ${y} ${z} ${i}`).join("\n");
  return new TextEncoder().encode(header + body + "\n");
}

/** Open `bytes` as a PCD, mint a Scene panel, bind the point-cloud channel, and
 *  return the panel id. */
async function openPcdIntoScene(page: Page, bytes: Uint8Array): Promise<string> {
  const result = await page.evaluate(
    async (b) =>
      window.__drivelineDevHooks!.openFiles([{ name: "scene.pcd", bytes: b }]),
    bytes,
  );
  expect(result.errors).toEqual([]);
  expect(result.opened).toContain("scene.pcd");

  return page.evaluate(() => {
    const h = window.__drivelineDevHooks!;
    const pc = h.listChannels().find((c) => c.kind === "point_cloud");
    if (!pc) throw new Error("no point_cloud channel after opening the PCD");
    const panelId = h.addScenePanel();
    if (!panelId) throw new Error("addScenePanel returned no id");
    h.setSceneChannelBinding(panelId, pc.id);
    h.setSelectedPanelId(panelId);
    return panelId;
  });
}

test.describe("LiDAR PCD", () => {
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

  test("opens a .pcd and renders points in the Scene panel", async ({
    page,
  }) => {
    const panelId = await openPcdIntoScene(page, makeScenePcd());

    // Geometry reaches the GPU once the bound spin is fetched + uploaded.
    await expect
      .poll(
        async () =>
          page.evaluate(
            (id) => window.__drivelineDevHooks!.getScenePanelSync(id)?.pointCount ?? 0,
            panelId,
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(1000);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    expect(sync?.spinCount).toBe(1); // a PCD is a single cloud

    await expect(page.getByTestId("scene-points-count")).toBeVisible();
    await page.waitForTimeout(300); // let the renderer paint a frame
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "lidar-pcd-scene.png"),
    });
  });
});
