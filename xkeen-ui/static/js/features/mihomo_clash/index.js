import {
  applyMihomoClashMigration,
  fetchMihomoPanelMode,
  fetchMihomoClashStatus,
  previewMihomoClashMigration,
  previewMihomoPanelSwitch,
  switchMihomoPanel,
} from './client.js';
import {
  activateMihomoClashGroups,
  deactivateMihomoClashGroups,
  initMihomoClashGroups,
} from './groups.js';
import {
  activateMihomoClashConnections,
  deactivateMihomoClashConnections,
  initMihomoClashConnections,
} from './connections.js';
import {
  activateMihomoClashRules,
  deactivateMihomoClashRules,
  focusMihomoClashRule,
  initMihomoClashRules,
} from './rules.js';
import {
  activateMihomoClashLogs,
  deactivateMihomoClashLogs,
  initMihomoClashLogs,
} from './logs.js';
import {
  mihomoClashStateCopy,
  normalizeMihomoClashState,
  normalizeMihomoClashSubview,
} from './state.js';

let initialized = false;
let active = false;
let visible = true;
let currentSubview = 'control';
let statusPayload = null;
let statusRequest = null;
let requestSequence = 0;
let migrationBusy = false;
let migrationPreviewId = '';
let assistantKind = '';
let panelMode = null;
let panelSwitchBusy = false;

function byId(id) {
  return document.getElementById(id);
}

function runtimeRoot() {
  return byId('mihomo-clash-runtime');
}

function configRoot() {
  return byId('mihomo-clash-panel-config');
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = String(value ?? '');
}

function setHidden(element, hidden) {
  if (!element) return;
  element.hidden = !!hidden;
  element.setAttribute('aria-hidden', hidden ? 'true' : 'false');
}

function stateTone(state) {
  if (state === 'ready') return 'positive';
  if (state === 'loading' || state === 'idle' || state === 'paused') return 'neutral';
  if (state === 'controller_missing' || state === 'not_configured' || state === 'core_stopped') return 'warning';
  return 'danger';
}

