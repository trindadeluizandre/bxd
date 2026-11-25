const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    headless: true
  },
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    env: {
      PORT: '3001',
      TEST_MOCK_MODE: 'true',
      TELEMETRY_DATA_DIR: './test-data'
    }
  }
});
