import { test, expect } from './fixtures.mjs';


async function openTools(page, viewport) {
  await page.setViewportSize(viewport);
  await page.route('**/api/devtools/update/info', (route) => route.fulfill({ json: {
    ok: true,
    build: { version: '2.10.0', repo: 'umarcheh001/Xkeen-UI', channel: 'main', commit: 'abc1234' },
    capabilities: { curl: true, tar: true, tar_exclude: true, sha256sum: true },
    settings: { repo: 'umarcheh001/Xkeen-UI', channel: 'main', branch: 'main' },
    security: {},
  } }));
  await page.route('**/api/devtools/update/status*', (route) => route.fulfill({ json: {
    ok: true, status: { state: 'idle' }, log_tail: [],
    lock: { exists: false, alive: false, stale: false }, backups: [], has_backup: false,
    reconciled: false, development_only: true,
  } }));
  await page.route('**/api/devtools/update/check', (route) => route.fulfill({ json: {
    ok: true, error: null, repo: 'umarcheh001/Xkeen-UI', channel: 'main', branch: 'main',
    current: { version: '2.10.0', repo: 'umarcheh001/Xkeen-UI', channel: 'main', commit: 'abc1234' },
    latest: { kind: 'main', branch: 'main', sha: 'abc1234', short_sha: 'abc1234',
      tarball_url: 'https://example.test/main.tar.gz' },
    update_available: false, stale: false, meta: null,
    security: { settings: {}, download: { url: 'https://example.test/main.tar.gz', ok: true, reason: null },
      checksum: null, warnings: [], will_block_run: false }, development_only: true,
  } }));
  await page.route('**/api/modules/installed', (route) => route.fulfill({ json: {
    ok: true,
    profile: 'full',
    modules: [
      { id: 'core', name: 'Xkeen UI Core', version: '1.0.0', enabled: true },
      { id: 'engine.xray', name: 'Xray', version: '1.0.0', enabled: true },
    ],
  } }));
  const envLoaded = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/devtools/env');
  const updateLoaded = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/devtools/update/info');
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
  // Видимой разметки мало: пока инициализация DevTools не дошла до карточек,
  // клик по ним проваливается впустую, и на загруженной машине тест падает на
  // ровном месте. Атрибут data-xk-collapsible-wired ставит сама панель, когда
  // карточки уже связаны с обработчиками (static/js/ui/shared_primitives.js).
  await expect(page.locator('#dt-terminal-theme-card')).toHaveAttribute(
    'data-xk-collapsible-wired',
    '1',
  );
  await Promise.all([envLoaded, updateLoaded]);
  await waitForToolsToSettle(page);
}

// Проводка обработчиков ещё не значит, что карточки доросли: «Сервис»,
// «Обновление» и список ENV догружают данные и прибавляют в высоте ещё
// до полусекунды (замер 25.09.2026: ENV 806 → 851 → 930 px при неизменном
// окне). Замер до этого момента выдаёт рост от загрузки за рост от окна —
// так сторож «высокого окна» падал на ровном месте с разницей в 45 px.
// Ждём, пока высоты карточек ряда простоят без изменений заметное время.
async function waitForToolsToSettle(page) {
  const heights = () => page.evaluate(() => (
    ['#dt-service-card', '#dt-update-card', '#dt-env-card']
      .map((s) => Math.round(document.querySelector(s)?.getBoundingClientRect().height || 0))
      .join(',')
  ));
  const stableForMs = 800;
  const deadline = Date.now() + 10000;
  let last = await heights();
  let stableSince = Date.now();
  while (Date.now() - stableSince < stableForMs) {
    if (Date.now() > deadline) throw new Error(`Карточки вкладки Tools не перестали расти: ${last}`);
    await page.waitForTimeout(100);
    const next = await heights();
    if (next !== last) {
      last = next;
      stableSince = Date.now();
    }
  }
}


