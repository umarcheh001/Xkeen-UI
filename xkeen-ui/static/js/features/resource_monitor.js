const ENDPOINT = '/api/system/resources';
const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;

let timer = 0;
let request = null;
let initialized = false;

function byId(id) { return document.getElementById(id); }

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number(value) || 0));
}

function formatBytes(value) {
  const amount = Math.max(0, Number(value) || 0);
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let current = amount;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function tone(percent) {
  if (percent >= 90) return 'danger';
  if (percent >= 75) return 'warning';
  return 'normal';
}

function render(payload) {
  const root = byId('xk-resource-monitor');
  const cpu = byId('xk-resource-cpu');
  const memory = byId('xk-resource-memory');
  const cpuMeter = byId('xk-resource-cpu-meter');
  const memoryMeter = byId('xk-resource-memory-meter');
  const stale = byId('xk-resource-monitor-stale');
  if (!root || !cpu || !memory) return;

  const cpuPercent = clampPercent(payload?.cpu?.percent);
  const memoryPercent = clampPercent(payload?.memory?.percent);
  cpu.textContent = `${cpuPercent.toFixed(cpuPercent % 1 ? 1 : 0)}%`;
  memory.textContent = `${memoryPercent.toFixed(memoryPercent % 1 ? 1 : 0)}%`;
  if (cpuMeter) cpuMeter.style.width = `${cpuPercent}%`;
  if (memoryMeter) memoryMeter.style.width = `${memoryPercent}%`;
  root.dataset.state = 'ready';
  root.dataset.cpuTone = tone(cpuPercent);
  root.dataset.memoryTone = tone(memoryPercent);
  if (stale) stale.hidden = true;
  const cores = Math.max(1, Number(payload?.cpu?.cores) || 1);
  const load = Number(payload?.cpu?.load_1m) || 0;
  root.title = `CPU ${cpuPercent}% · load ${load.toFixed(2)} · ${cores} ядер\nRAM ${formatBytes(payload?.memory?.used_bytes)} из ${formatBytes(payload?.memory?.total_bytes)}\nОбновление каждые 5 секунд`;
  root.setAttribute('aria-label', `Ресурсы роутера: CPU ${cpuPercent}%, RAM ${memoryPercent}%`);
}

function renderUnavailable() {
  const root = byId('xk-resource-monitor');
  const stale = byId('xk-resource-monitor-stale');
  if (!root) return;
  root.dataset.state = 'stale';
  root.title = 'Не удалось обновить ресурсы роутера. Нажмите, чтобы повторить.';
  if (stale) stale.hidden = false;
}

function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(refresh, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
}

async function refresh() {
  if (request) return;
  const controller = new AbortController();
  request = controller;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'GET', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    if (!controller.signal.aborted) renderUnavailable();
  } finally {
    if (request === controller) request = null;
    schedule();
  }
}

export function initResourceMonitor() {
  const root = byId('xk-resource-monitor');
  if (!root || initialized) return false;
  initialized = true;
  root.addEventListener('click', () => {
    window.clearTimeout(timer);
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    window.clearTimeout(timer);
    if (!document.hidden) void refresh(); else schedule();
  });
  void refresh();
  return true;
}

export const resourceMonitorApi = Object.freeze({ init: initResourceMonitor, refresh });
