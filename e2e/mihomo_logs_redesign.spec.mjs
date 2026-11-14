import { test, expect, selectPanelView } from "./fixtures.mjs";

async function open(page, groups = [], globalGroup = null, start = true) {
  await page.addInitScript(() => {
    localStorage.setItem("xkeen-theme", "dark");
    window.__logs = [];
    class Socket {
      constructor(url) {
        this.url = url;
        window.__logs.push(this);
        setTimeout(() => this.onopen?.({}), 0);
      }
      close() {
        this.closed = true;
      }
      emit(payload) {
        this.onmessage?.({
          data: JSON.stringify({
            type: "mihomo-clash-logs",
            schema_version: 1,
            state: "live",
            payload,
          }),
        });
      }
    }
    window.WebSocket = Socket;
    window.__clipboard = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.__clipboard = text;
        },
      },
    });
  });
  await page.route("**/api/mihomo/clash/status", (r) =>
    r.fulfill({
      json: {
        ok: true,
        state: "ready",
        runtime: { mode: "rule" },
        capabilities: { status: true, logs: true, logs_stream: true },
      },
    }),
  );
  await page.route("**/api/mihomo/clash/proxy-groups", async (r) => {
    if(groups.length)await new Promise(resolve=>setTimeout(resolve,1000));
    return r.fulfill({json:{ok:true,groups,global_group:globalGroup}});
  });
  await page.route("**/api/ws-token", (r) =>
    r.fulfill({ json: { ok: true, token: "mock" } }),
  );
  await page.goto("/");
  await selectPanelView(page, "mihomo");
  await page.locator("#mihomo-clash-tab-logs").click();
  if (!start) return;
  await page.locator("#mihomo-clash-logs-play").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__logs.filter((s) => s.url.includes("/logs") && !s.closed)
            .length,
      ),
    )
    .toBe(1);
}
const emit = async (page, items) =>
  page.evaluate((items) => {
    const s = window.__logs
      .filter((s) => s.url.includes("/logs") && !s.closed)
      .at(-1);
    for (const item of items) s.emit(item);
  }, items);
const dto = (n, route = "Google[PL [PL] Warsaw]") => ({
  sequence: n,
  time: "13:21:42",
  level: "info",
  message: `[TCP] 192.168.10.13:${40000 + n} --> host${n}.test:443 match RuleSet(google@domain) using ${route}`,
  devices: [{ ip: "192.168.10.13", name: "Телефон" }],
});

test('logs wait for Play on opening, returning and reloading', async ({ page }) => {
  let tokenRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/api/ws-token') && request.postDataJSON()?.scope === 'mihomo-clash-logs') tokenRequests += 1;
  });
  await open(page, [], null, false);
  const play = page.locator('#mihomo-clash-logs-play');
  const state = page.locator('#mihomo-clash-logs-state');
  const sockets = () => page.evaluate(() => window.__logs.filter(s => s.url.includes('/logs') && !s.closed).length);
  await expect(play).toBeVisible();
  await expect(state).toHaveText('Остановлено');
  expect(await sockets()).toBe(0);
  expect(tokenRequests).toBe(0);

  await play.click();
  await expect.poll(sockets).toBe(1);
  await emit(page, [dto(1)]);
  await expect(page.locator('#mihomo-clash-logs-list .tr')).toHaveCount(1);
  await page.locator('#mihomo-clash-tab-control').click();
  await expect.poll(sockets).toBe(0);
  await page.locator('#mihomo-clash-tab-logs').click();
  await expect(play).toBeVisible();
  await expect(state).toHaveText('Остановлено');
  await expect(page.locator('#mihomo-clash-logs-list .tr')).toHaveCount(1);
  expect(await sockets()).toBe(0);
  expect(tokenRequests).toBe(1);

  await play.click();
  await expect.poll(sockets).toBe(1);
  await page.locator('#mihomo-clash-logs-stop').click();
  await page.locator('#mihomo-clash-tab-control').click();
  await page.locator('#mihomo-clash-tab-logs').click();
  await expect(state).toHaveText('Остановлено');
  expect(await sockets()).toBe(0);
  expect(tokenRequests).toBe(2);

  await page.reload();
  await selectPanelView(page, 'mihomo');
  await page.locator('#mihomo-clash-tab-logs').click();
  await expect(play).toBeVisible();
  await expect(state).toHaveText('Остановлено');
  expect(await sockets()).toBe(0);
  expect(tokenRequests).toBe(2);
});

