// "Bring Your Own Agent" demo RECORDING — the marketing/onboarding clip.
//
// This is the screencast we hand to people so they get what Driveline's
// agent surface is *for*: a browser-first log viewer that an agent can
// drive headlessly to bring its own data, read it back, analyse it, and
// tag findings — no human clicking, no server, all in the tab.
//
// It records the running app to .webm in two scenes (one test each, so
// each scene is its own clip; `scripts/record-byoa-demo.sh` stitches them):
//
//   Scene 1 — Pure BYOA. EVERYTHING runs through the production
//     `window.__drivelineAgent` surface: discover the API, push an inline
//     columnar "drive" (speed + longitudinal accel + gear), lay it out,
//     fetch the data back, scan it for manoeuvres, and tag agent-authored
//     events (origin "agent", with a confidence badge). No fixtures — runs
//     anywhere.
//
//   Scene 2 — BYOA on a real dashcam. Loads the comma2k19 segment-10
//     dashcam + CAN signals, then the agent reads the real speed channel,
//     finds the hardest braking moment, tags it, and jumps the dashcam to
//     that frame. Skips automatically if the comma2k19 fixtures are absent.
//
// Underscore prefix keeps this out of normal CI runs. Invoke directly:
//   pnpm --filter e2e exec playwright test _demo-byoa-agent.spec.ts
// or, for the fetch + build + stitch pipeline:
//   scripts/record-byoa-demo.sh
//
// Scene 2 requires (see sample-data/realworld/README.md / verify-visually):
//   sample-data/realworld/comma2k19.mcap
//   sample-data/realworld/comma2k19_seg10.mp4
//   sample-data/realworld/comma2k19_seg10.mp4.timestamps

import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentApi } from "../../web/src/agent/agentApi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev hooks we lean on for *arrangement* (side-by-side panels) and for the
// file-backed scene-2 load. The BYOA story itself — ingest, read, analyse,
// tag — goes exclusively through `window.__drivelineAgent`.
type Hooks = {
  resetLayout: () => void;
  clearSession: () => Promise<void>;
  setLayoutJson: (json: unknown) => void;
  openFiles: (
    descs: Array<{ name: string; bytes: Uint8Array }>,
  ) => Promise<{ opened: string[]; errors: string[] }>;
  findChannelId: (q: { sourceName: string; nativeId: string }) => string | null;
  setVideoChannelBinding: (panelId: string, channelId: string) => void;
  videoLastBlitPtsNs: () => string | null;
  getPlotPanelSeriesStats: (
    panelId: string,
  ) => Array<{ channelId: string; count: number }> | null;
};

declare global {
  interface Window {
    __drivelineAgent?: AgentApi;
  }
}

// Record the page. Viewport-sized webm written to the test output dir, one
// per test (Playwright names the dir after the test title).
test.use({
  video: { mode: "on", size: { width: 1280, height: 720 } },
  viewport: { width: 1280, height: 720 },
});

// Let the recorded clip breathe so a human watching can follow each step.
const BEAT = 1400;
const LONG_BEAT = 2400;

async function bootBlank(page: Page, withAgent: boolean): Promise<void> {
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("console:", m.text());
  });
  await page.goto(withAgent ? "/?agent=1" : "/");
  await expect(page.getByTestId("worker-status")).toHaveText("workers ready");
  await page.evaluate(() => {
    (window.__drivelineDevHooks as unknown as Hooks).resetLayout();
  });
  await page.evaluate(async () => {
    await (window.__drivelineDevHooks as unknown as Hooks).clearSession();
  });
}

// Open the Event Tagging drawer so agent-authored events are visible as
// they land (each carries an "agent NN%" origin badge).
async function openEventsDrawer(page: Page): Promise<void> {
  await page.getByTestId("rail-events").click();
  await expect(page.getByTestId("drawer-events")).toBeVisible();
}

async function waitForVideoFrame(page: Page): Promise<void> {
  await page.getByTestId("video-panel-canvas").waitFor();
  await expect
    .poll(
      async () =>
        await page.evaluate(() =>
          (window.__drivelineDevHooks as unknown as Hooks).videoLastBlitPtsNs(),
        ),
      { timeout: 15_000, intervals: [200, 400, 800] },
    )
    .not.toBeNull();
}

async function waitForPlotSeries(page: Page, panelId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate((p) => {
          const s = (
            window.__drivelineDevHooks as unknown as Hooks
          ).getPlotPanelSeriesStats(p);
          return s && s.length > 0 ? s[0].count : 0;
        }, panelId),
      { timeout: 20_000, intervals: [200, 400, 800] },
    )
    .toBeGreaterThan(0);
}

