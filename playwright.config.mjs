import { defineConfig, devices } from '@playwright/test';

const E2E_PORT = Number(process.env.XKEEN_E2E_PORT || '18188');
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${E2E_PORT}`;
const E2E_PROFILE = String(process.env.XKEEN_E2E_MODULE_PROFILE || 'full').replace(/[^a-z0-9_-]/gi, '-');
const AUTH_STATE = process.env.XKEEN_E2E_AUTH_STATE || `e2e/.auth/user-${E2E_PROFILE}-${E2E_PORT}.json`;

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
  // The E2E runtime fixture is shared between tests. Keep runs serial so
  // remaining filesystem-backed scenarios cannot race one another.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    storageState: AUTH_STATE,
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