function renderStatus(state, payload = null) {
  const root = runtimeRoot();
  if (!root) return;
  const copy = mihomoClashStateCopy(state);
  root.dataset.mihomoClashState = state;
  root.dataset.tone = stateTone(state);
  root.setAttribute('aria-busy', state === 'loading' ? 'true' : 'false');
  setText('mihomo-clash-status-label', copy[0]);
  const statusLabel = byId('mihomo-clash-status-label');
  if (statusLabel) {
    const retrySuggested = !['ready', 'loading', 'idle', 'paused'].includes(state);
    statusLabel.classList.toggle('is-retry-suggested', retrySuggested);
    statusLabel.disabled = state === 'loading';
    statusLabel.setAttribute('aria-label', retrySuggested
      ? 'Проверить Mihomo API снова'
      : 'Проверить Mihomo API');
  }
  setText('mihomo-clash-control-title', copy[1]);
  setText('mihomo-clash-control-message', copy[2]);

  const version = payload && payload.core ? String(payload.core.version || '') : '';
  const mode = payload && payload.runtime ? String(payload.runtime.mode || '') : '';
  // `/version` already returns a branded value such as “Mihomo Meta v1.19.12”.
  // Prefixing it again made the compact status strip repeat “Mihomo”.
  setText('mihomo-clash-status-version', version || 'Версия —');
  setText('mihomo-clash-status-mode', mode ? mode.toUpperCase() : 'Режим —');

  const stateBox = byId('mihomo-clash-control-state');
  const content = byId('mihomo-clash-control-content');
  setHidden(stateBox, state === 'ready');
  setHidden(content, state !== 'ready');
  if (state === 'ready' && active && visible && currentSubview === 'control') {
    activateMihomoClashGroups(payload?.capabilities || {});
  } else {
    deactivateMihomoClashGroups();
  }
  if (state === 'ready' && active && visible && currentSubview === 'connections') {
    activateMihomoClashConnections(payload?.capabilities || {});
  } else if (currentSubview !== 'connections' || state !== 'loading') {
    deactivateMihomoClashConnections();
  }
  if (state === 'ready' && active && visible && currentSubview === 'rules') {
    activateMihomoClashRules(payload?.capabilities || {});
  } else if (currentSubview !== 'rules' || state !== 'loading') {
    deactivateMihomoClashRules();
  }
  if (state === 'ready' && active && visible && currentSubview === 'logs') {
    activateMihomoClashLogs(payload?.capabilities || {}, payload?.runtime || {});
  } else if (currentSubview !== 'logs' || state !== 'loading') {
    deactivateMihomoClashLogs();
  }

  const openConfig = document.querySelector('[data-mihomo-clash-action="open-config"]');
  if (openConfig) {
    openConfig.hidden = !['controller_missing', 'not_configured', 'blocked', 'unauthorized'].includes(state);
  }
  const warning = byId('mihomo-clash-security-warning');
  const migrationRequired = !!(payload?.security?.migration_required);
  const setupRequired = !!(payload?.security?.setup_required);
  const nextAssistantKind = setupRequired ? 'setup' : (migrationRequired ? 'security' : '');
  if (warning) warning.dataset.kind = nextAssistantKind;
  if (nextAssistantKind === 'setup') {
    setText('mihomo-clash-assistant-title', 'Нужно один раз включить Mihomo API');
    setText('mihomo-clash-assistant-message', 'Панель сама создаст backup, добавит локальный API, проверит конфиг, перезапустит Mihomo и проверит подключение.');
    setText('mihomo-clash-assistant-button', 'Включить API');
  } else if (nextAssistantKind === 'security') {
    setText('mihomo-clash-assistant-title', 'Mihomo API нужно защитить');
    setText('mihomo-clash-assistant-message', 'Панель автоматически перенесёт API с открытого LAN-порта на локальный Unix socket с backup и проверкой.');
    setText('mihomo-clash-assistant-button', 'Защитить автоматически');
  }
  setText('mihomo-clash-assistant-value', 'Ваши группы, узлы и подписки не изменятся');
  assistantKind = nextAssistantKind;
  setHidden(warning, !nextAssistantKind);
  void refreshPanelMode();
}

function renderPanelSwitch() {
  const button = byId('mihomo-clash-panel-switch');
  if (!button || !panelMode) return;
  const external = panelMode.mode === 'external';
  const available = external ? panelMode.can_enable_xkeen : panelMode.can_restore_external;
  setHidden(button, !available);
  button.disabled = panelSwitchBusy;
  const panelName = String(panelMode.panel_name || 'прежнюю панель');
  setText('mihomo-clash-panel-switch-label', external ? 'Вернуться в Xkeen Clash API' : `Вернуть ${panelName}`);
  button.setAttribute('data-tooltip', external
    ? 'Создать backup, включить защищённый Xkeen Clash API и перезапустить Mihomo'
    : `Создать backup и вернуть ${panelName} одной кнопкой`);
}

async function refreshPanelMode() {
  try {
    panelMode = await fetchMihomoPanelMode();
    renderPanelSwitch();
  } catch (error) {
    panelMode = null;
    setHidden(byId('mihomo-clash-panel-switch'), true);
  }
}

