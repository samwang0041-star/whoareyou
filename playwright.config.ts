import { defineConfig, devices } from "@playwright/test";

const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1" || !process.env.DATABASE_URL;

export default defineConfig({
  testDir: "tests/e2e",
  workers: process.env.DATABASE_URL ? 1 : undefined,
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    env: {
      ...process.env,
      PROVIDER_MODE: "fake",
      ALLOW_FAKE_PROVIDER: "1",
    },
    url: "http://127.0.0.1:3000",
    reuseExistingServer,
    timeout: 120000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 15"] } },
  ],
});
