// Predicted ego trajectory e2e — proves a Driveline `*.trajectory.json` file
// ingests as a `trajectory` source and renders cyan→green candidate polylines
// in the 3D Scene panel, driven by the cursor (one frame of paths per
// timestamp). Mirrors `bounding-box.spec.ts`: fixture bytes → openFiles → find
// the channel → addScenePanel → bind → scrub the cursor into a frame → wait for
// the geometry to reach the GPU → screenshot the WebGL canvas.
//
//   • comma-trajectory.trajectory.json — a synthetic 30-frame Alpamayo-style
//     ego prediction (a primary lane-change path + two lower-confidence
//     alternates) authored in the ISO-8855 z-up vehicle frame, with ns
//     timestamps at 10 Hz anchored at 2024-01-01T00:00:00Z.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "..",
  "screenshots",
  "trajectory",
);
const FIXTURE_DIR = path.resolve(__dirname, "../../../sample-data/openlabel");

const TRAJ_FILE = "comma-trajectory.trajectory.json";
// Three candidate paths per frame (primary + two alternates).
const TRAJ_EXPECTED_PATHS = 3;
// A timestamp comfortably inside the fixture — frame 10 (0 + 10 × 0.1 s).
const TRAJ_BASE_SEC = 1704067200;
const TRAJ_CURSOR_NS = String(BigInt(TRAJ_BASE_SEC + 1) * 1_000_000_000n);

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
        frameTsNs: string | null;
        spinIndex: number;
        spinCount: number;
        glOk: boolean;
        error: string | null;
      } | null;
    };
    __drivelineAgent?: {
      setCursor: (ns: string) => void;
    };
  }
}

/** Read a committed trajectory fixture from disk as raw bytes (Node scope). */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** Open `bytes` as a trajectory file, mint a Scene panel, bind its
 *  `trajectory` channel, and return the panel id. Mirrors the bounding-box
 *  `openOpenLabelIntoScene` helper. */
async function openTrajectoryIntoScene(
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
    const ch = h.listChannels().find((c) => c.kind === "trajectory");
    if (!ch) throw new Error("no trajectory channel after opening file");
    const panelId = h.addScenePanel();
    if (!panelId) throw new Error("addScenePanel returned no id");
    h.setSceneChannelBinding(panelId, ch.id);
    h.setSelectedPanelId(panelId);
    return panelId;
  });
}

/** Poll the per-panel sync snapshot until the paths are on the GPU. */
async function waitForPaths(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) =>
            window.__drivelineDevHooks!.getScenePanelSync(id)
              ?.trajectoryPathCount ?? 0,
          panelId,
        ),
      { timeout: 15_000, intervals: [150, 300, 600] },
    )
    .toBeGreaterThan(0);
}

test.describe("Predicted ego trajectories", () => {
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

  test("renders predicted candidate polylines", async ({ page }) => {
    const panelId = await openTrajectoryIntoScene(
      page,
      TRAJ_FILE,
      readFixture(TRAJ_FILE),
    );

    // Scrub the shared cursor to a timestamp inside the fixture's frames so the
    // panel fetches + decodes + uploads that frame's predicted paths.
    await page.evaluate(
      (ns) => window.__drivelineAgent!.setCursor(ns),
      TRAJ_CURSOR_NS,
    );

    await waitForPaths(page, panelId);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    expect(sync?.trajectoryPathCount).toBe(TRAJ_EXPECTED_PATHS);

    // The "N paths" pill confirms the ready state.
    await expect(page.getByTestId("scene-path-count")).toHaveText(
      `${TRAJ_EXPECTED_PATHS} paths`,
    );

    // Let the renderer paint a settled frame (the panel auto-frames the path
    // set, so the trajectories are guaranteed in view at the default camera).
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "trajectory-default.png"),
    });

    const host = page.getByTestId("scene-canvas-host");
    await expect(host).toBeVisible();
    await host.screenshot({
      path: path.join(SCREENSHOT_DIR, "trajectory-paths.png"),
    });
  });
});
