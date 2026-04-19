import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // Perf budgets (T6.3) measure wall-clock ms and must not race
      // other Playwright workers for CPU. They live in their own
      // project and run after the default chromium project.
      testIgnore: /perfBudgets\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        // Use the full Chromium build (not chromium-headless-shell). The
        // headless shell lacks the proprietary-codec flags WebCodecs needs
        // to decode H.264, which T5.1/T5.2 video tests rely on.
        channel: "chromium",
      },
    },
    {
      name: "perf",
      testMatch: /perfBudgets\.spec\.ts/,
      // Serial: one test at a time. No worker contention against the
      // open/fetch/tick/plot budgets.
      fullyParallel: false,
      workers: 1,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chromium",
      },
      dependencies: ["chromium"],
    },
  ],
  webServer: {
    command: "pnpm --filter web dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    cwd: "../..",
  },
});
