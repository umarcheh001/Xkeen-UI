const ENDPOINT = '/api/system/resources';
const POLL_MS = 5000;

let initialized = false;
let timer = 0;
let request = null;

function root() {
  return document.getElementById('xk-resource-monitor-install-offer');
}

function percent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function format(value) {
  return value == null ? '—' : `${Math.round(value * 10) / 10}%`;
}

function renderItem(item, payload) {
  const value = percent(payload);
  const strong = item?.querySelector('strong');
  const meter = item?.querySelector('.xk-resource-meter i');
  if (strong) strong.textContent = format(value);
  if (meter) meter.style.width = value == null ? '0%' : `${value}%`;
  return value;
}

function render(payload) {
  const monitor = root();
  if (!monitor) return;
  const cpu = renderItem(monitor.querySelector('.xk-resource-monitor-item:nth-child(1)'), payload?.cpu?.percent);
  const memory = renderItem(monitor.querySelector('.xk-resource-monitor-item:nth-child(2)'), payload?.memory?.percent);
  monitor.dataset.cpuTone = cpu >= 90 ? 'danger' : cpu >= 75 ? 'warning' : 'normal';
  monitor.dataset.memoryTone = memory >= 90 ? 'danger' : memory >= 75 ? 'warning' : 'normal';
}

async function refresh() {
  if (request) return request;
  request = fetch(ENDPOINT, { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => {
      if (!response.ok) throw new Error(`http ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      if (payload?.ok !== false) render(payload);
    })
    .catch(() => {})
    .finally(() => { request = null; });
  return request;
}

export function initResourceSummary() {
  const monitor = root();
  if (!monitor || initialized) return false;
  initialized = true;
  void refresh();
  timer = window.setInterval(() => { void refresh(); }, POLL_MS);
  return true;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initResourceSummary, { once: true });
} else {
  initResourceSummary();
}
