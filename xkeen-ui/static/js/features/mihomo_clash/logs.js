import {
  mihomoClashLogsWsUrl,
  requestMihomoClashWsToken,
} from './client.js';

const MAX_LOG_ROWS = 500;

let root = null;
let active = false;
let generation = 0;
let capabilities = {};
let paused = false;
let level = 'all';
let query = '';
let rows = [];
let socket = null;
let controller = null;
let renderFrame = 0;

function byId(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function searchText(row) {
  return [row?.level, row?.message, ...Object.entries(row?.fields || {}).flat(),
    ...(row?.devices || []).flatMap((device) => [device?.ip, device?.name])]
    .join(' ').toLocaleLowerCase('ru');
}

function annotatedLogText(value, devices) {
  const text = String(value ?? '');
  const aliases = (Array.isArray(devices) ? devices : [])
    .map((device) => ({ ip: String(device?.ip || ''), name: String(device?.name || '') }))
    .filter((device) => device.ip && device.name)
    .sort((a, b) => b.ip.length - a.ip.length);
  if (!aliases.length) return escapeHtml(text);
  let cursor = 0;
  let html = '';
  while (cursor < text.length) {
    let next = null;
    for (const alias of aliases) {
      let index = text.indexOf(alias.ip, cursor);
      while (index >= 0) {
        const left = index > 0 ? text[index - 1] : '';
        const right = text[index + alias.ip.length] || '';
        if (!/[\w.]/u.test(left) && !/[\w.]/u.test(right)) break;
        index = text.indexOf(alias.ip, index + alias.ip.length);
      }
      if (index >= 0 && (!next || index < next.index || (index === next.index && alias.ip.length > next.alias.ip.length))) {
        next = { index, alias };
      }
    }
    if (!next) { html += escapeHtml(text.slice(cursor)); break; }
    html += escapeHtml(text.slice(cursor, next.index + next.alias.ip.length));
    html += `<span class="xk-mihomo-device-name" title="Имя устройства для ${escapeHtml(next.alias.ip)}">${escapeHtml(next.alias.name)}</span>`;
    cursor = next.index + next.alias.ip.length;
  }
  return html;
}

function filteredRows() {
  const needle = query.trim().toLocaleLowerCase('ru');
  return rows.filter((row) => (level === 'all' || row.level === level)
    && (!needle || searchText(row).includes(needle)));
}

function setState(copy, tone = 'neutral') {
  const state = byId('mihomo-clash-logs-state');
  if (!state) return;
  state.textContent = String(copy || '');
  state.dataset.tone = tone;
}

function render() {
  const list = byId('mihomo-clash-logs-list');
  const empty = byId('mihomo-clash-logs-empty');
  if (!list || !empty) return;
  const previousScrollTop = list.scrollTop;
  const followTail = list.hidden
    || list.scrollHeight <= list.clientHeight
    || list.scrollHeight - list.clientHeight - list.scrollTop <= 24;
  const visible = filteredRows();
  list.innerHTML = visible.map((row) => {
    const fields = Object.entries(row.fields || {})
      .map(([key, value]) => `${key}=${value}`).join(' · ');
    return `<li data-log-level="${escapeHtml(row.level)}">
      <time>${escapeHtml(row.time || '—')}</time>
      <strong>${escapeHtml(row.level || 'info')}</strong>
      <span>${annotatedLogText(row.message || '—', row.devices)}</span>
      ${fields ? `<small>${annotatedLogText(fields, row.devices)}</small>` : ''}
    </li>`;
  }).join('');
  list.hidden = visible.length === 0;
  empty.hidden = visible.length > 0;
  if (visible.length) {
    list.scrollTop = followTail ? list.scrollHeight : previousScrollTop;
  }
  empty.textContent = rows.length && !visible.length
    ? 'Записи по текущему фильтру не найдены.'
    : 'Новые записи появятся здесь в реальном времени.';
  if (paused) setState(`Пауза · ${rows.length}/${MAX_LOG_ROWS}`, 'warning');
  else if (socket) setState(`Live · ${rows.length}/${MAX_LOG_ROWS}`, 'positive');
  const pause = byId('mihomo-clash-logs-pause');
  if (pause) {
    pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
    pause.setAttribute('aria-label', paused ? 'Продолжить вывод логов' : 'Пауза логов');
  }
}

function setPaused(nextPaused) {
  paused = !!nextPaused;
  render();
}

function scheduleRender() {
  if (renderFrame) return;
  renderFrame = window.requestAnimationFrame(() => {
    renderFrame = 0;
    if (active && !paused) render();
  });
}

function closeStream() {
  const currentSocket = socket;
  socket = null;
  if (controller) { try { controller.abort(); } catch (error) {} }
  controller = null;
  if (currentSocket) {
    currentSocket.onopen = null;
    currentSocket.onmessage = null;
    currentSocket.onerror = null;
    currentSocket.onclose = null;
    try { currentSocket.close(); } catch (error) {}
  }
}

async function openStream(runGeneration) {
  if (!active || capabilities.logs_stream !== true) {
    setState('Поток логов недоступен без WebSocket runtime.', 'warning');
    render();
    return;
  }
  const requestController = new AbortController();
  controller = requestController;
  setState('Подключение…');
  try {
    const token = await requestMihomoClashWsToken({
      signal: requestController.signal,
      scope: 'mihomo-clash-logs',
    });
    if (!active || generation !== runGeneration || !token) return;
    const nextSocket = new WebSocket(mihomoClashLogsWsUrl(token));
    socket = nextSocket;
    nextSocket.onopen = () => render();
    nextSocket.onmessage = (event) => {
      if (!active || generation !== runGeneration || socket !== nextSocket) return;
      let message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message?.type !== 'mihomo-clash-logs'
        || message.state !== 'live'
        || Number(message.schema_version) !== 1
        || !message.payload) return;
      rows.push(message.payload);
      if (rows.length > MAX_LOG_ROWS) rows.splice(0, rows.length - MAX_LOG_ROWS);
      // A busy Mihomo instance can deliver hundreds of records in one event
      // loop turn. Rebuilding the whole 500-row list for every record makes
      // the controls temporarily unresponsive, so coalesce paints per frame.
      if (!paused) scheduleRender();
      else setState(`Пауза · ${rows.length}/${MAX_LOG_ROWS}`, 'warning');
    };
    nextSocket.onerror = () => setState('Ошибка потока логов.', 'danger');
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null;
      if (active) setState('Поток завершён. Откройте вкладку повторно.', 'warning');
    };
  } catch (error) {
    if (!requestController.signal.aborted) setState('Не удалось открыть поток логов.', 'danger');
  } finally {
    if (controller === requestController) controller = null;
  }
}