async function togglePanelMode() {
  if (panelSwitchBusy) return false;
  if (!panelMode) await refreshPanelMode();
  if (!panelMode) return false;
  const target = panelMode.mode === 'external' ? 'xkeen' : 'external';
  const panelName = String(panelMode.panel_name || 'прежнюю панель');
  const question = target === 'external'
    ? `Вернуть ${panelName}? Панель создаст backup, восстановит прежний controller и перезапустит Mihomo.`
    : 'Вернуться в Xkeen Clash API? Панель создаст backup, включит локальный API и перезапустит Mihomo.';
  if (!window.confirm(question)) return false;
  panelSwitchBusy = true;
  renderPanelSwitch();
  try {
    const preview = await previewMihomoPanelSwitch(target);
    const result = await switchMihomoPanel(target, preview?.preview_id);
    panelMode = { ...panelMode, ...result };
    renderPanelSwitch();
    if (target === 'external' && result?.external_url) {
      window.location.assign(String(result.external_url));
      return true;
    }
    window.setTimeout(() => void refreshMihomoClashStatus({ reason: 'panel-switch' }), 500);
    return true;
  } catch (error) {
    const message = error?.data?.rolled_back
      ? 'Переключение не удалось, прежняя конфигурация автоматически восстановлена.'
      : (error?.message || 'Не удалось переключить панель.');
    try { window.toast(message, 'error'); } catch (toastError) { window.alert(message); }
    return false;
  } finally {
    panelSwitchBusy = false;
    renderPanelSwitch();
  }
}

function migrationTransport() {
  return String(byId('mihomo-clash-migration-transport')?.value || 'unix');
}

function setMigrationStatus(message, error = false) {
  const target = byId('mihomo-clash-migration-status');
  if (!target) return;
  target.textContent = String(message || '');
  target.dataset.tone = error ? 'danger' : 'neutral';
}

async function refreshMigrationPreview() {
  if (migrationBusy) return false;
  migrationBusy = true;
  setMigrationBusy(true);
  setMigrationStatus('Проверяем активную конфигурацию…');
  try {
    const payload = await previewMihomoClashMigration(migrationTransport());
    const preview = payload?.preview || {};
    migrationPreviewId = String(preview.preview_id || '');
    const list = byId('mihomo-clash-migration-changes');
    if (list) {
      list.replaceChildren(...(Array.isArray(preview.changes) ? preview.changes : []).map((change) => {
        const item = document.createElement('li');
        item.textContent = String(change || '');
        return item;
      }));
    }
    setMigrationStatus('Готово к настройке. До нажатия кнопки config.yaml не меняется.');
    return true;
  } catch (error) {
    migrationPreviewId = '';
    setMigrationStatus(error?.message || 'Не удалось проверить конфигурацию.', true);
    return false;
  } finally {
    migrationBusy = false;
    setMigrationBusy(false);
  }
}

function setMigrationBusy(busy) {
  const apply = byId('mihomo-clash-migration-apply');
  const close = document.querySelector('[data-mihomo-clash-action="migration-close"]');
  if (apply) apply.disabled = !!busy || !migrationPreviewId;
  if (close) close.disabled = !!busy;
}

function renderMigrationAssistantCopy() {
  const setup = assistantKind === 'setup';
  setText('mihomo-clash-migration-title', setup ? 'Включить Mihomo API' : 'Защитить Mihomo API');
  setText('mihomo-clash-migration-description', setup
    ? 'Одна кнопка — backup, проверка, сохранение, перезапуск и контроль подключения.'
    : 'Панель сохранит ваши настройки и автоматически закроет доступ к controller из LAN.');
  setText('mihomo-clash-migration-apply', setup ? 'Настроить и включить API' : 'Защитить и перезапустить');
}

async function openMigrationPreview() {
  renderMigrationAssistantCopy();
  setHidden(byId('mihomo-clash-migration'), false);
  const ready = await refreshMigrationPreview();
  if (ready) return applyMigration();
  return false;
}

