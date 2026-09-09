import { confirmMihomoAction } from '../mihomo_runtime.js';
import { toastXkeen } from '../xkeen_runtime.js';
import {
  flushMihomoClashDnsCache,
  flushMihomoClashFakeIpCache,
  queryMihomoClashDns,
} from './client.js';

let root = null;
let active = false;
let capabilities = {};
let busy = false;

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
  [byId('mihomo-clash-dns-name'), byId('mihomo-clash-dns-type')].forEach((item) => {
    if (item) item.disabled = busy;
  });
}

function renderCapabilities() {
  const querySupported = capabilities.dns_query === true;
  const dnsFlushSupported = capabilities.dns_flush === true;
  const fakeIpFlushSupported = capabilities.fake_ip_flush === true;
  const query = byId('mihomo-clash-dns-query');
  if (query) query.disabled = busy || !querySupported;
  const dnsFlush = byId('mihomo-clash-dns-flush');
  if (dnsFlush) dnsFlush.disabled = busy || !dnsFlushSupported;
  const fakeIpFlush = byId('mihomo-clash-fake-ip-flush');
  if (fakeIpFlush) fakeIpFlush.disabled = busy || !fakeIpFlushSupported;
  if (!querySupported) {
    setText('mihomo-clash-dns-state', 'not supported');
    setText('mihomo-clash-dns-result', 'DNS query отключён capability-флагом или не поддерживается текущим Mihomo. Переключатели доступны в DevTools → ENV → Mihomo и HWID.');
  } else {
    setText('mihomo-clash-dns-state', 'Готово');
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
  const latency = payload?.latency_ms === null || payload?.latency_ms === undefined
    ? '—'
    : `${Number(payload.latency_ms).toFixed(1)} ms`;
  const result = byId('mihomo-clash-dns-result');
  if (result) {
    result.dataset.tone = reason ? 'danger' : 'positive';
    result.innerHTML = `<div class="xk-mihomo-dns-result-head"><strong>${escapeHtml(status)}</strong><span>${escapeHtml(mode)} · ${escapeHtml(latency)}${escapeHtml(cacheLabel)}</span></div>${answerMarkup}`;
  }
  setText('mihomo-clash-dns-state', reason ? 'Ошибка ответа' : 'Получено');
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

async function flush(kind) {
  if (busy) return;
  const isFakeIp = kind === 'fake-ip';
  const supported = capabilities[isFakeIp ? 'fake_ip_flush' : 'dns_flush'] === true;
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
  byId('mihomo-clash-dns-query')?.addEventListener('click', () => { void runQuery(); });
  byId('mihomo-clash-dns-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runQuery();
    }
  });
  byId('mihomo-clash-dns-flush')?.addEventListener('click', () => { void flush('dns'); });
  byId('mihomo-clash-fake-ip-flush')?.addEventListener('click', () => { void flush('fake-ip'); });
  return true;
}

export function activateMihomoClashDns(nextCapabilities = {}) {
  if (!initMihomoClashDns()) return false;
  active = true;
  capabilities = nextCapabilities && typeof nextCapabilities === 'object'
    ? nextCapabilities
    : {};
  renderCapabilities();
  return true;
}

export function deactivateMihomoClashDns() {
  active = false;
  if (root) root.setAttribute('aria-busy', 'false');
  return true;
}
