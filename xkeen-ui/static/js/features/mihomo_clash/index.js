import {
  applyMihomoClashMigration,
  fetchMihomoClashStatus,
  previewMihomoClashMigration,
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
    activateMihomoClashGroups();
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
    setText('mihomo-clash-assistant-title', 'Mihomo API ещё не настроен');
    setText('mihomo-clash-assistant-message', 'Ничего вручную дописывать не нужно: панель добавит безопасный локальный Unix socket, проверит конфиг и предложит перезапуск Mihomo.');
    setText('mihomo-clash-assistant-button', 'Настроить автоматически');
  } else if (nextAssistantKind === 'security') {
    setText('mihomo-clash-assistant-title', 'Controller Mihomo доступен из LAN без secret');
    setText('mihomo-clash-assistant-message', 'Панель использует локальный backend, но сам TCP-порт остаётся незащищённым. Безопасный помощник заменит его на Unix socket после подтверждения.');
    setText('mihomo-clash-assistant-button', 'Исправить безопасно');
  }
  setText('mihomo-clash-assistant-value', payload?.security?.recommended_value || 'external-controller-unix: ./mihomo-api.sock');
  if (nextAssistantKind && nextAssistantKind !== assistantKind) {
    const restart = byId('mihomo-clash-migration-restart');
    if (restart) restart.checked = nextAssistantKind === 'setup';
  }
  assistantKind = nextAssistantKind;
  setHidden(warning, !nextAssistantKind);
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
  setMigrationStatus('Готовим preview…');
  try {
    const payload = await previewMihomoClashMigration(migrationTransport());
    const preview = payload?.preview || {};
    migrationPreviewId = String(preview.preview_id || '');
    setText('mihomo-clash-migration-preview', preview.content || '');
    const list = byId('mihomo-clash-migration-changes');
    if (list) {
      list.replaceChildren(...(Array.isArray(preview.changes) ? preview.changes : []).map((change) => {
        const item = document.createElement('li');
        item.textContent = String(change || '');
        return item;
      }));
    }
    setMigrationStatus('Preview готов. Активный config.yaml не изменён.');
    return true;
  } catch (error) {
    setMigrationStatus(error?.message || 'Не удалось подготовить preview.', true);
    return false;
  } finally {
    migrationBusy = false;
  }
}

function renderMigrationAssistantCopy() {
  const setup = assistantKind === 'setup';
  setText('mihomo-clash-migration-title', setup ? 'Автоматическая настройка Mihomo API' : 'Безопасная миграция controller');
  setText('mihomo-clash-migration-description', setup
    ? 'Панель сама добавит рекомендуемый Unix socket. До подтверждения активный config.yaml не меняется.'
    : 'Панель заменит небезопасный LAN controller. До подтверждения активный config.yaml не меняется.');
  setText('mihomo-clash-migration-restart-label', setup
    ? 'Перезапустить Mihomo после проверки и сохранения (нужно для включения API)'
    : 'Перезапустить после backup, validate и save');
  setText('mihomo-clash-migration-apply', setup ? 'Сохранить и включить API' : 'Применить безопасную настройку');
}

async function openMigrationPreview() {
  renderMigrationAssistantCopy();
  setHidden(byId('mihomo-clash-migration'), false);
  return refreshMigrationPreview();
}

async function applyMigration() {
  if (migrationBusy) return false;
  const restart = !!byId('mihomo-clash-migration-restart')?.checked;
  const setup = assistantKind === 'setup';
  const unix = migrationTransport() === 'unix';
  const controllerSetting = unix
    ? 'external-controller-unix: ./mihomo-api.sock'
    : 'локальный TCP controller 127.0.0.1:9090 с новым secret';
  const confirmed = window.confirm(setup
    ? `Добавить ${controllerSetting}, создать backup, проверить конфиг${restart ? ' и перезапустить Mihomo' : ''}?`
    : `Заменить controller на ${controllerSetting}, создать backup и проверить конфиг${restart ? ' с перезапуском Mihomo' : ''}?`);
  if (!confirmed) return false;
  migrationBusy = true;
  setMigrationStatus('Проверяем конфиг и создаём backup…');
  try {
    const payload = await applyMihomoClashMigration(migrationTransport(), migrationPreviewId, restart);
    setMigrationStatus(payload?.restarted
      ? 'Миграция применена, Mihomo перезапущен.'
      : 'Миграция применена. Перезапуск не выполнялся.');
    statusPayload = null;
    window.setTimeout(() => void refreshMihomoClashStatus({ reason: 'migration' }), restart ? 1500 : 0);
    return true;
  } catch (error) {
    setMigrationStatus(error?.message || 'Миграция не применена.', true);
    return false;
  } finally {
    migrationBusy = false;
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
    try {
      document.dispatchEvent(new CustomEvent('xkeen:mihomo-config-subview-shown', {
        detail: { reason: options.reason || 'subview' },
      }));
    } catch (error) {}
  } else if (active && visible) {
    if (next !== 'control') deactivateMihomoClashGroups();
    if (next !== 'connections') deactivateMihomoClashConnections();
    if (next !== 'rules') deactivateMihomoClashRules();
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
