import { iconHtml } from '../../ui/operator_icons.js';
import {
  fetchMihomoClashTrafficAnalytics,
  traceMihomoClashDomain,
} from './client.js';

let root = null;
let active = false;
let busy = false;
let trafficBusy = false;
let lastResult = null;
let trafficPayload = null;
let currentView = 'traffic';
let trafficTimer = 0;
let trafficRequest = null;

function byId(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(value) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = Math.max(0, Number(value) || 0);
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; }
  const digits = index === 0 || amount >= 100 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function setNotice(message, tone = 'neutral') {
  const notice = byId('mihomo-clash-diagnostics-notice');
  if (!notice) return;
  notice.textContent = String(message || '');
  notice.dataset.tone = tone;
}

function setTrafficNotice(message, tone = 'neutral') {
  const notice = byId('mihomo-clash-traffic-notice');
  if (!notice) return;
  notice.textContent = String(message || '');
  notice.dataset.tone = tone;
}

function setBusy(value) {
  busy = !!value;
  const button = byId('mihomo-clash-diagnostics-run');
  const input = byId('mihomo-clash-diagnostics-domain');
  if (button) {
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    button.innerHTML = busy ? `${iconHtml('loading')}<span>Проверяем…</span>` : `${iconHtml('ping')}<span>Проверить маршрут</span>`;
  }
  if (input) input.disabled = busy;
}

function setTrafficBusy(value) {
  trafficBusy = !!value;
  const button = byId('mihomo-clash-traffic-refresh');
  if (!button) return;
  button.disabled = trafficBusy;
  button.setAttribute('aria-busy', trafficBusy ? 'true' : 'false');
  button.innerHTML = trafficBusy
    ? `${iconHtml('loading')}<span>Обновляем…</span>`
    : `${iconHtml('refresh')}<span>Обновить</span>`;
}

function summaryValue(value, fallback = '—') {
  return value === null || value === undefined || value === '' ? fallback : String(value);
}

function render(result) {
  const output = byId('mihomo-clash-diagnostics-result');
  if (!output) return;
  if (!result) {
    output.hidden = true;
    return;
  }
  output.hidden = false;
  const copy = byId('mihomo-clash-diagnostics-copy');
  if (copy) copy.disabled = false;
  const dns = result.dns || {};
  const rule = result.matched_rule || {};
  const route = result.route || {};
  const dnsValue = Array.isArray(dns.addresses) && dns.addresses.length
    ? dns.addresses.join(', ')
    : 'Ответов нет';
  const cards = [
    ['DNS', dns.ok ? dnsValue : 'Не разрешён', dns.ok ? 'positive' : 'danger'],
    ['Правило', `${summaryValue(rule.type)}${rule.payload ? ` · ${summaryValue(rule.payload)}` : ''}`, rule.result === 'match' ? 'positive' : 'warning'],
    ['Направление', summaryValue(route.policy), route.policy && route.policy !== '—' ? 'positive' : 'warning'],
    ['Конечный узел', `${summaryValue(route.leaf)}${route.leaf_type ? ` · ${route.leaf_type}` : ''}`, route.leaf && route.leaf !== '—' ? 'positive' : 'neutral'],
  ];
  const summary = byId('mihomo-clash-diagnostics-summary');
  if (summary) {
    summary.innerHTML = cards.map(([label, value, tone]) => (
      `<div class="xk-mihomo-diagnostic-stat" data-tone="${tone}"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`
    )).join('');
  }
  const chain = byId('mihomo-clash-diagnostics-chain');
  if (chain) {
    chain.textContent = Array.isArray(route.chain) && route.chain.length ? route.chain.join(' → ') : 'Маршрут не определён';
  }
  const steps = byId('mihomo-clash-diagnostics-steps');
  if (steps) {
    steps.innerHTML = (Array.isArray(result.steps) ? result.steps : []).map((step) => {
      const tone = step.result === 'match' ? 'positive' : step.result === 'unknown' ? 'warning' : 'neutral';
      return `<li class="xk-mihomo-diagnostic-step" data-tone="${tone}">
        <span class="xk-mihomo-diagnostic-step-marker">${step.result === 'match' ? '✓' : step.result === 'unknown' ? '?' : '·'}</span>
        <div><strong>${escapeHtml(step.type || 'Правило')}</strong><code>${escapeHtml(step.payload || '—')}</code><small>${escapeHtml(step.reason || '')}</small></div>
        <em>${escapeHtml(step.target || '—')}</em>
      </li>`;
    }).join('') || '<li class="xk-mihomo-diagnostics-empty">Правила не получены.</li>';
  }
  const truncation = byId('mihomo-clash-diagnostics-truncated');
  if (truncation) truncation.hidden = result.truncated !== true;
}

