// Browser tests: the page against the real server on a made-up corpus of both agents (tests/e2e).
// `npm run e2e`. The node:test suite (`npm test`) is separate and never loads these specs.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.mjs",
  globalSetup: "./tests/e2e/global-setup.mjs",
  // One server and one corpus for the run: specs that rename or delete use their own sessions,
  // but the counts other specs read are shared, so the run is serial.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30000,
  expect: { timeout: 7000 },
  outputDir: "test-results/e2e",
  reporter: process.env.CI ? [["list"], ["github"]] : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  // The page in both languages and both themes: every spec runs in each.
  projects: [
    { name: "en-light", use: { browserName: "chromium", colorScheme: "light", lang: "en" } },
    { name: "ru-dark", use: { browserName: "chromium", colorScheme: "dark", lang: "ru" } },
  ],
});
