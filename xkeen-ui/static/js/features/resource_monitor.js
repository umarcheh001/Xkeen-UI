import { metricNumber } from "./resource_monitor_model.js";
import { closeDashboard, exportDashboardSnapshot, loadDashboardTool, openDashboard, refreshDashboard } from "./resource_monitor/dashboard.js";

// The header monitor (CPU and memory next to the bell) and the doors into the diagnostics
// window. It polls /api/system/resources only while the tab is visible; a hidden tab asks
// for nothing, and coming back costs exactly one request.
const ENDPOINT = "/api/system/resources";
const POLL_MS = 5000;

let timer = 0;
let request = null;
let initialized = false;
let pollMs = POLL_MS;
let telemetryStale = false;
let requestTimeout = 0;
let latestResourcePayload = null;

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

function setMoreMenuOpen(open) {
  const menu = byId("xk-resource-more-menu");
  const button = byId("xk-resource-more");
  if (!menu || !button) return;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
}

// The header monitor repaints every few seconds, and most of the time the numbers are the same:
// write only what changed, and edit the text in place (a new text node restyles the whole header).
function setText(element, text) {
  const node = element.firstChild;
  if (node && node.nodeType === 3 && !node.nextSibling) {
    if (node.data !== text) node.data = text;
  } else if (element.textContent !== text) {
    element.textContent = text;
  }
}
function setData(element, key, value) {
  if (element.dataset[key] !== value) element.dataset[key] = value;
}
function setWidth(element, percent) {
  const width = `${percent}%`;
  if (element.style.width !== width) element.style.width = width;
}
function setAttr(element, name, value) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
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
  setText(cpu, formatPercent(cpuPercent));
  setText(memory, formatPercent(memoryPercent));
  if (cpuMeter) setWidth(cpuMeter, clampPercent(cpuPercent));
  if (memoryMeter) setWidth(memoryMeter, clampPercent(memoryPercent));
  setData(root, "state", "ready");
  setData(root, "cpuTone", cpuPercent === null ? "unknown" : tone(cpuPercent));
  setData(root, "memoryTone", memoryPercent === null ? "unknown" : tone(memoryPercent));
  if (stale && !stale.hidden) stale.hidden = true;
  const cores = Math.max(1, Number(payload?.cpu?.cores) || 1);
  const load = Number(payload?.cpu?.load_1m) || 0;
  setAttr(root, "title", `CPU ${formatPercent(cpuPercent)} · load ${load.toFixed(2)} · ${cores} ядер\nRAM ${formatBytes(payload?.memory?.used_bytes)} из ${formatBytes(payload?.memory?.total_bytes)}\nНажмите для диагностики · обновление каждые 5 секунд`);
  setAttr(
    root,
    "aria-label",
    `Ресурсы роутера: CPU ${formatPercent(cpuPercent)}, RAM ${formatPercent(memoryPercent)}. Открыть диагностику`,
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

function renderUnavailable() {
  const root = byId("xk-resource-monitor");
  const stale = byId("xk-resource-monitor-stale");
  if (!root) return;
  root.dataset.state = "stale";
  root.title = "Не удалось обновить ресурсы роутера. Нажмите, чтобы повторить.";
  if (stale) stale.hidden = false;
  telemetryStale = true;
}

function syncTelemetryState() {
  const monitor = byId("xk-resource-monitor");
  if (monitor && !telemetryStale && latestResourcePayload) {
    setAttr(monitor, "title", `CPU ${formatPercent(latestResourcePayload.cpu?.percent)} · RAM ${formatPercent(latestResourcePayload.memory?.percent)}\n${pollMs ? `Обновление каждые ${pollMs / 1000} секунд` : "Автообновление на паузе"} · нажмите для диагностики`);
  }
}

// A hidden tab is not polled at all: the next refresh is scheduled by the visibility handler.
function schedule() {
  window.clearTimeout(timer);
  timer = 0;
  if (!pollMs || document.hidden) return;
  timer = window.setTimeout(() => void refresh(), pollMs);
}
// `visible`: the person asked (the refresh button), so the button shows the wait. The polling
// refresh stays silent; otherwise the open window would restart the button animation every tick.
async function refresh({ visible = false } = {}) {
  if (request) return;
  const controller = new AbortController();
  request = controller;
  requestTimeout = window.setTimeout(() => {
    controller.abort();
    renderUnavailable();
  }, 12000);
  if (visible) setRefreshBusy(true);
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
    syncTelemetryState();
  } catch (error) {
    if (!controller.signal.aborted) renderUnavailable();
  } finally {
    window.clearTimeout(requestTimeout);
    if (request === controller) request = null;
    if (visible) setRefreshBusy(false);
    schedule();
  }
}

export function initResourceMonitor() {
  const root = byId("xk-resource-monitor");
  if (!root || initialized) return false;
  initialized = true;
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
      void refresh({ visible: true });
      void refreshDashboard();
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
    timer = 0;
    if (!document.hidden && pollMs) void refresh();
  });
  if (!document.hidden) void refresh();
  return true;
}
export const resourceMonitorApi = Object.freeze({
  init: initResourceMonitor,
  refresh: () => refresh(),
  // the tool tabs live in the diagnostics window (resource_monitor/tools.js); these open the tab
  loadProcesses: () => loadDashboardTool("procs"),
  loadClients: () => loadDashboardTool("devices"),
  loadLte: () => loadDashboardTool("modems"),
  runChannelCheck: () => loadDashboardTool("ping"),
});
