// Visual screenshot spec for the App-shell UI/UX iter5 cluster.
// Underscore prefix keeps it out of the default `pnpm e2e` run; invoke
// explicitly when refreshing screenshots:
//
//   pnpm --filter e2e test _shellIter5Screenshots
//
// Captures (writes to apps/e2e/tests/screenshots/shell-iter5-*.png):
//   1. shell-iter5-topbar-session-and-status.png
//      — Top bar with the session title in the centre (1 source +
//        duration) and a failure-mode status chip (we seed errors via
//        the store so the screenshot shows the `degraded` state).
//   2. shell-iter5-rail-labels-and-popover.png
//      — Left rail with always-visible labels alongside the open
//        Sources popover showing the new primary "+ Add file" action
//        and the absence of the old "Open Sources panel" redirect.

import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

test.describe("shell iter5 screenshots", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
      window.__drivelineDevHooks!.setActiveRailTab(null);
    });
  });

  test("captures iter5 topbar with session title + failure-mode status", async ({
    page,
  }) => {
    // Load a single named source so the centre shows "<file>" + duration.
    await page.evaluate(async () => {
      const fetchBytes = async (p: string) => {
        const r = await fetch(p);
        if (!r.ok) throw new Error(`fetch ${p}: ${r.status}`);
        return new Uint8Array(await r.arrayBuffer());
      };
      const mcap = await fetchBytes("/sample-data/short.mcap");
      await window.__drivelineDevHooks!.openFiles([
        { name: "comma2k19_seg10.mcap", bytes: mcap },
      ]);
    });
    await page.waitForFunction(
      () =>
        (
          window.__drivelineDevHooks!.getSessionSnapshot() as {
            globalRange: unknown;
          }
        ).globalRange !== null,
    );

    // Seed a fake open error so the status chip renders `degraded`,
    // exercising the failure-mode design without breaking the actual
    // loaded source. We poke the store directly through a tiny
    // unconditional `setState` shim — the SessionState's
    // `lastOpenErrors` is a public slot.
    await page.evaluate(() => {
      const w = window as unknown as {
        __zustandUseSession?: { setState: (s: unknown) => void };
      };
      // The store exposes its actions via dev hooks; the easiest way
      // to add an error without going through `openFiles` is to import
      // the named export. Vite hot-bundles ESM in dev, so we can reach
      // into the module graph via the global useSession used by
      // dev-hook tests. As a portable alternative, we drive a bogus
      // file through `openFiles` (it will fail bucketing → produce an
      // error row), which is exactly the production failure path.
      // Keep it simple: a `.txt` file is rejected by `bucketFiles`.
      void w;
    });
    await page.evaluate(async () => {
      // A `.txt` file falls outside the MCAP/MF4/MP4 buckets and is
      // recorded in `lastOpenErrors` — exactly the path we want to
      // exercise the "Degraded" chip.
      await window.__drivelineDevHooks!.openFiles([
        { name: "stray-notes.txt", bytes: new Uint8Array([1, 2, 3]) },
      ]);
    });

    // Wait for the status to flip to degraded.
    await expect(page.getByTestId("status-chip")).toHaveAttribute(
      "data-status",
      "degraded",
    );

    // Confirm the session title is visible.
    await expect(page.getByTestId("topbar-session-primary")).toContainText(
      "comma2k19_seg10.mcap",
    );

    // Pop the error details so the screenshot shows the failure
    // surface in its expanded form.
    await page.getByTestId("status-details-toggle").click();
    await expect(page.getByTestId("status-details")).toBeVisible();

    // Capture the top region (160 px high so the details flyout fits).
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-iter5-topbar-session-and-status.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 220 },
    });
  });

  test("captures iter5 rail labels alongside the sources popover", async ({
    page,
  }) => {
    // Empty session so the popover renders the cold-start primary
    // affordance (`+ Add file` with hint copy). The rail still
    // renders with always-visible labels regardless.
    await page.getByTestId("sources-chip").click();
    await expect(page.getByTestId("sources-popover")).toBeVisible();
    await expect(page.getByTestId("sources-popover-add-file")).toBeVisible();
    // Confirm the old redirect is absent (regression guard for #4).
    await expect(
      page.locator('[data-testid="sources-popover-open-drawer"]'),
    ).toHaveCount(0);

    // Capture the left portion of the screen (rail + popover sit at
    // the right). The viewport is 1440×900; clip the top 540 px so the
    // popover at right and the labelled rail at left both fit.
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, "shell-iter5-rail-labels-and-popover.png"),
      fullPage: false,
      clip: { x: 0, y: 0, width: 1440, height: 540 },
    });
  });
});
