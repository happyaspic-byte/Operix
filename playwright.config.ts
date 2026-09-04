import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import chromium from "@sparticuz/chromium";
if (existsSync(".env")) process.loadEnvFile(".env");
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/e2e-results.json" }],
    ["html", { open: "never" }],
  ],
  use: {
    baseURL: process.env.APP_URL || "http://localhost:3000",
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 1040 },
    launchOptions: process.env.CHROMIUM_PATH
      ? {
          executablePath: process.env.CHROMIUM_PATH,
          args: chromium.args.filter(
            (a) =>
              ![
                "--disable-web-security",
                "--allow-running-insecure-content",
                "--disable-site-isolation-trials",
                "--single-process",
              ].includes(a),
          ),
        }
      : {},
  },
  webServer:
    process.env.E2E_START_SERVER === "1"
      ? {
          command: "npm run start",
          url: process.env.APP_URL || "http://localhost:3000",
          reuseExistingServer: false,
          timeout: 60000,
        }
      : undefined,
});