// ────────────────────────────────────────────────────────────────────────
// Scene 1 — Pure "Bring Your Own Agent". No fixtures; runs anywhere.
// ────────────────────────────────────────────────────────────────────────
test.describe("BYOA demo", () => {
  test.slow();

  test("scene 1 — agent brings, analyses, and tags its own data", async ({
    page,
  }) => {
    await bootBlank(page, true);

    // A two-panel stage: a speed line plot (left) and a gear state strip
    // (right). The agent fills both with its own data in a moment.
    await page.evaluate(
      (json) => {
        (window.__drivelineDevHooks as unknown as Hooks).setLayoutJson(json);
      },
      {
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
              weight: 60,
              children: [
                {
                  type: "tab",
                  id: "plot-speed",
                  name: "Speed (m/s)",
                  component: "plot",
                },
              ],
            },
            {
              type: "tabset",
              weight: 40,
              children: [
                {
                  type: "tab",
                  id: "enum-gear",
                  name: "Gear",
                  component: "enum",
                },
              ],
            },
          ],
        },
      },
    );
    await openEventsDrawer(page);
    await page.waitForTimeout(BEAT);

    // 1. DISCOVER — exactly what an external agent does first. The
    //    discovery trio is always on; here we confirm the full surface
    //    unlocked under ?agent (version 3).
    const discovery = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      return {
        version: agent.version,
        skillLen: agent.getSkill().length,
        capabilities: agent.describe().capabilities.length,
      };
    });
    expect(discovery.version).toBe(3);
    expect(discovery.skillLen).toBeGreaterThan(500);
    expect(discovery.capabilities).toBeGreaterThan(0);

    // 2. BRING YOUR OWN DATA — push an inline columnar "drive": a 50 Hz
    //    speed trace with a hard-braking dip and a relaunch, the matching
    //    longitudinal acceleration, and a gear enum. Pure agent surface.
    const added = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const HZ = 50;
      const SECONDS = 30;
      const N = HZ * SECONDS;
      const startNs = 1_700_000_000_000_000_000n;
      const stepNs = BigInt(1e9 / HZ); // 20 ms
      const timestampsNs: string[] = [];
      const speed: number[] = []; // m/s
      const accel: number[] = []; // m/s²
      const gear: number[] = [];

      // Piecewise speed profile (m/s): cruise → hard brake → hold → relaunch.
      const speedAt = (t: number): number => {
        if (t < 10) return 30; // highway cruise
        if (t < 13) return 30 - ((30 - 7) * (t - 10)) / 3; // hard brake to 7
        if (t < 16) return 7; // crawl
        if (t < 21) return 7 + ((29 - 7) * (t - 16)) / 5; // relaunch to 29
        return 29 - 0.4 * (t - 21); // gentle ease-off
      };

      let prev = speedAt(0);
      for (let i = 0; i < N; i++) {
        const t = i / HZ;
        timestampsNs.push((startNs + stepNs * BigInt(i)).toString());
        const v = speedAt(t);
        speed.push(Number(v.toFixed(3)));
        const a = (v - prev) * HZ; // dv/dt
        accel.push(Number(a.toFixed(3)));
        prev = v;
        // Gear by speed band (1..6).
        gear.push(Math.max(1, Math.min(6, Math.floor(v / 5) + 1)));
      }

      return agent.addDataSource({
        name: "agent-drive-2026-06-15",
        channels: [
          { name: "vehicle/speed", unit: "m/s", timestampsNs, values: speed },
          {
            name: "vehicle/accel_long",
            unit: "m/s^2",
            timestampsNs,
            values: accel,
          },
          { name: "vehicle/gear", kind: "enum", timestampsNs, values: gear },
        ],
      });
    });
    expect(added).not.toBeNull();
    expect(added!.channels).toHaveLength(3);

    // 3. LAY OUT — bind the agent's channels to the stage via the agent
    //    surface, then park the cursor at the start.
    const ids = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const byName = new Map(agent.listChannels().map((c) => [c.name, c.id]));
      const speedId = byName.get("/vehicle/speed")!;
      const accelId = byName.get("/vehicle/accel_long")!;
      const gearId = byName.get("/vehicle/gear")!;
      const boundSpeed = agent.bindChannels("plot-speed", [speedId]);
      const boundGear = agent.bindChannels("enum-gear", [gearId]);
      const range = agent.getSessionSnapshot().globalRange!;
      agent.setCursor(range.startNs);
      return { speedId, accelId, gearId, boundSpeed, boundGear, range };
    });
    expect(ids.boundSpeed).toBe(true);
    expect(ids.boundGear).toBe(true);
    await waitForPlotSeries(page, "plot-speed");
    await page.waitForTimeout(LONG_BEAT);

    // 4. ANALYSE — read the data back through `fetchChannelRange` and scan
    //    for the steepest braking and the strongest relaunch over a 0.6 s
    //    window. This is the agent doing real work on data it can see.
    const findings = await page.evaluate(
      async ({ accelId, range }) => {
        const agent = window.__drivelineAgent!;
        const r = await agent.fetchChannelRange(
          accelId,
          range.startNs,
          range.endNs,
        );
        if (!r) return null;
        const ts = r.columns.find((c) => c.name === "ts")!.values as string[];
        const a = r.columns.find((c) => c.name === "value")!.values as number[];
        let brake = { ns: ts[0], rate: 0 };
        let launch = { ns: ts[0], rate: 0 };
        for (let i = 0; i < a.length; i++) {
          if (a[i] < brake.rate) brake = { ns: ts[i], rate: a[i] };
          if (a[i] > launch.rate) launch = { ns: ts[i], rate: a[i] };
        }
        return { brake, launch };
      },
      { accelId: ids.accelId, range: ids.range },
    );
    expect(findings).not.toBeNull();

    // 5. TAG — write agent-authored events with confidence + structured
    //    tags from the default taxonomy (they render as chips + an
    //    "agent NN%" badge). Magnitude → confidence.
    const eventIds = await page.evaluate(({ brake, launch }) => {
      const agent = window.__drivelineAgent!;
      const conf = (rate: number) =>
        Math.max(0.5, Math.min(0.99, Math.abs(rate) / 9));
      const brakeId = agent.addEvent({
        ns: brake.ns,
        label: `Hard braking · ${brake.rate.toFixed(1)} m/s²`,
        tags: {
          maneuver: "Decelerate",
          road_type: "Highway",
          weather: "Clear",
        },
        confidence: conf(brake.rate),
      });
      const launchId = agent.addEvent({
        ns: launch.ns,
        label: `Relaunch · ${launch.rate.toFixed(1)} m/s²`,
        tags: { maneuver: "Accelerate", road_type: "Highway" },
        confidence: conf(launch.rate),
      });
      return { brakeId, launchId };
    }, findings!);
    expect(eventIds.brakeId).not.toBeNull();
    expect(eventIds.launchId).not.toBeNull();

    // Two agent events now visible in the drawer + as scrubber markers.
    await expect(page.getByTestId("bookmarks-count-pill")).toHaveText("2");
    await expect(
      page.getByTestId(`bookmark-origin-${eventIds.brakeId}`),
    ).toBeVisible();
    await page.waitForTimeout(LONG_BEAT);

    // 6. NAVIGATE — jump the cursor to each agent finding so the marker,
    //    the plot dip, and the gear strip line up under the playhead.
    for (const ns of [findings!.brake.ns, findings!.launch.ns]) {
      await page.evaluate((n) => window.__drivelineAgent!.setCursor(n), ns);
      await page.waitForTimeout(BEAT);
    }

    // 7. PLAY — let the replay roll a beat so the panels animate.
    await page.evaluate((n) => {
      const agent = window.__drivelineAgent!;
      agent.setCursor(n);
      agent.play();
    }, ids.range.startNs);
    await page.waitForTimeout(LONG_BEAT * 2);
    await page.evaluate(() => window.__drivelineAgent!.pause());
    await page.waitForTimeout(BEAT);
  });

  // ──────────────────────────────────────────────────────────────────────
  // Scene 2 — BYOA on a real dashcam (comma2k19 segment 10).
  // ──────────────────────────────────────────────────────────────────────
  const REL = {
    mcap: "realworld/comma2k19.mcap",
    mp4: "realworld/comma2k19_seg10.mp4",
    ts: "realworld/comma2k19_seg10.mp4.timestamps",
  };
  const ABS = Object.fromEntries(
    Object.entries(REL).map(([k, v]) => [
      k,
      path.resolve(__dirname, "../../../sample-data", v),
    ]),
  ) as Record<keyof typeof REL, string>;

  test("scene 2 — agent analyses a real dashcam and tags braking", async ({
    page,
  }) => {
    test.skip(
      !existsSync(ABS.mcap) || !existsSync(ABS.mp4) || !existsSync(ABS.ts),
      "comma2k19 fixtures missing — see sample-data/realworld/README.md",
    );

    await bootBlank(page, true);

    // Dashcam left, speed plot right.
    await page.evaluate(
      (json) => {
        (window.__drivelineDevHooks as unknown as Hooks).setLayoutJson(json);
      },
      {
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
              weight: 50,
              children: [
                {
                  type: "tab",
                  id: "video-1",
                  name: "Dashcam",
                  component: "video",
                },
              ],
            },
            {
              type: "tabset",
              weight: 50,
              children: [
                {
                  type: "tab",
                  id: "plot-1",
                  name: "Speed (m/s)",
                  component: "plot",
                },
              ],
            },
          ],
        },
      },
    );
    await openEventsDrawer(page);

    // Load the real dashcam (mp4 + sidecar) and the CAN MCAP.
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
      return await (window.__drivelineDevHooks as unknown as Hooks).openFiles(
        descs,
      );
    }, REL);
    expect(open.errors).toEqual([]);

    // Bind the dashcam (video binds via the store, not the agent surface).
    const videoChId = await page.evaluate(() =>
      (window.__drivelineDevHooks as unknown as Hooks).findChannelId({
        sourceName: "comma2k19_seg10.mp4",
        nativeId: "1/video",
      }),
    );
    expect(videoChId).not.toBeNull();
    await page.evaluate(
      ([id]) =>
        (window.__drivelineDevHooks as unknown as Hooks).setVideoChannelBinding(
          "video-1",
          id!,
        ),
      [videoChId],
    );

    // The AGENT now takes over: find the speed channel and plot it.
    const speedId = await page.evaluate(() => {
      const agent = window.__drivelineAgent!;
      const ch = agent.listChannels().find((c) => c.name === "/vehicle/speed");
      if (!ch) return null;
      agent.bindChannels("plot-1", [ch.id]);
      agent.setCursor(agent.getSessionSnapshot().globalRange!.startNs);
      return ch.id;
    });
    expect(speedId).not.toBeNull();
    await waitForVideoFrame(page);
    await waitForPlotSeries(page, "plot-1");
    await page.waitForTimeout(LONG_BEAT);

    // ANALYSE the REAL speed channel: scan for the steepest deceleration
    // over a ~0.8 s window (robust to per-sample noise).
    const brake = await page.evaluate(async (id) => {
      const agent = window.__drivelineAgent!;
      const range = agent.getSessionSnapshot().globalRange!;
      const r = await agent.fetchChannelRange(id, range.startNs, range.endNs);
      if (!r) return null;
      const ts = r.columns.find((c) => c.name === "ts")!.values as string[];
      const v = r.columns.find((c) => c.name === "value")!.values as number[];
      const WIN_NS = 800_000_000n;
      let worst = { ns: ts[0], rate: 0 };
      let j = 0;
      for (let i = 0; i < ts.length; i++) {
        const tEnd = BigInt(ts[i]) + WIN_NS;
        while (j < ts.length && BigInt(ts[j]) < tEnd) j++;
        const k = Math.min(j, ts.length - 1);
        if (k <= i) continue;
        const dt = Number(BigInt(ts[k]) - BigInt(ts[i])) / 1e9;
        if (dt <= 0) continue;
        const rate = (v[k] - v[i]) / dt; // m/s²
        if (rate < worst.rate) worst = { ns: ts[i], rate };
      }
      return worst;
    }, speedId!);
    expect(brake).not.toBeNull();

    // TAG the braking moment as an agent finding, with confidence.
    const brakeEventId = await page.evaluate((b) => {
      const agent = window.__drivelineAgent!;
      return agent.addEvent({
        ns: b.ns,
        label: `Hard braking · ${b.rate.toFixed(1)} m/s²`,
        tags: { maneuver: "Decelerate", lighting: "Day", weather: "Clear" },
        confidence: Math.max(0.5, Math.min(0.99, Math.abs(b.rate) / 6)),
      });
    }, brake!);
    expect(brakeEventId).not.toBeNull();
    await expect(
      page.getByTestId(`bookmark-origin-${brakeEventId}`),
    ).toBeVisible();
    await page.waitForTimeout(BEAT);

    // NAVIGATE the dashcam to the tagged braking frame — the payoff shot.
    await page.evaluate(
      (n) => window.__drivelineAgent!.setCursor(n),
      brake!.ns,
    );
    await waitForVideoFrame(page);
    await page.waitForTimeout(LONG_BEAT);

    // PLAY through the braking moment from a few seconds before.
    await page.evaluate((n) => {
      const agent = window.__drivelineAgent!;
      const before = (BigInt(n) - 3_000_000_000n).toString();
      agent.setCursor(before);
      agent.play();
    }, brake!.ns);
    await page.waitForTimeout(LONG_BEAT * 2);
    await page.evaluate(() => window.__drivelineAgent!.pause());
    await page.waitForTimeout(BEAT);
  });
});
