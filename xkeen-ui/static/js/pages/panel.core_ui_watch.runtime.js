import { getFileManagerApi } from '../features/file_manager.js';
import { isMihomoPanelEditorDirty } from '../features/mihomo_panel.js';
import { getRoutingShellApi } from '../features/routing_shell.js';
import {
  confirmXkeenAction,
  getXkeenConfigDirtyApi,
  getXkeenCoreHttpApi,
  getXkeenJsonEditorApi,
  toastXkeen,
} from '../features/xkeen_runtime.js';

const CORE_UI_WATCH_INITIAL_DELAY_MS = 8000;
const CORE_UI_WATCH_POLL_MS = 15000;
const CORE_UI_WATCH_HIDDEN_POLL_MS = 60000;
const CORE_UI_WATCH_ERROR_BACKOFF_MS = 60000;
const CORE_UI_WATCH_FOCUS_COOLDOWN_MS = 2500;

let coreUiKnownDetectedCores = getInitialDetectedCores();
let coreUiKnownSignature = coreListSignature(coreUiKnownDetectedCores);
let coreUiWatchTimer = null;
let coreUiWatchInFlight = false;
let coreUiReloadScheduled = false;
let coreUiPendingSignature = '';
let coreUiPendingMessage = '';
let coreUiLastCheckAt = 0;
let coreUiWatchInited = false;

function getCoreHttp() {
  return getXkeenCoreHttpApi();
}

function normalizeCoreList(list) {
  const raw = Array.isArray(list) ? list : [];
  const seen = Object.create(null);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const name = String(raw[i] || '').trim().toLowerCase();
    if (!name || (name !== 'xray' && name !== 'mihomo')) continue;
    if (seen[name]) continue;
    seen[name] = true;
    out.push(name);
  }
  out.sort();
  return out;
}

function coreListSignature(list) {
  return normalizeCoreList(list).join(',');
}

function getInitialDetectedCores() {
  try {
    if (Array.isArray(window.XKEEN_DETECTED_CORES)) {
      return normalizeCoreList(window.XKEEN_DETECTED_CORES);
    }
  } catch (error) {}
  try {
    if (window.XKEEN_CORE_UI_FALLBACK === true) return [];
  } catch (error) {}
  try {
    return normalizeCoreList(window.XKEEN_AVAILABLE_CORES);
  } catch (error) {}
  return [];
}

function formatCoreName(name) {
  const key = String(name || '').toLowerCase();
  if (key === 'xray') return 'Xray';
  if (key === 'mihomo') return 'Mihomo';
  return key;
}

function describeCoreUiTopologyChange(prevCores, nextCores) {
  const prev = normalizeCoreList(prevCores);
  const next = normalizeCoreList(nextCores);

  if (!prev.length && next.length) {
    return `Найдены новые ядра: ${next.map((name) => formatCoreName(name)).join(', ')}. Панель перестроится под расширенный набор вкладок.`;
  }

  if (prev.length && !next.length) {
    return 'Установленные ядра больше не обнаружены. Панель вернётся к безопасному режиму отображения.';
  }

  return 'Конфигурация ядер изменилась. Панель нужно обновить.';
}

function notifyPanelInfo(message) {
  const text = String(message || '').trim();
  if (!text) return;
  try { toastXkeen(text, 'info'); } catch (error) {}
}

export function hasPanelUnsavedChanges() {
  try {
    const dirtyApi = getXkeenConfigDirtyApi();
    if (dirtyApi && typeof dirtyApi.anyDirty === 'function' && dirtyApi.anyDirty(['routing', 'inbounds', 'outbounds'])) {
      return true;
    }
  } catch (error) {}

  try {
    const routingShell = getRoutingShellApi();
    if (routingShell && typeof routingShell.isDirty === 'function' && routingShell.isDirty()) {
      return true;
    }
  } catch (error) {}

  try {
    if (isMihomoPanelEditorDirty()) return true;
  } catch (error) {}

  try {
    const jsonEditor = getXkeenJsonEditorApi();
    if (jsonEditor && typeof jsonEditor.isDirty === 'function' && jsonEditor.isDirty()) {
      return true;
    }
  } catch (error) {}

  try {
    const fileManager = getFileManagerApi();
    const editor = fileManager ? fileManager.editor : null;
    if (editor && typeof editor.isDirty === 'function' && editor.isDirty()) {
      return true;
    }
  } catch (error) {}

  return false;
}

function getCoreUiRefreshButton() {
  return document.getElementById('panel-core-ui-refresh-btn');
}

async function confirmCoreUiManualReload() {
  if (!hasPanelUnsavedChanges()) return true;

  const title = 'Обновить панель?';
  const message = 'Панель перестроится под новый набор ядер, несохранённые изменения будут потеряны.';

  try {
      return await confirmXkeenAction({
        title,
        message,
        okText: 'Обновить',
        cancelText: 'Отмена',
        danger: true,
      }, message);
  } catch (error) {
    return false;
  }
}

function revealCoreUiRefreshButton(message) {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  try { btn.classList.remove('hidden'); } catch (error) {}
  try { btn.disabled = false; } catch (error) {}
  try { btn.title = String(message || btn.title || ''); } catch (error) {}
}

function reloadPanelForCoreUiChange(message) {
  if (coreUiReloadScheduled) return;
  coreUiReloadScheduled = true;

  const text = String(message || 'Найдено изменение в наборе ядер.');
  notifyPanelInfo(`${text} Перезагружаем панель...`);

  try {
    if (coreUiWatchTimer) clearTimeout(coreUiWatchTimer);
  } catch (error) {}
  coreUiWatchTimer = null;

  setTimeout(() => {
    try {
      window.location.reload();
    } catch (error) {
      try { window.location.href = window.location.href; } catch (secondaryError) {}
    }
  }, 900);
}

