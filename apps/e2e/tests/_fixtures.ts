// Fixture resolution for e2e tests.
//
// Points at `sample-data/` — the real corpus produced by
// `sample-data/generate.py` (T0.3). If a required file is missing, we
// fail fast with a message that tells the reader how to rebuild it,
// instead of surfacing opaque Playwright errors like `ENOENT`.
//
// The arrow contract test (`apps/web/src/tests/arrow.contract.test.ts`)
// still uses `test-fixtures/arrow_scalar.ipc` — that is an in-tree
// canonical byte fixture and intentionally left untouched.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const thisDir = dirname(fileURLToPath(import.meta.url));
export const SAMPLE_DATA_DIR = resolve(thisDir, "../../../sample-data");

export function fixturePath(name: string): string {
  const p = resolve(SAMPLE_DATA_DIR, name);
  if (!existsSync(p)) {
    throw new Error(
      `sample-data fixture missing: ${name}\n` +
      `  expected at: ${p}\n` +
      `  run \`make fixtures\` from the repo root (see sample-data/README.md).`,
    );
  }
  return p;
}

export const MCAP = fixturePath("short.mcap");
export const MF4 = fixturePath("short.mf4");
export const MP4 = fixturePath("short.mp4");
export const MP4_SIDECAR = fixturePath("short.mp4.ts.bin");

export const REFS_DIR = resolve(SAMPLE_DATA_DIR, "refs");

export function refPath(ms: number): string {
  const name = `t_${String(ms).padStart(4, "0")}.png`;
  return fixturePath(`refs/${name}`);
}

// Fetch fixture bytes *inside the page*. The dev server (see
// `apps/web/vite.config.ts`) serves `sample-data/` under
// `/sample-data/<name>`. This avoids shipping 30–40 MB files through
// CDP as JSON arrays, which SIGSEGVs the Playwright worker.
export async function fetchFixtureInPage(
  page: import("@playwright/test").Page,
  name: string,
): Promise<Uint8Array> {
  // Page-side fetch — returns Uint8Array that can be passed to dev hooks.
  return await page.evaluate(async (n) => {
    const resp = await fetch(`/sample-data/${n}`);
    if (!resp.ok) {
      throw new Error(`fetch /sample-data/${n}: ${resp.status}`);
    }
    const buf = await resp.arrayBuffer();
    return new Uint8Array(buf) as unknown as Uint8Array;
  }, name);
}
