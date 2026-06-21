// ODD-tagging BYOA demo driver — terminal + UI, side-by-side.
//
// Records TWO synchronised browser contexts in one run:
//   1. a Claude-Code-style *terminal* (odd-terminal.html) that streams the
//      agent's prompt, thinking, tool calls, results, inspected frames and
//      final answer — including a follow-up user question; and
//   2. the real Driveline app at /?agent=1, driven entirely through the
//      production window.__drivelineAgent surface (no privileged hooks beyond
//      the dev-only openFiles loader the other demos use).
//
// The driver runs one scripted-but-honest ODD (Operational Design Domain)
// analysis on the comma2k19 dashcam + CAN: it loads the data, "watches" the
// drive by sampling frames across the segment (each sample moves the app
// cursor AND pulls the frame into the terminal as a thumbnail), reads the CAN
// signals to confirm what's happening, then writes ONE event tagged with the
// four ODD scene elements (weather / road type / illumination / other road
// user) plus the maneuver, and explains itself.
//
// Both contexts are recorded as separate .webm clips; scripts/record-byoa-odd.sh
// stacks them horizontally with ffmpeg. Driving both pages from this single
// process keeps them on a shared wall clock, so the terminal and the app stay
// in step. Run from anywhere — the @playwright/test require is anchored at
// apps/e2e by absolute path, mirroring live-driver.mjs.

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const require = createRequire(path.join(ROOT, "apps/e2e/package.json"));
const { chromium } = require("@playwright/test");

const BASE = process.env.AGENT_BASE || "http://localhost:5173";
const REC = process.env.AGENT_REC || "/tmp/odd-rec";
const APP_W = Number(process.env.ODD_APP_W || 1100);
const TERM_W = Number(process.env.ODD_TERM_W || 760);
const H = Number(process.env.ODD_H || 720);

