import { iconHtml } from '../../ui/operator_icons.js';
import { confirmMihomoAction } from '../mihomo_runtime.js';
import {
  disconnectAllMihomoClashConnections,
  disconnectMihomoClashConnection,
  fetchMihomoClashConnections,
  mihomoClashConnectionsWsUrl,
  requestMihomoClashWsToken,
} from './client.js';

const HTTP_FALLBACK_INTERVAL_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 15000;
const PAGE_SIZE = 100;
const MAX_CLOSED_CONNECTIONS = 300;

let root = null;
let active = false;
let capabilities = {};
let snapshot = null;
let previousTotals = null;
let rates = { download: 0, upload: 0 };
let filterText = '';
let networkFilter = 'all';
let sortMode = 'traffic';
let sortDirection = 'desc';
let connectionView = 'active';
let closedConnections = new Map();
let ws = null;
let request = null;
let timer = 0;
let generation = 0;
let reconnectAttempt = 0;
let selectedId = '';
let pendingId = '';
let pendingAll = false;

function byId(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(value, suffix = '') {
  const bytes = Math.max(0, Number(value) || 0);
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let size = bytes;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  const digits = index === 0 || size >= 100 ? 0 : (size >= 10 ? 1 : 2);
  return `${size.toFixed(digits)} ${units[index]}${suffix}`;
}

function startTime(row) {
  const value = Date.parse(String(row?.start || ''));
  return Number.isFinite(value) ? value : 0;
}

function formatAge(row) {
  const started = startTime(row);
  if (!started) return '—';
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  if (seconds < 60) return `${seconds} с`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} мин`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
  return `${Math.floor(seconds / 86400)} д`;
}

function destination(row) {
  const metadata = row?.metadata || {};
  const host = metadata.sniff_host || metadata.host || metadata.destination_ip || '—';
  return metadata.destination_port ? `${host}:${metadata.destination_port}` : host;
}

function destinationHost(row) {
  const metadata = row?.metadata || {};
  return metadata.sniff_host || metadata.host || metadata.destination_ip || '';
}

function source(row) {
  const metadata = row?.metadata || {};
  const address = metadata.source_port ? `${metadata.source_ip}:${metadata.source_port}` : metadata.source_ip;
  return { name: metadata.source_name || '', address: address || '—' };
}

function deviceNameMarkup(name, ip) {
  if (!name) return '';
  return `<span class="xk-mihomo-device-name" title="Имя устройства для ${escapeHtml(ip)}">${escapeHtml(name)}</span>`;
}

function routeText(row) {
  const chains = Array.isArray(row?.chains) ? row.chains : [];
  return chains.length ? chains.join(' → ') : '—';
}

function searchText(row) {
  const metadata = row?.metadata || {};
  return [
    row?.id, metadata.source_name, metadata.source_ip, metadata.host, metadata.sniff_host,
    metadata.destination_ip, metadata.remote_destination, metadata.dns_mode,
    metadata.inbound_ip, metadata.inbound_name, metadata.process, metadata.process_path,
    row?.rule, row?.rule_payload, row?.closed_at,
    ...(row?.chains || []), ...(row?.provider_chains || []),
  ].join(' ').toLocaleLowerCase('ru');
}

function sortValue(row, mode) {
  if (mode === 'age') return startTime(row);
  if (mode === 'source') return `${source(row).name} ${source(row).address}`.trim();
  if (mode === 'destination') return destination(row);
  if (mode === 'route') return routeText(row);
  return (Number(row?.upload) || 0) + (Number(row?.download) || 0);
}

function rows() {
  const sourceRows = connectionView === 'closed'
    ? Array.from(closedConnections.values())
    : (Array.isArray(snapshot?.connections) ? snapshot.connections : []);
  const query = filterText.trim().toLocaleLowerCase('ru');
  const filtered = sourceRows.filter((row) => {
    const network = String(row?.metadata?.network || '').toLowerCase();
    return (networkFilter === 'all' || network === networkFilter) && (!query || searchText(row).includes(query));
  });
  filtered.sort((a, b) => {
    const aValue = sortValue(a, sortMode);
    const bValue = sortValue(b, sortMode);
    const comparison = typeof aValue === 'number' && typeof bValue === 'number'
      ? aValue - bValue
      : String(aValue).localeCompare(String(bValue), 'ru', { numeric: true, sensitivity: 'base' });
    return sortDirection === 'asc' ? comparison : -comparison;
  });
  return filtered.slice(0, PAGE_SIZE);
}

function selectedRow() {
  return (snapshot?.connections || []).find((item) => item.id === selectedId)
    || closedConnections.get(selectedId)
    || null;
}

function setText(id, value) { const element = byId(id); if (element) element.textContent = String(value); }

function setNotice(value, tone = 'neutral') {
  const notice = byId('mihomo-clash-connections-notice');
  if (!notice) return;
  notice.textContent = String(value || '');
  notice.dataset.tone = tone;
}

function setStreamState(state, copy) {
  if (root) root.dataset.streamState = state;
  setText('mihomo-clash-stream-state', copy);
}

function setFallbackNotice() {
  const bounded = snapshot?.truncated
    ? ` Показаны первые ${snapshot.connections.length} соединений из ${snapshot.total_connections}.`
    : '';
  setNotice(`HTTP fallback активен: обновление каждые 2 секунды.${bounded}`, 'warning');
}

function updateRates(next, receivedAt = Date.now()) {
  const download = Math.max(0, Number(next?.download_total) || 0);
  const upload = Math.max(0, Number(next?.upload_total) || 0);
  if (previousTotals) {
    const seconds = Math.max(.1, (receivedAt - previousTotals.receivedAt) / 1000);
    rates.download = download >= previousTotals.download ? (download - previousTotals.download) / seconds : 0;
    rates.upload = upload >= previousTotals.upload ? (upload - previousTotals.upload) / seconds : 0;
  } else {
    rates = { download: 0, upload: 0 };
  }
  previousTotals = { download, upload, receivedAt };
}

function renderSummary() {
  setText('mihomo-clash-connection-count', snapshot?.total_connections || 0);
  setText('mihomo-clash-active-tab-count', snapshot?.total_connections || 0);
  setText('mihomo-clash-closed-count', closedConnections.size);
  setText('mihomo-clash-download-rate', formatBytes(rates.download, '/с'));
  setText('mihomo-clash-upload-rate', formatBytes(rates.upload, '/с'));
  setText('mihomo-clash-download-total', `всего ${formatBytes(snapshot?.download_total || 0)}`);
  setText('mihomo-clash-upload-total', `всего ${formatBytes(snapshot?.upload_total || 0)}`);
  setText('mihomo-clash-memory', snapshot?.memory == null ? '—' : formatBytes(snapshot.memory));
  const disconnectAll = byId('mihomo-clash-disconnect-all');
  if (disconnectAll) disconnectAll.disabled = pendingAll || !(snapshot?.total_connections > 0) || capabilities.connection_disconnect === false;
}

function filterButton(value, label, content, className = '') {
  if (!value) return escapeHtml(content || '—');
  return `<button type="button" class="xk-mihomo-connection-value ${className}" data-mihomo-connection-filter="${escapeHtml(value)}" aria-label="Фильтровать по ${escapeHtml(label)}">${content || escapeHtml(value)}</button>`;
}

function copyButton(value, label) {
  if (!value) return '';
  return `<button type="button" class="xk-mihomo-connection-copy btn-secondary btn-icon" data-mihomo-connection-copy="${escapeHtml(value)}" aria-label="Копировать ${escapeHtml(label)}" title="Копировать ${escapeHtml(label)}">${iconHtml('duplicate')}</button>`;
}

function rowMarkup(row) {
  const origin = source(row);
  const metadata = row?.metadata || {};
  const network = String(metadata.network || '—').toUpperCase();
  const traffic = `${formatBytes(row?.download || 0)} ↓ · ${formatBytes(row?.upload || 0)} ↑`;
  const route = routeText(row);
  const rule = [row?.rule, row?.rule_payload].filter(Boolean).join(' · ') || 'Правило —';
  const sourceFilter = origin.name || metadata.source_ip;
  const closed = connectionView === 'closed';
  return `<tr data-connection-id="${escapeHtml(row.id)}" data-connection-state="${closed ? 'closed' : 'active'}" tabindex="0" aria-label="Открыть детали соединения ${escapeHtml(destination(row))}">
    <td data-label="Источник"><strong>${filterButton(sourceFilter, 'источнику', `${escapeHtml(origin.address)}${deviceNameMarkup(origin.name, metadata.source_ip)}`)}</strong><small>${filterButton(metadata.network, 'протоколу', escapeHtml(network))}</small></td>
    <td data-label="Назначение"><strong>${filterButton(destinationHost(row), 'назначению', escapeHtml(destination(row)))}</strong><small>${escapeHtml(metadata.destination_ip || '')}</small></td>
    <td data-label="Маршрут"><strong>${filterButton((row?.chains || [])[0] || route, 'маршруту', escapeHtml(route))}</strong><small>${filterButton(row?.rule_payload || row?.rule, 'правилу', escapeHtml(rule))}</small></td>
    <td data-label="Трафик"><strong>${escapeHtml(traffic)}</strong></td>
    <td data-label="Возраст"><strong>${escapeHtml(formatAge(row))}</strong></td>
    <td data-label="Действие">${closed ? '<span class="xk-mihomo-closed-mark">Закрыто</span>' : `<button type="button" class="btn-secondary btn-icon xk-mihomo-connection-close" data-mihomo-connection-close="${escapeHtml(row.id)}" aria-label="Завершить соединение" title="Завершить соединение" ${pendingId ? 'disabled' : ''}>${pendingId === row.id ? iconHtml('loading') : iconHtml('close')}</button>`}</td>
  </tr>`;
}

function renderRows() {
  const body = byId('mihomo-clash-connections-rows');
  const empty = byId('mihomo-clash-connections-empty');
  if (!body || !empty) return;
  const visibleRows = rows();
  body.innerHTML = visibleRows.map(rowMarkup).join('');
  empty.hidden = visibleRows.length > 0;
  if (!visibleRows.length) empty.textContent = filterText.trim()
    ? 'Соединения по текущему фильтру не найдены.'
    : (connectionView === 'closed' ? 'Недавно закрытых соединений нет.' : 'Активных соединений нет.');
  if (connectionView === 'active' && snapshot?.truncated) setNotice(`Показаны первые ${snapshot.connections.length} соединений из ${snapshot.total_connections}.`, 'warning');
  root?.querySelectorAll('[data-mihomo-connection-sort]').forEach((button) => {
    const activeSort = button.dataset.mihomoConnectionSort === sortMode;
    button.classList.toggle('is-active', activeSort);
    button.setAttribute('aria-sort', activeSort ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    const indicator = button.querySelector('span');
    if (indicator) indicator.textContent = activeSort ? (sortDirection === 'asc' ? '↑' : '↓') : '↕';
  });
}

function renderViewTabs() {
  root?.querySelectorAll('[data-mihomo-connections-view]').forEach((button) => {
    const selected = button.dataset.mihomoConnectionsView === connectionView;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  const clear = byId('mihomo-clash-closed-clear');
  if (clear) clear.hidden = connectionView !== 'closed' || !closedConnections.size;
  const disconnectAllButton = byId('mihomo-clash-disconnect-all');
  if (disconnectAllButton) disconnectAllButton.hidden = connectionView === 'closed';
}

function renderInspector() {
  const inspector = byId('mihomo-clash-connection-inspector');
  const details = byId('mihomo-clash-connection-inspector-details');
  if (!inspector || !details) return;
  const ruleLink = byId('mihomo-clash-connection-rule-link');
  const row = selectedRow();
  inspector.hidden = !row;
  if (ruleLink) ruleLink.hidden = !row?.rule;
  const copyAll = byId('mihomo-clash-connection-copy');
  if (copyAll) copyAll.hidden = !row;
  if (!row) { details.innerHTML = ''; return; }
  const metadata = row.metadata || {};
  const fields = [
    ['Состояние', closedConnections.has(row.id) ? 'Недавно закрыто' : 'Активно'],
    ['Устройство', source(row).name, source(row).name],
    ['IP источника', metadata.source_ip, metadata.source_ip],
    ['Порт источника', metadata.source_port],
    ['Назначение', destination(row), destinationHost(row)],
    ['IP назначения', metadata.destination_ip, metadata.destination_ip],
    ['Порт назначения', metadata.destination_port],
    ['Удалённый адрес', metadata.remote_destination, metadata.remote_destination],
    ['Сеть', metadata.network, metadata.network], ['Тип', metadata.type],
    ['DNS режим', metadata.dns_mode],
    ['Inbound', metadata.inbound_name],
    ['Inbound адрес', [metadata.inbound_ip, metadata.inbound_port].filter(Boolean).join(':')],
    ['Inbound user', metadata.inbound_user],
    ['Процесс', metadata.process], ['Путь процесса', metadata.process_path], ['UID', metadata.uid],
    ['Правило', row.rule, row.rule], ['Payload правила', row.rule_payload, row.rule_payload],
    ['Цепочка', routeText(row), (row.chains || [])[0] || routeText(row)],
    ['Provider chain', (row.provider_chains || []).join(' → ')],
    ['Получено', formatBytes(row.download || 0)], ['Отдано', formatBytes(row.upload || 0)],
    ['Начало', row.start], ['Закрыто', row.closed_at],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  details.innerHTML = fields.map(([label, value, filterValue]) => `<div><dt>${escapeHtml(label)}</dt><dd><span>${filterValue ? filterButton(filterValue, label, escapeHtml(value)) : escapeHtml(value)}</span>${copyButton(value, label)}</dd></div>`).join('');
}

function render() { renderSummary(); renderViewTabs(); renderRows(); renderInspector(); }

function rememberClosedConnections(nextConnections, closedAt = Date.now(), authoritative = true) {
  const previous = Array.isArray(snapshot?.connections) ? snapshot.connections : [];
  const nextIds = new Set(nextConnections.map((row) => row.id));
  if (authoritative) {
    for (const row of previous) {
      if (!nextIds.has(row.id) && row?.id) {
        closedConnections.delete(row.id);
        closedConnections.set(row.id, { ...row, closed_at: new Date(closedAt).toISOString() });
      }
    }
  }
  for (const row of nextConnections) closedConnections.delete(row.id);
  while (closedConnections.size > MAX_CLOSED_CONNECTIONS) {
    closedConnections.delete(closedConnections.keys().next().value);
  }
}

export function reconcileMihomoClosedConnectionsForTest(previousRows, nextRows, options = {}) {
  const priorSnapshot = snapshot;
  const priorClosed = closedConnections;
  try {
    snapshot = { connections: Array.isArray(previousRows) ? previousRows : [] };
    closedConnections = new Map();
    rememberClosedConnections(Array.isArray(nextRows) ? nextRows : [], options.closedAt || 0, options.authoritative !== false);
    return Array.from(closedConnections.values());
  } finally {
    snapshot = priorSnapshot;
    closedConnections = priorClosed;
  }
}

function applySnapshot(next, receivedAt = Date.now()) {
  if (!next || Number(next.schema_version) !== 1) return false;
  updateRates(next, receivedAt);
  // A missing ID in a truncated snapshot is not proof that the connection
  // closed; it may simply have moved outside the bounded first page.
  rememberClosedConnections(Array.isArray(next.connections) ? next.connections : [], receivedAt, next.truncated !== true);
  snapshot = next;
  render();
  return true;
}

function clearScheduled() { if (timer) window.clearTimeout(timer); timer = 0; }

function abortRequest() {
  if (request) { try { request.abort(); } catch (error) {} }
  request = null;
}

function closeSocket() {
  const socket = ws;
  ws = null;
  if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; try { socket.close(); } catch (error) {} }
}

function scheduleFallback(runGeneration, delay = HTTP_FALLBACK_INTERVAL_MS) {
  clearScheduled();
  timer = window.setTimeout(() => { if (active && runGeneration === generation) void pollSnapshot(runGeneration); }, delay);
}

async function pollSnapshot(runGeneration, immediate = false) {
  if (!active || runGeneration !== generation) return;
  abortRequest();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  request = controller;
  setStreamState('fallback', 'HTTP fallback');
  if (immediate) root?.setAttribute('aria-busy', 'true');
  try {
    const payload = await fetchMihomoClashConnections({ signal: controller?.signal });
    if (!active || runGeneration !== generation) return;
    capabilities = payload?.capabilities || capabilities;
    applySnapshot(payload, Date.now());
    setFallbackNotice();
  } catch (error) {
    if (!controller?.signal.aborted && active) {
      setStreamState('error', 'Ошибка');
      setNotice('Не удалось получить соединения. Повторяем запрос.', 'danger');
    }
  } finally {
    if (request === controller) request = null;
    root?.setAttribute('aria-busy', 'false');
    if (active && runGeneration === generation) scheduleFallback(runGeneration);
  }
}

function reconnectDelay() {
  const base = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * (2 ** Math.min(4, reconnectAttempt)));
  reconnectAttempt += 1;
  return Math.round(base * (.8 + Math.random() * .4));
}

async function openSocket(runGeneration) {
  if (!active || runGeneration !== generation || capabilities.connections_stream === false || typeof WebSocket !== 'function') {
    void pollSnapshot(runGeneration, true); return;
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  request = controller;
  setStreamState(reconnectAttempt ? 'reconnecting' : 'connecting', reconnectAttempt ? 'Переподключение' : 'Подключение');
  try {
    const token = await requestMihomoClashWsToken({
      signal: controller?.signal,
      scope: 'mihomo-clash',
    });
    if (!active || runGeneration !== generation || !token) return;
    // A status refresh and a subview activation may finish their bootstrap at
    // nearly the same time. Replace the older socket before assigning the new
    // one so there is still exactly one live browser stream.
    closeSocket();
    const socket = new WebSocket(mihomoClashConnectionsWsUrl(token));
    ws = socket;
    socket.onopen = () => { if (ws === socket) { reconnectAttempt = 0; setStreamState('live', 'Live'); setNotice('Live stream активен.', 'positive'); } };
    socket.onmessage = (event) => {
      if (!active || ws !== socket) return;
      let message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message?.type !== 'mihomo-clash-connections' || Number(message.schema_version) !== 1) return;
      if (message.state === 'live' && applySnapshot(message.payload, Number(message.received_at_ms) || Date.now())) return;
      if (message.state === 'error') {
        const code = String(message.error?.code || 'stream_failed');
        if (code === 'stream_busy') {
          setStreamState('reconnecting', 'Переподключение');
          setNotice('Предыдущий поток завершается. Подключаемся повторно…', 'neutral');
        } else {
          setNotice(`Live stream: ${code}.`, 'warning');
        }
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (!active || runGeneration !== generation) return;
      if (reconnectAttempt >= 3) { void pollSnapshot(runGeneration, true); return; }
      setStreamState('reconnecting', 'Переподключение');
      clearScheduled();
      timer = window.setTimeout(() => void openSocket(runGeneration), reconnectDelay());
    };
  } catch (error) {
    if (!controller?.signal.aborted && active && runGeneration === generation) void pollSnapshot(runGeneration, true);
  } finally {
    if (request === controller) request = null;
  }
}

async function disconnectOne(id) {
  if (!active || pendingId || !id) return;
  const ok = await confirmMihomoAction({
    title: 'Завершить соединение?', message: 'Mihomo немедленно закроет выбранное соединение.',
    okText: 'Завершить', cancelText: 'Оставить', danger: true,
  }, 'Завершить выбранное соединение?');
  if (!ok || !active) return;
  pendingId = id; renderRows();
  try {
    await disconnectMihomoClashConnection(id);
    setNotice('Команда отправлена. Строка исчезнет после подтверждённого snapshot.', 'positive');
    if (!ws) void pollSnapshot(generation, true);
  } catch (error) {
    setNotice('Не удалось завершить соединение; подтверждённая строка сохранена.', 'danger');
  } finally { pendingId = ''; renderRows(); }
}

async function disconnectAll() {
  const count = Number(snapshot?.total_connections) || 0;
  if (!active || pendingAll || !count) return;
  const ok = await confirmMihomoAction({
    title: `Завершить все соединения (${count})?`,
    message: `Mihomo немедленно закроет ${count} активных соединений. Новые соединения могут появиться сразу после действия.`,
    okText: `Завершить ${count}`, cancelText: 'Отменить', danger: true,
  }, `Завершить все соединения (${count})?`);
  if (!ok || !active) return;
  pendingAll = true; renderSummary();
  try {
    await disconnectAllMihomoClashConnections(count);
    setNotice('Команда отправлена. Список обновится только по следующему snapshot.', 'positive');
    if (!ws) void pollSnapshot(generation, true);
  } catch (error) {
    setNotice(error?.data?.code === 'connection_count_changed'
      ? 'Количество соединений изменилось. Обновите список и подтвердите снова.'
      : 'Не удалось завершить все соединения.', 'danger');
  } finally { pendingAll = false; renderSummary(); }
}

async function copyText(value, label = 'Значение') {
  const text = String(value || '');
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    setNotice(`${label} скопировано.`, 'positive');
    return true;
  } catch (error) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    setNotice(copied ? `${label} скопировано.` : 'Не удалось скопировать значение.', copied ? 'positive' : 'danger');
    return copied;
  }
}

function inspectorCopyText(row) {
  if (!row) return '';
  const metadata = row.metadata || {};
  return [
    `Состояние: ${closedConnections.has(row.id) ? 'недавно закрыто' : 'активно'}`,
    source(row).name ? `Устройство: ${source(row).name}` : '',
    `Источник: ${source(row).address}`,
    `Назначение: ${destination(row)}`,
    metadata.destination_ip ? `IP назначения: ${metadata.destination_ip}` : '',
    metadata.remote_destination ? `Удалённый адрес: ${metadata.remote_destination}` : '',
    metadata.network ? `Сеть: ${metadata.network}` : '',
    metadata.dns_mode ? `DNS режим: ${metadata.dns_mode}` : '',
    metadata.inbound_name ? `Inbound: ${metadata.inbound_name}` : '',
    metadata.process || metadata.process_path ? `Процесс: ${metadata.process || metadata.process_path}` : '',
    row.rule ? `Правило: ${row.rule}${row.rule_payload ? ` · ${row.rule_payload}` : ''}` : '',
    `Цепочка: ${routeText(row)}`,
    `Трафик: ↓ ${formatBytes(row.download || 0)} · ↑ ${formatBytes(row.upload || 0)}`,
    row.start ? `Начало: ${row.start}` : '',
    row.closed_at ? `Закрыто: ${row.closed_at}` : '',
  ].filter(Boolean).join('\n');
}

function setQuickFilter(value) {
  filterText = String(value || '');
  const input = byId('mihomo-clash-connections-filter');
  if (input) { input.value = filterText; input.focus(); }
  renderRows();
}

function switchConnectionView(nextView) {
  connectionView = nextView === 'closed' ? 'closed' : 'active';
  if (selectedId && !selectedRow()) selectedId = '';
  render();
}

function bind() {
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  byId('mihomo-clash-connections-filter')?.addEventListener('input', (event) => { filterText = event.target.value || ''; renderRows(); });
  byId('mihomo-clash-connections-network')?.addEventListener('change', (event) => { networkFilter = event.target.value || 'all'; renderRows(); });
  byId('mihomo-clash-connections-refresh')?.addEventListener('click', () => {
    if (active) activateMihomoClashConnections(capabilities);
  });
  byId('mihomo-clash-disconnect-all')?.addEventListener('click', () => void disconnectAll());
  byId('mihomo-clash-closed-clear')?.addEventListener('click', () => {
    closedConnections.clear(); selectedId = ''; render();
    setNotice('История недавно закрытых соединений очищена.', 'positive');
  });
  root.addEventListener('click', (event) => {
    const view = event.target.closest?.('[data-mihomo-connections-view]');
    if (view) { switchConnectionView(view.dataset.mihomoConnectionsView); return; }
    const sort = event.target.closest?.('[data-mihomo-connection-sort]');
    if (sort) {
      const nextMode = sort.dataset.mihomoConnectionSort || 'traffic';
      if (sortMode === nextMode) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      else { sortMode = nextMode; sortDirection = nextMode === 'source' || nextMode === 'destination' || nextMode === 'route' ? 'asc' : 'desc'; }
      renderRows(); return;
    }
    const filter = event.target.closest?.('[data-mihomo-connection-filter]');
    if (filter) { event.stopPropagation(); setQuickFilter(filter.dataset.mihomoConnectionFilter); return; }
    const copy = event.target.closest?.('[data-mihomo-connection-copy]');
    if (copy) { event.stopPropagation(); void copyText(copy.dataset.mihomoConnectionCopy, 'Значение'); return; }
    if (event.target.closest?.('[data-mihomo-connection-copy-all]')) {
      event.stopPropagation(); void copyText(inspectorCopyText(selectedRow()), 'Детали соединения'); return;
    }
    const close = event.target.closest?.('[data-mihomo-connection-close]');
    if (close) { event.stopPropagation(); void disconnectOne(close.dataset.mihomoConnectionClose); return; }
    if (event.target.closest?.('[data-mihomo-connection-inspector-close]')) { selectedId = ''; renderInspector(); return; }
    if (event.target.closest?.('[data-mihomo-connection-rule-link]')) {
      const selected = selectedRow();
      if (selected) root.dispatchEvent(new CustomEvent('xkeen:mihomo-clash-open-rule', {
        bubbles: true, detail: { rule: selected.rule, payload: selected.rule_payload },
      }));
      return;
    }
    const row = event.target.closest?.('[data-connection-id]');
    if (row) { selectedId = row.dataset.connectionId || ''; renderInspector(); }
  });
  root.addEventListener('keydown', (event) => {
    const row = event.target.closest?.('[data-connection-id]');
    if (row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); selectedId = row.dataset.connectionId || ''; renderInspector(); }
    if (event.key === 'Escape' && selectedId) { selectedId = ''; renderInspector(); }
  });
}

async function startRuntime() {
  const runGeneration = generation;
  root?.setAttribute('aria-busy', 'true');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  request = controller;
  try {
    const bootstrap = await fetchMihomoClashConnections({ signal: controller?.signal });
    if (!active || runGeneration !== generation) return;
    capabilities = bootstrap?.capabilities || {};
    applySnapshot(bootstrap, Date.now());
    root?.setAttribute('aria-busy', 'false');
    if (capabilities.connections_stream === true) void openSocket(runGeneration);
    else {
      setStreamState('fallback', 'HTTP fallback');
      setFallbackNotice();
      scheduleFallback(runGeneration);
    }
  } catch (error) {
    if (!controller?.signal.aborted && active) void pollSnapshot(runGeneration, true);
  } finally { if (request === controller) request = null; }
}

export function initMihomoClashConnections() {
  root = byId('mihomo-clash-connections');
  if (!root) return false;
  bind(); render(); return true;
}

export function activateMihomoClashConnections(nextCapabilities = {}) {
  if (!root && !initMihomoClashConnections()) return false;
  deactivateMihomoClashConnections();
  active = true;
  capabilities = nextCapabilities || {};
  generation += 1;
  reconnectAttempt = 0;
  previousTotals = null;
  void startRuntime();
  return true;
}

export function deactivateMihomoClashConnections() {
  active = false;
  generation += 1;
  clearScheduled(); abortRequest(); closeSocket();
  setStreamState('paused', 'Пауза');
  root?.setAttribute('aria-busy', 'false');
  return true;
}

export const mihomoClashConnectionsApi = Object.freeze({
  init: initMihomoClashConnections,
  activate: activateMihomoClashConnections,
  deactivate: deactivateMihomoClashConnections,
});