function resultText(result) {
  const rule = result?.matched_rule || {};
  const route = result?.route || {};
  const dns = result?.dns || {};
  const lines = [
    'Xkeen UI · диагностика Mihomo',
    `Домен: ${result?.domain || '—'}`,
    `DNS: ${dns.ok ? (dns.addresses || []).join(', ') || 'успешно' : 'ошибка'}`,
    `Правило: ${rule.type || '—'}${rule.payload ? ` ${rule.payload}` : ''}`,
    `Направление: ${route.policy || '—'}`,
    `Цепочка: ${(route.chain || []).join(' → ') || '—'}`,
    `Конечный узел: ${route.leaf || '—'}${route.leaf_type ? ` (${route.leaf_type})` : ''}`,
    '',
    ...(result?.steps || []).map((step) => `[${step.result}] ${step.type} ${step.payload} → ${step.target}: ${step.reason}`),
  ];
  return lines.join('\n');
}

function renderTrafficSummary(payload) {
  const summary = payload?.summary || {};
  const target = byId('mihomo-clash-traffic-summary');
  if (!target) return;
  const cards = [
    ['Всего учтено', formatBytes(summary.total_bytes), 'neutral'],
    ['Через Mihomo', formatBytes(summary.mihomo_bytes), 'positive'],
    ['Вне Mihomo · оценка', formatBytes(summary.outside_bytes), summary.outside_bytes ? 'warning' : 'neutral'],
    ['Устройства / маршруты', `${summary.device_count || 0} / ${summary.route_count || 0}`, 'neutral'],
  ];
  target.innerHTML = cards.map(([label, value, tone]) => (
    `<div class="xk-mihomo-diagnostic-stat" data-tone="${tone}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  )).join('');
}

function renderTrafficChart(payload) {
  const target = byId('mihomo-clash-traffic-chart');
  if (!target) return;
  const rows = Array.isArray(payload?.series) ? payload.series : [];
  const points = rows.filter((item) => Number(item?.total_bytes) > 0);
  if (!points.length) {
    target.innerHTML = '<div class="xk-mihomo-traffic-empty">Данных для графика пока нет.</div>';
    return;
  }
  const width = Math.max(320, Math.round(target.clientWidth || 1000));
  const height = 220;
  const padding = { top: 18, right: 12, bottom: 32, left: 54 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...points.map((item) => Number(item.total_bytes) || 0), 1);
  const x = (index) => padding.left + (points.length === 1 ? innerWidth / 2 : index * innerWidth / (points.length - 1));
  const y = (value) => padding.top + innerHeight - (Math.max(0, Number(value) || 0) / maxValue) * innerHeight;
  const path = (field) => points.map((item, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(item[field]).toFixed(1)}`).join(' ');
  const tickIndexes = Array.from(new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]));
  const yTicks = [0, .5, 1];
  target.innerHTML = `<svg class="xk-mihomo-traffic-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Трафик через Mihomo и вне Mihomo">
    ${yTicks.map((ratio) => `<line x1="${padding.left}" y1="${y(maxValue * ratio)}" x2="${width - padding.right}" y2="${y(maxValue * ratio)}" class="grid"/><text x="${padding.left - 8}" y="${y(maxValue * ratio) + 4}" text-anchor="end">${escapeHtml(formatBytes(maxValue * ratio))}</text>`).join('')}
    <path d="${path('outside_bytes')}" class="outside"/>
    <path d="${path('mihomo_bytes')}" class="mihomo"/>
    ${tickIndexes.map((index) => `<text x="${x(index)}" y="${height - 8}" text-anchor="${index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}">${new Date(Number(points[index].at) * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</text>`).join('')}
  </svg><div class="xk-mihomo-traffic-legend"><span><i class="is-mihomo"></i>Через Mihomo</span><span><i class="is-outside"></i>Вне Mihomo · оценка</span></div>`;
}

function routeBar(route, total) {
  const bytes = (Number(route?.download) || 0) + (Number(route?.upload) || 0);
  const width = total > 0 ? Math.max(2, Math.min(100, bytes * 100 / total)) : 0;
  return `<div class="xk-mihomo-device-route">
    <div><strong>${escapeHtml(route?.route || '—')}</strong><span>${escapeHtml(route?.node || '—')}</span><em>${escapeHtml(formatBytes(bytes))}</em></div>
    <i><b style="width:${width.toFixed(1)}%"></b></i>
  </div>`;
}

function renderTrafficDevices(payload) {
  const target = byId('mihomo-clash-traffic-devices');
  if (!target) return;
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  target.innerHTML = devices.slice(0, 24).map((device) => {
    const total = Number(device.total_bytes) || 0;
    const mihomo = Number(device.mihomo_bytes) || 0;
    const outside = Number(device.outside_bytes) || 0;
    const routes = Array.isArray(device.routes) ? device.routes : [];
    return `<article class="xk-mihomo-traffic-device">
      <header><div><strong>${escapeHtml(device.name || device.ip || 'Устройство')}</strong><span>${escapeHtml(device.ip || '')}</span></div><em>${escapeHtml(formatBytes(total))}</em></header>
      <div class="xk-mihomo-device-split" role="img" aria-label="${escapeHtml(`Через Mihomo ${formatBytes(mihomo)}, вне Mihomo ${formatBytes(outside)}`)}"><i class="is-mihomo" style="width:${total ? mihomo * 100 / total : 0}%"></i><i class="is-outside" style="width:${total ? outside * 100 / total : 0}%"></i></div>
      <div class="xk-mihomo-device-meta"><span>Через Mihomo <strong>${escapeHtml(formatBytes(mihomo))}</strong></span><span>Вне Mihomo · оценка <strong>${escapeHtml(formatBytes(outside))}</strong></span></div>
      <div class="xk-mihomo-device-routes">${routes.length ? routes.map((route) => routeBar(route, Math.max(mihomo, 1))).join('') : '<span class="xk-mihomo-traffic-empty">Маршруты ещё не накоплены.</span>'}</div>
    </article>`;
  }).join('') || '<div class="xk-mihomo-traffic-empty">Устройства появятся после накопления трафика.</div>';
}

function renderTrafficTables(payload) {
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  const routeBody = byId('mihomo-clash-traffic-routes');
  if (routeBody) {
    routeBody.innerHTML = routes.slice(0, 24).map((item) => `<tr><td>${escapeHtml(item.route || '—')}</td><td>${escapeHtml(item.node || '—')}</td><td>${Number(item.device_count) || 0}</td><td>${escapeHtml(formatBytes(item.bytes))}</td></tr>`).join('') || '<tr><td colspan="4">Данных пока нет.</td></tr>';
  }
  const resources = Array.isArray(payload?.resources) ? payload.resources : [];
  const resourceBody = byId('mihomo-clash-traffic-resources');
  if (resourceBody) {
    resourceBody.innerHTML = resources.slice(0, 24).map((item) => `<tr><td>${escapeHtml(item.resource || '—')}</td><td>${escapeHtml((item.devices || []).join(', ') || '—')}</td><td>${escapeHtml((item.routes || []).join(', ') || '—')}</td><td>${escapeHtml(formatBytes(item.bytes))}</td></tr>`).join('') || '<tr><td colspan="4">Данных пока нет.</td></tr>';
  }
}

function renderTraffic(payload) {
  trafficPayload = payload;
  const content = byId('mihomo-clash-traffic-content');
  if (content) content.hidden = false;
  renderTrafficSummary(payload);
  renderTrafficChart(payload);
  renderTrafficDevices(payload);
  renderTrafficTables(payload);
  const coverage = byId('mihomo-clash-traffic-coverage');
  if (coverage) {
    coverage.textContent = payload?.coverage?.keenetic_client_counters
      ? 'Mihomo + общие счётчики Keenetic · выборочное наблюдение'
      : 'Только трафик через Mihomo · выборочное наблюдение';
  }
}

async function refreshTraffic({ quiet = false } = {}) {
  if (trafficBusy || !active || currentView !== 'traffic') return false;
  setTrafficBusy(true);
  if (!quiet) setTrafficNotice('Читаем локальную историю трафика…', 'neutral');
  const controller = new AbortController();
  trafficRequest = controller;
  try {
    const range = byId('mihomo-clash-traffic-range')?.value || '24h';
    const payload = await fetchMihomoClashTrafficAnalytics(range, { signal: controller.signal });
    if (!active || currentView !== 'traffic' || trafficRequest !== controller) return false;
    renderTraffic(payload);
    const last = payload?.collection?.last_sample_at;
    const error = payload?.collection?.last_error;
    setTrafficNotice(
      error
        ? `Последний сбор завершился ошибкой: ${error}. Показана накопленная история.`
        : `Сбор активен${last ? ` · последний снимок ${new Date(last * 1000).toLocaleTimeString('ru-RU')}` : ''}.`,
      error ? 'warning' : 'positive',
    );
    return true;
  } catch (error) {
    if (error?.name !== 'AbortError') setTrafficNotice(error?.message || 'Статистика трафика недоступна.', 'danger');
    return false;
  } finally {
    if (trafficRequest === controller) trafficRequest = null;
    setTrafficBusy(false);
  }
}

function scheduleTraffic() {
  if (trafficTimer) window.clearInterval(trafficTimer);
  trafficTimer = 0;
  if (!active || currentView !== 'traffic') return;
  trafficTimer = window.setInterval(() => void refreshTraffic({ quiet: true }), 30000);
}

function switchView(view) {
  currentView = view === 'trace' ? 'trace' : 'traffic';
  root?.querySelectorAll('[data-mihomo-diagnostics-view]').forEach((button) => {
    const selected = button.dataset.mihomoDiagnosticsView === currentView;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  });
  root?.querySelectorAll('[data-mihomo-diagnostics-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.mihomoDiagnosticsPanel !== currentView;
  });
  if (currentView === 'traffic') {
    void refreshTraffic();
    scheduleTraffic();
  } else {
    if (trafficTimer) window.clearInterval(trafficTimer);
    trafficTimer = 0;
    trafficRequest?.abort();
    trafficRequest = null;
  }
}

