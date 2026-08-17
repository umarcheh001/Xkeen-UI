import {
  applyMihomoEgressListener,
  fetchMihomoClashEgressInfo,
  previewMihomoEgressListener,
} from './client.js';
import { confirmMihomoAction } from '../mihomo_runtime.js';
import { mihomoCountryFlag } from './visuals.js';

const LOCAL_CACHE_MS = 5 * 60 * 1000;
const VISIBILITY_STORAGE_KEY = 'xkeen:mihomo-clash-egress-visible';

let initialized = false;
let active = false;
let request = null;
let requestSequence = 0;
let payload = null;
let loadedAt = 0;
let expanded = false;
let setupBusy = false;

function byId(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = String(value ?? '');
}

function renderCountry(info) {
  const element = byId('mihomo-clash-egress-country');
  if (!element) return;
  const flag = mihomoCountryFlag(info?.country_code);
  const label = String(info?.country || flag.label || flag.code || 'Страна не определена');
  element.replaceChildren();
  element.removeAttribute('data-country');
  element.removeAttribute('role');
  element.removeAttribute('aria-label');
  element.removeAttribute('title');
  if (!flag.code) {
    element.textContent = '—';
    element.setAttribute('aria-hidden', 'true');
    return;
  }
  element.removeAttribute('aria-hidden');
  element.setAttribute('data-country', flag.code);
  element.setAttribute('role', 'img');
  element.setAttribute('aria-label', label);
  element.setAttribute('title', label);
  if (flag.svg) element.innerHTML = flag.svg;
  else element.textContent = flag.code;
}

function setSetupVisible(value) {
  const button = byId('mihomo-clash-egress-setup');
  if (!button) return;
  button.hidden = value !== true;
  button.disabled = setupBusy;
}

function locationCopy(info) {
  return [info.city, info.region, info.country].filter(Boolean).join(', ') || '—';
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
  const root = byId('mihomo-clash-egress');
  const toggle = byId('mihomo-clash-egress-toggle');
  if (root) root.hidden = !expanded;
  if (toggle) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.setAttribute('aria-pressed', expanded ? 'true' : 'false');
    toggle.setAttribute('data-tooltip', expanded
      ? 'Скрыть сведения о публичном IP через Mihomo'
      : 'Показать сведения о публичном IP через Mihomo');
  }
  if (options.persist === true) storeVisibility(expanded);
  if (!expanded) abortRequest();
  if (expanded && active && options.refresh !== false) void refresh();
}

function render(info = payload) {
  const root = byId('mihomo-clash-egress');
  if (!root) return;
  if (!info) {
    renderCountry(null);
    setText('mihomo-clash-egress-ip', 'Проверяем…');
    setText('mihomo-clash-egress-version', 'через Mihomo');
    setText('mihomo-clash-egress-location', '—');
    setText('mihomo-clash-egress-provider', '—');
    setText('mihomo-clash-egress-asn', '—');
    setText('mihomo-clash-egress-timezone', '—');
    return;
  }
  renderCountry(info);
  setText('mihomo-clash-egress-ip', info.ip || '—');
  setText('mihomo-clash-egress-version', [info.ip_version, info.cached ? 'кэш' : 'обновлено'].filter(Boolean).join(' · '));
  setText('mihomo-clash-egress-location', locationCopy(info));
  setText('mihomo-clash-egress-provider', info.organization || '—');
  setText('mihomo-clash-egress-asn', info.asn || '—');
  setText('mihomo-clash-egress-timezone', info.timezone || '—');
  setText(
    'mihomo-clash-egress-notice',
    'Это публичный IP после маршрутизации и NAT. Проверено через ipapi.co; для других доменов маршрут может отличаться.',
  );
}

function abortRequest() {
  requestSequence += 1;
  request?.abort();
  request = null;
}