test('review layout keeps light labels and centered controls with compact details',async({page})=>{
  await open(page);
  await emit(page,[dto(1),dto(2,'DIRECT'),dto(3,'REJECT')]);
  await page.locator('[data-mlog-summary-toggle]').click();
  const legend=page.locator('#mihomo-log-summary .xk-xlog-legend b').first();
  await expect(legend).toBeVisible();
  expect.soft(await legend.evaluate(el=>getComputedStyle(el).color)).toBe(await legend.evaluate(el=>{
    const probe=document.createElement('span');probe.style.color='var(--op-text-strong)';el.append(probe);
    const color=getComputedStyle(probe).color;probe.remove();return color;
  }));
  const table=page.locator('#mihomo-clash-logs-list');
  const geometry=await table.evaluate(host=>{
    const root=host.shadowRoot,row=root.querySelector('.tr');
    const box=el=>el.getBoundingClientRect();
    const check=box(row.querySelector('.check')), headerCheck=box(root.querySelector('.header .check'));
    const arrow=row.querySelector('.chev'), arrowBox=box(arrow), rowBox=box(row);
    return {checkWidth:check.width,checkHeight:check.height,checkX:check.x+check.width/2,
      headerX:headerCheck.x+headerCheck.width/2,arrowWidth:arrowBox.width,arrowHeight:arrowBox.height,
      arrowCenter:arrowBox.y+arrowBox.height/2,rowCenter:rowBox.y+rowBox.height/2,
      svg:!!arrow.querySelector('svg')};
  });
  expect.soft(geometry.checkWidth).toBe(14);expect.soft(geometry.checkHeight).toBe(14);
  expect.soft(geometry.checkX).toBeCloseTo(geometry.headerX,0);
  expect.soft(geometry.arrowWidth).toBe(22);expect.soft(geometry.arrowHeight).toBe(22);
  expect.soft(Math.abs(geometry.arrowCenter-geometry.rowCenter)).toBeLessThan(1);
  expect.soft(geometry.svg).toBe(true);
  await table.locator('[data-action="detail"]').first().click();
  await expect(table.locator('.detail .acts button')).toHaveCount(3);
  const detail=await table.locator('.detail').evaluate(el=>{
    const raw=el.querySelector('pre'),actions=el.querySelector('.acts');
    return {height:el.offsetHeight,border:getComputedStyle(raw).borderTopStyle,
      gap:actions.getBoundingClientRect().top-raw.getBoundingClientRect().bottom,
      bottom:el.getBoundingClientRect().bottom-actions.getBoundingClientRect().bottom};
  });
  expect(detail.height).toBeLessThan(180);expect(detail.border).toBe('dashed');
  expect(detail.gap).toBeGreaterThan(0);expect(detail.bottom).toBeLessThan(20);
});