async function run() {
  if (busy) return;
  const input = byId('mihomo-clash-diagnostics-domain');
  const domain = String(input?.value || '').trim();
  if (!domain) {
    setNotice('Введите домен, например github.com.', 'warning');
    input?.focus();
    return;
  }
  setBusy(true);
  setNotice('Запрашиваем DNS, правила и текущую цепочку прокси…', 'neutral');
  try {
    lastResult = await traceMihomoClashDomain(domain);
    render(lastResult);
    const unknown = lastResult?.matched_rule?.result === 'unknown';
    setNotice(
      unknown
        ? 'Маршрут получен частично: это правило нельзя вычислить только по домену.'
        : 'Трассировка завершена. Уже открытые соединения не изменялись.',
      unknown ? 'warning' : 'positive',
    );
  } catch (error) {
    lastResult = null;
    render(null);
    const copy = byId('mihomo-clash-diagnostics-copy');
    if (copy) copy.disabled = true;
    setNotice(error?.message || 'Не удалось построить трассировку маршрута.', 'danger');
  } finally {
    setBusy(false);
  }
}

async function copyReport() {
  if (!lastResult) return;
  try {
    await navigator.clipboard.writeText(resultText(lastResult));
    setNotice('Диагностический отчёт скопирован в буфер обмена.', 'positive');
  } catch (error) {
    setNotice('Браузер не разрешил копирование отчёта.', 'warning');
  }
}

export function initMihomoClashDiagnostics() {
  if (root) return true;
  root = byId('mihomo-clash-diagnostics');
  if (!root) return false;
  root.addEventListener('click', (event) => {
    const view = event.target.closest('[data-mihomo-diagnostics-view]')?.dataset.mihomoDiagnosticsView;
    if (view) switchView(view);
    if (event.target.closest('#mihomo-clash-diagnostics-run')) void run();
    if (event.target.closest('#mihomo-clash-diagnostics-copy')) void copyReport();
    if (event.target.closest('#mihomo-clash-traffic-refresh')) void refreshTraffic();
  });
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'mihomo-clash-traffic-range') void refreshTraffic();
  });
  byId('mihomo-clash-diagnostics-domain')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run();
  });
  return true;
}

export function activateMihomoClashDiagnostics() {
  if (!initMihomoClashDiagnostics()) return false;
  active = true;
  switchView(currentView);
  return true;
}

export function deactivateMihomoClashDiagnostics() {
  active = false;
  if (trafficTimer) window.clearInterval(trafficTimer);
  trafficTimer = 0;
  trafficRequest?.abort();
  trafficRequest = null;
  if (!busy) setNotice('Диагностика запускается только вручную и ничего не изменяет.', 'neutral');
  return true;
}