async function applyMigration() {
  if (migrationBusy || !migrationPreviewId) return false;
  const setup = assistantKind === 'setup';
  const confirmed = window.confirm(setup
    ? 'Панель создаст backup, настроит локальный Mihomo API и перезапустит Mihomo. Продолжить?'
    : 'Панель создаст backup, закроет доступ к controller из LAN и перезапустит Mihomo. Продолжить?');
  if (!confirmed) return false;
  migrationBusy = true;
  setMigrationBusy(true);
  setMigrationStatus('Создаём backup, проверяем конфиг и перезапускаем Mihomo…');
  try {
    const payload = await applyMihomoClashMigration(migrationTransport(), migrationPreviewId);
    setMigrationStatus(payload?.api_ready
      ? 'Готово. Mihomo API подключён и защищён.'
      : 'Настройка сохранена. Проверяем подключение Mihomo API…');
    statusPayload = null;
    window.setTimeout(async () => {
      const ready = await refreshMihomoClashStatus({ reason: 'migration' });
      if (ready && statusPayload?.state === 'ready') {
        setHidden(byId('mihomo-clash-migration'), true);
      }
    }, payload?.api_ready ? 300 : 1500);
    return true;
  } catch (error) {
    const saved = error?.data?.saved === true;
    setMigrationStatus(saved
      ? 'Настройка сохранена, но Mihomo не запустился. Попробуйте обычный перезапуск; backup уже создан.'
      : (error?.message || 'Настройка не применена.'), true);
    return false;
  } finally {
    migrationBusy = false;
    setMigrationBusy(false);
  }
}

function abortStatusRequest() {
  requestSequence += 1;
  const request = statusRequest;
  statusRequest = null;
  if (request && request.controller) {
    try { request.controller.abort(); } catch (error) {}
  }
}

export async function refreshMihomoClashStatus(options = {}) {
  if (!active || currentSubview === 'config' || !visible) return false;
  abortStatusRequest();
  const sequence = ++requestSequence;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  statusRequest = { controller, sequence };
  renderStatus('loading', statusPayload);

  try {
    const payload = await fetchMihomoClashStatus({
      signal: controller ? controller.signal : undefined,
      reason: options.reason || 'manual',
    });
    if (!active || !visible || currentSubview === 'config' || sequence !== requestSequence) return false;
    statusPayload = payload && typeof payload === 'object' ? payload : null;
    renderStatus(normalizeMihomoClashState(statusPayload), statusPayload);
    return true;
  } catch (error) {
    if (controller && controller.signal.aborted) return false;
    if (sequence !== requestSequence) return false;
    renderStatus('error', statusPayload);
    return false;
  } finally {
    if (statusRequest && statusRequest.sequence === sequence) statusRequest = null;
  }
}

function applySubview(name, options = {}) {
  const next = normalizeMihomoClashSubview(name);
  currentSubview = next;
  document.querySelectorAll('[data-mihomo-clash-subview]').forEach((button) => {
    const selected = button.dataset.mihomoClashSubview === next;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  });

  document.querySelectorAll('[data-mihomo-clash-panel]').forEach((panel) => {
    setHidden(panel, panel.dataset.mihomoClashPanel !== next);
  });
  setHidden(runtimeRoot(), next === 'config');
  if (next === 'config') {
    abortStatusRequest();
    deactivateMihomoClashGroups();
    deactivateMihomoClashConnections();
    deactivateMihomoClashRules();
    deactivateMihomoClashLogs();
    try {
      document.dispatchEvent(new CustomEvent('xkeen:mihomo-config-subview-shown', {
        detail: { reason: options.reason || 'subview' },
      }));
    } catch (error) {}
  } else if (active && visible) {
    if (next !== 'control') deactivateMihomoClashGroups();
    if (next !== 'connections') deactivateMihomoClashConnections();
    if (next !== 'rules') deactivateMihomoClashRules();
    if (next !== 'logs') deactivateMihomoClashLogs();
    void refreshMihomoClashStatus({ reason: options.reason || 'subview' });
  }
  return next;
}

function focusSiblingTab(current, direction) {
  const tabs = Array.from(document.querySelectorAll('[data-mihomo-clash-subview]:not([aria-disabled="true"])'));
  const index = tabs.indexOf(current);
  if (index < 0 || !tabs.length) return;
  const nextIndex = (index + direction + tabs.length) % tabs.length;
  const next = tabs[nextIndex];
  if (next && typeof next.focus === 'function') next.focus();
}