function bind() {
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  byId('mihomo-clash-logs-pause')?.addEventListener('click', () => setPaused(!paused));
  byId('mihomo-clash-logs-clear')?.addEventListener('click', () => { rows = []; render(); });
  byId('mihomo-clash-logs-level')?.addEventListener('change', (event) => {
    level = event.target.value || 'all'; render();
  });
  byId('mihomo-clash-logs-filter')?.addEventListener('input', (event) => {
    query = event.target.value || ''; render();
  });
}

export function initMihomoClashLogs() {
  root = byId('mihomo-clash-logs');
  if (!root) return false;
  bind();
  render();
  return true;
}

export function activateMihomoClashLogs(nextCapabilities = {}) {
  if (!root && !initMihomoClashLogs()) return false;
  deactivateMihomoClashLogs();
  active = true;
  paused = false;
  capabilities = nextCapabilities || {};
  generation += 1;
  void openStream(generation);
  return true;
}

export function deactivateMihomoClashLogs() {
  active = false;
  generation += 1;
  if (renderFrame) window.cancelAnimationFrame(renderFrame);
  renderFrame = 0;
  closeStream();
  root?.setAttribute('aria-busy', 'false');
  return true;
}

export const mihomoClashLogsApi = Object.freeze({
  init: initMihomoClashLogs,
  activate: activateMihomoClashLogs,
  deactivate: deactivateMihomoClashLogs,
});
