import { defineConfig } from "@playwright/test";

// One runner for everything: rules (pure functions), the API over HTTP, and the editor in Chromium.
// All of it runs against a real local Worker with D1, R2 and the local sign-in provider.
export default defineConfig({
  testDir: "./tests",
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:8787",
    locale: "nl-BE",
    // The full Chromium build isolates sites like a student's Chrome does. Playwright's default
    // headless shell does not, and a hanging preview then freezes the editor in every setup.
    channel: "chromium",
    viewport: { width: 1280, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/dev.mjs --test",
    url: "http://localhost:8787/api/me",
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
