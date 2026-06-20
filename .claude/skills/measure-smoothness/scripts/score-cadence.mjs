#!/usr/bin/env node
// Score a decode-worker frame-pacing sample against Driveline's own
// smoothness thresholds and print a verdict.
//
// Input: the JSON published by the video dev hooks —
//   { "cadence": <CadenceSummary | null>, "hud": <VideoHudSnapshot | null> }
// — exactly what `apps/e2e/tests/_demo-nuscenes-fusion.spec.ts` logs on its
// `[demo] PACING {...}` line. Pass it on stdin or as a file argument; a
// leading `[demo] PACING ` / `PACING ` prefix is tolerated so you can pipe a
// raw log line straight in.
//
// The PASS/FAIL verdict mirrors the worker's own `smooth` boolean
// (`crates`-free; thresholds live in videoDecode.worker.ts) so this never
// drifts from the app. The diagnostics block explains *why* a run failed —
// and, critically, separates PLAYER judder from an irregular ~12 fps SOURCE,
// which the boolean alone can't tell you.
//
// Exit code: 0 if smooth, 1 if not smooth, 2 if the input had no cadence.

import { readFileSync } from "node:fs";

// --- thresholds: keep in lockstep with videoDecode.worker.ts -----------------
const SMOOTH_JITTER_RATIO = 0.25; // dwell stdev under a quarter source-interval
const SMOOTH_P95_RATIO = 1.5; //     no frame held > 50% over ideal
const SMOOTH_REPEAT_RATIO = 0.05; // < 5% of frames stuttered (held >= 1.5x)
const SMOOTH_RATE_LO = 0.9;
const SMOOTH_RATE_HI = 1.1;

function readInput() {
  const fileArg = process.argv[2];
  return readFileSync(fileArg ?? 0, "utf8");
}

function parse(raw) {
  const trimmed = raw.trim();
  // Tolerate a log prefix: take from the first `{` onward.
  const brace = trimmed.indexOf("{");
  const json = brace >= 0 ? trimmed.slice(brace) : trimmed;
  return JSON.parse(json);
}

const fmt = (n, d = 1) =>
  typeof n === "number" && isFinite(n) ? n.toFixed(d) : String(n);
const mark = (ok) => (ok ? "PASS" : "FAIL");

function row(name, value, budget, ok) {
  const v = String(value).padEnd(11);
  const b = String(budget).padEnd(20);
  return `  ${mark(ok).padEnd(5)} ${name.padEnd(22)} ${v} ${b}`;
}

