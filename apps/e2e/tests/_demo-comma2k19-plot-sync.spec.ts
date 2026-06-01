// Regression spec for the "plot ignores playback time" bug.
//
// The Plot panel used to let uPlot auto-fit its x-axis to the per-series
// *data extent*. So a signal that only covers a sliver of the global
// timeline (e.g. a 60 s segment offset 10 min into an 11 min drive) got
// stretched across the whole panel, while the cursor overlay projected
// `cursorNs` over the *global* range — the two disagreed and the plot
// looked synced when it was not. The fix pins the x-scale to the shared
// global timeline, so a short signal occupies only its true slice of
// absolute time and the rest of the panel stays blank.
//
// This spec reproduces that exact shape with real comma2k19 data: a
// dashcam (≈60 s) plus an OFFSET signal segment anchored elsewhere on the
// drive, so the global timeline is far wider than the signal. It asserts
// the plot's x-domain spans the whole timeline (not just the data) and
// screenshots the cursor both over the data and in the blank region.
//
// Underscore-prefixed → skipped by normal CI. Invoke directly:
//   pnpm --filter e2e exec playwright test _demo-comma2k19-plot-sync.spec.ts

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "screenshots");

// Dashcam (zero-offset, anchored at the drive root) + the +600 s offset
// signal segment. Per sample-data/realworld/README.md this is precisely
// the "60 s video + 60 s signal 10 min apart" shape the user described:
// the dashcam sits at the start of the timeline, the signal 10 minutes
// later, so the unified range is ~11 min and the signal covers <10% of it.
const REL = {
  mp4: "realworld/comma2k19_seg10.mp4",
  ts: "realworld/comma2k19_seg10.mp4.timestamps",
  offsetSignal: "realworld/comma2k19_seg10_at600s.mcap",
};
const ABS = Object.fromEntries(
  Object.entries(REL).map(([k, v]) => [
    k,
    path.resolve(__dirname, "../../../sample-data", v),
  ]),
) as Record<keyof typeof REL, string>;

const PLOT_PANEL_ID = "plot-1";

// Drive the global cursor by clicking the transport scrubber at a given
// fraction of the timeline (mirrors the helper in the video spec).
async function seekToRatio(page: Page, ratio: number): Promise<void> {
  await page.evaluate((r) => {
    const scrubber = document.querySelector<HTMLElement>(
      "[data-testid='scrubber']",
    );
    if (!scrubber) throw new Error("scrubber not found");
    const rect = scrubber.getBoundingClientRect();
    const x = rect.left + rect.width * r;
    const y = rect.top + rect.height / 2;
    const opts: PointerEventInit = {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
    };
    scrubber.dispatchEvent(new PointerEvent("pointerdown", opts));
    scrubber.dispatchEvent(new PointerEvent("pointerup", opts));
  }, ratio);
}

async function paintAndSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
  await page.waitForTimeout(500);
}

