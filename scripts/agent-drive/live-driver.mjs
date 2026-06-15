// Live agent-driver harness for the "Bring Your Own Agent" demo.
//
// Unlike the Playwright spec (a deterministic script), this keeps ONE
// recorded browser alive and executes commands handed to it turn-by-turn
// by an external driver — here, Claude Code itself acting as the agent.
// Each command is JS evaluated in the page against the production
// `window.__drivelineAgent` surface; results come back so the driver can
// reason over real data and decide the next move. The whole session is
// screen-recorded to .webm, and an on-screen "agent HUD" narrates every
// call + decision so viewers can watch the agent think and act.
//
// Protocol (lockstep request/response, no polling sleeps on the caller):
//   - results FIFO at $AGENT_Q/results: server writes one JSON line per
//     command (and "READY" once booted); the caller `cat`s it to sync.
//   - commands: caller atomically `mv`s a file to $AGENT_Q/cmd-<n>.js
//     whose contents are a JS expression (sync or promise-returning);
//     "__QUIT__" closes the context (flushing the video) and exits.
//
// Run from apps/e2e so @playwright/test resolves. Requires the web dev
// server already up at http://localhost:5173.

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// This file lives in scripts/, but @playwright/test is installed under
// apps/e2e (pnpm-isolated). ESM resolves bare specifiers relative to the
// file, so anchor a CJS require at the e2e package to find it.
const require = createRequire(
  path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../apps/e2e/package.json",
  ),
);
const { chromium } = require("@playwright/test");

const Q = process.env.AGENT_Q || "/tmp/agentq";
const REC = process.env.AGENT_REC || "/tmp/agentrec";
const BASE = process.env.AGENT_BASE || "http://localhost:5173";
const RESULTS = path.join(Q, "results");
const DONE = path.join(Q, "done");

for (const d of [Q, REC, DONE]) mkdirSync(d, { recursive: true });

// The HUD: a fixed bottom bar with a pulsing "live" header and a scrolling
// log. Colour-coded by line kind. Installed once after boot.
const INSTALL_HUD = `(() => {
  const css = document.createElement('style');
  css.textContent = \`
    #agent-hud{position:fixed;left:0;right:0;bottom:44px;height:150px;z-index:99999;
      background:rgba(8,10,14,.86);border-top:2px solid #5b8cff;color:#dfe6f2;
      font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;
      display:flex;flex-direction:column;backdrop-filter:blur(2px)}
    #agent-hud .hd{display:flex;align-items:center;gap:8px;padding:5px 12px;
      border-bottom:1px solid rgba(255,255,255,.08);color:#9fb4d8;font-weight:600}
    #agent-hud .dot{width:9px;height:9px;border-radius:50%;background:#39d98a;
      box-shadow:0 0 0 0 rgba(57,217,138,.7);animation:agp 1.4s infinite}
    @keyframes agp{0%{box-shadow:0 0 0 0 rgba(57,217,138,.6)}
      70%{box-shadow:0 0 0 7px rgba(57,217,138,0)}100%{box-shadow:0 0 0 0 rgba(57,217,138,0)}}
    #agent-hud .think{margin-left:auto;color:#ffcf5b;display:none}
    #agent-hud.thinking .think{display:inline}
    #agent-hud .log{flex:1;overflow:hidden;padding:6px 12px;display:flex;
      flex-direction:column;justify-content:flex-end}
    #agent-hud .ln{white-space:pre-wrap;margin:1px 0;opacity:.96}
    #agent-hud .call{color:#7fb0ff}
    #agent-hud .data{color:#b8c4d6}
    #agent-hud .decision{color:#ffd479}
    #agent-hud .ok{color:#5fe0a0}
    #agent-hud .info{color:#9fb4d8}
    #agent-hud .ln b{color:#fff}
  \`;
  document.head.appendChild(css);
  const hud = document.createElement('div');
  hud.id = 'agent-hud';
  hud.innerHTML = '<div class="hd"><span class="dot"></span>'+
    '<span>AGENT — Claude, live via <b>window.__drivelineAgent</b></span>'+
    '<span class="think">▍ thinking…</span></div><div class="log" id="agent-log"></div>';
  document.body.appendChild(hud);
  window.__agentLog = (text, kind) => {
    const log = document.getElementById('agent-log');
    if(!log) return;
    const el = document.createElement('div');
    el.className = 'ln ' + (kind||'info');
    el.innerHTML = text;
    log.appendChild(el);
    while(log.childElementCount > 7) log.removeChild(log.firstChild);
  };
  window.__agentThinking = (on) => {
    const h = document.getElementById('agent-hud');
    if(h) h.classList.toggle('thinking', !!on);
  };
})()`;

function emit(line) {
  // Block until the caller reads — keeps us in lockstep.
  writeFileSync(RESULTS, line.endsWith("\n") ? line : line + "\n");
}

async function main() {
  const browser = await chromium.launch({
    channel: "chromium",
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: REC, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("PAGEERR:", e.message));
  page.on("console", (m) => {
    if (m.type() === "error") console.error("CONSOLE:", m.text());
  });

  await page.goto(`${BASE}/?agent=1`);
  await page.getByTestId("worker-status").waitFor();
  // Best-effort: wait for "workers ready".
  try {
    await page
      .getByTestId("worker-status")
      .filter({ hasText: "workers ready" })
      .waitFor({ timeout: 30000 });
  } catch {}
  await page.evaluate(() => {
    const h = window.__drivelineDevHooks;
    h && h.resetLayout && h.resetLayout();
  });
  await page.evaluate(async () => {
    const h = window.__drivelineDevHooks;
    if (h && h.clearSession) await h.clearSession();
  });
  await page.evaluate(INSTALL_HUD);

  emit("READY");

  let n = 0;
  for (;;) {
    // Show the "thinking" indicator while awaiting the next command.
    await page.evaluate(
      () => window.__agentThinking && window.__agentThinking(true),
    );
    let file = null;
    while (!file) {
      const cmds = readdirSync(Q)
        .filter((f) => /^cmd-\d+\.js$/.test(f))
        .sort(
          (a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]),
        );
      if (cmds.length) file = cmds[0];
      else await page.waitForTimeout(150);
    }
    await page.evaluate(
      () => window.__agentThinking && window.__agentThinking(false),
    );

    const full = path.join(Q, file);
    const body = readFileSync(full, "utf8");
    renameSync(full, path.join(DONE, file));
    n++;

    if (body.trim() === "__QUIT__") {
      emit(JSON.stringify({ ok: true, quit: true }));
      break;
    }
    try {
      const val = await page.evaluate(body);
      emit(JSON.stringify({ ok: true, val }));
    } catch (e) {
      emit(
        JSON.stringify({
          ok: false,
          error: String(e && e.message ? e.message : e),
        }),
      );
    }
  }

  await context.close();
  await browser.close();
  const vids = readdirSync(REC).filter((f) => f.endsWith(".webm"));
  console.log("VIDEO_FILES:", JSON.stringify(vids));
}

main().catch((e) => {
  console.error("DRIVER_FATAL:", e);
  process.exit(1);
});
