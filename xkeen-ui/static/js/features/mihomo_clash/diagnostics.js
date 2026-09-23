import { iconHtml } from '../../ui/operator_icons.js';
import {
  fetchMihomoClashTrafficAnalytics,
  traceMihomoClashDomain,
} from './client.js';
import { mihomoTrafficChartSvg } from './visuals.js';

let root = null;
let active = false;
let busy = false;
let trafficBusy = false;
let lastResult = null;
let trafficPayload = null;
let currentView = 'traffic';
let trafficTimer = 0;
let trafficRequest = null;
let trafficFilters = { device: '', route: '', resource: '' };
const trafficVisibleSeries = new Set(['mihomo', 'outside']);
const TRAFFIC_SERIES = Object.freeze({
  mihomo: { field: 'mihomo_bytes', label: 'Через Mihomo', tone: 'mihomo' },
  outside: { field: 'outside_bytes', label: 'Вне Mihomo · оценка', tone: 'outside' },
  download: { field: 'download_bytes', label: 'Загрузка', tone: 'download' },
  upload: { field: 'upload_bytes', label: 'Отдача', tone: 'upload' },
});

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

function routeKey(item) {
  return JSON.stringify([String(item?.route || ''), String(item?.node || '')]);
}

function routeNameFromKey(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return Array.isArray(parsed) ? String(parsed[0] || '') : '';
  } catch (error) {
    return '';
  }
}

function deviceDownload(device) {
  const explicit = Number(device?.total_download);
  return Number.isFinite(explicit)
    ? Math.max(0, explicit)
    : Math.max(0, Number(device?.mihomo_download) || 0) + Math.max(0, Number(device?.outside_download) || 0);
}

function deviceUpload(device) {
  const explicit = Number(device?.total_upload);
  return Number.isFinite(explicit)
    ? Math.max(0, explicit)
    : Math.max(0, Number(device?.mihomo_upload) || 0) + Math.max(0, Number(device?.outside_upload) || 0);
}

