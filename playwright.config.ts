import { defineConfig } from "@playwright/test";

const isCI = process.env.CI === "true";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: {
    timeout: 15_000, // Increased to allow worker thread encoding import (~10s)
  },
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  reporter: [["list"], ["html", { outputFolder: "artifacts/playwright-report", open: "never" }]],
  use: {
    trace: isCI ? "on-first-retry" : "retain-on-failure",
    screenshot: "only-on-failure",
    video: {
      mode: "on",
      size: { width: 1280, height: 720 },
    },
  },
  outputDir: "artifacts/playwright-output",
  projects: [
    {
      name: "electron",
      testDir: "./tests/e2e",
      // Electron tests are resource-intensive (each spawns a full browser).
      // Limit parallelism to avoid timing issues with transient UI elements like toasts.
      fullyParallel: false,
    },
  ],
});
