// Phase 7+ · Per-panel chrome e2e.
//
// Exercises the new tab chrome wired by Workspace.tsx's `onRenderTab`:
//   1. Each tab carries a kind identifier — Agent D dropped the text
//      badge in favour of a per-kind SVG icon, but `data-panel-kind`
//      stays on the header span so e2e (and CSS) can read it.
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

async function getLayout(page: Page): Promise<string> {
  return await page.evaluate(() => window.__drivelineDevHooks!.getLayoutJson());
}

test.describe("Per-panel chrome (Phase 7)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    // The default layout's two panels are Video (`video-1`) and Plot
    // (`plot-1`), each in its own tabset.
    await expect(
      page.getByTestId(`panel-body-${VIDEO_PANEL_ID}`),
    ).toBeVisible();
    await expect(page.getByTestId(`panel-body-${PLOT_PANEL_ID}`)).toBeVisible();
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("each tab carries its kind identifier", async ({ page }) => {
    // Agent D overhaul (UX issue #14+): the visible text badge was
    // replaced with a per-kind SVG glyph so the chrome doesn't bloat.
    // `data-panel-kind` is the durable, scriptable identifier and
    // remains the same surface tests/CSS pivot on.
    //
    // FlexLayout renders a duplicate "stamp" copy of each tab for
    // drag-preview reasons (`flexlayout__tab_button_stamp`). Scope to
    // the live tab button so we don't double-count.
    const headers = page.locator(
      ".flexlayout__tab_button [data-panel-id]:not(.flexlayout__tab_button_stamp [data-panel-id])",
    );
    await expect(headers).toHaveCount(2);
    const kinds = await headers.evaluateAll((nodes) =>
      nodes.map((n) => n.getAttribute("data-panel-kind")),
    );
    expect(kinds.sort()).toEqual(["plot", "video"]);
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
    await page.getByTestId("tab-settings").first().click();

    await expect
      .poll(() =>
        page.evaluate(() => window.__drivelineDevHooks!.getActiveRailTab()),
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
    await page.getByTestId(`panel-body-${PLOT_PANEL_ID}`).click({
      // Click the body itself, not the tab strip; FlexLayout puts the
      // tab strip outside the body wrapper.
      position: { x: 10, y: 40 },
    });
    await expect
      .poll(() =>
        page.evaluate(() => window.__drivelineDevHooks!.getSelectedPanelId()),
      )
      .toBe(PLOT_PANEL_ID);
  });

  test("maximize toggles the layout's maximized field", async ({ page }) => {
    const before = await getLayout(page);
    expect(before).not.toContain('"maximized"');

    // Two tabs → two maximize buttons. Click the first (video tabset).
    await page.getByTestId("tab-maximize").first().click();
    await expect
      .poll(async () => (await getLayout(page)).includes('"maximized":true'))
      .toBe(true);

    // Click again to restore.
    await page.getByTestId("tab-maximize").first().click();
    await expect
      .poll(async () => !(await getLayout(page)).includes('"maximized":true'))
      .toBe(true);
  });

  test("close removes the tab from the layout", async ({ page }) => {
    expect(await getLayout(page)).toContain(`"id":"${PLOT_PANEL_ID}"`);

    // The plot tab is the second of the two; locate by panel-body
    // anchor and walk to its tab close button.
    const closes = page.getByTestId("tab-close");
    await expect(closes).toHaveCount(2);
    // Click the close on whichever tab is the plot one — we identify it
    // by clicking each settings icon in turn and checking which selects
    // the plot id, but simpler: close the second (right-hand) tab,
    // which the default layout puts as plot.
    await closes.nth(1).click();

    await expect
      .poll(async () => await getLayout(page))
      .not.toContain(`"id":"${PLOT_PANEL_ID}"`);
    await expect(page.getByTestId(`panel-body-${PLOT_PANEL_ID}`)).toHaveCount(
      0,
    );
  });

  test("every tab action button advertises an accessible name", async ({
    page,
  }) => {
    // Agent D shipped a 4-icon action cluster (rename / settings /
    // maximize / close). Every icon-only control must carry both a
    // `title` (sighted hover tooltip) AND an `aria-label` (assistive
    // tech accessible name) — see PanelHeader.test.tsx for the unit
    // contract; this is the cross-tab integration check.
    //
    // FlexLayout's drag-preview "stamp" duplicates the tab DOM, so
    // each test-id appears 4× across both tabs. Pick the live ones
    // by scoping to the visible tab button.
    for (const testId of [
      "tab-rename",
      "tab-settings",
      "tab-maximize",
      "tab-close",
    ]) {
      const buttons = page.locator(
        `.flexlayout__tab_button [data-testid="${testId}"]`,
      );
      // 2 visible tab buttons × 1 action button each.
      await expect(buttons).toHaveCount(2);
      const labels = await buttons.evaluateAll((nodes) =>
        nodes.map((n) => ({
          title: n.getAttribute("title"),
          ariaLabel: n.getAttribute("aria-label"),
        })),
      );
      for (const l of labels) {
        expect(l.title).toBeTruthy();
        expect(l.ariaLabel).toBeTruthy();
      }
    }
  });
});
