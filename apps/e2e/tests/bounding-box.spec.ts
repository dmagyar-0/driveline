// OpenLABEL 3D bounding-box e2e — proves an ASAM OpenLABEL `.json` file ingests
// as a `bounding_box` source and renders amber wireframe boxes + floating HTML
// label chips in the 3D Scene panel, driven by the cursor (one frame per
// timestamp). Mirrors `lidar-pcd.spec.ts`: fixture bytes → openFiles → find the
// channel → addScenePanel → bind → scrub the cursor into a frame → wait for the
// geometry to reach the GPU → screenshot the WebGL canvas.
//
// Two fixtures exercise the path:
//   • comma-scene.openlabel.json — a synthetic 25-frame dashcam scene (5 cars +
//     1 truck + 1 pedestrian) authored in the ISO-8855 z-up vehicle frame, with
//     numeric float-second timestamps at 10 Hz. The headline demo.
//   • vcd-cuboids.openlabel.json — the real Vicomtech VCD OpenLABEL cuboid test
//     file (externally authored), as a real-world ingestion smoke test.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(
  __dirname,
  "..",
  "screenshots",
  "bounding-box",
);
const FIXTURE_DIR = path.resolve(__dirname, "../../../sample-data/openlabel");

// The comma fixture: 7 objects (every frame carries all 7 cuboids), 25 frames
// at 10 Hz, frame 0 anchored at 2024-01-01T00:00:00Z (1704067200 s).
const COMMA_FILE = "comma-scene.openlabel.json";
const COMMA_EXPECTED_BOXES = 7;
// A timestamp comfortably inside the fixture — frame 10 (0 + 10 × 0.1 s).
const COMMA_BASE_SEC = 1704067200;
const COMMA_CURSOR_NS = String(BigInt(COMMA_BASE_SEC + 1) * 1_000_000_000n);

// The Vicomtech VCD file: 2 objects. car1 uses the 9-element `val` form; car2
// uses OpenLABEL's convenience-field form (separate quaternion/translation/size
// with `val: null`). The reader now parses both, so both cars reach the GPU —
// exactly 2 boxes for the real-world ingestion smoke test.
const VCD_FILE = "vcd-cuboids.openlabel.json";
const VCD_EXPECTED_BOXES = 2;

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
        frameTsNs: string | null;
        spinIndex: number;
        spinCount: number;
        glOk: boolean;
        error: string | null;
      } | null;
    };
    // Agent automation surface (installed in DEV). Used here to drive the
    // shared cursor to a timestamp inside the fixture without scraping the
    // scrubber DOM. `ns` is a decimal string so full ns precision survives.
    __drivelineAgent?: {
      setCursor: (ns: string) => void;
    };
  }
}

/** Read a committed OpenLABEL fixture from disk as raw bytes (Node scope). */
function readFixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(FIXTURE_DIR, name)));
}

/** Open `bytes` as an OpenLABEL file, mint a Scene panel, bind its
 *  `bounding_box` channel, and return the panel id. Mirrors the lidar-pcd
 *  `openPcdIntoScene` helper. */
async function openOpenLabelIntoScene(
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
    const ch = h.listChannels().find((c) => c.kind === "bounding_box");
    if (!ch) throw new Error("no bounding_box channel after opening OpenLABEL");
    const panelId = h.addScenePanel();
    if (!panelId) throw new Error("addScenePanel returned no id");
    h.setSceneChannelBinding(panelId, ch.id);
    h.setSelectedPanelId(panelId);
    return panelId;
  });
}

/** Poll the per-panel sync snapshot until the boxes are on the GPU. */
async function waitForBoxes(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(
          (id) =>
            window.__drivelineDevHooks!.getScenePanelSync(id)?.boxCount ?? 0,
          panelId,
        ),
      { timeout: 15_000, intervals: [150, 300, 600] },
    )
    .toBeGreaterThan(0);
}

test.describe("OpenLABEL 3D bounding boxes", () => {
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

  test("renders labelled boxes around the dashcam scene", async ({ page }) => {
    const panelId = await openOpenLabelIntoScene(
      page,
      COMMA_FILE,
      readFixture(COMMA_FILE),
    );

    // Scrub the shared cursor to a timestamp inside the fixture's frames so the
    // panel fetches + decodes + uploads that frame's boxes.
    await page.evaluate(
      (ns) => window.__drivelineAgent!.setCursor(ns),
      COMMA_CURSOR_NS,
    );

    await waitForBoxes(page, panelId);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    // Every frame in the fixture carries all 7 objects' cuboids.
    expect(sync?.boxCount).toBe(COMMA_EXPECTED_BOXES);

    // At least one floating label chip is in the DOM overlay layer.
    await expect(page.getByTestId("scene-label-layer")).toBeVisible();
    const labelChips = page.getByTestId("scene-box-label");
    await expect(labelChips.first()).toBeVisible();
    expect(await labelChips.count()).toBeGreaterThan(0);

    // The amber "N boxes" pill confirms the ready state.
    await expect(page.getByTestId("scene-box-count")).toHaveText(
      `${COMMA_EXPECTED_BOXES} boxes`,
    );

    // Let the renderer paint a settled frame (Task B auto-frames the box set,
    // so the boxes are guaranteed in view at the default camera).
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "scene-default.png"),
    });

    // A tighter crop over the scene canvas confirming the label chips are
    // legible against the framed boxes.
    const host = page.getByTestId("scene-canvas-host");
    await expect(host).toBeVisible();
    await host.screenshot({
      path: path.join(SCREENSHOT_DIR, "scene-labels.png"),
    });
  });

  test("ingests the real Vicomtech VCD OpenLABEL file", async ({ page }) => {
    const panelId = await openOpenLabelIntoScene(
      page,
      VCD_FILE,
      readFixture(VCD_FILE),
    );

    // The static-form file has no frame timestamps, so its single frame sits at
    // ts 0; scrub there so the active-frame lookup lands on it.
    await page.evaluate(() => window.__drivelineAgent!.setCursor("0"));

    await waitForBoxes(page, panelId);

    const sync = await page.evaluate(
      (id) => window.__drivelineDevHooks!.getScenePanelSync(id),
      panelId,
    );
    expect(sync?.glOk).toBe(true);
    expect(sync?.error).toBeNull();
    // Both cars now parse (car1 via `val`, car2 via the convenience fields).
    expect(sync?.boxCount).toBe(VCD_EXPECTED_BOXES);

    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "vcd-scene.png"),
    });
  });
});
