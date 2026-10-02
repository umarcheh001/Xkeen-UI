import { test, expect, selectPanelView } from './fixtures.mjs';


// The command buttons run their command inside the PTY terminal. Whether the
// router has PTY is learned from /api/capabilities, and on a remote router that
// answer may come late or not at all. These tests pin what the panel does then.

const CAPABILITIES = {
  websocket: true,
  terminal: {
    lite: true,
    pty: true,
    ws: true,
    shell: {
      enabled: true,
      env: 'XKEEN_ALLOW_SHELL',
      default: '1',
      message: '',
      hint: '',
      requires_restart: false,
    },
  },
  remoteFs: { enabled: false, supported: false },
  storageUsb: { enabled: false },
};


async function mockCapabilities(page, link) {
  await page.route('**/api/capabilities', async (route) => {
    if (link.down) {
      await route.abort('connectionfailed');
      return;
    }
    if (link.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, link.delayMs));
    }
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CAPABILITIES),
      });
    } catch (error) {
      // The page gave up on this request while it was being held back.
    }
  });
}


async function mockPty(page, options = {}) {
  const inputs = [];
  await page.route('**/api/ws-token', async (route) => {
    let scope = '';
    try { scope = String((route.request().postDataJSON() || {}).scope || ''); } catch (error) { scope = ''; }
    if (scope !== 'pty') {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { ok: true, token: 'e2e-token', ttl: 60, scope: 'pty' } });
  });
  await page.routeWebSocket(/\/ws\/pty/, (ws) => {
    if (options.refuse) {
      ws.close({ code: 1011, reason: 'e2e refuses pty' });
      return;
    }
    ws.onMessage((raw) => {
      let message = null;
      try { message = JSON.parse(String(raw)); } catch (error) { message = null; }
      if (message && message.type === 'input') inputs.push(String(message.data || ''));
    });
    ws.send(JSON.stringify({ type: 'init', session_id: 'e2e-session', shell: '/bin/sh', reused: false, seq: 0 }));
  });
  return inputs;
}


async function openCommands(page) {
  await page.goto('/');
  await selectPanelView(page, 'commands');
  await expect(page.locator('#view-commands')).toBeVisible();
}


function commandRow(page) {
  return page.locator('.command-item[data-flag="-i"]');
}


test.describe('Commands: PTY capability probe on a slow link', () => {
  test('a late capabilities answer still runs the command in PTY', async ({ page }) => {
    const link = { down: false, delayMs: 3000 };
    await mockCapabilities(page, link);
    const inputs = await mockPty(page);

    await openCommands(page);
    await commandRow(page).locator('.command-item-action').click();

    await expect.poll(() => inputs.join(''), { timeout: 20_000 }).toContain('xkeen -i\r');
    await expect(page.locator('#toast-container .toast')).toHaveCount(0);
  });

  test('a failed probe is not remembered as "no PTY"', async ({ page }) => {
    const link = { down: true, delayMs: 0 };
    await mockCapabilities(page, link);
    const inputs = await mockPty(page);

    await openCommands(page);
    const row = commandRow(page);
    await row.locator('.command-item-action').click();
    await expect(row).not.toHaveAttribute('aria-busy', 'true', { timeout: 25_000 });
    expect(inputs.join('')).toBe('');

    // The link is back: the very next press must reach PTY.
    link.down = false;
    const close = page.locator('#terminal-btn-close');
    if (await close.isVisible()) await close.click();
    await expect(page.locator('#terminal-overlay')).toBeHidden();

    await row.locator('.command-item-action').click();
    await expect.poll(() => inputs.join(''), { timeout: 20_000 }).toContain('xkeen -i\r');
  });

  test('a press that lands before the command list has loaded still runs the command', async ({ page }) => {
    const link = { down: false, delayMs: 0 };
    await mockCapabilities(page, link);
    const inputs = await mockPty(page);

    // Hold the command list module back, as a slow link to the router does.
    // The press is then caught by the lazy-feature guard and replayed later.
    await page.route(/\/commands_list[-.][^/]*\.js(\?|$)/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      try { await route.continue(); } catch (error) {}
    });

    await openCommands(page);
    await commandRow(page).locator('.command-item-action').click();

    await expect.poll(() => inputs.join(''), { timeout: 20_000 }).toContain('xkeen -i\r');
  });

  test('a refused WebSocket is reported as a connection problem', async ({ page }) => {
    test.setTimeout(45_000);
    const link = { down: false, delayMs: 0 };
    await mockCapabilities(page, link);
    await mockPty(page, { refuse: true });

    await openCommands(page);
    await commandRow(page).locator('.command-item-action').click();

    const toast = page.locator('#toast-container .toast');
    await expect(toast).toContainText('WebSocket-соединение с роутером не устанавливается', { timeout: 25_000 });
    await expect(toast).toContainText('Команда не выполнена');
  });
});
