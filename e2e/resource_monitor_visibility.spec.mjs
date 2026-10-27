import { test, expect } from './fixtures.mjs';

// The monitor in the panel header (CPU and memory next to the bell) polls
// /api/system/resources while the tab is visible. A hidden tab must not be polled at all;
// coming back costs exactly one request.

const resources = () => ({
  ok: true, sampled_at: 1792602000,
  cpu: { percent: 19, cores: 3, load_1m: 0.4, load_5m: 0.4, load_15m: 0.3, total_tasks: 100, runnable_tasks: 1 },
  memory: { percent: 47, total_bytes: 1024 ** 3, used_bytes: 500000000, swap_total_bytes: 0, swap_used_bytes: 0 },
  storage: { percent: 18.5, total_bytes: 8 * 1024 ** 3, free_bytes: 7 * 1024 ** 3 },
  router: {},
});

const setVisibility = (page, state) => page.evaluate((value) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => value === 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
}, state);

test('header monitor does not poll in a hidden tab and refreshes once on return', async ({ page }) => {
  let requests = 0;
  await page.clock.install();
  await page.route('**/api/system/resources', (route) => {
    requests += 1;
    route.fulfill({ json: resources() });
  });
  await page.goto('/');
  const monitor = page.locator('#xk-resource-monitor');
  await expect(monitor).toHaveAttribute('data-state', 'ready');

  // visible: the 5 s poll keeps asking
  const first = requests;
  await page.clock.runFor(5200);
  await expect.poll(() => requests).toBeGreaterThan(first);

  // hidden: five minutes of timers bring no request at all
  await setVisibility(page, 'hidden');
  await page.waitForTimeout(200);
  const quiet = requests;
  await page.clock.runFor(5 * 60 * 1000);
  await page.waitForTimeout(400);
  expect(requests).toBe(quiet);

  // back: exactly one request at once, then the poll goes on
  await setVisibility(page, 'visible');
  await expect.poll(() => requests).toBe(quiet + 1);
  await page.waitForTimeout(400);
  expect(requests).toBe(quiet + 1);
  await page.clock.runFor(5200);
  await expect.poll(() => requests).toBeGreaterThan(quiet + 1);
});

test('header monitor repaints in place and shows the numbers', async ({ page }) => {
  let percent = 19;
  await page.clock.install();
  await page.route('**/api/system/resources', (route) => route.fulfill({ json: { ...resources(), cpu: { ...resources().cpu, percent } } }));
  await page.goto('/');
  const cpu = page.locator('#xk-resource-cpu');
  await expect(cpu).toHaveText('19%');
  // the text node is edited, not replaced: its identity survives the next poll
  await cpu.evaluate((el) => { el.__node = el.firstChild; });
  percent = 63;
  await page.clock.runFor(5200);
  await expect(cpu).toHaveText('63%');
  expect(await cpu.evaluate((el) => el.__node === el.firstChild)).toBe(true);
  await expect(page.locator('#xk-resource-monitor')).toHaveAttribute('data-cpu-tone', 'normal');
});
