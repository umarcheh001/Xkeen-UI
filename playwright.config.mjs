import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = Number(process.env.XKEEN_E2E_PORT || '18188');
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/*.spec.mjs'],
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    storageState: 'e2e/.auth/user.json',
    viewport: { width: 1440, height: 960 },
  },
  globalSetup: './e2e/global-setup.mjs',
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node scripts/run_e2e_server.mjs',
        url: `${BASE_URL}/setup`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
});