function filteredTrafficView(payload = trafficPayload) {
  const sourceDevices = Array.isArray(payload?.devices) ? payload.devices : [];
  const sourceRoutes = Array.isArray(payload?.routes) ? payload.routes : [];
  const sourceResources = Array.isArray(payload?.resources) ? payload.resources : [];
  const resourceQuery = trafficFilters.resource.trim().toLocaleLowerCase('ru');
  const selectedRoute = trafficFilters.route;
  const selectedRouteName = routeNameFromKey(selectedRoute);
  let devices = sourceDevices
    .filter((device) => !trafficFilters.device || String(device?.ip || '') === trafficFilters.device)
    .map((device) => {
      const routes = (Array.isArray(device?.routes) ? device.routes : [])
        .filter((route) => !selectedRoute || routeKey(route) === selectedRoute);
      if (!selectedRoute) return { ...device, routes };
      const download = routes.reduce((total, route) => total + (Number(route.download) || 0), 0);
      const upload = routes.reduce((total, route) => total + (Number(route.upload) || 0), 0);
      return {
        ...device,
        routes,
        mihomo_download: download,
        mihomo_upload: upload,
        mihomo_bytes: download + upload,
        outside_download: 0,
        outside_upload: 0,
        outside_bytes: 0,
        total_download: download,
        total_upload: upload,
        total_bytes: download + upload,
      };
    })
    .filter((device) => !selectedRoute || device.routes.length > 0);
  const routes = sourceRoutes.map((route) => {
    if (selectedRoute && routeKey(route) !== selectedRoute) return null;
    const breakdown = (route.breakdown || [])
      .filter((row) => !trafficFilters.device || row.ip === trafficFilters.device);
    if (trafficFilters.device && !breakdown.length) return null;
    if (!trafficFilters.device) return { ...route };
    return {
      ...route,
      download: breakdown.reduce((total, row) => total + (Number(row.download) || 0), 0),
      upload: breakdown.reduce((total, row) => total + (Number(row.upload) || 0), 0),
      bytes: breakdown.reduce((total, row) => total + (Number(row.download) || 0) + (Number(row.upload) || 0), 0),
      device_count: 1,
      device_ips: [trafficFilters.device],
    };
  }).filter(Boolean);
  const resources = sourceResources.map((resource) => {
    if (resourceQuery && !String(resource?.resource || '').toLocaleLowerCase('ru').includes(resourceQuery)) return false;
    if (selectedRouteName && !(resource?.routes || []).includes(selectedRouteName)) return false;
    const breakdown = (resource.breakdown || [])
      .filter((row) => !trafficFilters.device || row.ip === trafficFilters.device)
      .filter((row) => !selectedRouteName || row.route === selectedRouteName);
    if (trafficFilters.device || selectedRouteName) {
      if (!breakdown.length) return null;
      return {
        ...resource,
        download: breakdown.reduce((total, row) => total + (Number(row.download) || 0), 0),
        upload: breakdown.reduce((total, row) => total + (Number(row.upload) || 0), 0),
        bytes: breakdown.reduce((total, row) => total + (Number(row.download) || 0) + (Number(row.upload) || 0), 0),
        devices: [...new Set(breakdown.map((row) => row.name))],
        device_ips: [...new Set(breakdown.map((row) => row.ip))],
        routes: [...new Set(breakdown.map((row) => row.route))],
      };
    }
    return { ...resource };
  }).filter(Boolean);
  if (resourceQuery) {
    const deviceTotals = new Map();
    resources.forEach((resource) => {
      (resource.breakdown || []).forEach((row) => {
        if (trafficFilters.device && row.ip !== trafficFilters.device) return;
        if (selectedRouteName && row.route !== selectedRouteName) return;
        const current = deviceTotals.get(row.ip) || {
          ip: row.ip,
          name: row.name || row.ip,
          download: 0,
          upload: 0,
          routes: new Map(),
        };
        current.download += Number(row.download) || 0;
        current.upload += Number(row.upload) || 0;
        const route = current.routes.get(row.route) || {
          route: row.route,
          node: row.route,
          download: 0,
          upload: 0,
        };
        route.download += Number(row.download) || 0;
        route.upload += Number(row.upload) || 0;
        current.routes.set(row.route, route);
        deviceTotals.set(row.ip, current);
      });
    });
    devices = Array.from(deviceTotals.values()).map((device) => ({
      ip: device.ip,
      name: device.name,
      mihomo_download: device.download,
      mihomo_upload: device.upload,
      mihomo_bytes: device.download + device.upload,
      outside_download: 0,
      outside_upload: 0,
      outside_bytes: 0,
      total_download: device.download,
      total_upload: device.upload,
      total_bytes: device.download + device.upload,
      routes: Array.from(device.routes.values()),
    }));
  }
  const routeDownload = routes.reduce((total, item) => total + (Number(item?.download) || 0), 0);
  const routeUpload = routes.reduce((total, item) => total + (Number(item?.upload) || 0), 0);
  const resourceDownload = resources.reduce((total, item) => total + (Number(item?.download) || 0), 0);
  const resourceUpload = resources.reduce((total, item) => total + (Number(item?.upload) || 0), 0);
  const narrowedDownload = resourceQuery ? resourceDownload : selectedRoute ? routeDownload : null;
  const narrowedUpload = resourceQuery ? resourceUpload : selectedRoute ? routeUpload : null;
  const summary = {
    mihomo_bytes: narrowedDownload == null
      ? devices.reduce((total, item) => total + (Number(item?.mihomo_bytes) || 0), 0)
      : narrowedDownload + narrowedUpload,
    outside_bytes: narrowedDownload == null
      ? devices.reduce((total, item) => total + (Number(item?.outside_bytes) || 0), 0)
      : 0,
    download_bytes: narrowedDownload == null
      ? devices.reduce((total, item) => total + deviceDownload(item), 0)
      : narrowedDownload,
    upload_bytes: narrowedUpload == null
      ? devices.reduce((total, item) => total + deviceUpload(item), 0)
      : narrowedUpload,
    device_count: devices.length,
    route_count: routes.length,
    resource_count: resources.length,
  };
  summary.total_bytes = summary.download_bytes + summary.upload_bytes;
  return { summary, devices, routes, resources };
}

