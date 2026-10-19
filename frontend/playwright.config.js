import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium",
    // Google Chrome by default; PLAYWRIGHT_CHANNEL=chromium uses Playwright's bundled build.
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  },
  reporter: "list",
});