function bindWorkspace() {
  const root = byId('view-mihomo');
  if (!root || root.dataset.mihomoClashWorkspaceBound === '1') return;
  root.dataset.mihomoClashWorkspaceBound = '1';
  root.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-mihomo-clash-subview], [data-mihomo-clash-action]') : null;
    if (!target) return;
    if (target.getAttribute('aria-disabled') === 'true') return;
    const subview = target.dataset.mihomoClashSubview;
    const action = target.dataset.mihomoClashAction;
    if (subview) applySubview(subview, { reason: 'click' });
    if (action === 'retry') void refreshMihomoClashStatus({ reason: 'retry' });
    if (action === 'open-config') applySubview('config', { reason: 'diagnostic' });
    if (action === 'migration-preview') void openMigrationPreview();
    if (action === 'migration-refresh') void refreshMigrationPreview();
    if (action === 'migration-apply') void applyMigration();
    if (action === 'migration-close') setHidden(byId('mihomo-clash-migration'), true);
    if (action === 'panel-switch') void togglePanelMode();
  });
  root.addEventListener('change', (event) => {
    if (event.target?.id === 'mihomo-clash-migration-transport') {
      migrationPreviewId = '';
      void refreshMigrationPreview();
    }
  });
  root.addEventListener('keydown', (event) => {
    const tab = event.target && event.target.closest ? event.target.closest('[data-mihomo-clash-subview]') : null;
    if (!tab) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      focusSiblingTab(tab, event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (tab.getAttribute('aria-disabled') !== 'true') applySubview(tab.dataset.mihomoClashSubview, { reason: 'keyboard' });
    }
  });
  root.addEventListener('xkeen:mihomo-clash-open-rule', (event) => {
    applySubview('rules', { reason: 'connection-rule' });
    focusMihomoClashRule(event.detail?.rule, event.detail?.payload);
  });
}

function bindVisibility() {
  if (document.documentElement.dataset.mihomoClashVisibilityBound === '1') return;
  document.documentElement.dataset.mihomoClashVisibilityBound = '1';
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState !== 'hidden';
    if (!visible) {
      abortStatusRequest();
      deactivateMihomoClashGroups();
      deactivateMihomoClashConnections();
      deactivateMihomoClashRules();
      deactivateMihomoClashLogs();
      if (active && currentSubview !== 'config') renderStatus('paused', statusPayload);
    } else if (active && currentSubview !== 'config') {
      void refreshMihomoClashStatus({ reason: 'visibility' });
    }
  });
}

export function initMihomoClashWorkspace() {
  if (initialized) return true;
  if (!runtimeRoot() || !configRoot()) return false;
  initialized = true;
  visible = document.visibilityState !== 'hidden';
  bindWorkspace();
  bindVisibility();
  initMihomoClashGroups();
  initMihomoClashConnections();
  initMihomoClashRules();
  initMihomoClashLogs();
  renderStatus('idle', null);
  applySubview(currentSubview, { reason: 'init' });
  return true;
}

export function activateMihomoClashWorkspace(options = {}) {
  if (!initMihomoClashWorkspace()) return false;
  active = true;
  if (currentSubview === 'config') return true;
  if (!visible) {
    renderStatus('paused', statusPayload);
    return true;
  }
  void refreshMihomoClashStatus({ reason: options.reason || 'activate' });
  return true;
}

export function deactivateMihomoClashWorkspace() {
  active = false;
  abortStatusRequest();
  deactivateMihomoClashGroups();
  deactivateMihomoClashConnections();
  deactivateMihomoClashRules();
  deactivateMihomoClashLogs();
  return true;
}

export function activateMihomoClashSubview(name, options = {}) {
  if (!initMihomoClashWorkspace()) return null;
  return applySubview(name, options);
}

export function getMihomoClashApi() {
  return mihomoClashApi;
}

export const mihomoClashApi = Object.freeze({
  init: initMihomoClashWorkspace,
  activate: activateMihomoClashWorkspace,
  deactivate: deactivateMihomoClashWorkspace,
  activateSubview: activateMihomoClashSubview,
  refreshStatus: refreshMihomoClashStatus,
  getState() {
    return Object.freeze({
      active,
      visible,
      subview: currentSubview,
      status: statusPayload,
    });
  },
});
