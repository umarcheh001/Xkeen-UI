const ENDPOINT = "/api/system/resources";
const PROCESS_ENDPOINT = "/api/system/processes";
const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
const MAX_HISTORY = 360;

let timer = 0;
let request = null;
let initialized = false;
let history = [];
let rangeMinutes = 5;
let processRequest = null;
let processesLoaded = false;

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
function tone(percent) {
  if (percent >= 90) return "danger";
  if (percent >= 75) return "warning";
  return "normal";
}
function formatPercent(value) {
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
  if (open) {
    try {
      requestAnimationFrame(drawCharts);
    } catch (error) {
      drawCharts();
    }
  }
}

function render(payload) {
  const root = byId("xk-resource-monitor");
  const cpu = byId("xk-resource-cpu");
  const memory = byId("xk-resource-memory");
  const cpuMeter = byId("xk-resource-cpu-meter");
  const memoryMeter = byId("xk-resource-memory-meter");
  const stale = byId("xk-resource-monitor-stale");
  if (!root || !cpu || !memory) return;
  const cpuPercent = clampPercent(payload?.cpu?.percent);
  const memoryPercent = clampPercent(payload?.memory?.percent);
  cpu.textContent = formatPercent(cpuPercent);
  memory.textContent = formatPercent(memoryPercent);
  if (cpuMeter) cpuMeter.style.width = `${cpuPercent}%`;
  if (memoryMeter) memoryMeter.style.width = `${memoryPercent}%`;
  root.dataset.state = "ready";
  root.dataset.cpuTone = tone(cpuPercent);
  root.dataset.memoryTone = tone(memoryPercent);
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
  history.push({
    at: Number(payload?.sampled_at) || Math.round(Date.now() / 1000),
    cpu: clampPercent(payload?.cpu?.percent),
    load: Math.min(100, (Number(payload?.cpu?.load_1m) || 0) * 100),
    memory: clampPercent(payload?.memory?.percent),
    swap: Number(payload?.memory?.swap_total_bytes)
      ? clampPercent(
          ((payload.memory.swap_used_bytes || 0) * 100) /
            payload.memory.swap_total_bytes,
        )
      : 0,
    receive: Number(network.receive_bytes_per_second) || 0,
    send: Number(network.send_bytes_per_second) || 0,
  });
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
}

