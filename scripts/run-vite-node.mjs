// Tiny launcher: run a TypeScript script through `vite-node` so it resolves
// extensionless TS imports + JSON imports the same way the web app's Vite build
// does (the Format Agent smoke imports the real `llm/` source). `vite-node` is
// a transitive dependency of `vitest` (already installed for the web unit
// tests) but isn't exposed on the PATH, so we resolve its CLI relative to
// `vitest` and re-exec node against it. No new dependency, no `pnpm install`.
//
// Usage: node scripts/run-vite-node.mjs <script.ts> [args…]

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(here, "../apps/web");
// Resolve from the web package so we pick up its vitest → vite-node.
const require = createRequire(resolve(webDir, "package.json"));

const vitestEntry = require.resolve("vitest");
const vitestRequire = createRequire(vitestEntry);
const viteNodeCli = vitestRequire.resolve("vite-node/vite-node.mjs");

const target = process.argv[2];
if (!target) {
  console.error("usage: node scripts/run-vite-node.mjs <script.ts> [args…]");
  process.exit(2);
}

// vite-node loads the nearest vite config; run it from apps/web so the web
// Vite config (TS/JSON/wasm resolution) applies.
const res = spawnSync(
  process.execPath,
  [viteNodeCli, resolve(process.cwd(), target), ...process.argv.slice(3)],
  { stdio: "inherit", cwd: webDir },
);
process.exit(res.status ?? 1);