test.describe("comma2k19 plot ↔ playback time sync", () => {
  test.slow();
  test.skip(
    !existsSync(ABS.mp4) ||
      !existsSync(ABS.ts) ||
      !existsSync(ABS.offsetSignal),
    "comma2k19 fixtures missing — run the verify-comma2k19 skill " +
      "(fetch-sources + build-fixtures) to produce the dashcam and the " +
      "_at600s offset signal.",
  );

  test.beforeEach(async ({ page }) => {
    page.on("pageerror", (e) => console.error("pageerror:", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error("console:", m.text());
    });
    await page.goto("/");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() => window.__drivelineDevHooks!.resetLayout());
    await page.evaluate(async () => {
      await window.__drivelineDevHooks!.clearSession();
    });
  });

  test("plot x-axis spans the global timeline, not the signal's data extent", async ({
    page,
  }) => {
    // Single plot panel, stable id.
    const LAYOUT = {
      global: {
        tabEnableClose: true,
        tabEnableRename: false,
        splitterSize: 4,
        borderEnableAutoHide: true,
      },
      borders: [],
      layout: {
        type: "row",
        weight: 100,
        children: [
          {
            type: "tabset",
            weight: 100,
            children: [
              {
                type: "tab",
                id: PLOT_PANEL_ID,
                name: "Offset signal",
                component: "plot",
              },
            ],
          },
        ],
      },
    };
    await page.evaluate(
      (json) => window.__drivelineDevHooks!.setLayoutJson(json),
      LAYOUT,
    );

    const open = await page.evaluate(async (rels) => {
      const descs = await Promise.all(
        Object.values(rels).map(async (rel) => {
          const res = await fetch(`/sample-data/${rel}`);
          if (!res.ok) throw new Error(`fetch ${rel}: ${res.status}`);
          return {
            name: rel.split("/").pop()!,
            bytes: new Uint8Array(await res.arrayBuffer()),
          };
        }),
      );
      return await window.__drivelineDevHooks!.openFiles(descs);
    }, REL);
    expect(open.errors).toEqual([]);

    // Inspect the loaded sources: the dashcam + the offset signal must
    // occupy *different* parts of one wide timeline.
    const sources = await page.evaluate(() =>
      window.__drivelineDevHooks!.listSources(),
    );
    const globalRange = await page.evaluate(() =>
      window.__drivelineDevHooks!.getGlobalRange(),
    );
    expect(globalRange).not.toBeNull();

    const signalSrc = sources.find((s) => s.name.endsWith(".mcap"))!;
    expect(signalSrc, "offset signal source must load").toBeTruthy();

    const gStart = BigInt(globalRange!.startNs);
    const gEnd = BigInt(globalRange!.endNs);
    const sStart = BigInt(signalSrc.timeRange.startNs);
    const sEnd = BigInt(signalSrc.timeRange.endNs);
    const gSpan = Number(gEnd - gStart) / 1e9;
    const sSpan = Number(sEnd - sStart) / 1e9;
    const coverage = sSpan / gSpan;
    console.log(
      `PLOTSYNC global span=${gSpan.toFixed(1)}s signal span=${sSpan.toFixed(
        1,
      )}s coverage=${(coverage * 100).toFixed(1)}%`,
    );
    // The whole point: the signal must cover only a fraction of the
    // timeline so there is a large blank region to (mis)render.
    expect(coverage).toBeLessThan(0.5);

    // Bind the offset signal's speed channel to the plot.
    const channels = await page.evaluate(() =>
      window.__drivelineDevHooks!.listChannels(),
    );
    const speed = channels.find(
      (c) => c.sourceId === signalSrc.id && c.name === "/vehicle/speed",
    );
    expect(
      speed,
      "/vehicle/speed must exist in the offset signal",
    ).toBeTruthy();
    await page.evaluate(
      ([panelId, id]) =>
        window.__drivelineDevHooks!.addPlotChannelBinding(panelId, id),
      [PLOT_PANEL_ID, speed!.id],
    );

    // Wait for the render to publish a non-empty series.
    await expect
      .poll(
        async () => {
          const s = await page.evaluate(
            (p) => window.__drivelineDevHooks!.getPlotPanelSeriesStats(p),
            PLOT_PANEL_ID,
          );
          return s !== null && s.length === 1 && s[0].count > 0;
        },
        { timeout: 15_000, intervals: [200, 400, 800] },
      )
      .toBe(true);

    // CORE ASSERTION — the plot's x-domain is the global timeline, not the
    // ~60 s signal extent. Pre-fix `xScaleSec` span ≈ sSpan; post-fix it
    // must match gSpan.
    const sync = await page.evaluate(
      (p) => window.__drivelineDevHooks!.getPlotPanelSync(p),
      PLOT_PANEL_ID,
    );
    expect(sync, "plot sync snapshot").not.toBeNull();
    expect(sync!.xScaleSec, "x-scale must be published").not.toBeNull();
    const xSpan = sync!.xScaleSec!.max - sync!.xScaleSec!.min;
    console.log(
      `PLOTSYNC xScale span=${xSpan.toFixed(1)}s (global=${gSpan.toFixed(1)}s)`,
    );
    // The axis spans (essentially) the whole global range...
    expect(xSpan).toBeGreaterThan(gSpan * 0.98);
    // ...and is therefore far wider than the signal's own data extent.
    expect(xSpan).toBeGreaterThan(sSpan * 2);
    // Domain endpoints line up with the global range (within 1 s).
    expect(sync!.xScaleSec!.min).toBeCloseTo(Number(gStart) / 1e9, 0);
    expect(sync!.xScaleSec!.max).toBeCloseTo(Number(gEnd) / 1e9, 0);

    // Screenshot 1 — cursor parked OVER the signal data. The trace and the
    // orange cursor line coincide on the side of the panel where the data
    // actually lives.
    const overRatio =
      Number((sStart + sEnd) / 2n - gStart) / Number(gEnd - gStart);
    await seekToRatio(page, overRatio);
    await paintAndSettle(page);
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "comma2k19-plot-sync-cursor-over-data.png",
      ),
    });

    // Screenshot 2 — cursor parked in the BLANK region (the larger of the
    // empty spans on either side of the signal). The plot is empty there;
    // the cursor sits in dead space far from the trace, which is exactly
    // what absolute-time sync should show and what the old auto-fit
    // behaviour hid.
    const beforeSpan = Number(sStart - gStart);
    const afterSpan = Number(gEnd - sEnd);
    const blankMidNs =
      beforeSpan >= afterSpan
        ? gStart + (sStart - gStart) / 2n
        : sEnd + (gEnd - sEnd) / 2n;
    const blankRatio = Number(blankMidNs - gStart) / Number(gEnd - gStart);
    await seekToRatio(page, blankRatio);
    await paintAndSettle(page);
    await page.screenshot({
      path: path.join(
        SCREENSHOT_DIR,
        "comma2k19-plot-sync-cursor-in-blank.png",
      ),
    });
  });
});