function renderDashboard(payload) {
  const cpu = Number(payload?.cpu?.percent) || 0;
  const memory = Number(payload?.memory?.percent) || 0;
  const storage = payload?.storage || {};
  const temperature = Number(payload?.temperature_celsius);
  const network = payload?.network || {};
  const swapTotal = Number(payload?.memory?.swap_total_bytes) || 0;
  const values = [cpu, memory, Number(storage.percent) || 0];
  const healthTone = values.some((v) => v >= 90)
    ? "danger"
    : values.some((v) => v >= 75)
      ? "warning"
      : "normal";
  const health = byId("xk-resource-health");
  if (health) health.dataset.tone = healthTone;
  const healthTitle = byId("xk-resource-health-title");
  const healthNote = byId("xk-resource-health-note");
  if (healthTitle)
    healthTitle.textContent =
      healthTone === "danger"
        ? "Нужна проверка системы"
        : healthTone === "warning"
          ? "Есть нагрузка выше обычной"
          : "Система в норме";
  if (healthNote)
    healthNote.textContent =
      healthTone === "normal"
        ? "Критических сигналов не обнаружено"
        : "Откройте графики и проверьте источник нагрузки";
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
    `Load ${Number(payload?.cpu?.load_1m || 0).toFixed(2)} · ${payload?.cpu?.cores || 1} ядер`,
  );
  meter("xk-resource-dashboard-cpu-meter", cpu);
  set("xk-resource-dashboard-memory", formatPercent(memory));
  set(
    "xk-resource-dashboard-memory-note",
    `${formatBytes(payload?.memory?.used_bytes)} из ${formatBytes(payload?.memory?.total_bytes)}`,
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
    Number.isFinite(temperature) ? `${temperature.toFixed(1)} °C` : "—",
  );
  set(
    "xk-resource-dashboard-uptime",
    `Аптайм ${formatUptime(payload?.uptime_seconds)}`,
  );
  meter(
    "xk-resource-dashboard-temperature-meter",
    Number.isFinite(temperature) ? Math.max(0, temperature * 2) : 0,
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
      : "Не используется",
  );
  set(
    "xk-resource-detail-network",
    `${formatBytes(network.received_bytes)} ↓ · ${formatBytes(network.sent_bytes)} ↑`,
  );
  set(
    "xk-resource-detail-interfaces",
    (network.interfaces || []).map((item) => item.name).join(", ") || "—",
  );
  const freshness = byId("xk-resource-dashboard-freshness");
  if (freshness)
    freshness.textContent = `Обновлено ${new Date((Number(payload?.sampled_at) || Date.now() / 1000) * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  renderRouterDiagnostics(payload?.router);
  drawCharts();
}

function setCheck(name, value) {
  const row = document.querySelector(`[data-internet-check="${name}"]`);
  const label = byId(`xk-internet-check-${name}`);
  const state = value === true ? "ok" : value === false ? "failed" : "unknown";
  if (row) row.dataset.state = state;
  if (label)
    label.textContent =
      value === true
        ? "Доступен"
        : value === false
          ? "Нет связи"
          : "Нет данных";
}

function renderInternet(internet, freshness, rci) {
  const panel = byId("xk-internet-health");
  const available = internet?.available === true;
  const checks = [
    internet?.internet,
    internet?.gateway,
    internet?.dns,
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
  setCheck("dns", available ? internet?.dns : null);
  setCheck("captive", available ? internet?.captive : null);
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
}

function renderInterfaces(interfaces) {
  const body = byId("xk-interface-rows");
  const summary = byId("xk-interface-summary");
  if (!body) return;
  body.replaceChildren();
  const items = Array.isArray(interfaces?.items) ? interfaces.items : [];
  if (!interfaces?.available || !items.length) {
    const row = document.createElement("tr");
    textCell(row, "Интерфейсы RCI недоступны", "xk-resource-table-empty");
    row.firstElementChild.colSpan = 6;
    body.appendChild(row);
    if (summary) summary.textContent = "Данные KeeneticOS недоступны";
    return;
  }
  if (summary) {
    const online = items.filter((item) => item.online === true).length;
    summary.textContent = `${online} активных · ${interfaces.count || items.length} всего`;
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
      formatBitRate(item.receive_bits_per_second),
      "xk-resource-mono",
    );
    textCell(row, formatBitRate(item.send_bits_per_second), "xk-resource-mono");
    const errors =
      Number(item.receive_errors || 0) +
      Number(item.send_errors || 0) +
      Number(item.receive_dropped || 0) +
      Number(item.send_dropped || 0);
    textCell(
      row,
      errors ? errors.toLocaleString() : "0",
      errors ? "xk-interface-errors" : "xk-resource-mono",
    );
    body.appendChild(row);
  });
}

function renderRouterDiagnostics(router) {
  renderInternet(router?.internet, router?.freshness, router?.rci);
  renderConntrack(router?.conntrack);
  renderInterfaces(router?.interfaces);
}

function renderProcesses(payload) {
  const body = byId("xk-process-rows");
  const status = byId("xk-process-status");
  if (!body) return;
  body.replaceChildren();
  const items = Array.isArray(payload?.items) ? payload.items : [];
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
      ? `Показано ${items.length} из ${payload?.count || items.length} · Top CPU/RAM · ${sampled}`
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
  }
}

function drawChart(id, series, maxValue = null) {
  const canvas = byId(id);
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const empty = wrap?.querySelector(".xk-resource-chart-empty");
  const points = history.slice(
    -Math.max(1, Math.round((rangeMinutes * 60) / 5)),
  );
  if (empty) empty.hidden = points.length > 1;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.max(220, Math.floor(rect.width));
  const height = Math.max(120, Math.floor(rect.height));
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const pad = { top: 12, right: 10, bottom: 20, left: 30 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  ctx.strokeStyle = "rgba(150,157,169,.16)";
  ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, SFMono-Regular, monospace";
  ctx.fillStyle = "rgba(150,157,169,.8)";
  for (let i = 0; i <= 3; i += 1) {
    const y = pad.top + (chartH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${Math.round((maxValue ?? 100) * (1 - i / 3))}`, 2, y + 3);
  }
  series.forEach(([key, color]) => {
    const values = points.map((point) => Number(point[key]) || 0);
    if (!values.length) return;
    const max = maxValue ?? Math.max(100, ...values, 1);
    ctx.beginPath();
    values.forEach((value, index) => {
      const x =
        pad.left +
        chartW * (values.length === 1 ? 0.5 : index / (values.length - 1));
      const y = pad.top + chartH * (1 - Math.min(max, value) / max);
      index ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}
function drawCharts() {
  drawChart("xk-resource-chart-cpu", [
    ["cpu", "#7477e8"],
    ["load", "#4db68b"],
  ]);
  drawChart("xk-resource-chart-memory", [
    ["memory", "#4db68b"],
    ["swap", "#d7a650"],
  ]);
  const max = Math.max(
    1,
    ...history.map((point) => Math.max(point.receive, point.send)),
  );
  drawChart(
    "xk-resource-chart-network",
    [
      ["receive", "#5bb8d5"],
      ["send", "#d7a650"],
    ],
    max,
  );
}

function renderUnavailable() {
  const root = byId("xk-resource-monitor");
  const stale = byId("xk-resource-monitor-stale");
  if (!root) return;
  root.dataset.state = "stale";
  root.title = "Не удалось обновить ресурсы роутера. Нажмите, чтобы повторить.";
  if (stale) stale.hidden = false;
}
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(
    refresh,
    document.hidden ? HIDDEN_POLL_MS : POLL_MS,
  );
}
async function refresh() {
  if (request) return;
  const controller = new AbortController();
  request = controller;
  try {
    const response = await fetch(ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    render(payload);
    record(payload);
    renderDashboard(payload);
  } catch (error) {
    if (!controller.signal.aborted) renderUnavailable();
  } finally {
    if (request === controller) request = null;
    schedule();
  }
}

export function initResourceMonitor() {
  const root = byId("xk-resource-monitor");
  if (!root || initialized) return false;
  initialized = true;
  root.addEventListener("click", () => {
    setDashboardOpen(true);
    if (root.dataset.state !== "ready") void refresh();
  });
  byId("xk-resource-dashboard-close")?.addEventListener("click", () =>
    setDashboardOpen(false),
  );
  byId("xk-resource-dashboard-refresh")?.addEventListener(
    "click",
    () => void refresh(),
  );
  const processPanel = byId("xk-process-panel");
  processPanel?.addEventListener("toggle", () => {
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
  document.querySelectorAll("[data-resource-range]").forEach((button) =>
    button.addEventListener("click", () => {
      rangeMinutes = Number(button.dataset.resourceRange) || 5;
      document
        .querySelectorAll("[data-resource-range]")
        .forEach((item) => item.classList.toggle("is-active", item === button));
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
    if (!document.hidden) void refresh();
    else schedule();
  });
  void refresh();
  return true;
}
export const resourceMonitorApi = Object.freeze({
  init: initResourceMonitor,
  refresh,
  loadProcesses,
});
