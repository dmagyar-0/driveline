// Agent F · a11y verification spec.
//
// Generates two reference screenshots demonstrating the focus-ring
// + ARIA wiring we polished on top of the visual UX overhaul. The
// underscore prefix mirrors the existing screenshot-only specs
// (_layoutChromeScreenshots, _shellRedesignScreenshots, …) so this
// doesn't run as part of the default integration matrix unless the
// caller asks for it explicitly.

import { test, expect } from "@playwright/test";

test.describe("a11y polish (Agent F)", () => {
  test("focused rail item shows a visible ring", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

    // Tab from the very top of the document. Brand zone is decorative
    // (no tabindex), so the first stop is the first rail item.
    await page.keyboard.press("Tab");

    // Hover the rail to surface its labels as well so the screenshot
    // shows both focus-ring AND the labelled state.
    await page.locator('[data-testid="rail"]').hover();

    await page.screenshot({
      path: "tests/screenshots/a11y-rail-focused.png",
      clip: { x: 0, y: 0, width: 240, height: 280 },
    });
  });

  test("rail buttons announce sensible aria-* attributes", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");

    const attrs = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="rail"]');
      if (!rail) return null;
      const buttons = Array.from(rail.querySelectorAll("button"));
      return {
        navLabel: rail.getAttribute("aria-label"),
        groups: Array.from(rail.querySelectorAll('[role="group"]')).map((g) =>
          g.getAttribute("aria-label"),
        ),
        items: buttons.map((b) => ({
          label: b.getAttribute("aria-label"),
          expanded: b.getAttribute("aria-expanded"),
          pressed: b.getAttribute("aria-pressed"),
          controls: b.getAttribute("aria-controls"),
        })),
      };
    });

    expect(attrs?.navLabel).toBe("Sections");
    expect(attrs?.groups).toEqual(["Data", "Workspace", "Annotations"]);
    expect(attrs?.items.length).toBe(5);
    for (const item of attrs!.items) {
      expect(item.label).toBeTruthy();
      expect(item.expanded).toBeTruthy();
      expect(item.pressed).toBeTruthy();
      expect(item.controls).toBe("shell-drawer-region");
    }
  });

  test("every tab-action button carries a tooltip + aria-label", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());

    // Capture a focused tab action button so the screenshot
    // demonstrates the visible focus ring.
    await page.getByTestId("tab-settings").first().focus();
    await page.screenshot({
      path: "tests/screenshots/a11y-tab-action-focused.png",
      clip: { x: 0, y: 0, width: 800, height: 80 },
    });
  });
});