function renderTrafficSummary(summary = {}) {
  const target = byId('mihomo-clash-traffic-summary');
  if (!target) return;
  const cards = [
    ['Всего учтено', formatBytes(summary.total_bytes), 'neutral'],
    ['Загрузка ↓', formatBytes(summary.download_bytes), 'neutral'],
    ['Отдача ↑', formatBytes(summary.upload_bytes), 'neutral'],
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
    target.classList.add('is-empty');
    target.innerHTML = '<div class="xk-mihomo-traffic-empty">Данных для графика пока нет.</div>';
    renderTrafficChartStats([]);
    return;
  }
  target.classList.remove('is-empty');
  const visibleSeries = Object.keys(TRAFFIC_SERIES).filter((key) => trafficVisibleSeries.has(key));
  if (!visibleSeries.length) trafficVisibleSeries.add('mihomo');
  const width = Math.max(320, Math.round(target.clientWidth || 1000));
  const height = 220;
  const padding = { top: 18, right: 12, bottom: 32, left: 54 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const activeFields = visibleSeries.map((key) => TRAFFIC_SERIES[key].field);
  const maxValue = Math.max(
    ...points.flatMap((item) => activeFields.map((field) => Number(item[field]) || 0)),
    1,
  );
  const x = (index) => padding.left + (points.length === 1 ? innerWidth / 2 : index * innerWidth / (points.length - 1));
  const y = (value) => padding.top + innerHeight - (Math.max(0, Number(value) || 0) / maxValue) * innerHeight;
  const path = (field) => points.map((item, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(item[field]).toFixed(1)}`).join(' ');
  const tickIndexes = Array.from(new Set([
    0,
    Math.floor((points.length - 1) / 4),
    Math.floor((points.length - 1) / 2),
    Math.floor((points.length - 1) * 3 / 4),
    points.length - 1,
  ]));
  const yTicks = [0, .5, 1];
  target.innerHTML = `${mihomoTrafficChartSvg({
    width,
    height,
    yTicks: yTicks.map((ratio) => ({
      x1: padding.left,
      y1: y(maxValue * ratio),
      x2: width - padding.right,
      y2: y(maxValue * ratio),
      labelX: padding.left - 8,
      labelY: y(maxValue * ratio) + 4,
      label: formatBytes(maxValue * ratio),
    })),
    paths: visibleSeries.map((key) => ({
      key,
      tone: TRAFFIC_SERIES[key].tone,
      d: path(TRAFFIC_SERIES[key].field),
    })),
    guide: {
      x: x(0),
      y1: padding.top,
      y2: height - padding.bottom,
    },
    hitArea: {
      x: padding.left,
      y: padding.top,
      width: innerWidth,
      height: innerHeight + 4,
    },
    xLabels: tickIndexes.map((index) => ({
      x: x(index),
      y: height - 8,
      anchor: index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle',
      label: formatChartTime(points[index].at, payload?.range_seconds),
    })),
  })}<div id="mihomo-clash-traffic-tooltip" class="xk-mihomo-traffic-tooltip" role="status" aria-live="polite" hidden></div>`;
  syncTrafficSeriesButtons();
  renderTrafficChartStats(points);
  const svg = target.querySelector('.xk-mihomo-traffic-svg');
  const hit = target.querySelector('[data-chart-hit]');
  const guide = target.querySelector('[data-chart-guide]');
  const tooltip = target.querySelector('#mihomo-clash-traffic-tooltip');
  const showPoint = (event) => {
    if (!hit || !tooltip || !guide) return;
    const svgRect = svg.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const relativeX = Math.max(0, Math.min(svgRect.width, event.clientX - svgRect.left));
    const ratio = svgRect.width ? relativeX / svgRect.width : 0;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    const pointX = x(index);
    guide.setAttribute('x1', String(pointX));
    guide.setAttribute('x2', String(pointX));
    guide.hidden = false;
    tooltip.innerHTML = `<strong>${escapeHtml(formatChartDate(point.at))}</strong>${
      visibleSeries.map((key) => `<span><span>${escapeHtml(TRAFFIC_SERIES[key].label)}</span><b>${escapeHtml(formatBytes(point[TRAFFIC_SERIES[key].field]))}</b></span>`).join('')
    }`;
    tooltip.hidden = false;
    const left = Math.max(6, Math.min(targetRect.width - tooltip.offsetWidth - 6, event.clientX - targetRect.left + 10));
    const top = Math.max(6, Math.min(targetRect.height - tooltip.offsetHeight - 6, event.clientY - targetRect.top - tooltip.offsetHeight - 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };
  hit?.addEventListener('pointermove', showPoint);
  hit?.addEventListener('pointerleave', () => {
    if (guide) guide.hidden = true;
    if (tooltip) tooltip.hidden = true;
  });
}

function formatChartTime(value, rangeSeconds = 0) {
  const date = new Date(Number(value || 0) * 1000);
  if (Number(rangeSeconds) > 48 * 3600) {
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function formatChartDate(value) {
  return new Date(Number(value || 0) * 1000).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function syncTrafficSeriesButtons() {
  document.querySelectorAll('[data-mihomo-traffic-series]').forEach((button) => {
    const key = button.dataset.mihomoTrafficSeries;
    const active = trafficVisibleSeries.has(key);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.classList.toggle('is-active', active);
  });
}

function renderTrafficChartStats(points) {
  const target = byId('mihomo-clash-traffic-chart-stats');
  if (!target) return;
  const visibleSeries = Object.keys(TRAFFIC_SERIES).filter((key) => trafficVisibleSeries.has(key));
  target.innerHTML = visibleSeries.map((key) => {
    const field = TRAFFIC_SERIES[key].field;
    const values = points.map((point) => Number(point[field]) || 0);
    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 0;
    const avg = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    const current = values.at(-1) || 0;
    return `<div class="xk-mihomo-traffic-chart-stat" data-series="${key}">
      <header><i></i><span>${escapeHtml(TRAFFIC_SERIES[key].label)}</span></header>
      <dl><div><dt>Мин</dt><dd>${escapeHtml(formatBytes(min))}</dd></div><div><dt>Сред.</dt><dd>${escapeHtml(formatBytes(avg))}</dd></div><div><dt>Макс</dt><dd>${escapeHtml(formatBytes(max))}</dd></div><div><dt>Сейчас</dt><dd>${escapeHtml(formatBytes(current))}</dd></div></dl>
    </div>`;
  }).join('');
}

function routeBar(route, total) {
  const bytes = (Number(route?.download) || 0) + (Number(route?.upload) || 0);
  const width = total > 0 ? Math.max(2, Math.min(100, bytes * 100 / total)) : 0;
  return `<div class="xk-mihomo-device-route">
    <div><strong>${escapeHtml(route?.route || '—')}</strong><span>${escapeHtml(route?.node || '—')}</span><em>${escapeHtml(`${formatBytes(route?.download)} ↓ · ${formatBytes(route?.upload)} ↑`)}</em></div>
    <i><b style="width:${width.toFixed(1)}%"></b></i>
  </div>`;
}

function renderTrafficDevices(devices = []) {
  const target = byId('mihomo-clash-traffic-devices');
  if (!target) return;
  target.innerHTML = devices.slice(0, 24).map((device) => {
    const total = Number(device.total_bytes) || 0;
    const mihomo = Number(device.mihomo_bytes) || 0;
    const outside = Number(device.outside_bytes) || 0;
    const routes = Array.isArray(device.routes) ? device.routes : [];
    return `<article class="xk-mihomo-traffic-device">
      <header><div><strong>${escapeHtml(device.name || device.ip || 'Устройство')}</strong><span>${escapeHtml(device.ip || '')}</span></div><em>${escapeHtml(formatBytes(total))}</em></header>
      <div class="xk-mihomo-device-split" role="img" aria-label="${escapeHtml(`Через Mihomo ${formatBytes(mihomo)}, вне Mihomo ${formatBytes(outside)}`)}"><i class="is-mihomo" style="width:${total ? mihomo * 100 / total : 0}%"></i><i class="is-outside" style="width:${total ? outside * 100 / total : 0}%"></i></div>
      <div class="xk-mihomo-device-meta"><span>↓ <strong>${escapeHtml(formatBytes(deviceDownload(device)))}</strong></span><span>↑ <strong>${escapeHtml(formatBytes(deviceUpload(device)))}</strong></span><span>Через Mihomo <strong>${escapeHtml(formatBytes(mihomo))}</strong></span><span>Вне Mihomo · оценка <strong>${escapeHtml(formatBytes(outside))}</strong></span></div>
      <div class="xk-mihomo-device-routes">${routes.length ? routes.map((route) => routeBar(route, Math.max(mihomo, 1))).join('') : '<span class="xk-mihomo-traffic-empty">Маршруты ещё не накоплены.</span>'}</div>
    </article>`;
  }).join('') || '<div class="xk-mihomo-traffic-empty">Устройства появятся после накопления трафика.</div>';
}

function renderTrafficTables({ routes = [], resources = [] } = {}) {
  const routeBody = byId('mihomo-clash-traffic-routes');
  if (routeBody) {
    routeBody.innerHTML = routes.slice(0, 24).map((item) => `<tr><td>${escapeHtml(item.route || '—')}</td><td>${escapeHtml(item.node || '—')}</td><td>${Number(item.device_count) || 0}</td><td>${escapeHtml(formatBytes(item.download))}</td><td>${escapeHtml(formatBytes(item.upload))}</td></tr>`).join('') || '<tr><td colspan="5">Данных по фильтру нет.</td></tr>';
  }
  const resourceBody = byId('mihomo-clash-traffic-resources');
  if (resourceBody) {
    resourceBody.innerHTML = resources.slice(0, 24).map((item) => `<tr><td>${escapeHtml(item.resource || '—')}</td><td>${escapeHtml((item.devices || []).join(', ') || '—')}</td><td>${escapeHtml((item.routes || []).join(', ') || '—')}</td><td>${escapeHtml(formatBytes(item.download))}</td><td>${escapeHtml(formatBytes(item.upload))}</td></tr>`).join('') || '<tr><td colspan="5">Данных по фильтру нет.</td></tr>';
  }
}

function stateCopy(value) {
  return {
    healthy: 'Данные актуальны',
    partial: 'Частичное покрытие',
    degraded: 'Есть ошибки',
    warming_up: 'Накопление данных',
    demo: 'Демо-данные',
    live: 'Доступен',
    stale: 'Устарел',
    error: 'Ошибка',
    unavailable: 'Недоступен',
    waiting: 'Ожидание',
  }[String(value || '')] || 'Неизвестно';
}

function stateTone(value) {
  if (['healthy', 'live'].includes(value)) return 'positive';
  if (['degraded', 'error'].includes(value)) return 'danger';
  if (['partial', 'stale', 'unavailable', 'warming_up', 'demo'].includes(value)) return 'warning';
  return 'neutral';
}

function renderTrafficQuality(payload) {
  const quality = payload?.quality || {};
  const connections = quality.connections || {};
  const clients = quality.clients || {};
  const storage = quality.storage || {};
  const state = byId('mihomo-clash-traffic-quality-state');
  if (state) {
    state.textContent = stateCopy(quality.state || payload?.collection?.state);
    state.dataset.tone = stateTone(quality.state || payload?.collection?.state);
  }
  const cards = [
    ['Классифицировано', quality.classification_percent == null ? '—' : `${quality.classification_percent}%`, quality.classification_percent >= 80 ? 'positive' : 'warning'],
    ['Mihomo API', `${stateCopy(connections.state)} · ${connections.errors || 0} ошибок`, stateTone(connections.state)],
    ['Keenetic', `${stateCopy(clients.state)} · ${clients.errors || 0} ошибок`, stateTone(clients.state)],
    ['Локальная база', formatBytes(storage.database_size_bytes), 'neutral'],
  ];
  const target = byId('mihomo-clash-traffic-quality');
  if (target) {
    target.innerHTML = cards.map(([label, value, tone]) => `<div class="xk-mihomo-traffic-quality-item" data-tone="${tone}"><span>${escapeHtml(label)}</span><strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong></div>`).join('');
  }
  const note = byId('mihomo-clash-traffic-quality-note');
  if (note) {
    const truncated = Number(connections.truncated_samples) || 0;
    note.textContent = payload?.demo === true
      ? 'Синтетические данные предназначены только для проверки интерфейса и алгоритмов.'
      : `Статистика VPN является наблюдаемой нижней границей: короткие соединения между снимками могут быть пропущены.${truncated ? ` Снимков с усечённым списком: ${truncated}.` : ''}`;
  }
}

function syncTrafficFilters(payload) {
  const devices = Array.isArray(payload?.devices) ? payload.devices : [];
  const routes = Array.isArray(payload?.routes) ? payload.routes : [];
  const deviceSelect = byId('mihomo-clash-traffic-device');
  if (deviceSelect) {
    const selected = trafficFilters.device;
    deviceSelect.replaceChildren(new Option('Все устройства', ''));
    devices.forEach((device) => deviceSelect.add(new Option(`${device.name || device.ip} · ${device.ip}`, device.ip)));
    trafficFilters.device = devices.some((device) => device.ip === selected) ? selected : '';
    deviceSelect.value = trafficFilters.device;
  }
  const routeSelect = byId('mihomo-clash-traffic-route');
  if (routeSelect) {
    const selected = trafficFilters.route;
    routeSelect.replaceChildren(new Option('Все маршруты', ''));
    routes.forEach((route) => routeSelect.add(new Option(`${route.route || '—'} → ${route.node || '—'}`, routeKey(route))));
    trafficFilters.route = routes.some((route) => routeKey(route) === selected) ? selected : '';
    routeSelect.value = trafficFilters.route;
  }
  const resource = byId('mihomo-clash-traffic-resource');
  if (resource && resource.value !== trafficFilters.resource) resource.value = trafficFilters.resource;
}

function renderFilteredTraffic() {
  if (!trafficPayload) return;
  const view = filteredTrafficView(trafficPayload);
  renderTrafficSummary(view.summary);
  renderTrafficDevices(view.devices);
  renderTrafficTables(view);
}

function renderTraffic(payload) {
  trafficPayload = payload;
  const content = byId('mihomo-clash-traffic-content');
  if (content) content.hidden = false;
  syncTrafficFilters(payload);
  renderFilteredTraffic();
  renderTrafficChart(payload);
  renderTrafficQuality(payload);
  const coverage = byId('mihomo-clash-traffic-coverage');
  if (coverage) {
    coverage.textContent = payload?.coverage?.keenetic_client_counters
      ? 'Mihomo + общие счётчики Keenetic · выборочное наблюдение'
      : 'Только трафик через Mihomo · выборочное наблюдение';
  }
}

function downloadTrafficFile(contents, filename, type) {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportTraffic(format) {
  if (!trafficPayload) return false;
  const view = filteredTrafficView(trafficPayload);
  const date = new Date().toISOString().slice(0, 10);
  if (format === 'json') {
    const payload = {
      schema_version: 1,
      exported_at: new Date().toISOString(),
      range_seconds: trafficPayload.range_seconds,
      filters: { ...trafficFilters },
      summary: view.summary,
      quality: trafficPayload.quality || {},
      devices: view.devices,
      routes: view.routes,
      resources: view.resources,
    };
    downloadTrafficFile(
      `${JSON.stringify(payload, null, 2)}\n`,
      `xkeen-mihomo-traffic-${date}.json`,
      'application/json;charset=utf-8',
    );
    setTrafficNotice('JSON с текущими фильтрами подготовлен.', 'positive');
    return true;
  }
  const rows = [[
    'kind', 'device', 'ip', 'route', 'node', 'resource',
    'download_bytes', 'upload_bytes', 'outside_bytes',
  ]];
  view.devices.forEach((device) => {
    (device.routes || []).forEach((route) => rows.push([
      'route', device.name, device.ip, route.route, route.node, '',
      Number(route.download) || 0, Number(route.upload) || 0, 0,
    ]));
    if (Number(device.outside_bytes) > 0) {
      rows.push([
        'outside_estimated', device.name, device.ip, '', '', '',
        Number(device.outside_download) || 0,
        Number(device.outside_upload) || 0,
        Number(device.outside_bytes) || 0,
      ]);
    }
  });
  view.resources.forEach((resource) => rows.push([
    'resource',
    (resource.devices || []).join(' | '),
    (resource.device_ips || []).join(' | '),
    (resource.routes || []).join(' | '),
    '',
    resource.resource,
    Number(resource.download) || 0,
    Number(resource.upload) || 0,
    0,
  ]));
  downloadTrafficFile(
    `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
    `xkeen-mihomo-traffic-${date}.csv`,
    'text/csv;charset=utf-8',
  );
  setTrafficNotice('CSV с текущими фильтрами подготовлен.', 'positive');
  return true;
}

function resetTrafficFilters() {
  trafficFilters = { device: '', route: '', resource: '' };
  syncTrafficFilters(trafficPayload);
  renderFilteredTraffic();
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
    const qualityState = payload?.quality?.state;
    setTrafficNotice(
      payload?.demo === true
        ? 'Демо-режим: показаны синтетические устройства, VPN и ресурсы; реальные данные роутера не используются.'
        : error
        ? `Последний сбор завершился ошибкой: ${error}. Показана накопленная история.`
        : qualityState === 'partial'
        ? 'Трафик Mihomo собирается, но общие счётчики Keenetic недоступны: объём вне Mihomo пока не определяется.'
        : qualityState === 'warming_up'
        ? 'Сборщик запущен и накапливает первые контрольные снимки.'
        : `Сбор активен${last ? ` · последний снимок ${new Date(last * 1000).toLocaleTimeString('ru-RU')}` : ''}.`,
      payload?.demo === true || error || ['partial', 'warming_up'].includes(qualityState) ? 'warning' : 'positive',
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
    const seriesButton = event.target.closest('[data-mihomo-traffic-series]');
    if (seriesButton) {
      const key = seriesButton.dataset.mihomoTrafficSeries;
      if (key && trafficVisibleSeries.has(key) && trafficVisibleSeries.size === 1) return;
      if (key) {
        if (trafficVisibleSeries.has(key)) trafficVisibleSeries.delete(key);
        else trafficVisibleSeries.add(key);
        renderTrafficChart(trafficPayload);
      }
    }
    if (event.target.closest('#mihomo-clash-diagnostics-run')) void run();
    if (event.target.closest('#mihomo-clash-diagnostics-copy')) void copyReport();
    if (event.target.closest('#mihomo-clash-traffic-refresh')) void refreshTraffic();
    if (event.target.closest('#mihomo-clash-traffic-filters-reset')) resetTrafficFilters();
    if (event.target.closest('#mihomo-clash-traffic-export-csv')) exportTraffic('csv');
    if (event.target.closest('#mihomo-clash-traffic-export-json')) exportTraffic('json');
  });
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'mihomo-clash-traffic-range') void refreshTraffic();
    if (event.target?.id === 'mihomo-clash-traffic-device') {
      trafficFilters.device = event.target.value || '';
      renderFilteredTraffic();
    }
    if (event.target?.id === 'mihomo-clash-traffic-route') {
      trafficFilters.route = event.target.value || '';
      renderFilteredTraffic();
    }
  });
  byId('mihomo-clash-traffic-resource')?.addEventListener('input', (event) => {
    trafficFilters.resource = event.target.value || '';
    renderFilteredTraffic();
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
