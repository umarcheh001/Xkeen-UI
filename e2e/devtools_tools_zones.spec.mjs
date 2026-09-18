import { test, expect } from './fixtures.mjs';


async function openTools(page, viewport) {
  await page.setViewportSize(viewport);
  await page.goto('/devtools');
  await expect(page.locator('body')).toHaveClass(/\bdevtools-page\b/);
  await expect(page.locator('#dt-env-card')).toBeVisible();
}


test.describe('DevTools Tools zones', () => {
  test('cards are laid out in three zones without horizontal scroll', async ({ page }) => {
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

    // Вместо простыни update.log в карточке стоит одна строка вердикта.
    const logBox = page.locator('#dt-update-log-box');
    await expect(logBox).toBeVisible();
    await expect(logBox.locator('.dt-update-log-head')).toHaveText('Лог обновлений');
    await expect(page.locator('#dt-update-card pre')).toHaveCount(0);

    const verdict = await page.evaluate(() => {
      const bottom = (id) => document.getElementById(id).getBoundingClientRect().bottom;
      const box = document.getElementById('dt-update-log-verdict');
      const openBtn = document.getElementById('dt-update-log-open');
      return {
        state: box.getAttribute('data-verdict'),
        text: document.getElementById('dt-update-log-verdict-text').textContent.trim(),
        openBtnVisible: !!(openBtn && openBtn.offsetParent !== null),
        boxBottom: box.getBoundingClientRect().bottom,
        cardBottom: bottom('dt-update-card'),
      };
    });

    // На чистом стенде обновлений не было: строка спокойная, кнопка в Logs спрятана.
    expect(['empty', 'clean']).toContain(verdict.state);
    expect(verdict.openBtnVisible).toBe(false);
    expect(verdict.boxBottom).toBeLessThanOrEqual(verdict.cardBottom + 2);
  });

  test('update log verdict offers the full log only when something went wrong', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    // Ошибку рисует тот же путь, что и живой статус: состояние операции + хвост лога.
    await page.evaluate(() => {
      const box = document.getElementById('dt-update-log-verdict');
      box.setAttribute('data-verdict', 'failed');
      document.getElementById('dt-update-log-verdict-text').textContent =
        'Во время обновлений обнаружены ошибки';
      document.getElementById('dt-update-log-open').style.display = '';
    });

    await page.locator('#dt-update-log-open').click();
    await expect(page.locator('#dt-tab-logs')).toBeVisible();
    await expect(page.locator('#dt-tab-btn-logs')).toHaveAttribute('aria-selected', 'true');
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

    // Восемь вкладок ложатся в четыре ряда по два, пять переключателей — в три.
    expect(wide.items).toBe(8);
    expect(wide.rows).toBe(4);
    expect(wide.switches).toBe(5);
    expect(wide.switchRows).toBe(3);
    // «Reset tabs» — компактная кнопка, а не полоса во всю карточку.
    expect(wide.resetShare).toBeLessThan(0.2);

    await page.setViewportSize({ width: 900, height: 1000 });
    const narrowRows = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#dt-layout-tab-list .dt-tab-item')];
      return new Set(items.map((el) => Math.round(el.getBoundingClientRect().top))).size;
    });
    expect(narrowRows).toBe(8);
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

  test('top row halves end on the same line with the log right under the status', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const row = await page.evaluate(() => {
      const b = (s) => document.querySelector(s).getBoundingClientRect();
      return {
        updateBottom: b('#dt-update-card').bottom,
        envBottom: b('#dt-env-card').bottom,
        logTop: b('.dt-update-log-summary').top,
        logBottom: b('.dt-update-log-summary').bottom,
        substatusBottom: b('#dt-update-substatus').bottom,
        verdictRowBottom: b('.dt-update-verdict-row').bottom,
        autocheckTop: b('.dt-update-autocheck-row').top,
      };
    });

    // Обе половины ряда кончаются вместе...
    expect(Math.abs(row.updateBottom - row.envBottom)).toBeLessThanOrEqual(2);
    // ...а строка итога по логу стоит сразу под статусом, а не у нижнего края.
    expect(row.logTop - row.substatusBottom).toBeLessThanOrEqual(12);

    // Блок лога обрамлён одинаково: сверху — столько же, сколько снизу до края карточки.
    const above = row.logTop - row.substatusBottom;
    const below = row.updateBottom - row.logBottom;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(2);

    // Свободная высота растянутой карточки собирается над блоком автопроверки,
    // поэтому зазор под вердиктом заметно больше зазора вокруг блока лога.
    expect(row.autocheckTop - row.verdictRowBottom).toBeGreaterThan(below);
  });

  test('the update verdict pill is roomy enough to read', async ({ page }) => {
    await openTools(page, { width: 1600, height: 1000 });

    const pill = await page.evaluate(() => {
      const el = document.getElementById('dt-update-verdict');
      const cs = getComputedStyle(el);
      return {
        padTop: parseFloat(cs.paddingTop),
        padBottom: parseFloat(cs.paddingBottom),
        fontSize: parseFloat(cs.fontSize),
        height: el.getBoundingClientRect().height,
        switchHeight: document
          .querySelector('.dt-update-autocheck-row .dt-switch')
          .getBoundingClientRect().height,
      };
    });

    // Поля вокруг текста одинаковые сверху и снизу...
    expect(pill.padTop).toBe(pill.padBottom);
    // ...кегль не мельче остального текста карточки...
    expect(pill.fontSize).toBeGreaterThanOrEqual(12);
    // ...и пилюля не ниже переключателя рядом: строки идут одним ритмом.
    expect(pill.height).toBeGreaterThanOrEqual(pill.switchHeight);
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

    await card.locator('summary').click();
    await expect(card).toHaveAttribute('open', /.*/);

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
