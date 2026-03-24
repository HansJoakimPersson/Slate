const { defineConfig } = require("@playwright/test");

const port = 4179;
const cwd = process.cwd().replace(/'/g, "'\\''");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: true,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    viewport: { width: 1440, height: 960 },
  },
  webServer: {
    command: `python3 -m http.server ${port} --bind 127.0.0.1 --directory '${cwd}'`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
