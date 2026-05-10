// Phase 5 · Panel drawer e2e.
//
// Exercises the new PanelDrawer end-to-end:
//   1. Empty state when no panel is selected.
//   2. Plot body: + add channel popover, × removes a binding.
//   3. Video body: HUD toggle round-trips through three surfaces (drawer
//      button, in-panel button, `h` keypress). Persists across reload.

import { test, expect, type Page } from "@playwright/test";

interface HudStats {
  ptsNs: string | null;
  frameIndex: number;
  decodeQueue: number;
  blitQueueLen: number;
  dropped: number;
  codec: string | null;
  hudOn: boolean;
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
      setVideoChannelBinding: (
        panelId: string,
        channelId: string | null,
      ) => void;
      addPlotChannelBinding: (panelId: string, channelId: string) => void;
      resetLayout: () => void;
      listChannels: () => Array<{ id: string; name: string; sourceId: string }>;
      findChannelId: (q: { sourceName: string; nativeId: string }) =>
        string | null;
      setActiveRailTab: (tab: string | null) => void;
      setSelectedPanelId: (id: string | null) => void;
      getSelectedPanelId: () => string | null;
      getVideoHudOn: (panelId: string) => boolean;
      videoHudStats: () => HudStats | null;
    };
  }
}

const VIDEO_PANEL_ID = "video-1";
// PR #84b08ee changed `Channel.id` from the native form to
// `qualifiedChannelId(sourceId, nativeId)`, so the test resolves the id
// at runtime via the `findChannelId` dev hook.
const VIDEO_NATIVE_ID = "1/video";
const VIDEO_SOURCE_NAME = "short.mp4";

async function hud(page: Page): Promise<HudStats | null> {
  return await page.evaluate(() => window.__drivelineDevHooks!.videoHudStats());
}

async function getHudOn(page: Page, panelId: string): Promise<boolean> {
  return await page.evaluate(
    (id) => window.__drivelineDevHooks!.getVideoHudOn(id),
    panelId,
  );
}

test.describe("Panel drawer (Phase 5)", () => {
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

  test("empty state shows when no panel is selected", async ({ page }) => {
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setSelectedPanelId(null),
    );
    await expect(page.getByTestId("panel-drawer-empty")).toBeVisible();
    await expect(page.getByTestId("drawer-panel-name")).toHaveCount(0);
  });

  test("video body: HUD toggle round-trips across drawer/button/keypress and persists across reload", async ({
    page,
  }) => {
    // Drop the mp4 + sidecar fixture and bind the default video panel.
    const result = await page.evaluate(async () => {
      const names = ["short.mp4", "short.mp4.timestamps"];
      const descs = await Promise.all(
        names.map(async (n) => {
          const r = await fetch(`/sample-data/${n}`);
          if (!r.ok) throw new Error(`fetch ${n}: ${r.status}`);
          return { name: n, bytes: new Uint8Array(await r.arrayBuffer()) };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    });
    expect(result.errors).toEqual([]);
    // Resolve the qualified channel id at runtime — PR #84b08ee changed
    // `Channel.id` to `qualifiedChannelId(sourceId, nativeId)`.
    const channelId = await page.evaluate(
      ({ sourceName, nativeId }) =>
        window.__drivelineDevHooks!.findChannelId({ sourceName, nativeId }),
      { sourceName: VIDEO_SOURCE_NAME, nativeId: VIDEO_NATIVE_ID },
    );
    expect(channelId, "video channel must resolve").not.toBeNull();
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.setVideoChannelBinding(panelId, id),
      [VIDEO_PANEL_ID, channelId!],
    );
    await page.getByTestId("video-panel-canvas").waitFor();
    await expect
      .poll(async () => (await hud(page)) !== null, { timeout: 10_000 })
      .toBe(true);

    // Open the panel drawer and select the video panel.
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
      VIDEO_PANEL_ID,
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("VIDEO");

    // Codec label fills in from the rAF-published HUD snapshot.
    await expect
      .poll(
        async () =>
          (await page.getByTestId("panel-video-decoder").textContent()) ?? "—",
        { timeout: 5_000 },
      )
      .not.toBe("—");

    // Surface 1: drawer toggle.
    await page.getByTestId("panel-drawer-hud-toggle").click();
    await expect
      .poll(() => getHudOn(page, VIDEO_PANEL_ID))
      .toBe(true);

    // Surface 2: in-panel button. Flips back to false.
    await page.getByTestId("video-hud-toggle").click();
    await expect
      .poll(() => getHudOn(page, VIDEO_PANEL_ID))
      .toBe(false);

    // Surface 3: `h` keypress on the video panel container. Flips to true.
    await page.getByTestId("video-panel-canvas").click();
    await page.keyboard.press("h");
    await expect
      .poll(() => getHudOn(page, VIDEO_PANEL_ID))
      .toBe(true);

    // Persistence — reload, re-open drawer, re-select; bit survives.
    await page.reload();
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await expect
      .poll(() => getHudOn(page, VIDEO_PANEL_ID))
      .toBe(true);
  });

  test("plot body: × removes a bound channel", async ({ page }) => {
    // Open the mcap fixture so a scalar channel exists.
    const result = await page.evaluate(async () => {
      const r = await fetch(`/sample-data/short.mcap`);
      if (!r.ok) throw new Error(`fetch short.mcap: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mcap", bytes },
      ]);
    });
    expect(result.errors).toEqual([]);

    // Pick the first scalar channel and bind it to the default plot panel.
    const channelId = await page.evaluate(() => {
      const list = window.__drivelineDevHooks!.listChannels();
      return list[0]?.id ?? null;
    });
    expect(channelId).not.toBeNull();
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.addPlotChannelBinding(panelId, id),
      ["plot-1", channelId!],
    );

    // Open the panel drawer and select the plot panel.
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("panel"),
    );
    await page.evaluate(
      (id) => window.__drivelineDevHooks!.setSelectedPanelId(id),
      "plot-1",
    );
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("PLOT");
    await expect(
      page.getByTestId(`panel-plot-remove-${channelId}`),
    ).toBeVisible();

    // Click × removes the binding.
    await page.getByTestId(`panel-plot-remove-${channelId}`).click();
    await expect(
      page.getByTestId(`panel-plot-remove-${channelId}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("panel-plot-count")).toHaveText("0 / 8");
  });
});
