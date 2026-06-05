// Phase 7 · Per-panel chrome e2e.
//
// Exercises the new tab chrome wired by Workspace.tsx's `onRenderTab`:
//   1. Each tab carries a kind badge (VIDEO / PLOT) injected by
//      `kindLabel(panelKindOf(...))`.
//   2. Clicking the settings icon flips the rail to the Panel drawer
//      and selects the clicked panel.
//   3. Clicking inside the panel body marks that panel as selected via
//      the `panelFactory` click-to-select wrapper.
//   4. Maximize toggles the FlexLayout `maximized` field on the
//      tabset id (asserted from the round-tripped `getLayoutJson()`).
//   5. Close removes the tab id from the layout JSON entirely.

import { test, expect, type Page } from "@playwright/test";

declare global {
  interface Window {
    __drivelineDevHooks?: {
      resetLayout: () => void;
      clearSession: () => Promise<void>;
      openFiles: (
        descs: { name: string; bytes: Uint8Array }[],
      ) => Promise<{
        opened: string[];
        errors: { name: string; reason: string }[];
      }>;
      setActiveRailTab: (tab: string | null) => void;
      getActiveRailTab: () => string | null;
      setSelectedPanelId: (id: string | null) => void;
      getSelectedPanelId: () => string | null;
      getLayoutJson: () => string;
    };
  }
}

const VIDEO_PANEL_ID = "video-1";
const PLOT_PANEL_ID = "plot-1";

// FlexLayout renders hidden, off-screen "drag stamp" copies of every tab
// button (under `.flexlayout__layout_tab_stamps`, positioned at
// top:-10000px) so it can show a drag-preview rectangle. Those stamps run
// our `onRenderTab` content too, so each `tab-*` testid resolves to BOTH
// the real on-screen tab and its stamp — doubling every count and breaking
// strict-mode clicks. Scope chrome lookups to the real tabset strip
// (`.flexlayout__tabset`), which never contains the stamps, so the tests
// see exactly one element per visible tab.
function tabChrome(page: Page, testId: string) {
  return page.locator(`.flexlayout__tabset [data-testid="${testId}"]`);
}

async function getLayout(page: Page): Promise<string> {
  return await page.evaluate(() =>
    window.__drivelineDevHooks!.getLayoutJson(),
  );
}

