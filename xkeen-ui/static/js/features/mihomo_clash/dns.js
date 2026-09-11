import { confirmMihomoAction } from '../mihomo_runtime.js';
import { toastXkeen } from '../xkeen_runtime.js';
import {
  flushMihomoClashDnsCache,
  flushMihomoClashFakeIpCache,
  probeMihomoClashDnsRoute,
  queryMihomoClashDns,
} from './client.js';

let root = null;
let active = false;
let capabilities = {};
let busy = false;
let routeBusy = false;
let expanded = false;

const VISIBILITY_STORAGE_KEY = 'xkeen:mihomo-clash-dns-visible';

function byId(id) { return document.getElementById(id); }

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = String(value ?? '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setBusy(value) {
  busy = !!value;
  if (root) root.setAttribute('aria-busy', busy ? 'true' : 'false');
  const query = byId('mihomo-clash-dns-query');
  if (query) query.disabled = busy || capabilities.dns_query !== true;
  [
    ['mihomo-clash-dns-flush', 'dns_flush'],
    ['mihomo-clash-fake-ip-flush', 'fake_ip_flush'],
  ].forEach(([id, capability]) => {
    const button = byId(id);
    if (button) button.disabled = busy || !isActionable(capability);
  });
  const routeButton = byId('mihomo-clash-dns-route-check');
  if (routeButton) routeButton.disabled = busy || routeBusy || capabilities.status !== true;
  [byId('mihomo-clash-dns-name'), byId('mihomo-clash-dns-type')].forEach((item) => {
    if (item) item.disabled = busy;
  });
}

function capabilityDetails(name) {
  const details = capabilities?.capability_details;
  return details && typeof details === 'object' && details[name]
    ? details[name]
    : {};
}

function isActionable(name) {
  return capabilities?.[name] === true || capabilityDetails(name).actionable === true;
}