test('expanded detail resizes with wrapped raw text without covering the next row',async({page})=>{
  await open(page);
  const item=dto(1);item.message+=' '+('long-raw-text '.repeat(60));
  await emit(page,[item,dto(2)]);
  const table=page.locator('#mihomo-clash-logs-list');
  await table.locator('[data-id="2"] [data-action="detail"]').click();
  await expect(table.locator('.detail .acts')).toBeVisible();
  await page.setViewportSize({width:650,height:1000});
  await expect.poll(()=>table.evaluate(host=>{
    const root=host.shadowRoot,detail=root.querySelector('.detail'),next=root.querySelector('[data-id="1"]');
    return Math.abs(detail.getBoundingClientRect().bottom-next.getBoundingClientRect().top);
  })).toBeLessThan(1);
  await table.locator('[data-id="1"] [data-action="detail"]').click();
  await expect(table.locator('.detail pre')).toHaveText(item.message);
  expect(await table.locator('.detail').evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThanOrEqual(1);
});

test('group icon is retained alongside route and country',async({page})=>{
 await page.route('**/group-icon.svg',r=>r.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="6"/></svg>'}));
 await open(page,[{name:'Google',icon:'/group-icon.svg',nodes:[]}]);await emit(page,[dto(1)]);
 await expect(page.locator('#mihomo-clash-logs-list .route-icon')).toHaveAttribute('src','/group-icon.svg');
});

test('alt click on a direct route filters by route rather than a proxy node',async({page})=>{
 await open(page);await emit(page,[dto(1),dto(2,'DIRECT'),dto(3,'REJECT')]);
 const table=page.locator('#mihomo-clash-logs-list');await expect(table.locator('.tr')).toHaveCount(3);
 await table.locator('.tr.direct [data-field="node"]').click({modifiers:['Alt']});
 await expect(table.locator('.tr')).toHaveCount(1);await expect(table.locator('.tr')).toContainText('host2.test');
});

test("table renders routes rules flags protocols and original copy", async ({
  page,
}) => {
  await open(page);
  const rows = [dto(1), dto(2, "DIRECT"), dto(3, "REJECT")];
  await emit(page, rows);
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(table.locator(".tr")).toHaveCount(3);
  await expect(table).toContainText("Через прокси");
  await expect(table).toContainText("Напрямую");
  await expect(table).toContainText("Заблокировано");
  await expect(table).toContainText("443/tcp");
  await expect(table).toContainText("RuleSet(google@domain)");
  await expect(table.locator(".flag svg")).toHaveCount(1);
  await table.locator('[data-id="1"] [data-action="detail"]').click();
  await expect(table.locator(".detail")).toContainText(rows[0].message);
  await table.locator('[data-action="copy-raw"]').click();
  await expect
    .poll(() => page.evaluate(() => window.__clipboard))
    .toBe(rows[0].message);
  await page.locator("[data-mlog-summary-toggle]").click();
  await expect(page.locator("#mihomo-log-summary .xk-xlog-tile")).toHaveCount(
    4,
  );
  await expect(page.locator("#mihomo-log-chips")).toContainText("DNS");
  await page.screenshot({path:'../../mihomo-implemented.png',fullPage:true});
  const fits=await page.evaluate(()=>document.querySelector('#mihomo-clash-logs').getBoundingClientRect().bottom>=document.querySelector('#mihomo-log-stats').getBoundingClientRect().bottom);
  expect(fits).toBe(true);
});

test("pause buffer selection and stop preserve core configuration", async ({
  page,
}) => {
  await open(page);
  await emit(page, [dto(1)]);
  await expect(page.locator("#mihomo-clash-logs-list .tr")).toHaveCount(1);
  await page.locator("#mihomo-clash-logs-pause").click();
  await emit(
    page,
    Array.from({ length: 502 }, (_, i) => dto(i + 2)),
  );
  await expect(page.locator("#mihomo-clash-logs-list .tr")).toHaveCount(1);
  await expect(page.locator("#mihomo-clash-logs-state")).toContainText("Пауза");
  await page.locator("#mihomo-clash-logs-pause").click();
  await expect(page.locator("#mihomo-log-stats")).toContainText("500");
  expect(
    await page.locator("#mihomo-clash-logs-list .tr").count(),
  ).toBeLessThan(100);
  await page.locator("#mihomo-clash-logs-pause").click();
  await page.locator("#mihomo-clash-logs-stop").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__logs.filter((s) => s.url.includes("/logs") && !s.closed)
            .length,
      ),
    )
    .toBe(0);
  await expect(page.locator("#mihomo-clash-logs-state")).toContainText(
    "Остановлено",
  );
});

test("dns filter system errors html escaping and local filters", async ({
  page,
}) => {
  await open(page);
  await emit(page, [
    dto(1),
    {
      time: "13:00:00",
      level: "debug",
      message: "[DNS] cache hit example.org --> [1.1.1.1]",
    },
    { level: "error", message: "<img src=x onerror=alert(1)> failure" },
  ]);
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(table.locator(".tr")).toHaveCount(2);
  await expect(table.locator("img")).toHaveCount(0);
  await expect(table).toContainText("<img");
  await page
    .locator('#mihomo-log-chips [data-filter="kind"][data-value="dns"]')
    .click();
  await expect(table.locator(".tr")).toHaveCount(3);
  await page.locator("#mihomo-clash-logs-filter").fill("host1");
  await expect(table.locator(".tr")).toHaveCount(1);
});

test("selection keyboard order and view cleanup", async ({ page }) => {
  await open(page);
  await emit(page, [dto(1), dto(2)]);
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(table.locator(".tr")).toHaveCount(2);
  await table.focus();
  await table.press("Control+a");
  await table.press("Control+c");
  await expect
    .poll(() => page.evaluate(() => window.__clipboard))
    .toContain(dto(1).message);
  await page.locator("#mihomo-clash-logs-order").click();
  await expect(table.locator(".tr").first()).toContainText("host1.test");
  await selectPanelView(page, "xkeen");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__logs.filter((s) => s.url.includes("/logs") && !s.closed)
            .length,
      ),
    )
    .toBe(0);
});

test("away from new rows counts events and preserves reading position", async ({
  page,
}) => {
  await open(page);
  await emit(
    page,
    Array.from({ length: 120 }, (_, i) => dto(i)),
  );
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(page.locator("#mihomo-log-stats")).toContainText("120");
  await table.evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
  });
  const before = await table.locator(".tr").first().getAttribute("data-id");
  await emit(page, [dto(130)]);
  await expect(page.locator("[data-mlog-new]")).toContainText("1");
  await expect(table.locator(".tr").first()).toHaveAttribute("data-id", before);
  await page.locator("[data-mlog-new]").click();
  await expect(table.locator(".tr").first()).toContainText("host130.test");
});

