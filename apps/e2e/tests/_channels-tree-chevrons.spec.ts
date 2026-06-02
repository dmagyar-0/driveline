// Focused visual check for the Channels-drawer disclosure chevrons.
//
// Loads the real comma2k19 MCAP + MF4 (the same two sources shown in the
// bug report screenshot), opens the Channels drawer, and screenshots the
// tree. Captures two states so the chevron is eyeball-checkable:
//   - expanded:  every source header + branch chevron points down.
//   - collapsed: one branch ("vehicle") is collapsed, so its chevron points
//                right while its siblings stay pointing down — proving the
//                aria-expanded-driven rotation.
//
// Underscore prefix keeps it out of normal CI; invoke directly:
//   pnpm --filter e2e exec playwright test _channels-tree-chevrons.spec.ts
//
// Output PNGs land in $CHEV_OUT (default /tmp/chev) so a before/after run
// can redirect them without touching the committed screenshots dir.

import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(__dirname, "../../../sample-data");
const OUT = process.env.CHEV_OUT ?? "/tmp/chev";
const REL = ["realworld/comma2k19.mcap", "realworld/comma2k19.mf4"];

test.describe("channels drawer chevrons", () => {
  test.slow();
  test.skip(
    !REL.every((r) => existsSync(path.join(SAMPLE, r))),
    "comma2k19 fixtures missing — run the verify-visually skill stages 1-3",
  );

  test("renders the channel tree with clear disclosure chevrons", async ({
    page,
  }) => {
    mkdirSync(OUT, { recursive: true });

    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        rels.map(async (rel) => {
          const r = await fetch(`/sample-data/${rel}`);
          if (!r.ok) throw new Error(`fetch ${rel}: ${r.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await r.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, REL);
    expect(open.errors).toEqual([]);
    expect(open.opened).toEqual(
      expect.arrayContaining(["comma2k19.mcap", "comma2k19.mf4"]),
    );

    // Open the Channels drawer and wait for the tree to populate.
    await page.evaluate(() =>
      window.__drivelineDevHooks!.setActiveRailTab("channels"),
    );
    const drawer = page.getByTestId("drawer-channels");
    await expect(drawer).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(() => window.__drivelineDevHooks!.listChannels().length),
      )
      .toBeGreaterThan(0);
    // Branch rows carry the chevrons we're verifying.
    const branches = page.locator('[data-testid^="channels-branch-"]');
    await expect(branches.first()).toBeVisible();

    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
    await drawer.screenshot({ path: path.join(OUT, "expanded.png") });

    // Collapse the MCAP "vehicle" branch: its chevron rotates to point
    // right while the other branches keep pointing down.
    await branches.filter({ hasText: "vehicle" }).first().click();
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
    await drawer.screenshot({ path: path.join(OUT, "collapsed.png") });
  });
});
