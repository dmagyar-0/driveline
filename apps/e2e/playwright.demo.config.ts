// GPU/headed recording config for the nuScenes fusion demo.
// System Chrome (bundled Chromium is blocked here) in HEADED mode so the RTX
// GPU drives WebGL (3D cloud) + hardware H.264 decode → smooth 1x playback.
// Pinned to :5199 so it never reuses a main-repo dev server on :5173.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /_demo-nuscenes-fusion\.spec\.ts$/,
  reporter: "list",
  timeout: 240_000,
  use: {
    baseURL: "http://localhost:5199",
    channel: "chrome",
    headless: false,
    trace: "retain-on-failure",
    launchOptions: {
      args: [
        "--ignore-gpu-blocklist",
        "--use-angle=d3d11",
        "--enable-gpu-rasterization",
        "--enable-zero-copy",
      ],
    },
  },
  webServer: {
    command: "pnpm --filter web dev --port 5199 --strictPort",
    url: "http://localhost:5199",
    cwd: "../..",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
