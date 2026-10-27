import { defineConfig, devices } from '@playwright/test';

// Every worker starts its own panel server on XKEEN_E2E_PORT + its index and
// signs in there (e2e/fixtures.mjs), so spec files run side by side. An
// external server (E2E_BASE_URL) is shared and stays serial; `--workers=1`
// gives the serial run for the local servers.
const SERIAL = !!process.env.E2E_BASE_URL;

// Speed measurements (tests tagged @perf) are slow to set up and depend on the
// machine, so a normal run skips them. They run when asked for by name
// (`npx playwright test e2e/resource_monitor_perf.spec.mjs`) or with XKEEN_E2E_PERF=1.
// `-g "@perf"` / `--grep=@perf` asks for them by tag, `--grep-invert` asks for the opposite.
const argv = process.argv;
const PERF_REQUESTED = !!process.env.XKEEN_E2E_PERF
  || argv.some((arg, i) => /_perf\.spec/.test(arg)
    || (/@perf/.test(arg) && !/^(-gv|--grep-invert)/.test(arg) && !/^(-gv|--grep-invert)$/.test(argv[i - 1] || '')));

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/*.spec.mjs'],
  grepInvert: PERF_REQUESTED ? undefined : /@perf/,
  // Side-by-side workers share the CPU, so the same test takes longer than
  // in a serial run; the limits leave room for that.
  timeout: SERIAL ? 30_000 : 45_000,
  expect: {
    timeout: SERIAL ? 10_000 : 15_000,
  },
  fullyParallel: false,
  // Tests of one file share a server and run in order; only files are spread
  // across workers.
  workers: SERIAL ? 1 : 4,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Recording every test costs a noticeable share of CPU in a parallel
    // run; the trace and the screenshot already describe a failure.
    video: 'off',
    viewport: { width: 1440, height: 960 },
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