test.describe("Per-panel chrome (Phase 7)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText(
      "workers ready",
    );
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

    // Load a minimal session so the FirstRun splash (an opaque, full-screen
    // overlay shown while `sources.length === 0`) is dismissed. Without a
    // session it sits on top of the workspace and intercepts every pointer
    // event, so the tab-chrome clicks below would never reach their target.
    // Any source dismisses it; `short.mf4` is the smallest fixture.
    const load = await page.evaluate(async () => {
      const r = await fetch("/sample-data/short.mf4");
      if (!r.ok) throw new Error(`fetch mf4: ${r.status}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      return await window.__drivelineDevHooks!.openFiles([
        { name: "short.mf4", bytes },
      ]);
    });
    expect(load.errors).toEqual([]);
    await expect(page.getByTestId("first-run")).toHaveCount(0);

    // The default layout's two panels are Video (`video-1`) and Plot
    // (`plot-1`), each in its own tabset.
    await expect(page.getByTestId(`panel-body-${VIDEO_PANEL_ID}`)).toBeVisible();
    await expect(page.getByTestId(`panel-body-${PLOT_PANEL_ID}`)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("each tab renders its kind badge", async ({ page }) => {
    const badges = tabChrome(page, "tab-kind-badge");
    // Two default panels → two badges, one VIDEO and one PLOT.
    await expect(badges).toHaveCount(2);
    const labels = await badges.allInnerTexts();
    expect(labels.sort()).toEqual(["PLOT", "VIDEO"]);
  });

  test("settings click selects panel and flips drawer to Panel tab", async ({
    page,
  }) => {
    expect(
      await page.evaluate(() =>
        window.__drivelineDevHooks!.getSelectedPanelId(),
      ),
    ).toBeNull();

    // Click the first settings icon (the one for the video tab — the
    // default layout puts video on the left).
    await tabChrome(page, "tab-settings").first().click();

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__drivelineDevHooks!.getActiveRailTab(),
        ),
      )
      .toBe("panel");
    expect(
      await page.evaluate(() =>
        window.__drivelineDevHooks!.getSelectedPanelId(),
      ),
    ).toBe(VIDEO_PANEL_ID);
    await expect(page.getByTestId("drawer-panel-kind")).toHaveText("VIDEO");
  });

  test("clicking the panel body selects that panel", async ({ page }) => {
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setSelectedPanelId(null),
    );
    // `panel-body-*` is a `display: contents` wrapper (panelFactory.module.css)
    // so it has no box of its own to click. Click the rendered plot content
    // inside it — its pointerdown bubbles up through the contents box to the
    // wrapper's click-to-select handler. Aim low to clear the control bar.
    await page.getByTestId("plot-panel").click({ position: { x: 30, y: 160 } });
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__drivelineDevHooks!.getSelectedPanelId(),
        ),
      )
      .toBe(PLOT_PANEL_ID);
  });

  test("maximize toggles the layout's maximized field", async ({ page }) => {
    const before = await getLayout(page);
    expect(before).not.toContain('"maximized"');

    // Two tabs → two maximize buttons. Maximizing one tabset hides the
    // other, so filter to whatever is on-screen and re-resolve before each
    // click (a bare `.first()` would land on the now-hidden tabset's button
    // for the restore click).
    const maximize = tabChrome(page, "tab-maximize").filter({ visible: true });
    await maximize.first().click();
    await expect
      .poll(async () => (await getLayout(page)).includes('"maximized":true'))
      .toBe(true);

    // Click again to restore.
    await maximize.first().click();
    await expect
      .poll(async () => !(await getLayout(page)).includes('"maximized":true'))
      .toBe(true);
  });

  test("close removes the tab from the layout", async ({ page }) => {
    // `getLayoutJson()` is null until FlexLayout's model first changes
    // (`resetLayout` writes null and the default model is only synced back
    // on the next `onModelChange`), so assert the tab's presence via the DOM
    // rather than the persisted layout json.
    await expect(page.getByTestId(`panel-body-${PLOT_PANEL_ID}`)).toHaveCount(1);

    // The plot tab is the second of the two; locate by panel-body
    // anchor and walk to its tab close button.
    const closes = tabChrome(page, "tab-close");
    await expect(closes).toHaveCount(2);
    // Click the close on whichever tab is the plot one — we identify it
    // by clicking each settings icon in turn and checking which selects
    // the plot id, but simpler: close the second (right-hand) tab,
    // which the default layout puts as plot.
    await closes.nth(1).click();

    await expect
      .poll(async () => await getLayout(page))
      .not.toContain(`"id":"${PLOT_PANEL_ID}"`);
    await expect(
      page.getByTestId(`panel-body-${PLOT_PANEL_ID}`),
    ).toHaveCount(0);
  });

  test("each tab shows exactly one close button (no duplicate stock ✕)", async ({
    page,
  }) => {
    // `onRenderTab` draws one custom close per tab → two for the default
    // Video + Plot layout.
    await expect(tabChrome(page, "tab-close")).toHaveCount(2);
    // FlexLayout otherwise appends its own trailing close
    // (`flexlayout__tab_button_trailing`) whenever `tabEnableClose` is on,
    // which used to render a second ✕. `buildModel` forces
    // `tabEnableClose:false` for every loaded layout, so no tab carries the
    // stock button.
    await expect(
      page.locator(".flexlayout__tabset .flexlayout__tab_button_trailing"),
    ).toHaveCount(0);
  });

  test("no stock tabset maximize button (custom tab-maximize is the only one)", async ({
    page,
  }) => {
    // `onRenderTab` draws one custom maximize button per tab → two for the
    // default Video + Plot layout.
    await expect(tabChrome(page, "tab-maximize")).toHaveCount(2);
    // FlexLayout otherwise renders its own maximize/restore button in each
    // tabset's right-edge toolbar (`flexlayout__tab_toolbar_button-min` when
    // not maximized, `-max` when maximized) — a duplicate of our custom one.
    // `buildModel` forces `tabSetEnableMaximize:false` for every loaded
    // layout, so that stock button is gone and the custom tab button is the
    // only way to maximize.
    await expect(
      page.locator(
        ".flexlayout__tabset .flexlayout__tab_toolbar_button-min, " +
          ".flexlayout__tabset .flexlayout__tab_toolbar_button-max",
      ),
    ).toHaveCount(0);
  });
});