test.describe('DevTools Tools zones', () => {
  test('cards are laid out in three zones without horizontal scroll', async ({ page }) => {
    // Проверка ниже про «чистый стенд», а сервер у e2e общий: smoke в том же
    // прогоне жмёт «Обновить панель», и на Windows запуск падает с
    // spawn_failed. Раньше тест успевал прочитать вердикт до ответа статуса и
    // этого не видел; теперь он дожидается загрузки, поэтому статус подменяем.
    await page.route('**/api/devtools/update/status*', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        status: { state: 'idle' },
        log_tail: [],
        lock: { exists: false, alive: false, stale: false },
        backups: [],
        has_backup: false,
      }),
    }));
    await openTools(page, { width: 1600, height: 1000 });

    const heads = page.locator('#dt-tab-tools .dt-zone-head');
    await expect(heads).toHaveCount(3);
    await expect(heads.nth(0)).toHaveText('Сервис, обновление и настройки');
    await expect(heads.nth(1)).toHaveText('Система');
    await expect(heads.nth(2)).toHaveText('Вид интерфейса');

    const geometry = await page.evaluate(() => {
      const zoneLabel = (id) => document.getElementById(id).closest('.dt-zone')?.getAttribute('aria-label') || '';
      const bottom = (id) => document.getElementById(id).getBoundingClientRect().bottom;
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        happZone: zoneLabel('dt-happ-decryptor-card'),
        terminalZone: zoneLabel('dt-terminal-theme-card'),
        brandingZone: zoneLabel('dt-branding-card'),
        layoutZone: zoneLabel('dt-layout-card'),
        trayBottom: document.querySelector('.dt-tools-left').getBoundingClientRect().bottom,
        envBottom: bottom('dt-env-card'),
        prefsBottom: bottom('dt-ui-prefs-card'),
        ioBottom: bottom('dt-ui-prefs-io-card'),
      };
    });

    expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
    expect(geometry.happZone).toBe('Система');
    expect(geometry.terminalZone).toBe('Система');
    expect(geometry.brandingZone).toBe('Вид интерфейса');
    expect(geometry.layoutZone).toBe('Вид интерфейса');
    expect(Math.abs(geometry.trayBottom - geometry.envBottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.prefsBottom - geometry.ioBottom)).toBeLessThanOrEqual(2);

    // Карточка обновления стала информационной: сведения о панели и модулях,
    // а команды обновления живут в разделе «Модули и обновления».
    await expect(page.locator('#dt-update-card')).toContainText('Xkeen UI Core');
    await expect(page.locator('#dt-panel-profile')).toHaveText('full');
    await expect(page.locator('#dt-panel-modules')).toContainText('Xray 1.0.0');
    await expect(page.locator('#dt-update-card pre:visible')).toHaveCount(0);
    await expect(page.locator('#dt-update-log-box')).toHaveCount(0);
    await expect(page.locator('#dt-update-check')).toHaveCount(0);
  });

  test('only the header links to the modules manager', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const links = page.getByRole('link', { name: 'Модули и обновления', exact: true });
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', /\/modules$/);
    await expect(page.locator('[data-dt-modules-manager-notice]')).toHaveCount(0);
  });

  test('button rows keep the same gap as the card padding', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const branding = await page.evaluate(() => {
      const card = document.getElementById('dt-branding-card');
      const row = card.querySelector('.dt-logging-actions');
      const buttons = [...row.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
      const box = card.getBoundingClientRect();
      return {
        rightInset: box.right - buttons[buttons.length - 1].right,
        between: buttons[1].left - buttons[0].right,
      };
    });

    // Зазор между Save и Reset равен отступу пары от края карточки.
    expect(Math.abs(branding.between - branding.rightInset)).toBeLessThanOrEqual(1);

    const service = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('.dt-service-actions button')]
        .map((b) => b.getBoundingClientRect());
      return {
        firstGap: buttons[1].left - buttons[0].right,
        secondGap: buttons[2].left - buttons[1].right,
      };
    });

    expect(service.firstGap).toBeGreaterThanOrEqual(10);
    expect(Math.abs(service.firstGap - service.secondGap)).toBeLessThanOrEqual(1);
  });

  test('every card keeps save and reset together on the right', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const terminal = page.locator('#dt-terminal-theme-card');
    await terminal.locator('summary').click();
    await expect(terminal).toHaveAttribute('open', /.*/);

    const rows = await page.evaluate(() => {
      const read = (id) => {
        const el = document.getElementById(id);
        const rect = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll('.dt-logging-actions button')]
          .map((b) => b.getBoundingClientRect());
        const width = buttons.reduce((sum, b) => sum + b.width, 0);
        return {
          count: buttons.length,
          sameRow: buttons.every((b) => Math.abs(b.top - buttons[0].top) <= 1),
          widthShare: width / rect.width,
          rightInset: rect.right - buttons[buttons.length - 1].right,
        };
      };
      return {
        terminal: read('dt-terminal-theme-card'),
        branding: read('dt-branding-card'),
        layout: read('dt-layout-card'),
        logging: read('dt-logging-card'),
        prefs: read('dt-ui-prefs-card'),
      };
    });

    // Одинаково во всех карточках: компактная группа у правого края.
    for (const key of ['terminal', 'branding', 'layout', 'logging', 'prefs']) {
      const row = rows[key];
      expect(row.count).toBeGreaterThanOrEqual(1);
      expect(row.sameRow).toBe(true);
      expect(row.widthShare).toBeLessThan(0.5);
      expect(row.rightInset).toBeLessThanOrEqual(16);
    }

    expect(rows.terminal.count).toBe(2);
    expect(rows.branding.count).toBe(2);
    expect(rows.layout.count).toBe(1);
  });

  test('layout tweaks show tabs in two columns', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const wide = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#dt-layout-tab-list .dt-tab-item')];
      const tops = new Set(items.map((el) => Math.round(el.getBoundingClientRect().top)));
      const switches = [...document.querySelectorAll('.dt-layout-switches .dt-switch')];
      const switchTops = new Set(switches.map((el) => Math.round(el.getBoundingClientRect().top)));
      const card = document.getElementById('dt-layout-card').getBoundingClientRect();
      const resetBtn = document.querySelector('#dt-layout-card .dt-logging-actions button')
        .getBoundingClientRect();
      return {
        items: items.length,
        rows: tops.size,
        switchRows: switchTops.size,
        switches: switches.length,
        resetShare: resetBtn.width / card.width,
      };
    });

    // Девять вкладок ложатся в пять рядов по два, пять переключателей — в три.
    expect(wide.items).toBe(9);
    expect(wide.rows).toBe(5);
    expect(wide.switches).toBe(5);
    expect(wide.switchRows).toBe(3);
    // «Reset tabs» — компактная кнопка, а не полоса во всю карточку.
    expect(wide.resetShare).toBeLessThan(0.2);

    await page.setViewportSize({ width: 900, height: 1000 });
    const narrowRows = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#dt-layout-tab-list .dt-tab-item')];
      return new Set(items.map((el) => Math.round(el.getBoundingClientRect().top))).size;
    });
    expect(narrowRows).toBe(9);
  });

  test('export card fills its height and layout columns start together', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const io = await page.evaluate(() => {
      const card = document.getElementById('dt-ui-prefs-io-card').getBoundingClientRect();
      const reset = document.querySelector('#dt-ui-prefs-io-card .dt-io-reset').getBoundingClientRect();
      const area = document.querySelector('#dt-ui-prefs-io-card .dt-codearea').getBoundingClientRect();
      const neighbour = document.getElementById('dt-ui-prefs-card').getBoundingClientRect();
      return {
        cardBottom: card.bottom,
        neighbourBottom: neighbour.bottom,
        gapUnderReset: card.bottom - reset.bottom,
        areaHeight: area.height,
      };
    });

    // Карточка по-прежнему вровень с соседней, но пустоты под подвалом больше нет:
    // высоту забирают поля ввода.
    expect(Math.abs(io.cardBottom - io.neighbourBottom)).toBeLessThanOrEqual(2);
    expect(io.gapUnderReset).toBeLessThanOrEqual(24);
    expect(io.areaHeight).toBeGreaterThan(120);

    const layout = await page.evaluate(() => {
      const heads = [...document.querySelectorAll('#dt-layout-card .dt-layout-col-head')]
        .map((el) => el.getBoundingClientRect().top);
      const bodies = [...document.querySelectorAll('#dt-layout-card .dt-layout-split > * > *:last-child')]
        .map((el) => el.getBoundingClientRect().top);
      return { heads, bodies };
    });

    expect(layout.heads).toHaveLength(2);
    expect(Math.abs(layout.heads[0] - layout.heads[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(layout.bodies[0] - layout.bodies[1])).toBeLessThanOrEqual(1);
  });

  test('top row halves end on the same line with the panel summary at the top', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const row = await page.evaluate(() => {
      const b = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        updateBottom: b('#dt-update-card').bottom,
        envBottom: b('#dt-env-card').bottom,
        updateBodyTop: b('#dt-update-card .dt-update-body').top,
        summaryTop: b('#dt-update-card .dt-panel-summary-grid').top,
        modulesTop: b('#dt-panel-modules').top,
      };
    });

    expect(Math.abs(row.updateBottom - row.envBottom)).toBeLessThanOrEqual(2);
    // Тело начинается после компактной 40px-шапки карточки; сводка идёт
    // сразу под ней, без промежуточного пустого блока.
    expect(row.summaryTop - row.updateBodyTop).toBeLessThanOrEqual(64);
    expect(row.modulesTop).toBeGreaterThan(row.summaryTop);
  });

  test('a taller ENV card stretches the informational card without moving its summary', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const measure = () =>
      page.evaluate(() => {
        const b = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          updateBottom: b('#dt-update-card').bottom,
          envBottom: b('#dt-env-card').bottom,
          summaryTop: b('#dt-update-card .dt-panel-summary-grid').top,
          modulesBottom: b('#dt-panel-modules').bottom,
        };
      });

    const short = await measure();
    await page.addStyleTag({ content: '#dt-env-card { min-height: 1200px !important; }' });
    const stretched = await measure();
    expect(Math.abs(stretched.updateBottom - stretched.envBottom)).toBeLessThanOrEqual(2);
    expect(Math.abs(stretched.summaryTop - short.summaryTop)).toBeLessThanOrEqual(1);
    expect(stretched.updateBottom - stretched.modulesBottom).toBeGreaterThan(100);
  });

  test('zones collapse to one column on a narrow screen', async ({ page }) => {
    await openTools(page, { width: 900, height: 900 });

    const columns = await page.evaluate(() => {
      const zone = document.querySelector('#dt-tab-tools .dt-zone');
      return getComputedStyle(zone).gridTemplateColumns.split(' ').length;
    });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );

    expect(columns).toBe(1);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('terminal theme card starts collapsed and remembers being opened', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const card = page.locator('#dt-terminal-theme-card');
    await expect(card).not.toHaveAttribute('open', /.*/);

    // Карточку перерисовывают уже после первой отрисовки страницы, и клик,
    // пришедший в этот момент, теряется вместе со старым узлом.
    await expect(async () => {
      await card.locator('summary').click();
      await expect(card).toHaveAttribute('open', /.*/, { timeout: 2000 });
    }).toPass({ timeout: 20000 });

    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).toHaveAttribute('open', /.*/);

    const stored = await page.evaluate(
      () => localStorage.getItem('xk.devtools.collapse.dt-terminal-theme-card.open'),
    );
    expect(stored).toBe('1');

    await page.locator('#dt-terminal-theme-card summary').click();
    await page.reload();
    await expect(page.locator('#dt-env-card')).toBeVisible();
    await expect(page.locator('#dt-terminal-theme-card')).not.toHaveAttribute('open', /.*/);
  });
});