test("reading below an expanded row keeps its place when a new event arrives", async ({
  page,
}) => {
  await open(page);
  await emit(
    page,
    Array.from({ length: 120 }, (_, i) => dto(i)),
  );
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(page.locator("#mihomo-log-stats")).toContainText("120");
  await table.locator('[data-id="120"] [data-action="detail"]').click();
  await expect(table.locator(".detail")).toBeVisible();
  await table.evaluate((el) => {
    el.scrollTop = 600;
    el.dispatchEvent(new Event("scroll"));
  });
  await emit(page, [dto(130)]);
  await expect(page.locator("[data-mlog-new]")).toContainText("1");
  // The expanded row adds DETAIL above the eye: the anchor row and its offset
  // are measured on the old geometry and restored on the new one.
  expect(await table.evaluate((el) => el.scrollTop)).toBe(632);
});

test("global group icon is used when a route names GLOBAL", async ({ page }) => {
  await page.route("**/global-icon.svg", (r) =>
    r.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><rect width="14" height="14"/></svg>',
    }),
  );
  await open(page, [], {
    name: "GLOBAL",
    icon: "/global-icon.svg",
    nodes: [],
  });
  await emit(page, [dto(1, "GLOBAL")]);
  await expect(page.locator("#mihomo-clash-logs-list .route-icon")).toHaveAttribute(
    "src",
    "/global-icon.svg",
  );
});

test("filter buttons survive counter updates under the pointer", async ({
  page,
}) => {
  await open(page);
  await emit(page, Array.from({ length: 4 }, (_, i) => dto(i + 1)));
  await page.locator("[data-mlog-summary-toggle]").click();
  const ids = await page.evaluate(() => {
    const box = document.querySelector("#mihomo-log-chips");
    const chip = box.querySelector('[data-filter="kind"][data-value="direct"]');
    window.__chipButton = chip;
    window.__summaryButton = document
      .querySelector("#mihomo-log-summary")
      .querySelector(".xk-xlog-top button");
    return [!!chip, !!window.__summaryButton];
  });
  expect(ids).toEqual([true, true]);
  // Hold the pointer down on a filter while counters update. The stats pass
  // runs once a second, so a plain re-render would replace the pressed button
  // and the click would never reach the panel.
  const chipBox = await page
    .locator('#mihomo-log-chips [data-filter="kind"][data-value="direct"]')
    .boundingBox();
  await page.mouse.move(
    chipBox.x + chipBox.width / 2,
    chipBox.y + chipBox.height / 2,
  );
  await page.mouse.down();
  await emit(page, Array.from({ length: 6 }, (_, i) => dto(i + 10)));
  await expect(page.locator("#mihomo-log-stats")).toContainText("10");
  await page.waitForTimeout(1400);
  await page.mouse.up();
  // "Напрямую" is on by default, so a click that reaches the panel turns it
  // off; a click swallowed by a replaced button would leave it on.
  await expect(
    page.locator('#mihomo-log-chips [data-filter="kind"][data-value="direct"]'),
  ).toHaveAttribute("aria-pressed", "false");
  expect(
    await page.evaluate(
      () =>
        window.__chipButton ===
          document.querySelector("#mihomo-log-chips")
            .querySelector('[data-filter="kind"][data-value="direct"]') &&
        window.__summaryButton ===
          document
            .querySelector("#mihomo-log-summary")
            .querySelector(".xk-xlog-top button"),
    ),
  ).toBe(true);
});

test("a rating button keeps keyboard focus while counters update", async ({
  page,
}) => {
  await open(page);
  await emit(page, Array.from({ length: 4 }, (_, i) => dto(i + 1)));
  await page.locator("[data-mlog-summary-toggle]").click();
  await page.locator("#mihomo-log-summary .xk-xlog-top button").first().focus();
  await emit(page, Array.from({ length: 6 }, (_, i) => dto(i + 10)));
  await expect(page.locator("#mihomo-log-stats")).toContainText("10");
  await page.waitForTimeout(1400);
  expect(
    await page.evaluate(
      () =>
        document.activeElement ===
        document.querySelector("#mihomo-log-summary .xk-xlog-top button"),
    ),
  ).toBe(true);
});

