import { metricNumber, selectHistory, nearestPointIndex, resourceHealth, buildResourceSnapshot, collectionGap, historyGaps, gapAtTime, selectClients } from "./resource_monitor_model.js";

import { mountDashboardView } from "./resource_monitor/view.js";

const ENDPOINT = "/api/system/resources";
const SUMMARY_ENDPOINT = "/api/system/summary";
const HARDWARE_ENDPOINT = "/api/system/hardware";
const PROCESS_ENDPOINT = "/api/system/processes";
const CLIENTS_ENDPOINT = "/api/system/router/clients";
const LTE_ENDPOINT = "/api/system/router/lte";
const LTE_CONTROL_REQUEST_TIMEOUT_MS = 20000;
const CHANNEL_ENDPOINT = "/api/system/router/channel-check";
const DNS_DIAGNOSTICS_ENDPOINT = "/api/system/router/dns-diagnostics";
const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
const COLLAPSIBLE_PANEL_SELECTOR = "details.xk-collapsible-panel";
// Stage-one used MAX_HISTORY = 360; the expanded ring now retains 24h at the
// five-second cadence so the 1h/6h/24h controls have real history to show.
const MAX_HISTORY = 17280;

let timer = 0;
let request = null;
let initialized = false;
let history = [];
let rangeMinutes = 5;
let pollMs = POLL_MS;
let expectedPollSeconds = POLL_MS / 1000;
let telemetryStale = false;
let requestTimeout = 0;
let processRequest = null;
let processesLoaded = false;
let clientsRequest = null;
let clientsLoaded = false;
let clientsShowAll = false;
let latestClientsPayload = null;
let lteRequest = null;
const lteControls = new Map();
let channelRequest = null;
let interfaceFilter = "active";
let latestInterfaces = null;
let dnsGuidanceOpen = false;
let latestResourcePayload = null;
let dnsDiagnostics = null;
let dnsDiagnosticsRequest = null;
let dnsDiagnosticsLoaded = false;
const chartState = new Map();

function syncCollapsiblePanelState(panel) {
  if (!panel?.matches?.(COLLAPSIBLE_PANEL_SELECTOR)) return;
  const open = Boolean(panel.open);
  panel.classList.toggle("is-active", open);
  panel.setAttribute("aria-expanded", open ? "true" : "false");
}

function syncCollapsiblePanels(node) {
  if (!node) return;
  if (node.matches?.(COLLAPSIBLE_PANEL_SELECTOR)) {
    syncCollapsiblePanelState(node);
  }
  node.querySelectorAll?.(COLLAPSIBLE_PANEL_SELECTOR).forEach(
    syncCollapsiblePanelState,
  );
}

