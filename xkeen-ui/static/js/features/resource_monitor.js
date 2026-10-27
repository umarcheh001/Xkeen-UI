import { metricNumber, resourceHealth } from "./resource_monitor_model.js";
import { closeDashboard, exportDashboardSnapshot, loadDashboardTool, openDashboard, refreshDashboard } from "./resource_monitor/dashboard.js";

const ENDPOINT = "/api/system/resources";
const DNS_DIAGNOSTICS_ENDPOINT = "/api/system/router/dns-diagnostics";
const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
const COLLAPSIBLE_PANEL_SELECTOR = "details.xk-collapsible-panel";

let timer = 0;
let request = null;
let initialized = false;
let pollMs = POLL_MS;
let expectedPollSeconds = POLL_MS / 1000;
let telemetryStale = false;
let requestTimeout = 0;
let dnsGuidanceOpen = false;
let latestResourcePayload = null;
let dnsDiagnostics = null;
let dnsDiagnosticsRequest = null;
let dnsDiagnosticsLoaded = false;

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
  if (open) void openDashboard();
  else closeDashboard();
}

let dashboardView = null;
let dashboardViewRequest = null;

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
  renderRouterDiagnostics(payload?.router);
  syncTelemetryState();
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

function renderRouterDiagnostics(router) {
  const internet = router?.internet;
  renderInternet(internet, router?.freshness, router?.rci);
  renderConntrack(router?.conntrack);
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
  bindCollapsiblePanelState();
  byId("xk-resource-export")?.addEventListener("click", () => {
    setMoreMenuOpen(false);
    exportDashboardSnapshot();
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
      void refreshDashboard();
      void loadDnsDiagnostics({ force: true });
    },
  );
  const dashboard = byId("xk-resource-dashboard-modal");
  if (dashboard && typeof MutationObserver === "function") {
    new MutationObserver(() => {
      const isOpen = !dashboard.classList.contains("hidden");
      root.setAttribute("aria-expanded", isOpen ? "true" : "false");
      if (isOpen) void openDashboard();
      else closeDashboard();
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
  // the tool tabs live in the diagnostics window (resource_monitor/tools.js); these open the tab
  loadProcesses: () => loadDashboardTool("procs"),
  loadClients: () => loadDashboardTool("devices"),
  loadLte: () => loadDashboardTool("modems"),
  runChannelCheck: () => loadDashboardTool("ping"),
});
