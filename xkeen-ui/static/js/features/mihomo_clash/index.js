import { fetchMihomoClashStatus } from './client.js';
import {
  activateMihomoClashGroups,
  deactivateMihomoClashGroups,
  initMihomoClashGroups,
} from './groups.js';
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
  setText('mihomo-clash-control-title', copy[1]);
  setText('mihomo-clash-control-message', copy[2]);

  const version = payload && payload.core ? String(payload.core.version || '') : '';
  const mode = payload && payload.runtime ? String(payload.runtime.mode || '') : '';
  setText('mihomo-clash-status-version', version ? `Mihomo ${version}` : 'Mihomo —');
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

  const openConfig = document.querySelector('[data-mihomo-clash-action="open-config"]');
  if (openConfig) {
    openConfig.hidden = !['controller_missing', 'not_configured', 'blocked', 'unauthorized'].includes(state);
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
    try {
      document.dispatchEvent(new CustomEvent('xkeen:mihomo-config-subview-shown', {
        detail: { reason: options.reason || 'subview' },
      }));
    } catch (error) {}
  } else if (active && visible) {
    if (next !== 'control') deactivateMihomoClashGroups();
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
}

function bindVisibility() {
  if (document.documentElement.dataset.mihomoClashVisibilityBound === '1') return;
  document.documentElement.dataset.mihomoClashVisibilityBound = '1';
  document.addEventListener('visibilitychange', () => {
    visible = document.visibilityState !== 'hidden';
    if (!visible) {
      abortStatusRequest();
      deactivateMihomoClashGroups();
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