function main() {
  let payload;
  try {
    payload = parse(readInput());
  } catch (e) {
    console.error("score-cadence: could not parse input as JSON:", e.message);
    process.exit(2);
  }

  const c = payload.cadence ?? payload; // allow a bare CadenceSummary too
  const hud = payload.hud ?? null;

  if (!c || typeof c.idealDwellMs !== "number") {
    console.error(
      "score-cadence: no cadence summary in input (null window). " +
        "Sample WHILE playing or right after pause — a seek/play-start " +
        "resets the window.",
    );
    process.exit(2);
  }

  const ideal = c.idealDwellMs;
  const n = c.paints ?? 0;

  // --- verdict components (mirror the worker's `smooth`) ---------------------
  const jitterOk = c.jitterMs <= SMOOTH_JITTER_RATIO * ideal;
  const p95Ok = c.p95DwellMs <= SMOOTH_P95_RATIO * ideal;
  const repeatOk = (c.repeats ?? 0) <= SMOOTH_REPEAT_RATIO * n;
  const rateOk =
    c.playbackRateRatio >= SMOOTH_RATE_LO &&
    c.playbackRateRatio <= SMOOTH_RATE_HI;
  const monotonicOk = (c.backwardSteps ?? 0) === 0;
  const verdictSmooth = jitterOk && p95Ok && repeatOk && rateOk && monotonicOk;

  const lines = [];
  lines.push(
    `Frame-pacing over ${n} paints — source interval ${fmt(
      c.sourceIntervalNs / 1e6,
    )} ms (idealDwell ${fmt(ideal)} ms, ${fmt(1000 / ideal, 1)} fps)`,
  );
  lines.push("");
  lines.push("  VERDICT  METRIC                 VALUE       BUDGET");
  lines.push(
    row("jitter (dwell stdev)", `${fmt(c.jitterMs)}ms`, `<= ${fmt(SMOOTH_JITTER_RATIO * ideal)}ms`, jitterOk),
  );
  lines.push(
    row("p95 dwell", `${fmt(c.p95DwellMs)}ms`, `<= ${fmt(SMOOTH_P95_RATIO * ideal)}ms`, p95Ok),
  );
  lines.push(
    row("repeats (>=1.5x held)", `${c.repeats}`, `<= ${fmt(SMOOTH_REPEAT_RATIO * n, 0)} (5%)`, repeatOk),
  );
  lines.push(
    row("playback rate", `${fmt(c.playbackRateRatio, 3)}x`, `${SMOOTH_RATE_LO}-${SMOOTH_RATE_HI}x`, rateOk),
  );
  lines.push(
    row("backward steps", `${c.backwardSteps}`, `== 0`, monotonicOk),
  );
  lines.push("");

  // --- diagnostics (NOT part of the verdict; localise the cause) ------------
  lines.push("  DIAGNOSTICS (not scored — explain the verdict)");
  lines.push(`    dwell p50/mean/max     ${fmt(c.p50DwellMs)} / ${fmt(c.meanDwellMs)} / ${fmt(c.maxDwellMs)} ms`);
  lines.push(`    rushed (<=0.5x)        ${c.rushed}`);

  // Player vs source: the key disambiguation. A large playerErrStdRegularMs
  // (error on near-median source intervals) means the PLAYER is the cause,
  // not the source being steppy.
  const srcJit = c.sourceJitterMs;
  const playReg = c.playerErrStdRegularMs;
  lines.push(`    source jitter          ${fmt(srcJit)} ms   (irregularity of the captured data itself)`);
  lines.push(
    `    player err (all)       ${fmt(c.playerErrStdMs)} ms  (p95 ${fmt(c.playerErrP95Ms)}, max ${fmt(c.playerErrMaxMs)})`,
  );
  lines.push(
    `    player err (regular)   ${fmt(playReg)} ms  over ${c.regularPairs} near-median-interval pairs`,
  );
  let cause;
  if (playReg != null && srcJit != null) {
    if (playReg <= SMOOTH_JITTER_RATIO * ideal) {
      cause =
        "player tracks the source faithfully on regular frames; residual judder is the IRREGULAR SOURCE, not the player.";
    } else if (playReg > srcJit) {
      cause =
        "player error on regular frames exceeds source jitter — the PLAYER itself is the dominant cause.";
    } else {
      cause = "mixed — both an irregular source and player error contribute.";
    }
    lines.push(`    -> cause: ${cause}`);
  }
  lines.push("");

  // Blit-clock health (200 Hz tick). Starvation -> capped catch-up rushes.
  lines.push(
    `    blit tick gap p95/max  ${fmt(c.tickGapP95Ms)} / ${fmt(c.tickGapMaxMs)} ms   starved ${c.starvedTicks}/${c.ticks} ticks`,
  );
  lines.push(
    `    re-anchors             resync ${c.resyncReanchors} / scrub ${c.scrubReanchors}   (resync -> a catch-up rush; the periodic-slip suspect)`,
  );
  lines.push(
    `    rate first/second half ${fmt(c.firstHalfRate, 3)} / ${fmt(c.secondHalfRate, 3)}   (startup catch-up vs steady-state)`,
  );
  if (Array.isArray(c.histDwell)) {
    lines.push(
      `    dwell histogram        [${c.histDwell.join(", ")}]  buckets x ideal: <0.25 .25-.5 .5-.75 .75-1.25 1.25-1.75 1.75-2.5 >=2.5`,
    );
  }

  // Frame loss from the HUD monotonic counters, if present.
  if (hud) {
    const lossOk = (hud.skipped ?? 0) === 0 && (hud.dropped ?? 0) === 0;
    lines.push("");
    lines.push("  FRAME LOSS (HUD counters — 0 in smooth playback)");
    lines.push(
      `    ${mark(lossOk)}  drawn ${hud.drawn}  skipped ${hud.skipped}  dropped ${hud.dropped}  straggler ${hud.straggler}`,
    );
    lines.push(
      `          skipped = source frames the cursor jumped past undrawn (visual frame-loss); dropped = decode-queue loss`,
    );
  }

  lines.push("");
  lines.push(
    `  ============================================================`,
  );
  lines.push(
    `  VERDICT: ${verdictSmooth ? "SMOOTH" : "NOT SMOOTH"}` +
      (verdictSmooth ? "" : `  (failed: ${[
        !jitterOk && "jitter",
        !p95Ok && "p95-dwell",
        !repeatOk && "repeats",
        !rateOk && "playback-rate",
        !monotonicOk && "backward-steps",
      ]
        .filter(Boolean)
        .join(", ")})`),
  );
  lines.push(
    `  ============================================================`,
  );

  console.log(lines.join("\n"));
  process.exit(verdictSmooth ? 0 : 1);
}

main();
