#!/usr/bin/env node
// License gate for the JS dependency tree (mirrors deny.toml on the Rust side).
//
// Runs `pnpm licenses list --json` over the installed graph and fails if any
// package resolves to a license outside the permissive / MPL-compatible
// allow list. Keeps Driveline's MPL-2.0 promise clean: a transitive GPL/AGPL
// dep can't slip in unnoticed.
//
//   Usage: node scripts/check-js-licenses.mjs   (deps must be installed first)

import { execSync } from "node:child_process";

// Permissive + our own weak-copyleft license. Kept in sync with deny.toml.
const ALLOW = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Zlib",
  "Unlicense",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "BlueOak-1.0.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
  "MPL-2.0", // Driveline's own license
]);

// Evaluate an SPDX-ish expression the way cargo-deny does:
//   "A OR B"  -> pass if EITHER side passes
//   "A AND B" -> pass only if BOTH sides pass
// Parentheses are stripped; unknown/empty strings fail (manual review).
function isAllowed(expr) {
  if (!expr) return false;
  const clean = expr.replace(/[()]/g, " ").trim();
  if (ALLOW.has(clean)) return true;
  if (/\bOR\b/i.test(clean)) {
    return clean.split(/\bOR\b/i).some((p) => isAllowed(p.trim()));
  }
  if (/\bAND\b/i.test(clean)) {
    return clean.split(/\bAND\b/i).every((p) => isAllowed(p.trim()));
  }
  return ALLOW.has(clean);
}

let raw;
try {
  raw = execSync("pnpm licenses list --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  // pnpm exits non-zero if there are no deps to inspect; surface and bail.
  console.error("Failed to run `pnpm licenses list --json`:", err.message);
  process.exit(2);
}

const data = JSON.parse(raw);
// pnpm emits an object keyed by license -> array of package descriptors.
const violations = [];
for (const [license, pkgs] of Object.entries(data)) {
  if (isAllowed(license)) continue;
  for (const p of pkgs) {
    const versions = Array.isArray(p.versions) ? p.versions.join(", ") : "";
    violations.push(`${p.name}${versions ? `@${versions}` : ""}  →  ${license}`);
  }
}

if (violations.length > 0) {
  console.error("\n✗ Disallowed JS dependency licenses found:\n");
  for (const v of violations.sort()) console.error("  " + v);
  console.error(
    "\nIf one of these is acceptable, add its SPDX id to ALLOW in " +
      "scripts/check-js-licenses.mjs (and deny.toml if it also affects Rust).\n",
  );
  process.exit(1);
}

console.log("✓ All JS dependency licenses are on the allow list.");
