#!/usr/bin/env node
// Enforces Driveline's first-load size budget (see CLAUDE.md):
//   - first-load total  < 2.5 MB gzip  (entry JS + CSS + the wasm payload)
//   - wasm               < 2.0 MB gzip
//
// Run after `pnpm build`. Globs the Vite `dist` output so it is robust to
// content-hashed filenames and layout tweaks. Exits non-zero with a clear
// message if any budget is exceeded.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// --- Budget thresholds (gzip bytes) --------------------------------------
const MB = 1024 * 1024;
const FIRST_LOAD_BUDGET = 2.5 * MB; // entry JS + CSS + wasm, gzipped
const WASM_BUDGET = 2.0 * MB; // wasm payload alone, gzipped

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "apps", "web", "dist");

/** Recursively collect every file path under `dir`. */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function gzipSize(path) {
  return gzipSync(readFileSync(path)).length;
}

function fmt(bytes) {
  return `${(bytes / MB).toFixed(3)} MB`;
}

const files = walk(DIST);
if (files.length === 0) {
  console.error(
    `[size-check] No files found in ${DIST}.\n` +
      "Run `pnpm build` (which builds the wasm bundle then Vite) first.",
  );
  process.exit(1);
}

// The "entry" first-load surface: the top-level JS/CSS Vite emits plus the
// wasm. Lazy-loaded chunks are excluded by only counting files referenced at
// startup, which in this project's flat output means all top-level .js/.css
// in dist/assets plus the wasm. We approximate the first-load cost as the sum
// of every emitted .js/.css and the wasm — a conservative upper bound.
const jsCss = files.filter((f) => /\.(js|css)$/.test(f));
const wasmFiles = files.filter((f) => /\.wasm$/.test(f));

if (wasmFiles.length === 0) {
  console.error(
    "[size-check] No .wasm file found in dist — the wasm bundle did not ship.",
  );
  process.exit(1);
}

let failed = false;

// --- Per-wasm budget ------------------------------------------------------
let wasmGzipTotal = 0;
for (const w of wasmFiles) {
  const g = gzipSize(w);
  wasmGzipTotal += g;
  const ok = g <= WASM_BUDGET;
  console.log(
    `[size-check] wasm  ${ok ? "OK " : "OVER"} ${fmt(g)} gzip  (budget ${fmt(
      WASM_BUDGET,
    )})  ${w.slice(DIST.length + 1)}`,
  );
  if (!ok) failed = true;
}

// --- First-load total budget ---------------------------------------------
let firstLoad = wasmGzipTotal;
for (const f of jsCss) {
  firstLoad += gzipSize(f);
}
const firstLoadOk = firstLoad <= FIRST_LOAD_BUDGET;
console.log(
  `[size-check] total ${firstLoadOk ? "OK " : "OVER"} ${fmt(
    firstLoad,
  )} gzip  (budget ${fmt(FIRST_LOAD_BUDGET)})  [${
    jsCss.length
  } js/css + ${wasmFiles.length} wasm]`,
);
if (!firstLoadOk) failed = true;

if (failed) {
  console.error(
    "\n[size-check] FAIL: bundle exceeds the size budget. See CLAUDE.md.",
  );
  process.exit(1);
}
console.log("\n[size-check] PASS: within size budget.");