async function refresh(options = {}) {
  if (!active || !expanded) return false;
  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && payload && Date.now() - loadedAt < LOCAL_CACHE_MS) {
    render(payload);
    return true;
  }
  abortRequest();
  const sequence = ++requestSequence;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  request = controller;
  const root = byId('mihomo-clash-egress');
  const button = byId('mihomo-clash-egress-refresh');
  root?.setAttribute('aria-busy', 'true');
  if (button) button.disabled = true;
  setText('mihomo-clash-egress-notice', forceRefresh ? 'Повторно проверяем IP через Mihomo…' : 'Проверяем IP выхода через Mihomo…');
  try {
    const next = await fetchMihomoClashEgressInfo({
      forceRefresh,
      signal: controller?.signal,
    });
    if (!active || sequence !== requestSequence) return false;
    payload = next && typeof next === 'object' ? next : null;
    loadedAt = Date.now();
    setSetupVisible(false);
    render(payload);
    return true;
  } catch (error) {
    if (controller?.signal.aborted || sequence !== requestSequence) return false;
    if (payload) {
      render(payload);
      setText('mihomo-clash-egress-notice', `${error?.message || 'Не удалось обновить IP выхода.'} Показан последний результат.`);
    } else {
      setText('mihomo-clash-egress-ip', 'Недоступно');
      setText('mihomo-clash-egress-version', 'проверка не выполнена');
      setText('mihomo-clash-egress-notice', error?.message || 'Не удалось определить IP выхода через Mihomo.');
    }
    setSetupVisible(error?.data?.setup_available === true);
    return false;
  } finally {
    if (sequence === requestSequence) request = null;
    root?.setAttribute('aria-busy', 'false');
    if (button) button.disabled = false;
  }
}

async function setupListener() {
  if (setupBusy || !active || !expanded) return false;
  setupBusy = true;
  setSetupVisible(true);
  try {
    const preview = await previewMihomoEgressListener();
    const details = preview?.preview || {};
    const confirmed = await confirmMihomoAction({
      title: 'Настроить проверку IP выхода?',
      message: 'Панель создаст backup, добавит proxy-listener только на 127.0.0.1 и перезапустит Mihomo. Доступ из локальной сети открыт не будет.',
      details: ['Изменение проходит проверку Mihomo; при неудачном запуске прежний конфиг восстанавливается автоматически.'],
      okText: 'Настроить и перезапустить',
      cancelText: 'Отмена',
      danger: false,
    }, 'Настроить локальную проверку IP и перезапустить Mihomo?');
    if (!confirmed) return false;
    setText('mihomo-clash-egress-notice', 'Создаём backup, проверяем конфигурацию и перезапускаем Mihomo…');
    await applyMihomoEgressListener(details.preview_id);
    try {
      document.dispatchEvent(new CustomEvent('xkeen:mihomo-config-changed', {
        detail: { reason: 'egress-listener-setup' },
      }));
    } catch (error) {}
    payload = null;
    loadedAt = 0;
    setSetupVisible(false);
    window.setTimeout(() => void refresh({ forceRefresh: true }), 1000);
    return true;
  } catch (error) {
    setText('mihomo-clash-egress-notice', error?.message || 'Не ��далось автоматически настроить проверку IP.');
    setSetupVisible(true);
    return false;
  } finally {
    setupBusy = false;
    const button = byId('mihomo-clash-egress-setup');
    if (button) button.disabled = false;
  }
}

export function initMihomoClashEgress() {
  if (initialized) return true;
  if (!byId('mihomo-clash-egress')) return false;
  initialized = true;
  expanded = storedVisibility();
  byId('mihomo-clash-egress-toggle')?.addEventListener('click', () => {
    applyVisibility(!expanded, { persist: true });
  });
  byId('mihomo-clash-egress-refresh')?.addEventListener('click', () => {
    void refresh({ forceRefresh: true });
  });
  byId('mihomo-clash-egress-setup')?.addEventListener('click', () => {
    void setupListener();
  });
  document.addEventListener('xkeen:mihomo-egress-invalidated', () => {
    payload = null;
    loadedAt = 0;
    if (active && expanded) window.setTimeout(() => void refresh({ forceRefresh: true }), 350);
  });
  render(null);
  applyVisibility(expanded, { refresh: false });
  return true;
}

export function activateMihomoClashEgress() {
  if (!initMihomoClashEgress()) return false;
  active = true;
  const toggle = byId('mihomo-clash-egress-toggle');
  if (toggle) toggle.hidden = false;
  applyVisibility(expanded);
  return true;
}

export function deactivateMihomoClashEgress() {
  active = false;
  abortRequest();
  const toggle = byId('mihomo-clash-egress-toggle');
  if (toggle) toggle.hidden = true;
  return true;
}