function deferCoreUiReload(message, nextCores) {
  const nextSig = coreListSignature(nextCores);
  if (coreUiPendingSignature === nextSig) return;

  coreUiPendingSignature = nextSig;
  coreUiPendingMessage = String(message || 'Конфигурация ядер изменилась.');
  revealCoreUiRefreshButton(coreUiPendingMessage);
  notifyPanelInfo(`${coreUiPendingMessage} Сохраните изменения и нажмите "Обновить панель".`);

  try {
    if (coreUiWatchTimer) clearTimeout(coreUiWatchTimer);
  } catch (error) {}
  coreUiWatchTimer = null;
}

function parseDetectedCoresFromPayload(data) {
  if (!data || typeof data !== 'object') return null;

  if (Array.isArray(data.cores)) {
    return normalizeCoreList(data.cores);
  }

  if (data.cores && typeof data.cores === 'object') {
    const out = [];
    if (data.cores.xray && data.cores.xray.installed) out.push('xray');
    if (data.cores.mihomo && data.cores.mihomo.installed) out.push('mihomo');
    return normalizeCoreList(out);
  }

  return null;
}

async function fetchDetectedCores() {
  const http = getCoreHttp();
  if (http && typeof http.fetchJSON === 'function') {
    try {
      const data = await http.fetchJSON('/api/xkeen/core', {
        method: 'GET',
        timeoutMs: 6000,
        retry: 1,
      });
      if (!data || data.ok !== true) return null;
      return parseDetectedCoresFromPayload(data);
    } catch (error) {
      return null;
    }
  }

  try {
    const response = await fetch('/api/xkeen/core', { cache: 'no-store' });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) return null;
    return parseDetectedCoresFromPayload(data);
  } catch (error) {
    return null;
  }
}

function scheduleCoreUiWatch(delayMs) {
  if (coreUiReloadScheduled || coreUiPendingSignature) return;

  const wait = (typeof delayMs === 'number' && delayMs >= 0) ? delayMs : CORE_UI_WATCH_POLL_MS;
  try {
    if (coreUiWatchTimer) clearTimeout(coreUiWatchTimer);
  } catch (error) {}
  coreUiWatchTimer = setTimeout(() => {
    coreUiWatchTimer = null;
    void checkCoreUiTopology('timer');
  }, wait);
}

async function handleCoreUiTopologyChange(prevCores, nextCores) {
  const message = describeCoreUiTopologyChange(prevCores, nextCores);
  if (hasPanelUnsavedChanges()) {
    deferCoreUiReload(message, nextCores);
    return;
  }
  reloadPanelForCoreUiChange(message);
}

async function checkCoreUiTopology(reason) {
  if (coreUiReloadScheduled || coreUiPendingSignature || coreUiWatchInFlight) return;

  try {
    if (document.visibilityState === 'hidden') {
      scheduleCoreUiWatch(CORE_UI_WATCH_HIDDEN_POLL_MS);
      return;
    }
  } catch (error) {}

  const now = Date.now();
  if (reason === 'focus' && (now - coreUiLastCheckAt) < CORE_UI_WATCH_FOCUS_COOLDOWN_MS) {
    scheduleCoreUiWatch(CORE_UI_WATCH_POLL_MS);
    return;
  }

  coreUiWatchInFlight = true;
  coreUiLastCheckAt = now;

  let nextDelay = CORE_UI_WATCH_POLL_MS;
  try {
    const nextCores = await fetchDetectedCores();
    if (!nextCores) {
      nextDelay = CORE_UI_WATCH_ERROR_BACKOFF_MS;
      return;
    }

    const prevCores = coreUiKnownDetectedCores.slice();
    const nextSig = coreListSignature(nextCores);
    if (nextSig !== coreUiKnownSignature) {
      coreUiKnownDetectedCores = nextCores.slice();
      coreUiKnownSignature = nextSig;
      void handleCoreUiTopologyChange(prevCores, nextCores);
      return;
    }
  } finally {
    coreUiWatchInFlight = false;
  }

  scheduleCoreUiWatch(nextDelay);
}

function wireCoreUiRefreshButton() {
  const btn = getCoreUiRefreshButton();
  if (!btn) return;
  if (btn.dataset && btn.dataset.xkCoreRefreshWired === '1') return;

  btn.addEventListener('click', async (event) => {
    event.preventDefault();
    const ok = await confirmCoreUiManualReload();
    if (!ok) return;
    reloadPanelForCoreUiChange(coreUiPendingMessage || 'Перестраиваем панель под доступные ядра.');
  });

  if (btn.dataset) btn.dataset.xkCoreRefreshWired = '1';
}

export function initPanelCoreUiAutoDetect() {
  if (coreUiWatchInited) return;
  coreUiWatchInited = true;

  wireCoreUiRefreshButton();

  document.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'visible') void checkCoreUiTopology('visibility');
    } catch (error) {}
  });

  window.addEventListener('focus', () => {
    void checkCoreUiTopology('focus');
  });

  scheduleCoreUiWatch(CORE_UI_WATCH_INITIAL_DELAY_MS);
}

export const panelCoreUiWatchRuntimeApi = Object.freeze({
  init: initPanelCoreUiAutoDetect,
  hasUnsavedChanges: hasPanelUnsavedChanges,
});
