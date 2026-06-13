// Bring Your Own Agent (BYOA) e2e — docs/13, docs/11 §v3.
//
// Drives the ENTIRE core flow through the production `window.__drivelineAgent`
// surface (no dev hooks for the flow itself — only `getPlotPanelSeriesStats`
// for assertion): push a 2-channel inline source (a sine scalar + an enum),
// confirm the channels appear, plot the scalar, and assert the agent-pushed
// sine actually renders. Also proves the always-on discovery trio
// (`getSkill`/`describe`) is reachable WITHOUT `?agent`.
//
// Screenshot: screenshots/byo-agent-plot.png — the agent-pushed sine plotted.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentApi } from "../../web/src/agent/agentApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname, "screenshots");

type Hooks = {
  resetLayout: () => void;
  clearSession: () => Promise<void>;
  getPlotPanelSeriesStats: (
    panelId: string,
  ) => Array<{ channelId: string; min: number; max: number; count: number }> | null;
};

declare global {
  interface Window {
    __drivelineAgent?: AgentApi;
  }
}

test.describe("bring your own agent (v3)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/?agent=1");
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    await page.evaluate(() =>
      (window.__drivelineDevHooks as unknown as Hooks).resetLayout(),
    );
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(async () => {
      await (window.__drivelineDevHooks as unknown as Hooks).clearSession();
    });
  });

  test("pushes an inline source through the agent surface and plots it", async ({
    page,
  }) => {
    // The agent surface installs under ?agent — version 3.
    expect(await page.evaluate(() => window.__drivelineAgent!.version)).toBe(3);

    // getSkill() returns a non-empty guide.
    const skillLen = await page.evaluate(
      () => window.__drivelineAgent!.getSkill().length,
    );
    expect(skillLen).toBeGreaterThan(500);

    // 1. Push a 2-channel inline source: a 50 Hz sine "vehicle/speed" scalar
    //    and a "vehicle/gear" enum — entirely through the agent surface.
    const added = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const N = 600;
      const startNs = 1_700_000_000_000_000_000n;
      const stepNs = 20_000_000n; // 20 ms = 50 Hz
      const timestampsNs: string[] = [];
      const speed: number[] = [];
      const gear: number[] = [];
      for (let i = 0; i < N; i++) {
        timestampsNs.push((startNs + stepNs * BigInt(i)).toString());
        speed.push(20 + 15 * Math.sin((2 * Math.PI * 0.2 * i) / 50));
        gear.push((Math.floor(i / 100) % 5) + 1);
      }
      const res = agent.addDataSource({
        name: "my-agent-run",
        channels: [
          { name: "vehicle/speed", unit: "m/s", timestampsNs, values: speed },
          { name: "vehicle/gear", kind: "enum", timestampsNs, values: gear },
        ],
      });
      return res;
    });
    expect(added).not.toBeNull();
    expect(added!.channels).toHaveLength(2);

    // 2. The channels appear via listChannels.
    const channelNames = await page.evaluate(() =>
      window.__drivelineAgent!.listChannels().map((c) => c.name),
    );
    expect(channelNames).toContain("/vehicle/speed");
    expect(channelNames).toContain("/vehicle/gear");

    // 3. The scrubber / global range covers the pushed data.
    const snap = await page.evaluate(() =>
      window.__drivelineAgent!.getSessionSnapshot(),
    );
    expect(snap.globalRange).not.toBeNull();
    expect(snap.globalRange!.startNs).toBe("1700000000000000000");
    // 600 samples @ 20ms → last ts = start + 599*20ms.
    const expectedEnd = (
      1_700_000_000_000_000_000n +
      599n * 20_000_000n
    ).toString();
    expect(snap.globalRange!.endNs).toBe(expectedEnd);

    // 4. Create a plot panel and bind the sine channel through the agent.
    const plot = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const speedId = agent
        .listChannels()
        .find((c) => c.name === "/vehicle/speed")!.id;
      const panelId = agent.createPanel("plot")!;
      const bound = agent.bindChannels(panelId, [speedId]);
      // Park the cursor in the middle so the plot + transport line up.
      agent.setCursor(agent.getSessionSnapshot().globalRange!.startNs);
      return { panelId, speedId, bound };
    });
    expect(plot.bound).toBe(true);

    // The panel body renders.
    await expect(page.getByTestId(`panel-body-${plot.panelId}`)).toBeVisible();

    // 5. The plot draws a non-empty series for the bound channel (assert via
    //    the dev hook). Poll until the async fetch + render lands.
    await expect
      .poll(async () => {
        return await page.evaluate((panelId) => {
          const stats = (
            window.__drivelineDevHooks as unknown as Hooks
          ).getPlotPanelSeriesStats(panelId);
          if (!stats || stats.length === 0) return 0;
          return stats[0].count;
        }, plot.panelId);
      })
      .toBeGreaterThan(0);

    // The sine spans roughly [5, 35] m/s — assert the series min/max reflect it.
    const stats = await page.evaluate((panelId) => {
      const s = (
        window.__drivelineDevHooks as unknown as Hooks
      ).getPlotPanelSeriesStats(panelId);
      return s ? s[0] : null;
    }, plot.panelId);
    expect(stats).not.toBeNull();
    expect(stats!.min).toBeLessThan(10);
    expect(stats!.max).toBeGreaterThan(30);

    // Settle: pause and let the uPlot redraw quiesce so the element is stable.
    await page.evaluate(() => window.__drivelineAgent!.pause());
    await page.waitForTimeout(300);
    await page
      .getByTestId("workspace")
      .screenshot({ path: path.join(SHOTS, "byo-agent-plot.png") });
  });

  test("discovery (getSkill/describe) is reachable WITHOUT ?agent", async ({
    page,
  }) => {
    // NOTE: the e2e dev server runs with `import.meta.env.DEV === true`, which
    // (by design) installs the full surface regardless of `?agent` so local
    // automation gets it for free — so this load can't prove the *gating* of
    // the mutating ops (the unit test does that via `installAgentApi(false)`).
    // What it proves here is that the discovery trio (version/getSkill/
    // describe) is present and functional on a plain `/` load with no query.
    await page.goto("/"); // no ?agent
    await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
    const probe = await page.evaluate(() => {
      const agent = window.__drivelineAgent;
      if (!agent) return { present: false };
      return {
        present: true,
        version: agent.version,
        skillLen: agent.getSkill().length,
        manifest: agent.describe(),
      };
    });
    expect(probe.present).toBe(true);
    expect(probe.version).toBe(3);
    expect(probe.skillLen).toBeGreaterThan(500);
    expect(probe.manifest).toBeTruthy();
  });
});