const APP_DIR = path.join(REC, "app");
const TERM_DIR = path.join(REC, "term");
for (const d of [APP_DIR, TERM_DIR]) mkdirSync(d, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Channels + sources this demo uses (the gitignored comma2k19 fixtures).
const FIXTURES = [
  "realworld/comma2k19.mcap",
  "realworld/comma2k19_seg10.mp4",
  "realworld/comma2k19_seg10.mp4.timestamps",
];

async function main() {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });

  // --- terminal context (left pane) -----------------------------------------
  const termCtx = await browser.newContext({
    viewport: { width: TERM_W, height: H },
    recordVideo: { dir: TERM_DIR, size: { width: TERM_W, height: H } },
  });
  const term = await termCtx.newPage();
  await term.setContent(
    readFileSync(path.join(HERE, "odd-terminal.html"), "utf8"),
  );
  await term.waitForFunction(() => !!window.__term);

  // --- app context (right pane) ---------------------------------------------
  const appCtx = await browser.newContext({
    viewport: { width: APP_W, height: H },
    recordVideo: { dir: APP_DIR, size: { width: APP_W, height: H } },
  });
  const app = await appCtx.newPage();
  app.on("pageerror", (e) => console.error("PAGEERR:", e.message));
  app.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE:", m.text());
  });

  // Terminal helpers (run in the terminal page; awaited for typewriter pacing).
  const tUser = (t) => term.evaluate((s) => window.__term.user(s), t);
  const tThink = (t) => term.evaluate((s) => window.__term.think(s), t);
  const tCall = (t) => term.evaluate((s) => window.__term.call(s), t);
  const tResult = (t) => term.evaluate((s) => window.__term.result(s), t);
  const tAsst = (t) => term.evaluate((s) => window.__term.assistant(s), t);
  const tTag = (t) => term.evaluate((s) => window.__term.tag(s), t);
  const tGap = () => term.evaluate(() => window.__term.gap());
  const tFrames = (items) =>
    term.evaluate((xs) => window.__term.frames(xs), items);

  // ===========================================================================
  // Beat 0 — the user's request, while the app boots.
  // ===========================================================================
  await tUser("analyse and tag the ODD on this comma2k19 drive");
  await tGap();
  await tThink(
    "I'll discover the agent surface, load the dashcam + CAN, watch the drive, then tag the ODD scene elements.",
  );

  await app.goto(`${BASE}/?agent=1`);
  await app.getByTestId("worker-status").waitFor();
  try {
    await app
      .getByTestId("worker-status")
      .filter({ hasText: "workers ready" })
      .waitFor({ timeout: 30000 });
  } catch {}
  await app.evaluate(() => {
    const h = window.__drivelineDevHooks;
    h?.resetLayout?.();
  });
  await app.evaluate(async () => {
    const h = window.__drivelineDevHooks;
    if (h?.clearSession) await h.clearSession();
  });

  // A tiny, demo-only inspection badge on the app — makes "which frame the
  // agent is checking" legible in the recording. Not part of the product.
  await app.evaluate(() => {
    const css = document.createElement("style");
    css.textContent = `
      #odd-inspect{position:fixed;top:10px;left:50%;transform:translateX(-50%);
        z-index:99999;background:rgba(11,14,20,.86);border:1px solid #7fb0ff;
        color:#dfe9fb;font:600 13px/1 ui-monospace,Menlo,monospace;
        padding:7px 12px;border-radius:999px;opacity:0;transition:opacity .18s;
        box-shadow:0 4px 18px rgba(0,0,0,.4)}
      #odd-inspect.on{opacity:1}
      #odd-inspect .dot{color:#ffcf5b}`;
    document.head.appendChild(css);
    const b = document.createElement("div");
    b.id = "odd-inspect";
    document.body.appendChild(b);
    window.__oddInspect = (label) => {
      const el = document.getElementById("odd-inspect");
      if (!el) return;
      if (label === null) {
        el.classList.remove("on");
        return;
      }
      el.innerHTML = '<span class="dot">🔍</span> ' + label;
      el.classList.add("on");
    };
  });

  // ===========================================================================
  // Beat 1 — discover the surface.
  // ===========================================================================
  await tCall("window.__drivelineAgent.getSkill() · describe()");
  const disc = await app.evaluate(() => {
    const a = window.__drivelineAgent;
    return {
      v: a.version,
      caps: a.describe().capabilities.length,
      skill: a.getSkill().length,
    };
  });
  await tResult(
    `API v${disc.v} · ${disc.caps} capabilities · skill ${disc.skill} chars`,
  );
  await sleep(400);

  // ===========================================================================
  // Beat 2 — lay out panels + load the comma2k19 dashcam and CAN.
  // ===========================================================================
  await tThink(
    "Laying out a dashcam + speed/steering plots and opening the Events drawer.",
  );
  await app.evaluate(() => {
    const h = window.__drivelineDevHooks;
    h.setLayoutJson({
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
            weight: 56,
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
            type: "column",
            weight: 44,
            children: [
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
              {
                type: "tabset",
                weight: 50,
                children: [
                  {
                    type: "tab",
                    id: "plot-2",
                    name: "Steering (°)",
                    component: "plot",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    document.querySelector('[data-testid="rail-events"]')?.click();
  });
  await sleep(700);

  await tCall("openFiles(comma2k19.mcap, comma2k19_seg10.mp4 + .timestamps)");
  const opened = await app.evaluate(async (rels) => {
    const h = window.__drivelineDevHooks;
    const descs = await Promise.all(
      rels.map(async (rel) => {
        const r = await fetch("/sample-data/" + rel);
        return {
          name: rel.split("/").pop(),
          bytes: new Uint8Array(await r.arrayBuffer()),
        };
      }),
    );
    return h.openFiles(descs);
  }, FIXTURES);
  await tResult(`opened: ${opened.opened.join(", ")}`);
  await sleep(400);

  // ===========================================================================
  // Beat 3 — bind video + plots, jump to the start.
  // ===========================================================================
  const bind = await app.evaluate(() => {
    const a = window.__drivelineAgent;
    const h = window.__drivelineDevHooks;
    const vid = h.findChannelId({
      sourceName: "comma2k19_seg10.mp4",
      nativeId: "1/video",
    });
    h.setVideoChannelBinding("video-1", vid);
    const speed = a.listChannels().find((c) => c.name === "/vehicle/speed");
    const steer = a
      .listChannels()
      .find((c) => c.name === "/vehicle/steering_angle");
    a.bindChannels("plot-1", [speed.id]);
    a.bindChannels("plot-2", [steer.id]);
    const r = a.getSessionSnapshot().globalRange;
    a.setCursor(r.startNs);
    return {
      vid,
      speed: speed.id,
      steer: steer.id,
      startNs: r.startNs,
      endNs: r.endNs,
    };
  });
  // Wait for the first frame to blit.
  await app.evaluate(async () => {
    const h = window.__drivelineDevHooks;
    for (let i = 0; i < 60 && !h.videoLastBlitPtsNs(); i++)
      await new Promise((r) => setTimeout(r, 200));
  });
  await tResult("dashcam decoding · speed + steering plotted");
  await sleep(900);

  // ===========================================================================
  // Beat 4 — read the CAN to ground the analysis (real numbers).
  // ===========================================================================
  await tCall("fetchChannelRange('/vehicle/speed') · profile decel + extremes");
  const prof = await app.evaluate(async ({ startNs, endNs }) => {
    const a = window.__drivelineAgent;
    const chans = a.listChannels();
    const summarise = async (name) => {
      const c = chans.find((x) => x.name === name);
      if (!c) return null;
      const res = await a.fetchChannelRange(c.id, startNs, endNs);
      if (!res) return null;
      const v = res.columns
        .find((x) => x.name === "value")
        .values.filter((x) => x != null);
      let mn = Infinity,
        mx = -Infinity;
      for (const x of v) {
        if (x < mn) mn = x;
        if (x > mx) mx = x;
      }
      const ts = res.columns.find((x) => x.name === "ts").values;
      const WIN = 800000000n;
      let worst = 0,
        j = 0;
      for (let i = 0; i < ts.length; i++) {
        const tEnd = BigInt(ts[i]) + WIN;
        while (j < ts.length && BigInt(ts[j]) < tEnd) j++;
        const k = Math.min(j, ts.length - 1);
        if (k <= i) continue;
        const dt = Number(BigInt(ts[k]) - BigInt(ts[i])) / 1e9;
        if (dt > 0) {
          const rate = (v[k] - v[i]) / dt;
          if (rate < worst) worst = rate;
        }
      }
      return {
        rows: res.rows,
        min: +mn.toFixed(2),
        max: +mx.toFixed(2),
        worstDecel: +worst.toFixed(2),
      };
    };
    return {
      spd: await summarise("/vehicle/speed"),
      steer: await summarise("/vehicle/steering_angle"),
    };
  }, bind);
  await tResult(
    `speed ${prof.spd.min}–${prof.spd.max} m/s · hardest decel ${prof.spd.worstDecel} m/s² · steering ${prof.steer.min}–${prof.steer.max}°`,
  );
  await tThink(
    "Steady ~30 m/s with tiny steering — a highway cruise, no hard braking. Now I'll look at the road itself.",
  );
  await sleep(500);

  // ===========================================================================
  // Beat 5 — "watch" the drive: sample frames across the segment.
  //   Each sample moves the app cursor (video + plots follow) and pulls the
  //   decoded frame into the terminal as a thumbnail.
  // ===========================================================================
  await tCall("captureVideoFrameAt(dashcam, t) at 5 points across the drive");
  const span = BigInt(bind.endNs) - BigInt(bind.startNs);
  const fracs = [0.08, 0.3, 0.5, 0.72, 0.92];
  const samples = [];
  for (const f of fracs) {
    const ns = (
      BigInt(bind.startNs) +
      (span * BigInt(Math.round(f * 1000))) / 1000n
    ).toString();
    const tSec = (Number(BigInt(ns) - BigInt(bind.startNs)) / 1e9).toFixed(1);
    // Move the app cursor so the main video + plot cursor track the sample.
    await app.evaluate((x) => window.__drivelineAgent.setCursor(x), ns);
    await app.evaluate(
      (label) => window.__oddInspect(label),
      `inspecting frame · t=${tSec}s`,
    );
    await app.evaluate(async () => {
      const h = window.__drivelineDevHooks;
      for (let i = 0; i < 30 && !h.videoLastBlitPtsNs(); i++)
        await new Promise((r) => setTimeout(r, 100));
    });
    await sleep(450);
    const cap = await app.evaluate(
      ({ id, ns }) => window.__drivelineAgent.captureVideoFrameAt(id, ns),
      { id: bind.vid, ns },
    );
    if (cap?.dataUrl) {
      samples.push({ t: `t=${tSec}s`, dataUrl: cap.dataUrl });
      await tFrames([{ t: `t=${tSec}s`, dataUrl: cap.dataUrl }]);
    }
    await sleep(250);
  }
  await app.evaluate(() => window.__oddInspect(null));
  await tThink(
    "Across all five frames: bright daylight with hard shadows, dry multi-lane divided road with a guardrail, a lead vehicle ahead in-lane. Clear sky.",
  );
  await sleep(500);

  // ===========================================================================
  // Beat 6 — write the ODD event with the four scene-element tags.
  // ===========================================================================
  await tCall("getEventTagConfig() — confirm the ODD taxonomy");
  const cfg = await app.evaluate(() =>
    window.__drivelineAgent.getEventTagConfig().attributes.map((a) => a.id),
  );
  await tResult(`attributes: ${cfg.join(", ")}`);
  await sleep(300);

  await tThink(
    "Tagging one event spanning the whole segment with the ODD scene elements + maneuver, each with a confidence.",
  );
  const ev = await app.evaluate(({ startNs, endNs }) => {
    const a = window.__drivelineAgent;
    const id = a.addEvent({
      ns: startNs,
      label: "ODD · daytime highway cruise · clear · lead vehicle",
      tags: {
        weather: "Clear",
        road_type: "Highway",
        lighting: "Day",
        other_road_user: "Lead vehicle",
        maneuver: "Go straight",
      },
      confidence: 0.82,
    });
    a.setEventRange(id, "0", String(BigInt(endNs) - BigInt(startNs)));
    return { id, count: a.listEvents().length };
  }, bind);
  await tCall(`addEvent() → ${ev.id}  (origin:"agent", confidence 0.82)`);
  await tTag("weather = Clear        — blue sky, hard shadows");
  await tTag("road type = Highway    — divided, multi-lane, guardrail");
  await tTag("illumination = Day     — bright daylight throughout");
  await tTag("other road user = Lead vehicle — ahead, in-lane");
  await tTag("maneuver = Go straight — ~30 m/s, steering near 0°");
  await sleep(400);

  // Drive the cursor across the event so the viewer sees the tagged span.
  await app.evaluate((x) => window.__drivelineAgent.setCursor(x), bind.startNs);
  await app.evaluate(() => window.__drivelineAgent.play());
  await sleep(5200);
  await app.evaluate(() => window.__drivelineAgent.pause());

  // ===========================================================================
  // Beat 7 — the scene summary.
  // ===========================================================================
  await tGap();
  await tAsst(
    "Summary: a calm ~60 s daytime highway cruise. The ego holds 30–33 m/s (≈113 km/h) with near-zero steering and no hard braking — a steady straight-ahead drive on a dry, multi-lane divided highway under clear skies, following a lead vehicle. Tagged one ODD event over the full segment.",
  );
  await sleep(400);

  // ===========================================================================
  // Beat 8 — a follow-up user question, answered.
  // ===========================================================================
  await tGap();
  await tUser("any vulnerable road users — pedestrians or cyclists?");
  await tThink("Re-checking the five sampled frames for VRUs.");
  await tAsst(
    "No. Across the sampled frames I only see a lead vehicle ahead in-lane; no pedestrians, cyclists or motorcyclists. That's why other_road_user is tagged 'Lead vehicle', not a VRU.",
  );
  await sleep(1800);

  // --- flush both recordings -------------------------------------------------
  await Promise.all([appCtx.close(), termCtx.close()]);
  await browser.close();

  const appVid = readdirSync(APP_DIR).filter((f) => f.endsWith(".webm"))[0];
  const termVid = readdirSync(TERM_DIR).filter((f) => f.endsWith(".webm"))[0];
  console.log(
    "ODD_VIDEOS:" +
      JSON.stringify({
        app: path.join(APP_DIR, appVid),
        term: path.join(TERM_DIR, termVid),
      }),
  );
}

main().catch((e) => {
  console.error("DRIVER_FATAL:", e);
  process.exit(1);
});