test("a single click on the row checkbox toggles that row", async ({ page }) => {
  await open(page);
  await emit(page, [dto(1), dto(2)]);
  const table = page.locator("#mihomo-clash-logs-list");
  await expect(table.locator(".tr")).toHaveCount(2);
  const first = table.locator('[data-id="2"] [data-action="select"]');
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "true");
  await first.click();
  await expect(first).toHaveAttribute("aria-checked", "false");
  await expect(page.locator("#mihomo-log-selection")).toBeHidden();
});

test("Escape leaves fullscreen and reports it to assistive technology", async ({
  page,
}) => {
  await open(page);
  await page.locator("#mihomo-log-fullscreen").click();
  await expect(page.locator("#mihomo-log-fullscreen")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#mihomo-clash-logs-filter").press("Escape");
  await expect(page.locator("#mihomo-clash-logs")).not.toHaveClass(
    /is-fullscreen/,
  );
  await expect(page.locator("#mihomo-log-fullscreen")).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("debug expiry reconnects at info and only one stream stays active", async ({
  page,
}) => {
  await open(page);
  await page.locator("#mihomo-clash-logs details").click();
  await page.locator("#mihomo-clash-logs-level").selectOption("debug");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__logs
            .filter((s) => s.url.includes("/logs") && !s.closed)
            .at(-1)?.url,
      ),
    )
    .toContain("level=debug");
  await page.evaluate(() => {
    const s = window.__logs
      .filter((s) => s.url.includes("/logs") && !s.closed)
      .at(-1);
    s.onmessage({
      data: JSON.stringify({
        type: "mihomo-clash-logs",
        schema_version: 1,
        state: "ended",
        payload: { reason: "debug_window_expired" },
      }),
    });
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__logs
            .filter((s) => s.url.includes("/logs") && !s.closed)
            .at(-1)?.url,
      ),
    )
    .toContain("level=info");
  expect(
    await page.evaluate(
      () =>
        window.__logs.filter((s) => s.url.includes("/logs") && !s.closed)
          .length,
    ),
  ).toBe(1);
});

test("mobile layout stays within viewport and hidden reactivation shows rows", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await emit(page, [dto(1), dto(2, "REJECT")]);
  await expect(page.locator("#mihomo-clash-logs-list .tr")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.locator("#mihomo-clash-tab-control").click();
  await page.locator("#mihomo-clash-tab-logs").click();
  await expect(
    page.locator("#mihomo-clash-logs-list .tr").first(),
  ).toBeVisible();
});

test("detail buttons keep identity while records arrive", async ({ page }) => {
  await open(page);
  await emit(page, [dto(1)]);
  await page.locator('#mihomo-clash-logs-list [data-action="detail"]').click();
  await page.evaluate(() => {
    window.__copyButton = document
      .querySelector("#mihomo-clash-logs-list")
      .shadowRoot.querySelector('[data-action="copy-raw"]');
  });
  await emit(page, [dto(2)]);
  await expect(page.locator("#mihomo-log-stats")).toContainText("2");
  expect(
    await page.evaluate(
      () =>
        window.__copyButton ===
        document
          .querySelector("#mihomo-clash-logs-list")
          .shadowRoot.querySelector('[data-action="copy-raw"]'),
    ),
  ).toBe(true);
});

test("bounded DOM and responsive controls at 50 events per second @perf", async ({
  page,
}) => {
  await open(page);
  await emit(
    page,
    Array.from({ length: 500 }, (_, i) => dto(i)),
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.evaluate(() => {
    window.__long = [];
    window.__observer = new PerformanceObserver((list) =>
      window.__long.push(...list.getEntries().map((e) => e.duration)),
    );
    window.__observer.observe({ entryTypes: ["longtask"] });
    window.__load = setInterval(() => {
      const s = window.__logs
        .filter((s) => s.url.includes("/logs") && !s.closed)
        .at(-1);
      s?.emit({
        time: "14:00:00",
        level: "info",
        message: "[TCP] 192.168.10.13:53535 --> load.test:443 using DIRECT",
      });
    }, 20);
  });
  await page.waitForTimeout(5000);
  await page.locator("#mihomo-clash-logs-pause").click();
  await expect(page.locator("#mihomo-clash-logs-pause")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const result = await page.evaluate(() => {
    clearInterval(window.__load);
    window.__observer.disconnect();
    return {
      max: Math.max(0, ...window.__long),
      long: window.__long.length,
      rows: document
        .querySelector("#mihomo-clash-logs-list")
        .shadowRoot.querySelectorAll(".tr").length,
    };
  });
  console.log("Mihomo perf", JSON.stringify(result));
  expect(result.rows).toBeLessThan(100);
  expect(result.max).toBeLessThan(250);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
});