function storedVisibility() {
  try {
    return window.localStorage.getItem(VISIBILITY_STORAGE_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function storeVisibility(value) {
  try {
    window.localStorage.setItem(VISIBILITY_STORAGE_KEY, value ? '1' : '0');
  } catch (error) {}
}

function applyVisibility(value, options = {}) {
  expanded = value === true;
  const toggle = byId('mihomo-clash-dns-toggle');
  if (root) root.hidden = !expanded;
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    toggle.setAttribute('data-tooltip', expanded
      ? 'Скрыть диагностику DNS через Mihomo'
      : 'Показать диагностику DNS через Mihomo');
  }
  if (options.persist === true) storeVisibility(expanded);
}

function renderCapabilities() {
  const querySupported = capabilities.dns_query === true;
  const dnsFlushSupported = isActionable('dns_flush');
  const fakeIpFlushSupported = isActionable('fake_ip_flush');
  const query = byId('mihomo-clash-dns-query');
  if (query) query.disabled = busy || !querySupported;
  const routeButton = byId('mihomo-clash-dns-route-check');
  if (routeButton) routeButton.disabled = busy || routeBusy || capabilities.status !== true;
  const dnsFlush = byId('mihomo-clash-dns-flush');
  if (dnsFlush) {
    dnsFlush.disabled = busy || !dnsFlushSupported;
    dnsFlush.setAttribute('data-tooltip', dnsFlushSupported
      ? 'Очистить кэш DNS Mihomo после подтверждения'
      : 'Текущая версия Mihomo не сообщает этот endpoint');
    dnsFlush.removeAttribute('title');
  }
  const fakeIpFlush = byId('mihomo-clash-fake-ip-flush');
  if (fakeIpFlush) {
    fakeIpFlush.disabled = busy || !fakeIpFlushSupported;
    fakeIpFlush.setAttribute('data-tooltip', fakeIpFlushSupported
      ? 'Очистить таблицу Fake-IP Mihomo после подтверждения'
      : 'Текущая версия Mihomo не сообщает этот endpoint');
    fakeIpFlush.removeAttribute('title');
  }
  const hint = byId('mihomo-clash-dns-maintenance-hint');
  const dnsDetail = capabilityDetails('dns_flush');
  const fakeDetail = capabilityDetails('fake_ip_flush');
  if (hint) {
    if (dnsDetail.actionable === true || fakeDetail.actionable === true) {
      hint.textContent = 'Сборка сообщает hash/alpha-версию: endpoint проверится при нажатии. Нужны отдельное подтверждение и доступ к API; config.yaml не изменяется.';
    } else if (dnsDetail.reason === 'old_core' || fakeDetail.reason === 'old_core') {
      hint.textContent = 'Эта версия Mihomo слишком старая для API cache/flush. Обновите ядро или очистите кэш вручную.';
    } else if (dnsDetail.reason === 'disabled' || fakeDetail.reason === 'disabled') {
      hint.textContent = 'Обслуживание отключено флагом XKEEN_MIHOMO_*_FLUSH_ENABLE в DevTools → ENV.';
    } else {
      hint.textContent = 'Требует отдельного подтверждения. Автоматическое исправление DNS не выполняется.';
    }
  }
  if (!querySupported) {
    setText('mihomo-clash-dns-state', 'not supported');
    setText('mihomo-clash-dns-result', 'DNS query отключён capability-флагом или не поддерживается текущим Mihomo. Переключатели доступны в DevTools → ENV → Mihomo и HWID.');
  } else {
    const state = String(byId('mihomo-clash-dns-state')?.textContent || '').trim();
    if (!state || state === 'Ожидание' || state === 'not supported') {
      setText('mihomo-clash-dns-state', 'Готово');
    }
  }
}

function renderResult(payload) {
  const answers = Array.isArray(payload?.answers) ? payload.answers : [];
  const reason = String(payload?.error_reason || '');
  const status = reason ? `Ошибка: ${reason}` : String(payload?.rcode_name || 'NOERROR');
  const answerMarkup = answers.length
    ? `<ul>${answers.map((item) => `<li><code>${escapeHtml(item.data)}</code><span>${escapeHtml(item.type)} · TTL ${escapeHtml(item.ttl)} с</span></li>`).join('')}</ul>`
    : '<p class="xk-mihomo-dns-empty">Ответов нет.</p>';
  const cacheLabel = payload?.cached ? ' · cache hit' : '';
  const mode = String(payload?.dns_mode || 'unknown');
  const observationState = String(payload?.answer_observation?.state || '');
  const observationLabels = {
    'fake-ip-range': 'адрес похож на Fake-IP CIDR (ответ API)',
    'upstream-address': 'получен upstream IP (ответ API)',
    'range-unavailable': 'IP есть, но ожидаемый Fake-IP CIDR не найден в config.yaml',
    'resolved': 'обычный реальный IP (ответ API)',
    'no-address': 'IP-адресов в ответе нет',
  };
  const observationLabel = observationLabels[observationState] || 'форма ответа API не определена';
  const observationRange = payload?.answer_observation?.range ? ` · ${payload.answer_observation.range}` : '';
  const routeState = String(payload?.route_check?.state || 'not-checked');
  const routeLabel = routeState === 'not-checked'
    ? 'порт 53/TUN/TProxy этим запросом не проверен'
    : routeState;
  const routeRange = payload?.route_check?.range ? ` · ${payload.route_check.range}` : '';
  const latency = payload?.latency_ms === null || payload?.latency_ms === undefined
    ? '—'
    : `${Number(payload.latency_ms).toFixed(1)} ms`;
  const result = byId('mihomo-clash-dns-result');
  if (result) {
    result.dataset.tone = reason ? 'danger' : 'positive';
    result.innerHTML = `<div class="xk-mihomo-dns-result-head"><strong>${escapeHtml(status)}</strong><span>${escapeHtml(mode)} · ${escapeHtml(latency)}${escapeHtml(cacheLabel)}</span></div><div class="xk-mihomo-dns-route" data-state="${escapeHtml(observationState)}">Ответ API: ${escapeHtml(observationLabel)}${escapeHtml(observationRange)}</div><div class="xk-mihomo-dns-route" data-state="${escapeHtml(routeState)}">Маршрут Fake-IP: ${escapeHtml(routeLabel)}${escapeHtml(routeRange)}</div>${answerMarkup}`;
  }
  setText('mihomo-clash-dns-state', reason ? 'Ошибка ответа' : 'Получено');
}

function renderRouteCheck(payload) {
  const result = byId('mihomo-clash-dns-route-result');
  if (!result) return;
  const state = String(payload?.state || 'unreachable');
  const labels = {
    'fake-ip': 'Fake-IP подтверждён локальным listener',
    'real-ip': 'listener отвечает реальным IP (домен может быть в Fake-IP filter)',
    'resolved': 'listener отвечает обычным реальным IP',
    'range-unavailable': 'listener отвечает, но Fake-IP CIDR не найден в конфигурации',
    'no-address': 'listener ответил без IP-адресов',
    'unreachable': 'порт 53 не ответил на локальный UDP-запрос',
  };
  const label = labels[state] || 'результат listener не определён';
  const addresses = Array.isArray(payload?.addresses) ? payload.addresses : [];
  const addressText = addresses.length ? ` · ${addresses.slice(0, 4).join(', ')}` : '';
  const rangeText = payload?.range ? ` · ${payload.range}` : '';
  const latency = payload?.latency_ms === null || payload?.latency_ms === undefined
    ? '—'
    : `${Number(payload.latency_ms).toFixed(1)} ms`;
  result.dataset.state = state;
  result.textContent = `Listener 127.0.0.1:53: ${label}${rangeText}${addressText} · ${latency}`;
}

function readQuery() {
  return {
    name: String(byId('mihomo-clash-dns-name')?.value || '').trim(),
    type: String(byId('mihomo-clash-dns-type')?.value || 'A').toUpperCase(),
  };
}

async function runQuery() {
  if (busy || capabilities.dns_query !== true) return;
  const query = readQuery();
  if (!query.name) {
    toastXkeen('Укажите DNS-имя.', 'warning');
    byId('mihomo-clash-dns-name')?.focus();
    return;
  }
  setBusy(true);
  setText('mihomo-clash-dns-state', 'Проверка…');
  try {
    const payload = await queryMihomoClashDns(query.name, query.type);
    renderResult(payload);
  } catch (error) {
    const message = error?.data?.error_reason || error?.data?.error || 'Не удалось выполнить DNS-запрос.';
    setText('mihomo-clash-dns-state', 'Ошибка');
    const result = byId('mihomo-clash-dns-result');
    if (result) {
      result.dataset.tone = 'danger';
      result.textContent = String(message);
    }
  } finally {
    setBusy(false);
    renderCapabilities();
  }
}

async function runRouteCheck() {
  if (busy || routeBusy || capabilities.status !== true) return;
  const query = readQuery();
  if (!query.name) {
    toastXkeen('Укажите DNS-имя для проверки listener.', 'warning');
    byId('mihomo-clash-dns-name')?.focus();
    return;
  }
  if (!['A', 'AAAA'].includes(query.type)) {
    toastXkeen('Проверка listener поддерживает только A и AAAA.', 'warning');
    return;
  }
  routeBusy = true;
  setBusy(true);
  const result = byId('mihomo-clash-dns-route-result');
  if (result) result.textContent = 'Проверка локального listener 127.0.0.1:53…';
  try {
    renderRouteCheck(await probeMihomoClashDnsRoute(query.name, query.type));
  } catch (error) {
    const message = error?.data?.error || 'Не удалось проверить DNS listener роутера.';
    if (result) {
      result.dataset.state = 'unreachable';
      result.textContent = String(message);
    }
  } finally {
    routeBusy = false;
    setBusy(false);
    renderCapabilities();
  }
}

async function flush(kind) {
  if (busy) return;
  const isFakeIp = kind === 'fake-ip';
  const capability = isFakeIp ? 'fake_ip_flush' : 'dns_flush';
  const supported = isActionable(capability);
  if (!supported) return;
  const accepted = await confirmMihomoAction({
    title: isFakeIp ? 'Очистить Fake-IP cache?' : 'Очистить DNS cache?',
    message: 'Будет выполнено только обслуживание текущего кэша Mihomo. Конфигурация DNS не изменяется и автоматическое исправление не запускается.',
    okText: 'Очистить',
    cancelText: 'Отмена',
    danger: true,
  });
  if (!accepted) return;
  setBusy(true);
  setText('mihomo-clash-dns-state', 'Очистка…');
  try {
    const payload = isFakeIp
      ? await flushMihomoClashFakeIpCache()
      : await flushMihomoClashDnsCache();
    toastXkeen(isFakeIp ? 'Fake-IP cache очищен.' : 'DNS cache очищен.', 'success');
    setText('mihomo-clash-dns-state', 'Кэш очищен');
    if (payload?.cache) {
      const result = byId('mihomo-clash-dns-result');
      if (result) result.dataset.maintenance = payload.cache;
    }
  } catch (error) {
    toastXkeen(error?.data?.error || 'Не удалось очистить кэш Mihomo.', 'error');
    setText('mihomo-clash-dns-state', 'Ошибка обслуживания');
  } finally {
    setBusy(false);
    renderCapabilities();
  }
}

export function initMihomoClashDns() {
  root = byId('mihomo-clash-dns-diagnostics');
  if (!root || root.dataset.bound === '1') return !!root;
  root.dataset.bound = '1';
  expanded = storedVisibility();
  byId('mihomo-clash-dns-toggle')?.addEventListener('click', () => {
    applyVisibility(!expanded, { persist: true });
  });
  byId('mihomo-clash-dns-query')?.addEventListener('click', () => { void runQuery(); });
  byId('mihomo-clash-dns-route-check')?.addEventListener('click', () => { void runRouteCheck(); });
  byId('mihomo-clash-dns-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runQuery();
    }
  });
  byId('mihomo-clash-dns-flush')?.addEventListener('click', () => { void flush('dns'); });
  byId('mihomo-clash-fake-ip-flush')?.addEventListener('click', () => { void flush('fake-ip'); });
  applyVisibility(expanded);
  return true;
}

export function activateMihomoClashDns(nextCapabilities = {}) {
  if (!initMihomoClashDns()) return false;
  active = true;
  capabilities = nextCapabilities && typeof nextCapabilities === 'object'
    ? nextCapabilities
    : {};
  const toggle = byId('mihomo-clash-dns-toggle');
  if (toggle) toggle.hidden = false;
  applyVisibility(expanded);
  renderCapabilities();
  return true;
}

export function deactivateMihomoClashDns() {
  active = false;
  if (root) root.setAttribute('aria-busy', 'false');
  const toggle = byId('mihomo-clash-dns-toggle');
  if (toggle) toggle.hidden = true;
  return true;
}