function bindCollapsiblePanelState() {
  // The panel screen may append dashboard sections after this module has
  // initialized. Delegate `toggle` from the document so late <details>
  // elements still keep their visual and ARIA state in sync.
  syncCollapsiblePanels(document);
  document.addEventListener(
    "toggle",
    (event) => syncCollapsiblePanelState(event.target),
    true,
  );
  if (typeof MutationObserver === "function") {
    new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach(syncCollapsiblePanels);
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
}

// Keep the dashboard dependency-free for low-memory routers, but borrow the
// useful workbench ideas from fan92rus/xkeen-ui: series controls, hover
// inspection, smoothed lines and min/P95/max/current summaries.
const CHARTS = Object.freeze({
  load: {
    id: "xk-resource-chart-load",
    minMax: .25,
    axisFormat: (value) => value.toFixed(value < 1 ? 2 : value < 10 ? 1 : 0),
    valueFormat: (value) => Number(value).toFixed(2),
    series: [
      { key: "load1", label: "1 мин", color: "#4db68b" },
      { key: "load5", label: "5 мин", color: "#d7a650" },
      { key: "load15", label: "15 мин", color: "#5bb8d5" },
    ],
  },
  cpu: {
    id: "xk-resource-chart-cpu",
    fixedMax: 100,
    axisFormat: (value) => `${Math.round(value)}%`,
    valueFormat: (value) => formatPercent(value),
    bands: true,
    series: [
      { key: "cpu", label: "CPU", color: "#7477e8" },
    ],
  },
  memory: {
    id: "xk-resource-chart-memory",
    fixedMax: 100,
    axisFormat: (value) => `${Math.round(value)}%`,
    valueFormat: (value) => formatPercent(value),
    bands: true,
    series: [
      { key: "memory", label: "RAM", color: "#4db68b" },
      { key: "swap", label: "Swap", color: "#d7a650" },
    ],
  },
  network: {
    id: "xk-resource-chart-network",
    minMax: 1024,
    axisFormat: formatCompactRate,
    valueFormat: formatRate,
    series: [
      { key: "receive", label: "Приём", color: "#42a5e8" },
      { key: "send", label: "Отдача", color: "#e58a35" },
    ],
  },
});

function byId(id) {
  return document.getElementById(id);
}
function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}
function formatBytes(value) {
  const amount = Math.max(0, Number(value) || 0);
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let current = amount;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function formatRate(value) {
  return `${formatBytes(value)}/с`;
}
function formatCompactRate(value) {
  const amount = Math.max(0, Number(value) || 0);
  const units = ["Б", "КБ", "МБ", "ГБ"];
  let current = amount;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function formatBitRate(value) {
  const amount = Math.max(0, Number(value) || 0);
  const units = ["бит/с", "Кбит/с", "Мбит/с", "Гбит/с"];
  let current = amount;
  let unit = 0;
  while (current >= 1000 && unit < units.length - 1) {
    current /= 1000;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatOptionalBitRate(value) {
  return value == null || !Number.isFinite(Number(value))
    ? "—"
    : formatBitRate(value);
}
function tone(percent) {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "normal";
}
function formatPercent(value) {
  if (metricNumber(value) === null) return "—";
  const number = clampPercent(value);
  return `${number.toFixed(number % 1 ? 1 : 0)}%`;
}
function formatUptime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor(seconds / 3600) % 24;
  const minutes = Math.floor(seconds / 60) % 60;
  return days ? `${days} д ${hours} ч` : `${hours} ч ${minutes} мин`;
}

function modalApi() {
  try {
    return window.XKeen?.ui?.modal || window.XKeen?.uiModal || null;
  } catch (error) {
    return null;
  }
}
function setDashboardOpen(open) {
  const root = byId("xk-resource-dashboard-modal");
  const trigger = byId("xk-resource-monitor");
  if (!root) return;
  const api = root.classList.contains("modal") ? modalApi() : null;
  if (
    api &&
    typeof api.open === "function" &&
    typeof api.close === "function"
  ) {
    if (open) api.open(root, { source: "resource_monitor" });
    else api.close(root, { source: "resource_monitor" });
  } else {
    root.classList.toggle("hidden", !open);
    document.body.classList.toggle("modal-open", open);
    if (open) byId("xk-resource-dashboard-close")?.focus();
  }
  if (trigger) trigger.setAttribute("aria-expanded", open ? "true" : "false");
  if (!open) setMoreMenuOpen(false);
  if (open) {
    void loadDashboardView();
    try {
      requestAnimationFrame(drawCharts);
    } catch (error) {
      drawCharts();
    }
  }
}

// The new window (shadow DOM). Task 10 replaces this single fetch with the polling
// controller; until then the window is filled once per opening.
let dashboardView = null;
let dashboardViewRequest = null;

function ensureDashboardView() {
  if (dashboardView) return dashboardView;
  const host = byId("xk-resource-dashboard-view");
  if (!host) return null;
  dashboardView = mountDashboardView(host);
  return dashboardView;
}

async function fetchJson(url) {
  const response = await fetch(url, { method: "GET", cache: "no-store", credentials: "same-origin" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function loadDashboardView() {
  const view = ensureDashboardView();
  if (!view) return Promise.resolve();
  if (dashboardViewRequest) return dashboardViewRequest;
  dashboardViewRequest = Promise.allSettled([fetchJson(SUMMARY_ENDPOINT), fetchJson(HARDWARE_ENDPOINT)])
    .then(([summary, hardware]) => {
      if (hardware.status === "fulfilled") view.renderHardware(hardware.value);
      if (summary.status === "fulfilled") {
        view.renderSummary(summary.value);
        view.renderConnection(summary.value.router);
      }
      view.redraw();
    })
    .finally(() => {
      dashboardViewRequest = null;
    });
  return dashboardViewRequest;
}

function setMoreMenuOpen(open) {
  const menu = byId("xk-resource-more-menu");
  const button = byId("xk-resource-more");
  if (!menu || !button) return;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

function render(payload) {
  latestResourcePayload = payload;
  const root = byId("xk-resource-monitor");
  const cpu = byId("xk-resource-cpu");
  const memory = byId("xk-resource-memory");
  const cpuMeter = byId("xk-resource-cpu-meter");
  const memoryMeter = byId("xk-resource-memory-meter");
  const stale = byId("xk-resource-monitor-stale");
  if (!root || !cpu || !memory) return;
  const cpuPercent = metricNumber(payload?.cpu?.percent);
  const memoryPercent = metricNumber(payload?.memory?.percent);
  cpu.textContent = formatPercent(cpuPercent);
  memory.textContent = formatPercent(memoryPercent);
  if (cpuMeter) cpuMeter.style.width = `${clampPercent(cpuPercent)}%`;
  if (memoryMeter) memoryMeter.style.width = `${clampPercent(memoryPercent)}%`;
  root.dataset.state = "ready";
  root.dataset.cpuTone = cpuPercent === null ? "unknown" : tone(cpuPercent);
  root.dataset.memoryTone = memoryPercent === null ? "unknown" : tone(memoryPercent);
  if (stale) stale.hidden = true;
  const cores = Math.max(1, Number(payload?.cpu?.cores) || 1);
  const load = Number(payload?.cpu?.load_1m) || 0;
  root.title = `CPU ${formatPercent(cpuPercent)} · load ${load.toFixed(2)} · ${cores} ядер\nRAM ${formatBytes(payload?.memory?.used_bytes)} из ${formatBytes(payload?.memory?.total_bytes)}\nНажмите для диагностики · обновление каждые 5 секунд`;
  root.setAttribute(
    "aria-label",
    `Ресурсы роутера: CPU ${formatPercent(cpuPercent)}, RAM ${formatPercent(memoryPercent)}. Открыть диагностику`,
  );
}

function record(payload) {
  const network = payload?.network || {};
  const point = {
    at: Number(payload?.sampled_at) || Math.round(Date.now() / 1000),
    period: expectedPollSeconds,
    cpu: metricNumber(payload?.cpu?.percent),
    load1: metricNumber(payload?.cpu?.load_1m),
    load5: metricNumber(payload?.cpu?.load_5m),
    load15: metricNumber(payload?.cpu?.load_15m),
    memory: metricNumber(payload?.memory?.percent),
    swap: metricNumber(payload?.memory?.swap_total_bytes) === null ? null : Number(payload?.memory?.swap_total_bytes)
      ? clampPercent(
          ((payload.memory.swap_used_bytes || 0) * 100) /
            payload.memory.swap_total_bytes,
        )
      : 0,
    receive: metricNumber(network.receive_bytes_per_second),
    send: metricNumber(network.send_bytes_per_second),
  };
  if (point.at < history.at(-1)?.at) history = [];
  if (point.at === history.at(-1)?.at) history[history.length - 1] = point;
  else history.push(point);
  history = selectHistory(history, 1440);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
}

function renderDashboard(payload) {
  const cpu = metricNumber(payload?.cpu?.percent);
  const memory = metricNumber(payload?.memory?.percent);
  const storage = payload?.storage || {};
  const temperature = metricNumber(payload?.temperature_celsius);
  const network = payload?.network || {};
  const telemetry = payload?.resource_telemetry || {};
  const swapTotal = Number(payload?.memory?.swap_total_bytes) || 0;
  const healthState = resourceHealth(payload, dnsDiagnostics);
  const health = byId("xk-resource-health");
  if (health) health.dataset.tone = healthState.tone;
  const healthTitle = byId("xk-resource-health-title");
  const healthNote = byId("xk-resource-health-note");
  if (healthTitle) healthTitle.textContent = healthState.title;
  if (healthNote) healthNote.textContent = healthState.note;
  const set = (id, value) => {
    const el = byId(id);
    if (el) el.textContent = value;
  };
  const meter = (id, value) => {
    const el = byId(id);
    if (el) el.style.width = `${clampPercent(value)}%`;
  };
  set("xk-resource-dashboard-cpu", formatPercent(cpu));
  set(
    "xk-resource-dashboard-load",
    `${payload?.cpu?.cores || 1} ядер · ориентир полной загрузки: ${payload?.cpu?.cores || 1}`,
  );
  meter("xk-resource-dashboard-cpu-meter", cpu);
  const cores = Math.max(1, Number(payload?.cpu?.cores) || 1);
  for (const interval of [1, 5, 15]) {
    const load = metricNumber(payload?.cpu?.[`load_${interval}m`]);
    set(`xk-resource-load-${interval}`, load === null ? "—" : load.toFixed(2));
    meter(`xk-resource-load-${interval}-meter`, (load / cores) * 100);
  }
  const loadValue = metricNumber(payload?.cpu?.load_1m);
  const loadGuide = byId("xk-resource-load-explanation");
  if (loadGuide) loadGuide.textContent = loadValue === null
    ? `Load недоступен. Ориентир полной загрузки для этого роутера: ${cores}.`
    : `Сейчас ${loadValue.toFixed(2)} при ${cores} ядрах — ${loadValue < cores * .7 ? "запас производительности есть" : loadValue < cores ? "нагрузка повышена" : "задачи могут ждать CPU или диск"}. Низкие линии — это нормально; постоянный load выше ${cores} — повод проверить процессы.`;
  const swapPercent = swapTotal ? (Number(payload?.memory?.swap_used_bytes) || 0) * 100 / swapTotal : 0;
  set("xk-resource-dashboard-swap", metricNumber(payload?.memory?.swap_total_bytes) === null ? "—" : swapTotal ? formatPercent(swapPercent) : "Нет");
  meter("xk-resource-dashboard-swap-meter", swapPercent);
  set("xk-resource-network-receive", metricNumber(network.receive_bytes_per_second) === null ? "—" : formatRate(network.receive_bytes_per_second));
  set("xk-resource-network-send", metricNumber(network.send_bytes_per_second) === null ? "—" : formatRate(network.send_bytes_per_second));
  document.querySelectorAll("[data-resource-stat]").forEach((element) => {
    const value = { cpu, memory, storage: metricNumber(storage.percent), swap: swapPercent }[element.dataset.resourceStat];
    element.dataset.tone = value == null ? "unknown" : tone(value);
  });
  set("xk-resource-dashboard-memory", formatPercent(memory));
  set(
    "xk-resource-dashboard-memory-note",
    `${formatBytes(payload?.memory?.used_bytes)} из ${formatBytes(payload?.memory?.total_bytes)}`,
  );
  set(
    "xk-resource-dashboard-resource-source",
    telemetry.source === "keenetic_rci"
      ? "KeeneticOS RCI · те же CPU/RAM, что в веб-интерфейсе"
      : "Linux procfs · KeeneticOS RCI недоступен",
  );
  meter("xk-resource-dashboard-memory-meter", memory);
  set(
    "xk-resource-dashboard-storage",
    storage.total_bytes ? formatPercent(storage.percent) : "—",
  );
  set(
    "xk-resource-dashboard-storage-note",
    storage.total_bytes
      ? `${formatBytes(storage.free_bytes)} свободно`
      : "Недоступно",
  );
  meter("xk-resource-dashboard-storage-meter", storage.percent || 0);
  set(
    "xk-resource-dashboard-temperature",
    temperature !== null ? `${temperature.toFixed(1)} °C` : "—",
  );
  set(
    "xk-resource-dashboard-uptime",
    `Аптайм ${formatUptime(payload?.uptime_seconds)}`,
  );
  meter(
    "xk-resource-dashboard-temperature-meter",
    temperature !== null ? Math.min(100, temperature) : 0,
  );
  set("xk-resource-detail-cores", `${payload?.cpu?.cores || 1}`);
  set(
    "xk-resource-detail-load",
    [payload?.cpu?.load_1m, payload?.cpu?.load_5m, payload?.cpu?.load_15m]
      .map((v) => Number(v || 0).toFixed(2))
      .join(" / "),
  );
  set(
    "xk-resource-detail-tasks",
    payload?.cpu?.total_tasks
      ? `${payload.cpu.runnable_tasks || 0} / ${payload.cpu.total_tasks}`
      : "—",
  );
  set(
    "xk-resource-detail-swap",
    swapTotal
      ? `${formatBytes(payload.memory.swap_used_bytes)} из ${formatBytes(swapTotal)}`
      : metricNumber(payload?.memory?.swap_total_bytes) === null ? "—" : "Не используется",
  );
  set(
    "xk-resource-detail-network",
    `${formatBytes(network.received_bytes)} ↓ · ${formatBytes(network.sent_bytes)} ↑`,
  );
  const interfacesDetail = byId("xk-resource-detail-interfaces");
  if (interfacesDetail) {
    interfacesDetail.replaceChildren();
    const interfaceItems = Array.isArray(network.interfaces) ? network.interfaces : [];
    if (!interfaceItems.length) {
      interfacesDetail.textContent = "—";
    } else {
      interfaceItems.forEach((item) => {
        const chip = document.createElement("span");
        chip.className = "xk-resource-interface-chip";
        chip.textContent = item?.name || "—";
        const receive = formatOptionalBitRate(item?.receive_bytes_per_second == null ? null : item.receive_bytes_per_second * 8);
        const send = formatOptionalBitRate(item?.send_bytes_per_second == null ? null : item.send_bytes_per_second * 8);
        chip.title = `${item?.name || "Интерфейс"} · ↓ ${receive} · ↑ ${send}`;
        interfacesDetail.appendChild(chip);
      });
    }
  }
  const freshness = byId("xk-resource-dashboard-freshness");
  if (freshness)
    freshness.textContent = `Обновлено ${new Date((Number(payload?.sampled_at) || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  renderRouterDiagnostics(payload?.router);
  syncTelemetryState();
  drawCharts();
}

function setCheck(name, value, detail = "") {
  const row = document.querySelector(`[data-internet-check="${name}"]`);
  const label = byId(`xk-internet-check-${name}`);
  const state = value === true ? "ok" : value === false ? "failed" : "unknown";
  if (row) row.dataset.state = state;
  if (label) {
    if (name === "captive") {
      label.textContent = value === true ? "Нет перехвата" : value === false ? "Обнаружен" : "Нет данных";
    } else if (detail && value === false) {
      label.textContent = detail;
    } else {
      label.textContent = value === true ? "Доступен" : value === false ? "Нет связи" : "Нет данных";
    }
  }
}

function syncDnsGuidanceState(canToggle) {
  const panel = byId("xk-dns-guidance");
  const row = byId("xk-internet-check-dns-row");
  const available = canToggle === true;
  if (!available) dnsGuidanceOpen = false;
  const visible = available && dnsGuidanceOpen;
  if (panel) {
    panel.hidden = !visible;
    panel.setAttribute("aria-hidden", visible ? "false" : "true");
    renderDnsGuidance();
  }
  if (row) {
    row.dataset.dnsToggle = available ? "true" : "false";
    row.setAttribute("aria-disabled", available ? "false" : "true");
    row.setAttribute("aria-expanded", visible ? "true" : "false");
    row.setAttribute("tabindex", available ? "0" : "-1");
  }
}

function renderDnsGuidance() {
  const panel = byId("xk-dns-guidance");
  if (!panel) return;
  const title = byId("xk-dns-guidance-title");
  const note = byId("xk-dns-guidance-note");
  const set = (element, value) => {
    if (element) element.textContent = value;
  };
  if (dnsDiagnosticsRequest) {
    set(title, "Проверяем журнал DNS…");
    set(note, "Запрашиваем журнал роутера по требованию.");
    panel.dataset.state = "loading";
    panel.setAttribute("aria-busy", "true");
    return;
  }
  panel.setAttribute("aria-busy", "false");
  if (!dnsDiagnosticsLoaded) {
    set(title, "Ошибки DNS (DoH/DoT)");
    set(note, "Нажмите DNS, чтобы запросить журнал диагностики Keenetic.");
    panel.dataset.state = "idle";
    return;
  }
  const state = dnsDiagnostics?.state;
  if (!dnsDiagnostics?.available || state === "unavailable") {
    set(title, "Журнал DNS недоступен");
    set(note, "Не удалось получить журнал диагностики Keenetic.");
    panel.dataset.state = "unavailable";
  } else if (state === "error") {
    set(title, "Ошибки DNS (DoH/DoT)");
    set(note, dnsDiagnostics.summary || "Ошибки зашифрованного DNS обнаружены в журнале.");
    panel.dataset.state = "error";
  } else {
    set(title, "Ошибок DNS (DoH/DoT) не обнаружено");
    set(note, dnsDiagnostics.summary || "В последнем фрагменте журнала ошибок нет.");
    panel.dataset.state = "ok";
  }
}

async function loadDnsDiagnostics({ force = false } = {}) {
  if (dnsDiagnosticsRequest) return dnsDiagnosticsRequest;
  if (dnsDiagnosticsLoaded && !force) {
    renderDnsGuidance();
    return null;
  }
  const controller = new AbortController();
  const requestPromise = (async () => {
    try {
      const response = await fetch(DNS_DIAGNOSTICS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      dnsDiagnostics = await response.json();
      dnsDiagnosticsLoaded = true;
    } catch (error) {
      if (controller.signal.aborted) return;
      dnsDiagnostics = {
        available: false,
        state: "unavailable",
        summary: "Не удалось получить журнал диагностики Keenetic.",
      };
      dnsDiagnosticsLoaded = true;
    } finally {
      if (dnsDiagnosticsRequest === requestPromise) dnsDiagnosticsRequest = null;
      if (latestResourcePayload) renderDashboard(latestResourcePayload);
      else renderDnsGuidance();
    }
  })();
  dnsDiagnosticsRequest = requestPromise;
  renderDnsGuidance();
  return requestPromise;
}

function toggleDnsGuidance(event) {
  const row = event?.currentTarget || byId("xk-internet-check-dns-row");
  if (!row || row.dataset.dnsToggle !== "true") return;
  event?.preventDefault();
  event?.stopPropagation();
  dnsGuidanceOpen = !dnsGuidanceOpen;
  syncDnsGuidanceState(true);
  if (dnsGuidanceOpen) void loadDnsDiagnostics();
}

function renderInternet(internet, freshness, rci) {
  const panel = byId("xk-internet-health");
  const available = internet?.available === true;
  const currentDnsDiagnostics = dnsDiagnostics || internet?.dns_diagnostics || {};
  const dnsError = currentDnsDiagnostics.state === "error";
  const dnsCheck = dnsError ? false : internet?.dns;
  const checks = [
    internet?.internet,
    internet?.gateway,
    dnsCheck,
    internet?.captive,
  ];
  const known = checks.filter((value) => typeof value === "boolean");
  const state = !available
    ? "unknown"
    : known.some((value) => value === false)
      ? "danger"
      : known.length
        ? "normal"
        : "unknown";
  if (panel) panel.dataset.tone = state;
  const set = (id, value) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };
  set(
    "xk-internet-state",
    state === "normal"
      ? "ONLINE"
      : state === "danger"
        ? "ПРОБЛЕМА"
        : "НЕТ ДАННЫХ",
  );
  set(
    "xk-internet-summary",
    !available
      ? rci?.state === "unauthorized"
        ? "RCI отклонил токен доступа"
        : "Проверка KeeneticOS недоступна"
      : dnsError
        ? currentDnsDiagnostics.summary || "Ошибки зашифрованного DNS"
      : state === "normal"
        ? "Все проверки подключения пройдены"
        : "Одна или несколько проверок не пройдены",
  );
  set("xk-internet-interface", internet?.interface || "—");
  set("xk-internet-address", internet?.address || "—");
  const age = Math.max(0, Number(freshness?.age_seconds) || 0);
  set(
    "xk-router-freshness",
    freshness?.state === "stale"
      ? `Устарело · ${age} с назад`
      : available
        ? age < 2
          ? "Только что"
          : `${age} с назад`
        : "Нет свежих данных",
  );
  setCheck("internet", available ? internet?.internet : null);
  setCheck("gateway", available ? internet?.gateway : null);
  setCheck("dns", available ? dnsCheck : null, dnsError ? "Ошибка DoH/DoT" : "");
  setCheck("captive", available ? internet?.captive : null);
  syncDnsGuidanceState(available);
}

function renderConntrack(conntrack) {
  const panel = byId("xk-conntrack-panel");
  const meter = byId("xk-conntrack-meter");
  const progress = meter?.parentElement;
  const available = conntrack?.available === true;
  const percent = available ? Math.max(0, Number(conntrack.percent) || 0) : 0;
  if (panel)
    panel.dataset.tone = available
      ? conntrack?.tone || tone(percent)
      : "unknown";
  if (meter) meter.style.width = `${Math.min(100, percent)}%`;
  if (progress)
    progress.setAttribute("aria-valuenow", `${Math.min(100, percent)}`);
  const set = (id, value) => {
    const element = byId(id);
    if (element) element.textContent = value;
  };
  set(
    "xk-conntrack-state",
    available
      ? percent >= 90
        ? "КРИТИЧНО"
        : percent >= 75
          ? "ВНИМАНИЕ"
          : "НОРМА"
      : "НЕТ ДАННЫХ",
  );
  set("xk-conntrack-percent", available ? formatPercent(percent) : "—");
  set(
    "xk-conntrack-usage",
    available
      ? `${Number(conntrack.count || 0).toLocaleString()} из ${Number(conntrack.max || 0).toLocaleString()}`
      : "Данные недоступны",
  );
  set(
    "xk-conntrack-available",
    available
      ? `Свободно ${Number(conntrack.available_entries || 0).toLocaleString()} записей`
      : "Conntrack не обнаружен в procfs",
  );
}

function textCell(row, value, className = "") {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (className) cell.className = className;
  row.appendChild(cell);
}

function setProcessAction(icon, label, { busy = false } = {}) {
  const action = byId("xk-process-action");
  if (!action) return;
  const icons = window.XKeen?.ui?.operatorIcons;
  if (icons && typeof icons.set === "function") {
    icons.set(action, icon, { label });
  } else {
    const labelElement = action.querySelector(".xk-action-label");
    if (labelElement) labelElement.textContent = label;
    else action.textContent = label;
  }
  action.classList.toggle("is-busy", busy);
  action.setAttribute("aria-busy", busy ? "true" : "false");
  action.setAttribute(
    "data-tooltip",
    busy
      ? "Загружаем Top CPU/RAM через RCI"
      : label === "Загружено"
        ? "Список процессов загружен. Нажмите, чтобы оставить секцию открытой"
        : label === "Повторить"
          ? "Не удалось загрузить процессы. Нажмите, чтобы повторить"
          : "Открыть список процессов и загрузить Top CPU/RAM",
  );
}

function setPressedGroup(selector, active) {
  document.querySelectorAll(selector).forEach((item) => {
    const selected = item === active;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function setRefreshBusy(busy) {
  const button = byId("xk-resource-dashboard-refresh");
  if (!button) return;
  button.classList.toggle("is-busy", busy);
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  button.setAttribute(
    "data-tooltip",
    busy ? "Обновляем телеметрию роутера…" : "Запросить свежую телеметрию роутера",
  );
}

function interfaceErrorMetrics(item) {
  return [
    ["RX errors", item?.receive_errors],
    ["RX drops", item?.receive_dropped],
    ["TX errors", item?.send_errors],
    ["TX drops", item?.send_dropped],
  ].filter(([, value]) => value != null && Number.isFinite(Number(value)));
}

function toggleInterfaceErrorDetails(button, item) {
  const row = button.closest("tr");
  if (!row) return;
  const current = row.nextElementSibling;
  if (current?.classList.contains("xk-interface-error-detail")) {
    current.remove();
    button.setAttribute("aria-expanded", "false");
    row.classList.remove("is-error-expanded");
    return;
  }
  const detailRow = document.createElement("tr");
  detailRow.className = "xk-interface-error-detail";
  const detailCell = document.createElement("td");
  detailCell.colSpan = 6;
  const detail = document.createElement("div");
  detail.className = "xk-interface-error-detail-body";
  const title = document.createElement("strong");
  title.textContent = `${item?.name || "Интерфейс"} · ошибки и drops`;
  detail.appendChild(title);
  interfaceErrorMetrics(item).forEach(([label, value]) => {
    const metric = document.createElement("span");
    metric.textContent = `${label}: ${Number(value).toLocaleString()}`;
    detail.appendChild(metric);
  });
  detailCell.appendChild(detail);
  detailRow.appendChild(detailCell);
  row.after(detailRow);
  button.setAttribute("aria-expanded", "true");
  row.classList.add("is-error-expanded");
}

function appendInterfaceErrorCell(row, item, errorsAvailable, errors) {
  const cell = document.createElement("td");
  cell.className = errors ? "xk-interface-errors-cell" : "xk-resource-mono";
  if (!errorsAvailable) {
    cell.textContent = "—";
  } else if (!errors) {
    cell.textContent = "0";
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "xk-interface-errors";
    button.textContent = errors.toLocaleString();
    button.title = "Показать ошибки и drops по направлениям";
    button.setAttribute("aria-label", `${item?.name || "Интерфейс"}: показать ошибки и drops`);
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", () => toggleInterfaceErrorDetails(button, item));
    cell.appendChild(button);
  }
  row.appendChild(cell);
}

function renderInterfaces(interfaces) {
  const body = byId("xk-interface-rows");
  const summary = byId("xk-interface-summary");
  if (!body) return;
  body.replaceChildren();
  latestInterfaces = interfaces;
  const allItems = Array.isArray(interfaces?.items) ? interfaces.items : [];
  const items = interfaceFilter === "all"
    ? allItems
    : allItems.filter((item) => item.online === true);
  if (!interfaces?.available || !items.length) {
    const row = document.createElement("tr");
    textCell(row, "Интерфейсы RCI недоступны", "xk-resource-table-empty");
    row.firstElementChild.colSpan = 6;
    body.appendChild(row);
    if (summary) summary.textContent = "Данные KeeneticOS недоступны";
    return;
  }
  if (summary) {
    const online = allItems.filter((item) => item.online === true).length;
    summary.textContent = interfaceFilter === "all"
      ? `${online} активных · ${interfaces.count || allItems.length} всего`
      : `${online} активных · скрыто ${Math.max(0, (interfaces.count || allItems.length) - online)}`;
  }
  items.forEach((item) => {
    const row = document.createElement("tr");
    row.dataset.state =
      item.online === true
        ? "online"
        : item.online === false
          ? "offline"
          : "unknown";
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    name.textContent = item.name || "—";
    detail.textContent = `${String(item.kind || "lan").toUpperCase()}${item.default_gateway ? " · default" : item.description ? ` · ${item.description}` : ""}`;
    identity.append(name, detail);
    row.appendChild(identity);
    textCell(
      row,
      item.online === true
        ? "UP"
        : item.online === false
          ? "DOWN"
          : item.state || "—",
      "xk-interface-state",
    );
    textCell(row, item.address || "—", "xk-resource-mono");
    textCell(
      row,
      formatOptionalBitRate(item.receive_bits_per_second),
      "xk-resource-mono",
    );
    textCell(row, formatOptionalBitRate(item.send_bits_per_second), "xk-resource-mono");
    const errorValues = [item.receive_errors, item.send_errors, item.receive_dropped, item.send_dropped];
    const errorsAvailable = errorValues.some((value) => value != null && Number.isFinite(Number(value)));
    const errors = errorValues.reduce((total, value) => total + (Number(value) || 0), 0);
    appendInterfaceErrorCell(row, item, errorsAvailable, errors);
    body.appendChild(row);
  });
}

function renderRouterDiagnostics(router) {
  const internet = router?.internet;
  renderInternet(internet, router?.freshness, router?.rci);
  renderConntrack(router?.conntrack);
  renderInterfaces(router?.interfaces);
  renderIncidents(router?.incidents);
}

function setStage2Button(id, label, { busy = false, pressed } = {}) {
  const button = byId(id);
  if (!button) return;
  button.textContent = busy ? "Загрузка…" : label;
  button.classList.toggle("is-busy", busy);
  button.disabled = busy;
  button.setAttribute("aria-busy", busy ? "true" : "false");
  if (pressed !== undefined) {
    button.classList.toggle("is-active", pressed);
    button.setAttribute("aria-pressed", pressed ? "true" : "false");
  }
}

function renderClients(payload) {
  const body = byId("xk-client-rows");
  const status = byId("xk-clients-status");
  if (!body) return;
  latestClientsPayload = payload;
  body.replaceChildren();
  const allItems = Array.isArray(payload?.items) ? payload.items : [];
  const items = selectClients(payload, clientsShowAll);
  const showAll = byId("xk-clients-show-all");
  if (showAll) {
    const canShowAll = allItems.length > 5;
    showAll.hidden = !canShowAll;
    showAll.textContent = clientsShowAll ? "Показать Top‑5" : `Показать всех (${Number(payload?.count || allItems.length)})`;
    showAll.setAttribute("aria-pressed", clientsShowAll ? "true" : "false");
  }
  if (!payload?.available || !items.length) {
    const row = document.createElement("tr");
    textCell(row, payload?.available ? "Активные клиенты не найдены" : "Клиенты RCI недоступны", "xk-resource-table-empty");
    row.firstElementChild.colSpan = 6;
    body.appendChild(row);
  } else {
    items.forEach((item) => {
      const row = document.createElement("tr");
      const identity = document.createElement("td");
      const name = document.createElement("strong");
      const detail = document.createElement("small");
      name.textContent = item.name || item.mac || item.ip || "Клиент";
      detail.textContent = [item.ip, item.mac].filter(Boolean).join(" · ");
      identity.append(name, detail);
      row.appendChild(identity);
      textCell(row, formatBytes(item.traffic_bytes), "xk-resource-mono");
      textCell(row, formatOptionalBitRate(item.rx_rate), "xk-resource-mono");
      textCell(row, formatOptionalBitRate(item.tx_rate), "xk-resource-mono");
      textCell(row, item.rssi == null ? "—" : `${item.rssi} dBm`, "xk-resource-mono");
      textCell(row, item.interface || "—", "xk-resource-mono");
      body.appendChild(row);
    });
  }
  if (status) {
    const sampled = new Date((Number(payload?.sampled_at) || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    status.textContent = payload?.available
      ? `Показано ${items.length} из ${payload?.count ?? allItems.length} · ${clientsShowAll ? "все доступные" : "Top‑5 по объёму трафика"}${payload?.truncated ? " · лимит RCI: 100 записей" : ""} · ${sampled}`
      : "KeeneticOS не вернул список клиентов.";
    status.dataset.state = payload?.available ? "ready" : "error";
  }
  clientsLoaded = payload?.available === true;
  setStage2Button(
    "xk-clients-action",
    clientsLoaded ? "Обновить" : "Повторить",
    { pressed: clientsLoaded },
  );
}

async function loadClients() {
  if (clientsRequest) return;
  const status = byId("xk-clients-status");
  const controller = new AbortController();
  clientsRequest = controller;
  setStage2Button("xk-clients-action", "Загрузка…", { busy: true, pressed: true });
  if (status) {
    status.textContent = "Загрузка списка клиентов через RCI…";
    status.dataset.state = "loading";
  }
  try {
    const response = await fetch(CLIENTS_ENDPOINT, { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderClients(await response.json());
  } catch (error) {
    if (!controller.signal.aborted && status) {
      status.textContent = "Не удалось получить клиентов. Проверьте доступ RCI и повторите.";
      status.dataset.state = "error";
    }
    setStage2Button("xk-clients-action", "Повторить", { pressed: false });
  } finally {
    if (clientsRequest === controller) clientsRequest = null;
    if (byId("xk-clients-action")) byId("xk-clients-action").disabled = false;
  }
}

function lteControlState(modemId) {
  if (!lteControls.has(modemId)) {
    lteControls.set(modemId, {
      probeAvailable: false, probeBusy: false, message: "", tone: "",
    });
  }
  return lteControls.get(modemId);
}

function lteControlMessage(code) {
  const messages = {
    modem_not_found: "Модем больше не найден. Обновите данные.",
    transport_not_matched: "Управляющий порт этого модема не найден.",
    qmi_tool_missing: "QMI-инструмент на роутере недоступен. Установите пакет qmi-utils: opkg update && opkg install qmi-utils. Затем повторите проверку.",
    qmi_probe_timeout: "Проверка QMI превысила время ожидания.",
    qmi_probe_failed: "Проверка QMI завершилась ошибкой.",
  };
  return messages[code] || "Не удалось проверить управляющий порт.";
}

function syncLteControlCard(modemId) {
  const root = byId("xk-lte-modems");
  const card = Array.from(root?.children || []).find((node) => node.dataset.modemId === modemId);
  if (!card) return;
  const state = lteControlState(modemId);
  const probeButton = card.querySelector('[data-lte-action="probe"]');
  const status = card.querySelector(".xk-lte-control-status");
  if (probeButton) probeButton.disabled = state.probeBusy || !modemId;
  if (status) {
    status.textContent = state.message;
    status.dataset.state = state.tone;
    status.hidden = !state.message;
  }
}

async function lteControlRequest(url, options = {}, timeoutMs = LTE_CONTROL_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  let expired = false;
  const timeout = window.setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  try {
    let requestInit = {
      cache: "no-store", credentials: "same-origin", ...options, signal: controller.signal,
    };
    try {
      const coreHttp = window.XKeen?.core?.http;
      if (typeof coreHttp?.withCSRF === "function") {
        requestInit = coreHttp.withCSRF(requestInit, requestInit.method || "GET");
      } else if (String(requestInit.method || "GET").toUpperCase() !== "GET") {
        const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") || "";
        const headers = new Headers(requestInit.headers || {});
        if (token && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", token);
        requestInit.headers = headers;
      }
    } catch (error) {}
    const response = await fetch(url, requestInit);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(lteControlMessage(payload?.code));
    return payload;
  } catch (error) {
    if (expired) {
      const timeoutError = new Error("Нет ответа от роутера. Проверьте состояние модема.");
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function probeLteModem(modemId) {
  const state = lteControlState(modemId);
  if (state.probeBusy) return;
  state.probeBusy = true;
  state.probeAvailable = false;
  state.message = "Проверяем управляющий порт…";
  state.tone = "running";
  syncLteControlCard(modemId);
  try {
    const payload = await lteControlRequest(`${LTE_ENDPOINT}/${encodeURIComponent(modemId)}/probe`, { method: "POST" });
    const available = Boolean(payload?.preferred_transport && payload?.transports?.some((transport) => transport.kind === payload.preferred_transport && transport.available === true));
    state.probeAvailable = available && state.connected;
    state.message = !state.connected
      ? "Модем не подключён."
      : available
      ? `${payload.preferred_transport === "qmi" ? "QMI" : "AT"} доступен · ${modemId}`
      : lteControlMessage(payload?.code);
    state.tone = state.probeAvailable ? "success" : "error";
  } catch (error) {
    state.message = error.message || lteControlMessage();
    state.tone = "error";
  } finally {
    state.probeBusy = false;
    syncLteControlCard(modemId);
  }
}

function lteControlButton(action, label, iconName) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn-secondary";
  button.dataset.lteAction = action;
  button.setAttribute("aria-label", label);
  button.setAttribute("data-tooltip", label);
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `/static/icons/operator.svg#xk-${iconName}`);
  icon.appendChild(use);
  const text = document.createElement("span");
  text.textContent = label;
  button.append(icon, text);
  return button;
}

function renderLte(payload) {
  const available = payload?.available === true;
  const set = (id, value) => { const element = byId(id); if (element) element.textContent = value; };
  const root = byId("xk-lte-modems");
  const items = Array.isArray(payload?.items) ? payload.items : available ? [payload] : [];
  const metric = (value, unit) => value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(0)} ${unit}`;
  const text = (value) => value == null || String(value).trim() === "" ? "—" : String(value);
  const duration = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value < 0) return "—";
    const days = Math.floor(value / 86400);
    const hours = Math.floor((value % 86400) / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return [days ? `${days} д` : "", hours ? `${hours} ч` : "", `${minutes} мин`].filter(Boolean).join(" ");
  };
  const appendMetric = (list, label, value, options = {}) => {
    if (options.optional && (value == null || String(value).trim() === "")) return;
    const cell = document.createElement("div");
    if (options.wide) cell.className = "is-wide";
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = text(value);
    if (options.title) description.title = text(options.title);
    cell.append(term, description);
    list.appendChild(cell);
  };
  set("xk-lte-summary", items.length ? `${items.length} ${items.length === 1 ? "модем" : items.length < 5 ? "модема" : "модемов"} · ${items.map((item) => item.operator || item.name || item.id).filter(Boolean).join(" / ")}` : "LTE-модемы не обнаружены");
  if (root) {
    root.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("span");
      empty.className = "xk-stage2-status";
      empty.textContent = "KeeneticOS не вернул данные LTE-модемов.";
      root.appendChild(empty);
    }
    items.forEach((item, index) => {
      const card = document.createElement("article");
      card.className = "xk-lte-modem";
      const modemId = String(item.id || "");
      card.dataset.modemId = modemId;
      if (item.default_route === true) card.dataset.primary = "true";
      const header = document.createElement("header");
      const heading = document.createElement("div");
      const title = document.createElement("strong");
      const subtitle = document.createElement("span");
      const badge = document.createElement("span");
      title.textContent = item.name || item.id || `Модем ${index + 1}`;
      subtitle.textContent = [item.id, item.model].filter(Boolean).join(" · ") || "LTE-модем";
      badge.className = "xk-lte-state";
      const connected = item.connected === true || String(item.connection_state || "").toLowerCase() === "connected";
      card.dataset.connected = connected ? "true" : "false";
      const controlState = lteControlState(modemId);
      controlState.connected = connected;
      if (!connected) {
        controlState.probeAvailable = false;
        if (!controlState.message) {
          controlState.message = "Модем не подключён.";
          controlState.tone = "error";
        }
      }
      badge.dataset.state = connected ? "connected" : "offline";
      badge.textContent = connected ? (item.default_route === true ? "Основной · подключён" : "Подключён") : (item.connection_state || "Не подключён");
      heading.append(title, subtitle);
      header.append(heading, badge);
      const list = document.createElement("dl");
      list.className = "xk-stage2-metrics xk-lte-metrics";
      appendMetric(list, "Оператор", item.operator);
      appendMetric(list, "Сеть", item.technology);
      appendMetric(list, "RSRP", metric(item.rsrp, "dBm"));
      appendMetric(list, "RSRQ", metric(item.rsrq, "dB"));
      appendMetric(list, "CINR", metric(item.cinr, "dB"));
      appendMetric(list, "RSSI", metric(item.rssi, "dBm"));
      appendMetric(list, "Диапазон", item.band ? `B${String(item.band).replace(/^B/i, "")}` : "—");
      appendMetric(list, "Полоса", metric(item.bandwidth, "МГц"));
      appendMetric(list, "IP-адрес", item.address);
      appendMetric(list, "Маска", item.mask);
      appendMetric(list, "Базовая станция", item.base_station);
      appendMetric(list, "Расстояние", item.distance == null ? "—" : metric(item.distance, "м"));
      appendMetric(list, "IMEI", item.imei);
      appendMetric(list, "SIM", item.sim);
      appendMetric(list, "APN", item.apn);
      appendMetric(list, "Аптайм", duration(item.uptime));
      const carrierBands = Array.isArray(item.carriers) ? item.carriers.map((carrier) => carrier.band ? `B${carrier.band}${carrier.bandwidth == null ? "" : ` · ${carrier.bandwidth} МГц`}` : "").filter(Boolean).join("; ") : "";
      appendMetric(list, "Агрегация несущих", carrierBands, { optional: true, wide: true });
      appendMetric(list, "Прошивка модема", item.firmware, { optional: true, wide: true, title: item.firmware });
      const controls = document.createElement("div");
      controls.className = "xk-lte-controls";
      const probeButton = lteControlButton("probe", "Проверить управление", "search");
      const controlStatus = document.createElement("span");
      controlStatus.className = "xk-lte-control-status";
      controlStatus.setAttribute("role", "status");
      controlStatus.setAttribute("aria-live", "polite");
      controlStatus.hidden = true;
      probeButton.addEventListener("click", () => void probeLteModem(modemId));
      controls.append(probeButton, controlStatus);
      if (!modemId) {
        const state = lteControlState(modemId);
        state.message = "Идентификатор модема недоступен.";
        state.tone = "error";
      }
      card.append(header, list, controls);
      root.appendChild(card);
      syncLteControlCard(modemId);
    });
  }
  setStage2Button("xk-lte-action", available ? "Обновлено" : "Проверить ещё раз", { pressed: available });
}

async function loadLte() {
  if (lteRequest) return lteRequest.promise;
  const current = { promise: null };
  lteRequest = current;
  current.promise = (async () => {
    setStage2Button("xk-lte-action", "Загрузка…", { busy: true, pressed: true });
    const summary = byId("xk-lte-summary");
    if (summary) summary.textContent = "Запрашиваем состояние модема…";
    try {
      renderLte(await lteControlRequest(LTE_ENDPOINT, { method: "GET" }, 12000));
    } catch (error) {
      if (summary) summary.textContent = "Не удалось получить данные LTE";
      setStage2Button("xk-lte-action", "Повторить", { pressed: false });
    } finally {
      if (lteRequest === current) lteRequest = null;
      if (byId("xk-lte-action")) byId("xk-lte-action").disabled = false;
    }
  })();
  return current.promise;
}

function renderIncidents(incidents) {
  const root = byId("xk-incidents-list");
  if (!root) return;
  root.replaceChildren();
  const items = Array.isArray(incidents) ? incidents.slice(0, 8) : [];
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "xk-stage2-status";
    empty.textContent = "Пока без событий.";
    root.appendChild(empty);
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "xk-incident-row";
    row.dataset.state = item.state || "normal";
    const message = document.createElement("strong");
    const at = document.createElement("time");
    message.textContent = item.message || "Изменение состояния";
    at.textContent = new Date((Number(item.at) || 0) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    row.append(message, at);
    root.appendChild(row);
  });
}

function renderChannelCheck(payload) {
  const status = byId("xk-channel-status");
  const trace = byId("xk-channel-trace-output");
  const traceResult = byId("xk-channel-trace-result");
  const traceTitle = byId("xk-channel-trace-title");
  const traceNote = byId("xk-channel-trace-note");
  const traceHops = byId("xk-channel-trace-hops");
  const panel = byId("xk-channel-panel");
  if (panel) panel.dataset.state = payload?.state || "unknown";
  if (status) {
    if (!payload?.available && payload?.state === "unavailable") status.textContent = payload.error || "Команда ping недоступна на сервере.";
    else status.textContent = `Потери ${Number(payload?.loss_percent || 0).toFixed(1)}% · RTT ${payload?.latency_ms == null ? "—" : `${payload.latency_ms} ms`} · jitter ${payload?.jitter_ms == null ? "—" : `${payload.jitter_ms} ms`}`;
    status.dataset.state = payload?.state || "unknown";
  }
  if (trace) {
    trace.textContent = payload?.trace || "";
  }
  if (traceResult) {
    const hasTrace = Boolean(payload?.trace);
    traceResult.hidden = !hasTrace;
    traceResult.dataset.state = payload?.trace_state || "unknown";
    if (traceTitle) traceTitle.textContent = payload?.trace_summary || "Результат трассировки";
    if (traceNote) traceNote.textContent = payload?.trace_note || "Подробный ответ команды доступен ниже.";
    if (traceHops) {
      traceHops.replaceChildren();
      const answered = Array.isArray(payload?.trace_hops)
        ? payload.trace_hops.filter((hop) => hop?.responded)
        : [];
      answered.forEach((hop) => {
        const row = document.createElement("div");
        const number = document.createElement("span");
        const address = document.createElement("strong");
        const latency = document.createElement("span");
        number.textContent = `Шаг ${Number(hop.number) || "—"}`;
        address.textContent = hop.address || "Узел ответил";
        latency.textContent = hop.latency_ms == null ? "ответ получен" : `${hop.latency_ms} ms`;
        row.append(number, address, latency);
        traceHops.appendChild(row);
      });
      traceHops.hidden = answered.length === 0;
    }
  }
  setStage2Button("xk-channel-action", "Проверить снова", { pressed: payload?.state === "good" });
}

async function runChannelCheck() {
  if (channelRequest) return;
  const controller = new AbortController();
  channelRequest = controller;
  const target = byId("xk-channel-target")?.value?.trim() || "1.1.1.1";
  const includeTrace = byId("xk-channel-trace")?.getAttribute("aria-pressed") === "true";
  const query = `?target=${encodeURIComponent(target)}&trace=${includeTrace ? "1" : "0"}`;
  setStage2Button("xk-channel-action", "Проверка…", { busy: true, pressed: true });
  const status = byId("xk-channel-status");
  if (status) { status.textContent = `Проверяем ${target}…`; status.dataset.state = "loading"; }
  try {
    const response = await fetch(`${CHANNEL_ENDPOINT}${query}`, { method: "GET", cache: "no-store", credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderChannelCheck(await response.json());
  } catch (error) {
    if (!controller.signal.aborted && status) { status.textContent = "Проверка канала не выполнена."; status.dataset.state = "error"; }
    setStage2Button("xk-channel-action", "Повторить", { pressed: false });
  } finally {
    if (channelRequest === controller) channelRequest = null;
    if (byId("xk-channel-action")) byId("xk-channel-action").disabled = false;
  }
}

function renderProcesses(payload) {
  const body = byId("xk-process-rows");
  const status = byId("xk-process-status");
  if (!body) return;
  body.replaceChildren();
  const allItems = Array.isArray(payload?.items) ? payload.items : [];
  const useful = allItems.filter((item) =>
    Number(item.cpu_percent || 0) > 0 ||
    Number(item.memory_bytes || 0) > 0 ||
    String(item.service || "").trim(),
  );
  const items = (useful.length ? useful : allItems).slice(0, 24);
  items.forEach((item) => {
    const row = document.createElement("tr");
    const identity = document.createElement("td");
    const name = document.createElement("strong");
    const service = document.createElement("small");
    name.textContent = item.name || "process";
    service.textContent = item.service || "";
    identity.append(name, service);
    row.appendChild(identity);
    textCell(row, `${item.pid || "—"}`, "xk-resource-mono");
    textCell(row, formatPercent(item.cpu_percent), "xk-resource-mono");
    textCell(row, formatBytes(item.memory_bytes), "xk-resource-mono");
    textCell(row, `${item.threads || "—"}`, "xk-resource-mono");
    textCell(row, item.state || "—");
    body.appendChild(row);
  });
  if (status) {
    const sampled = new Date(
      (Number(payload?.sampled_at) || Date.now() / 1000) * 1000,
    ).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    status.textContent = items.length
      ? `Показано ${items.length} значимых из ${payload?.count || allItems.length} · Top CPU/RAM · ${sampled}`
      : "KeeneticOS не вернул процессов.";
    status.dataset.state = "ready";
  }
  processesLoaded = true;
  setProcessAction("check", "Загружено");
}

async function loadProcesses() {
  if (processRequest) return;
  const status = byId("xk-process-status");
  const controller = new AbortController();
  processRequest = controller;
  const refreshButton = byId("xk-process-refresh");
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.classList.add("is-busy");
    refreshButton.setAttribute("aria-busy", "true");
    refreshButton.setAttribute("data-tooltip", "Обновляем список процессов…");
  }
  if (status) {
    status.textContent = "Загрузка списка процессов через RCI…";
    status.dataset.state = "loading";
  }
  setProcessAction("loading", "Загрузка…", { busy: true });
  try {
    const response = await fetch(PROCESS_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    renderProcesses(await response.json());
  } catch (error) {
    if (!controller.signal.aborted && status) {
      status.textContent =
        "Не удалось получить процессы. Проверьте доступ RCI и повторите.";
      status.dataset.state = "error";
    }
    setProcessAction("retry", "Повторить");
  } finally {
    if (processRequest === controller) processRequest = null;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.classList.remove("is-busy");
      refreshButton.setAttribute("aria-busy", "false");
      refreshButton.setAttribute("data-tooltip", "Повторно запросить список процессов через RCI");
    }
  }
}

function chartPoints() {
  return selectHistory(history, rangeMinutes);
}

function percentile(values, value) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((value / 100) * sorted.length) - 1);
  return sorted[index];
}

function niceChartMax(value) {
  const maximum = Math.max(0.01, Number(value) || 0);
  const power = 10 ** Math.floor(Math.log10(maximum));
  const normalized = maximum / power;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * power;
}

function chartRuntime(name) {
  if (!chartState.has(name)) {
    chartState.set(name, { disabled: new Set(), hoverIndex: null, hoverAt: null, frame: 0 });
  }
  return chartState.get(name);
}

function traceSmoothLine(ctx, coordinates) {
  if (!coordinates.length) return;
  ctx.moveTo(coordinates[0].x, coordinates[0].y);
  for (let index = 1; index < coordinates.length; index += 1) {
    const previous = coordinates[index - 1];
    const current = coordinates[index];
    const controlX = (previous.x + current.x) / 2;
    ctx.bezierCurveTo(controlX, previous.y, controlX, current.y, current.x, current.y);
  }
}

function renderChartStats(name, config, points) {
  const root = byId(`${config.id}-stats`);
  if (!root) return;
  root.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "xk-resource-chart-stats-row xk-resource-chart-stats-head";
  ["", "мин", "макс", "сред", "P95", "сейчас"].forEach((label) => {
    const cell = document.createElement("span");
    cell.textContent = label;
    heading.appendChild(cell);
  });
  root.appendChild(heading);
  const runtime = chartRuntime(name);
  config.series.forEach((series) => {
    const values = points.map((point) => metricNumber(point[series.key])).filter((value) => value !== null);
    const row = document.createElement("div");
    row.className = "xk-resource-chart-stats-row";
    row.classList.toggle("is-disabled", runtime.disabled.has(series.key));
    const label = document.createElement("span");
    label.className = "xk-resource-chart-stats-label";
    label.style.setProperty("--chart-series-color", series.color);
    label.textContent = series.label;
    row.appendChild(label);
    const stats = values.length
      ? [Math.min(...values), Math.max(...values), values.reduce((sum, value) => sum + value, 0) / values.length, percentile(values, 95), metricNumber(points.at(-1)?.[series.key])]
      : [null, null, null, null, null];
    stats.forEach((value) => {
      const cell = document.createElement("span");
      cell.textContent = value === null ? "—" : config.valueFormat(value);
      row.appendChild(cell);
    });
    root.appendChild(row);
  });
}

function renderChartTooltip(name, config, points, coordinates, width) {
  const runtime = chartRuntime(name);
  const canvas = byId(config.id);
  const tooltip = canvas?.parentElement?.querySelector(".xk-resource-chart-tooltip");
  const index = runtime.hoverIndex;
  if (!tooltip || index === null || !points[index] || !coordinates[index]) {
    if (tooltip) tooltip.hidden = true;
    return;
  }
  tooltip.replaceChildren();
  const gap = gapAtTime(points, runtime.hoverAt);
  if (gap) {
    const title = document.createElement("strong");
    const note = document.createElement("div");
    title.textContent = `Нет данных · ${Math.round(gap.seconds)} с`;
    note.textContent = "Опрос был пропущен или приостановлен. Это не нулевой трафик.";
    tooltip.append(title, note);
    tooltip.style.left = `${Math.max(8, Math.min(width - 176, coordinates[index].x))}px`;
    tooltip.style.top = "12px";
    tooltip.hidden = false;
    return;
  }
  const time = document.createElement("strong");
  time.textContent = new Date(points[index].at * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  tooltip.appendChild(time);
  config.series.forEach((series) => {
    if (runtime.disabled.has(series.key)) return;
    const row = document.createElement("span");
    row.style.setProperty("--chart-series-color", series.color);
    const value = metricNumber(points[index][series.key]);
    row.textContent = `${series.label}: ${value === null ? "—" : config.valueFormat(value)}`;
    tooltip.appendChild(row);
  });
  const desiredLeft = coordinates[index].x + 12;
  tooltip.style.left = `${Math.max(54, Math.min(width - 176, desiredLeft))}px`;
  tooltip.style.top = "12px";
  tooltip.hidden = false;
}

function drawChartGapAnnotations(ctx, points, pad, chartW, chartH, width, height) {
  if (points.length < 2) return;
  const startAt = points[0].at;
  const span = Math.max(1, points.at(-1).at - startAt);
  historyGaps(points).forEach((gap) => {
    const left = pad.left + chartW * ((gap.from - startAt) / span);
    const right = pad.left + chartW * ((gap.to - startAt) / span);
    ctx.save();
    ctx.fillStyle = "rgba(215,166,80,.05)";
    ctx.strokeStyle = "rgba(215,166,80,.28)";
    ctx.setLineDash([3, 4]);
    ctx.fillRect(left, pad.top, Math.max(3, right - left), chartH);
    ctx.beginPath();
    ctx.moveTo(left, pad.top);
    ctx.lineTo(left, pad.top + chartH);
    ctx.moveTo(right, pad.top);
    ctx.lineTo(right, pad.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(215,166,80,.75)";
    ctx.font = "8px ui-monospace, SFMono-Regular, monospace";
    if (right - left > 68) ctx.fillText(`нет данных ${Math.round(gap.seconds)}с`, Math.max(pad.left, Math.min(width - 88, left + 4)), Math.min(height - 7, pad.top + 12));
    ctx.restore();
  });
}

function drawChart(name, config) {
  const canvas = byId(config.id);
  if (!canvas || !canvas.getClientRects().length) return;
  const wrap = canvas.parentElement;
  const empty = wrap?.querySelector(".xk-resource-chart-empty");
  const points = chartPoints();
  const hasHistory = points.length > 1;
  if (empty) empty.hidden = hasHistory;
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    renderChartStats(name, config, points);
    return;
  }
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(220, Math.floor(rect.width));
  const height = Math.max(120, Math.floor(rect.height));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const pad = { top: 12, right: 14, bottom: 25, left: 54 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const css = getComputedStyle(canvas);
  const textColor = css.getPropertyValue("--op-muted").trim() || "rgba(150,157,169,.8)";
  const gridColor = css.getPropertyValue("--op-border").trim() || "rgba(150,157,169,.14)";
  const runtime = chartRuntime(name);
  const activeSeries = config.series.filter((series) => !runtime.disabled.has(series.key));
  const dataMax = Math.max(
    .01,
    ...activeSeries.flatMap((series) => points.map((point) => Number(point[series.key]) || 0)),
  );
  const valuesMax = config.fixedMax || niceChartMax(Math.max(config.minMax || 1, dataMax * 1.08));
  if (config.bands) {
    const band = (from, to, color) => {
      const top = pad.top + chartH * (1 - to / valuesMax);
      const bottom = pad.top + chartH * (1 - from / valuesMax);
      ctx.fillStyle = color;
      ctx.fillRect(pad.left, top, chartW, bottom - top);
    };
    band(0, 75, "rgba(77,182,139,.025)");
    band(75, 90, "rgba(215,166,80,.035)");
    band(90, 100, "rgba(223,114,123,.045)");
  }
  ctx.strokeStyle = gridColor;
  ctx.globalAlpha = 0.68;
  ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = textColor;
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + (chartH * index) / 4;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(config.axisFormat(valuesMax * (1 - index / 4)), 2, y + 3);
    ctx.globalAlpha = 0.68;
  }
  const startAt = points[0]?.at || 0;
  const span = Math.max(1, (points.at(-1)?.at || startAt) - startAt);
  const pointX = (point) => pad.left + chartW * (points.length === 1 ? .5 : (point.at - startAt) / span);
  if (points.length > 1) {
    const tickIndexes = [...new Set([0, .25, .5, .75, 1].map((ratio) => Math.round((points.length - 1) * ratio)))];
    tickIndexes.forEach((pointIndex) => {
      const x = pointX(points[pointIndex]);
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + chartH);
      ctx.stroke();
      const label = new Date(points[pointIndex].at * 1000).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit", ...(span <= 600 ? {second: "2-digit"} : {})});
      ctx.globalAlpha = 1;
      ctx.textAlign = pointIndex === 0 ? "left" : pointIndex === points.length - 1 ? "right" : "center";
      ctx.fillText(label, x, height - 5);
      ctx.globalAlpha = 0.68;
    });
    ctx.textAlign = "start";
  }
  drawChartGapAnnotations(ctx, points, pad, chartW, chartH, width, height);
  ctx.globalAlpha = 1;
  const allCoordinates = points.map((point) => ({
    x: pointX(point),
  }));
  if (hasHistory) activeSeries.forEach((series) => {
    // Missing samples and pauses must not look like continuous telemetry.
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = metricNumber(point[series.key]);
      const gap = index && collectionGap(points[index - 1], point);
      if ((value === null || gap) && segment.length) { segments.push(segment); segment = []; }
      if (value !== null) segment.push({
        x: allCoordinates[index].x,
        y: pad.top + chartH * (1 - Math.min(valuesMax, value) / valuesMax),
      });
    });
    if (segment.length) segments.push(segment);
    segments.forEach((coordinates) => {
      ctx.beginPath();
      traceSmoothLine(ctx, coordinates);
      ctx.lineTo(coordinates.at(-1).x, pad.top + chartH);
      ctx.lineTo(coordinates[0].x, pad.top + chartH);
      ctx.closePath();
      const fill = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
      fill.addColorStop(0, `${series.color}2e`);
      fill.addColorStop(1, `${series.color}03`);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.beginPath();
      traceSmoothLine(ctx, coordinates);
      ctx.strokeStyle = series.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      const last = coordinates.at(-1);
      ctx.beginPath();
      ctx.arc(last.x, last.y, 2, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
    });
  });
  if (hasHistory && runtime.hoverIndex !== null && allCoordinates[runtime.hoverIndex] && !gapAtTime(points, runtime.hoverAt)) {
    const index = runtime.hoverIndex;
    const x = allCoordinates[index].x;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = textColor;
    ctx.globalAlpha = .7;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartH);
    ctx.stroke();
    ctx.restore();
    activeSeries.forEach((series) => {
      const value = metricNumber(points[index]?.[series.key]);
      if (value === null) return;
      const y = pad.top + chartH * (1 - Math.min(valuesMax, value) / valuesMax);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = css.getPropertyValue("--op-surface-2").trim() || "#1a1e25";
      ctx.stroke();
    });
  }
  runtime.geometry = { pad, chartW, points };
  renderChartStats(name, config, points);
  renderChartTooltip(name, config, points, allCoordinates, width);
}

function drawCharts() {
  if (byId("xk-resource-dashboard-modal")?.classList.contains("hidden")) return;
  const note = byId("xk-resource-history-note");
  if (note) {
    const points = chartPoints();
    const seconds = points.length > 1 ? points.at(-1).at - points[0].at : 0;
    const gaps = historyGaps(points).length;
    note.textContent = `CPU, память и сеть · ${points.length} точек / ${seconds >= 60 ? `${Math.floor(seconds / 60)} мин` : `${seconds} с`} · ${gaps ? `${gaps} пропусков опроса` : "без пропусков"} · только эта вкладка`;
  }
  Object.entries(CHARTS).forEach(([name, config]) => drawChart(name, config));
}

function scheduleChartDraw(name) {
  const runtime = chartRuntime(name);
  if (runtime.frame) return;
  runtime.frame = requestAnimationFrame(() => {
    runtime.frame = 0;
    drawChart(name, CHARTS[name]);
  });
}

function bindChartInteractions() {
  Object.entries(CHARTS).forEach(([name, config]) => {
    const canvas = byId(config.id);
    if (!canvas || canvas.dataset.chartInteractive === "true") return;
    canvas.dataset.chartInteractive = "true";
    canvas.addEventListener("pointermove", (event) => {
      const runtime = chartRuntime(name);
      const geometry = runtime.geometry;
      if (!geometry || geometry.points.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const relativeX = (event.clientX - rect.left) * (Math.max(220, rect.width) / Math.max(1, rect.width));
      const ratio = Math.max(0, Math.min(1, (relativeX - geometry.pad.left) / geometry.chartW));
      const points = geometry.points;
      const at = points[0].at + ratio * (points.at(-1).at - points[0].at);
      runtime.hoverAt = at;
      runtime.hoverIndex = nearestPointIndex(points, at);
      scheduleChartDraw(name);
    });
    canvas.addEventListener("pointerleave", () => {
      chartRuntime(name).hoverIndex = null;
      chartRuntime(name).hoverAt = null;
      scheduleChartDraw(name);
    });
  });
  document.querySelectorAll("[data-chart-toggle]").forEach((button) => {
    if (button.dataset.chartToggleBound === "true") return;
    button.dataset.chartToggleBound = "true";
    button.addEventListener("click", () => {
      const name = button.dataset.chartToggle;
      const key = button.dataset.series;
      const config = CHARTS[name];
      if (!config || !config.series.some((series) => series.key === key)) return;
      const runtime = chartRuntime(name);
      const enabledCount = config.series.filter((series) => !runtime.disabled.has(series.key)).length;
      if (runtime.disabled.has(key)) runtime.disabled.delete(key);
      else if (enabledCount > 1) runtime.disabled.add(key);
      const enabled = !runtime.disabled.has(key);
      button.classList.toggle("is-disabled", !enabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      drawChart(name, config);
    });
  });
}

function renderUnavailable() {
  const root = byId("xk-resource-monitor");
  const stale = byId("xk-resource-monitor-stale");
  if (!root) return;
  root.dataset.state = "stale";
  root.title = "Не удалось обновить ресурсы роутера. Нажмите, чтобы повторить.";
  if (stale) stale.hidden = false;
  telemetryStale = true;
  syncTelemetryState();
}

function syncTelemetryState() {
  const live = byId("xk-resource-live");
  const body = byId("xk-resource-dashboard-modal")?.querySelector(".xk-resource-dashboard-body");
  if (body) body.dataset.freshness = telemetryStale ? "stale" : "fresh";
  if (live) {
    live.dataset.state = telemetryStale ? "stale" : !pollMs ? "paused" : "live";
    live.textContent = telemetryStale ? "Нет свежих данных" : !pollMs ? "На паузе" : `Обновление ${pollMs / 1000} с`;
  }
  const exportButton = byId("xk-resource-export");
  if (exportButton) exportButton.disabled = !latestResourcePayload;
  const monitor = byId("xk-resource-monitor");
  if (monitor && !telemetryStale && latestResourcePayload) {
    monitor.title = `CPU ${formatPercent(latestResourcePayload.cpu?.percent)} · RAM ${formatPercent(latestResourcePayload.memory?.percent)}\n${pollMs ? `Обновление каждые ${pollMs / 1000} секунд` : "Автообновление на паузе"} · нажмите для диагностики`;
  }
  if (telemetryStale) {
    const health = byId("xk-resource-health");
    if (health) health.dataset.tone = "unknown";
    const title = byId("xk-resource-health-title");
    const note = byId("xk-resource-health-note");
    if (title) title.textContent = "Телеметрия недоступна";
    if (note) note.textContent = latestResourcePayload ? "Показан последний успешный снимок. Повторите обновление." : "Не удалось получить состояние роутера.";
  }
}

function exportSnapshot() {
  if (!latestResourcePayload) return;
  const snapshot = buildResourceSnapshot(latestResourcePayload, history, rangeMinutes, pollMs, telemetryStale);
  const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `xkeen-resources-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function schedule() {
  window.clearTimeout(timer);
  if (!pollMs) return;
  const interval = document.hidden ? Math.max(HIDDEN_POLL_MS, pollMs) : pollMs;
  expectedPollSeconds = interval / 1000;
  timer = window.setTimeout(
    refresh,
    interval,
  );
}
async function refresh() {
  if (request) return;
  const controller = new AbortController();
  request = controller;
  requestTimeout = window.setTimeout(() => {
    controller.abort();
    renderUnavailable();
  }, 12000);
  setRefreshBusy(true);
  try {
    const response = await fetch(ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (controller.signal.aborted || payload?.ok === false || !payload?.cpu || !payload?.memory) throw new Error("Invalid telemetry");
    telemetryStale = false;
    render(payload);
    record(payload);
    renderDashboard(payload);
  } catch (error) {
    if (!controller.signal.aborted) renderUnavailable();
  } finally {
    window.clearTimeout(requestTimeout);
    if (request === controller) request = null;
    setRefreshBusy(false);
    schedule();
  }
}

export function initResourceMonitor() {
  const root = byId("xk-resource-monitor");
  if (!root || initialized) return false;
  initialized = true;
  bindChartInteractions();
  bindCollapsiblePanelState();
  document.querySelectorAll(".xk-dashboard-section").forEach((section) => {
    section.addEventListener("toggle", () => {
      if (section.open) requestAnimationFrame(drawCharts);
    });
  });
  byId("xk-resource-export")?.addEventListener("click", () => {
    setMoreMenuOpen(false);
    exportSnapshot();
  });
  byId("xk-resource-more")?.addEventListener("click", (event) => {
    event.stopPropagation();
    setMoreMenuOpen(byId("xk-resource-more-menu")?.hidden !== false);
  });
  document.addEventListener("click", (event) => {
    const menu = byId("xk-resource-more-menu");
    if (menu && !menu.hidden && !menu.contains(event.target)) setMoreMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const menu = byId("xk-resource-more-menu");
    if (!menu || menu.hidden) return;
    event.stopPropagation();
    setMoreMenuOpen(false);
    byId("xk-resource-more")?.focus();
  }, true);
  const dnsToggle = byId("xk-internet-check-dns-row");
  dnsToggle?.addEventListener("click", toggleDnsGuidance);
  dnsToggle?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") toggleDnsGuidance(event);
  });
  syncDnsGuidanceState(false);
  root.addEventListener("click", () => {
    setDashboardOpen(true);
    if (root.dataset.state !== "ready") void refresh();
  });
  byId("xk-resource-dashboard-close")?.addEventListener("click", () =>
    setDashboardOpen(false),
  );
  byId("xk-resource-dashboard-refresh")?.addEventListener(
    "click",
    () => {
      void refresh();
      void loadDashboardView();
      void loadDnsDiagnostics({ force: true });
    },
  );
  const processPanel = byId("xk-process-panel");
  const syncProcessPanelState = () => {
    if (!processPanel) return;
    const open = processPanel.open;
    processPanel.classList.toggle("is-active", open);
    processPanel.setAttribute("aria-expanded", open ? "true" : "false");
    byId("xk-process-action")?.setAttribute("aria-pressed", open ? "true" : "false");
  };
  syncProcessPanelState();
  processPanel?.addEventListener("toggle", () => {
    syncProcessPanelState();
    if (processPanel.open && !processesLoaded) void loadProcesses();
  });
  const processAction = byId("xk-process-action");
  const activateProcessAction = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!processPanel) return;
    if (!processPanel.open) processPanel.open = true;
    else if (!processesLoaded) void loadProcesses();
  };
  processAction?.addEventListener("click", activateProcessAction);
  processAction?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ")
      activateProcessAction(event);
  });
  byId("xk-process-refresh")?.addEventListener(
    "click",
    () => void loadProcesses(),
  );
  const clientsPanel = byId("xk-clients-panel");
  const syncClientsPanelState = () => {
    if (!clientsPanel) return;
    const open = clientsPanel.open;
    clientsPanel.classList.toggle("is-active", open);
    clientsPanel.setAttribute("aria-expanded", open ? "true" : "false");
    byId("xk-clients-action")?.setAttribute("aria-pressed", clientsLoaded || open ? "true" : "false");
  };
  syncClientsPanelState();
  clientsPanel?.addEventListener("toggle", () => {
    syncClientsPanelState();
    if (clientsPanel.open && !clientsLoaded) void loadClients();
  });
  const clientsAction = byId("xk-clients-action");
  const activateClientsAction = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!clientsPanel) return;
    if (!clientsPanel.open) clientsPanel.open = true;
    else void loadClients();
  };
  clientsAction?.addEventListener("click", activateClientsAction);
  clientsAction?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") activateClientsAction(event);
  });
  byId("xk-clients-show-all")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    clientsShowAll = !clientsShowAll;
    renderClients(latestClientsPayload);
  });
  byId("xk-lte-action")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void loadLte();
  });
  byId("xk-channel-action")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void runChannelCheck();
  });
  byId("xk-channel-trace")?.addEventListener("click", (event) => {
    event.preventDefault();
    const button = event.currentTarget;
    const active = button.getAttribute("aria-pressed") !== "true";
    button.setAttribute("aria-pressed", active ? "true" : "false");
    button.classList.toggle("is-active", active);
    button.setAttribute("data-tooltip", active ? "Traceroute будет выполнен вместе со следующей проверкой" : "Запускать только ping без трассировки");
  });
  document.querySelectorAll("[data-interface-filter]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      interfaceFilter = button.dataset.interfaceFilter === "all" ? "all" : "active";
      setPressedGroup("[data-interface-filter]", button);
      renderInterfaces(latestInterfaces);
    }),
  );
  document.querySelectorAll("[data-resource-range]").forEach((button) =>
    button.addEventListener("click", () => {
      rangeMinutes = Number(button.dataset.resourceRange) || 5;
      setPressedGroup("[data-resource-range]", button);
      drawCharts();
    }),
  );
  window.addEventListener("resize", drawCharts, { passive: true });
  const dashboard = byId("xk-resource-dashboard-modal");
  if (dashboard && typeof MutationObserver === "function") {
    new MutationObserver(() => {
      const isOpen = !dashboard.classList.contains("hidden");
      root.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (isOpen) drawCharts();
    }).observe(dashboard, { attributes: true, attributeFilter: ["class"] });
  }
  dashboard?.addEventListener("click", (event) => {
    if (event.target === dashboard) setDashboardOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      dashboard &&
      !dashboard.classList.contains("hidden")
    ) {
      setDashboardOpen(false);
      root.focus();
    }
  });
  document.addEventListener("visibilitychange", () => {
    window.clearTimeout(timer);
    if (!document.hidden && pollMs) void refresh();
    else schedule();
  });
  void refresh();
  return true;
}
export const resourceMonitorApi = Object.freeze({
  init: initResourceMonitor,
  refresh,
  loadProcesses,
  loadClients,
  loadLte,
  runChannelCheck,
});
