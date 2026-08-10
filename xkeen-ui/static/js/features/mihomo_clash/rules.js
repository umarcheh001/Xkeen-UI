import { iconHtml } from '../../ui/operator_icons.js';
import { confirmMihomoAction } from '../mihomo_runtime.js';
import {
  fetchMihomoClashProviders,
  fetchMihomoClashRules,
  healthcheckMihomoClashProvider,
  mihomoClashLogsWsUrl,
  requestMihomoClashWsToken,
  updateMihomoClashProvider,
} from './client.js';
import { invalidateMihomoClashGroups } from './groups.js';

const MAX_RULE_ROWS = 300;
const MAX_LOG_ROWS = 500;

let root = null;
let active = false;
let generation = 0;
let rulesPayload = null;
let providersPayload = null;
let capabilities = {};
let requests = new Set();
let query = '';
let providerKind = 'all';
let pendingProvider = '';
let logsOpen = false;
let logsPaused = false;
let logLevel = 'all';
let logQuery = '';
let logRows = [];
let logSocket = null;
let logController = null;
let logFocusReturn = null;

function byId(id) { return document.getElementById(id); }
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setNotice(copy, tone = 'neutral') {
  const notice = byId('mihomo-clash-rules-notice');
  if (!notice) return;
  notice.textContent = String(copy || '');
  notice.dataset.tone = tone;
}

function ruleSearchText(rule) {
  return [rule?.index, rule?.type, rule?.payload, rule?.target].join(' ').toLocaleLowerCase('ru');
}

function filteredRules() {
  const needle = query.trim().toLocaleLowerCase('ru');
  const source = Array.isArray(rulesPayload?.rules) ? rulesPayload.rules : [];
  return source.filter((rule) => !needle || ruleSearchText(rule).includes(needle)).slice(0, MAX_RULE_ROWS);
}

function renderRules() {
  const rows = byId('mihomo-clash-rules-rows');
  const empty = byId('mihomo-clash-rules-empty');
  const count = byId('mihomo-clash-rules-count');
  if (!rows || !empty) return;
  const visible = filteredRules();
  rows.innerHTML = visible.map((rule) => `<tr data-rule-index="${Number(rule.index) || 0}" tabindex="0">
    <td data-label="#"><strong>${Number(rule.index) + 1}</strong></td>
    <td data-label="Тип"><strong>${escapeHtml(rule.type || '—')}</strong>${rule.disabled === true ? '<small>временно отключено</small>' : ''}</td>
    <td data-label="Payload"><strong>${escapeHtml(rule.payload || '—')}</strong></td>
    <td data-label="Маршрут"><strong>${escapeHtml(rule.target || '—')}</strong></td>
  </tr>`).join('');
  empty.hidden = visible.length > 0;
  empty.textContent = rulesPayload && !visible.length ? 'Правила по текущему фильтру не найдены.' : 'Правила загружаются.';
  if (count) count.textContent = `${rulesPayload?.total_rules || 0} правил`;
}

function providerKey(provider) { return `${provider.kind}:${provider.name}`; }
function filteredProviders() {
  const source = Array.isArray(providersPayload?.providers) ? providersPayload.providers : [];
  return source.filter((provider) => providerKind === 'all' || provider.kind === providerKind);
}

function providerActionEnabled(capability) {
  return capabilities?.[capability] === true;
}

function renderProviders() {
  const list = byId('mihomo-clash-providers-list');
  const empty = byId('mihomo-clash-providers-empty');
  const count = byId('mihomo-clash-providers-count');
  if (!list || !empty) return;
  const providers = filteredProviders();
  list.innerHTML = providers.map((provider) => {
    const key = providerKey(provider);
    const pending = pendingProvider === key;
    const updateEnabled = providerActionEnabled('provider_update');
    const healthcheckEnabled = provider.healthcheck && providerActionEnabled('provider_healthcheck');
    const state = provider.kind === 'proxy'
      ? `${provider.alive ?? 0} доступны · ${provider.failed ?? 0} недоступны`
      : `${provider.count || 0} правил · ${provider.behavior || provider.format || 'rule set'}`;
    return `<article class="xk-mihomo-provider" data-provider-key="${escapeHtml(key)}">
      <div class="xk-mihomo-provider-copy"><strong>${escapeHtml(provider.name)}</strong><small>${provider.kind === 'proxy' ? 'Proxy provider' : 'Rule provider'} · ${escapeHtml(provider.vehicle_type || provider.type || '—')}</small></div>
      <div class="xk-mihomo-provider-state"><strong>${escapeHtml(state)}</strong><small>${escapeHtml(provider.updated_at || 'Время обновления неизвестно')}</small></div>
      <div class="xk-mihomo-provider-actions">
        ${provider.healthcheck ? `<button type="button" class="btn-secondary btn-icon" data-mihomo-provider-healthcheck aria-label="Проверить provider ${escapeHtml(provider.name)}" ${pending || !healthcheckEnabled ? 'disabled' : ''}>${iconHtml(pending ? 'loading' : 'ping')}</button>` : ''}
        <button type="button" class="btn-secondary btn-icon" data-mihomo-provider-update aria-label="Обновить provider ${escapeHtml(provider.name)}" ${pendingProvider || !updateEnabled ? 'disabled' : ''}>${iconHtml(pending ? 'loading' : 'refresh')}</button>
      </div>
    </article>`;
  }).join('');
  empty.hidden = providers.length > 0;
  if (count) count.textContent = `${providersPayload?.total_providers || 0} providers`;
}

function logSearchText(row) {
  return [row?.level, row?.message, ...Object.entries(row?.fields || {}).flat()].join(' ').toLocaleLowerCase('ru');
}

function filteredLogs() {
  const needle = logQuery.trim().toLocaleLowerCase('ru');
  return logRows.filter((row) => (logLevel === 'all' || row.level === logLevel) && (!needle || logSearchText(row).includes(needle)));
}

function renderLogs() {
  const drawer = byId('mihomo-clash-logs-drawer');
  const list = byId('mihomo-clash-logs-list');
  const state = byId('mihomo-clash-logs-state');
  if (drawer) drawer.hidden = !logsOpen;
  if (!list) return;
  const rows = filteredLogs();
  list.innerHTML = rows.map((row) => {
    const fields = Object.entries(row.fields || {}).map(([key, value]) => `${key}=${value}`).join(' · ');
    return `<li data-log-level="${escapeHtml(row.level)}"><time>${escapeHtml(row.time || '—')}</time><strong>${escapeHtml(row.level)}</strong><span>${escapeHtml(row.message || '—')}</span>${fields ? `<small>${escapeHtml(fields)}</small>` : ''}</li>`;
  }).join('');
  if (state) state.textContent = logsPaused ? `Пауза · ${logRows.length}/${MAX_LOG_ROWS}` : (logSocket ? `Live · ${logRows.length}/${MAX_LOG_ROWS}` : 'Ожидание');
  const pause = byId('mihomo-clash-logs-pause');
  if (pause) {
    pause.setAttribute('aria-pressed', logsPaused ? 'true' : 'false');
    pause.setAttribute('aria-label', logsPaused ? 'Продолжить вывод логов' : 'Пауза логов');
  }
}

function setPaused(nextPaused) {
  logsPaused = !!nextPaused;
  if (!logsPaused) renderLogs();
  else {
    const state = byId('mihomo-clash-logs-state');
    if (state) state.textContent = `Пауза · ${logRows.length}/${MAX_LOG_ROWS}`;
    const pause = byId('mihomo-clash-logs-pause');
    if (pause) {
      pause.setAttribute('aria-pressed', 'true');
      pause.setAttribute('aria-label', 'Продолжить вывод логов');
    }
  }
}

function abortRequests() {
  for (const controller of requests) { try { controller.abort(); } catch (error) {} }
  requests.clear();
}

function closeLogs({ restoreFocus = false } = {}) {
  const socket = logSocket;
  logSocket = null;
  if (logController) { try { logController.abort(); } catch (error) {} }
  logController = null;
  if (socket) {
    socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
    try { socket.close(); } catch (error) {}
  }
  renderLogs();
  const focusTarget = logFocusReturn;
  logFocusReturn = null;
  if (restoreFocus && focusTarget?.isConnected) focusTarget.focus();
}

async function loadRuntime(runGeneration) {
  root?.setAttribute('aria-busy', 'true');
  const rulesController = new AbortController();
  const providersController = new AbortController();
  requests.add(rulesController); requests.add(providersController);
  try {
    const [nextRules, nextProviders] = await Promise.all([
      fetchMihomoClashRules({ signal: rulesController.signal }),
      fetchMihomoClashProviders({ signal: providersController.signal }),
    ]);
    if (!active || generation !== runGeneration) return;
    rulesPayload = nextRules; providersPayload = nextProviders;
    renderRules(); renderProviders();
    setNotice('Правила read-only. Обновление providers выполняется только вручную.', 'neutral');
  } catch (error) {
    if (active && generation === runGeneration
      && !rulesController.signal.aborted && !providersController.signal.aborted) {
      setNotice('Не удалось загрузить rules/providers Mihomo.', 'danger');
    }
  } finally {
    requests.delete(rulesController); requests.delete(providersController);
    root?.setAttribute('aria-busy', 'false');
  }
}

async function providerAction(provider, action) {
  if (!active || pendingProvider || !provider) return;
  const key = providerKey(provider);
  const healthcheck = action === 'healthcheck';
  const accepted = await confirmMihomoAction({
    title: healthcheck ? 'Запустить healthcheck provider?' : 'Обновить provider?',
    message: healthcheck
      ? 'Mihomo проверит узлы выбранного proxy provider. Persistent YAML не изменяется.'
      : 'Mihomo загрузит свежие данные выбранного provider. Persistent YAML не изменяется.',
    okText: healthcheck ? 'Проверить' : 'Обновить', cancelText: 'Отменить',
  }, healthcheck ? 'Запустить healthcheck provider?' : 'Обновить provider?');
  if (!accepted || !active) return;
  pendingProvider = key; renderProviders();
  try {
    if (healthcheck) await healthcheckMihomoClashProvider(provider.name);
    else await updateMihomoClashProvider(provider.kind, provider.name);
    invalidateMihomoClashGroups();
    if (!active) return;
    setNotice(healthcheck ? 'Healthcheck запущен.' : 'Provider обновлён.', 'positive');
    await loadRuntime(generation);
  } catch (error) {
    setNotice(healthcheck ? 'Не удалось запустить healthcheck.' : 'Не удалось обновить provider.', 'danger');
  } finally { pendingProvider = ''; renderProviders(); }
}

async function openLogs() {
  if (!active || logsOpen) return;
  if (capabilities.logs_stream !== true) {
    setNotice('Runtime logs недоступны без WebSocket runtime.', 'warning');
    return;
  }
  logFocusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  logsOpen = true; logsPaused = false; renderLogs();
  byId('mihomo-clash-logs-close')?.focus();
  const runGeneration = generation;
  const controller = new AbortController();
  logController = controller;
  try {
    const token = await requestMihomoClashWsToken({
      signal: controller.signal,
      scope: 'mihomo-clash-logs',
    });
    if (!active || !logsOpen || generation !== runGeneration || !token) return;
    const socket = new WebSocket(mihomoClashLogsWsUrl(token));
    logSocket = socket;
    socket.onopen = renderLogs;
    socket.onmessage = (event) => {
      if (!active || !logsOpen || logSocket !== socket) return;
      let message = null;
      try { message = JSON.parse(event.data); } catch (error) { return; }
      if (message?.type !== 'mihomo-clash-logs' || message.state !== 'live' || Number(message.schema_version) !== 1) return;
      if (message.payload) {
        logRows.push(message.payload);
        if (logRows.length > MAX_LOG_ROWS) logRows.splice(0, logRows.length - MAX_LOG_ROWS);
        if (!logsPaused) renderLogs();
      }
    };
    socket.onerror = () => {};
    socket.onclose = () => { if (logSocket === socket) logSocket = null; renderLogs(); };
  } catch (error) { if (!controller.signal.aborted) setNotice('Не удалось открыть поток логов.', 'danger'); }
  finally { if (logController === controller) logController = null; }
}

function bind() {
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  byId('mihomo-clash-rules-filter')?.addEventListener('input', (event) => { query = event.target.value || ''; renderRules(); });
  byId('mihomo-clash-provider-kind')?.addEventListener('change', (event) => { providerKind = event.target.value || 'all'; renderProviders(); });
  byId('mihomo-clash-rules-refresh')?.addEventListener('click', () => { if (active) void loadRuntime(generation); });
  byId('mihomo-clash-logs-open')?.addEventListener('click', () => void openLogs());
  byId('mihomo-clash-logs-close')?.addEventListener('click', () => { logsOpen = false; closeLogs({ restoreFocus: true }); renderLogs(); });
  byId('mihomo-clash-logs-pause')?.addEventListener('click', () => setPaused(!logsPaused));
  byId('mihomo-clash-logs-clear')?.addEventListener('click', () => { logRows = []; renderLogs(); });
  byId('mihomo-clash-logs-level')?.addEventListener('change', (event) => { logLevel = event.target.value || 'all'; renderLogs(); });
  byId('mihomo-clash-logs-filter')?.addEventListener('input', (event) => { logQuery = event.target.value || ''; renderLogs(); });
  root.addEventListener('click', (event) => {
    const card = event.target.closest?.('[data-provider-key]');
    if (!card) return;
    const provider = (providersPayload?.providers || []).find((item) => providerKey(item) === card.dataset.providerKey);
    if (event.target.closest?.('[data-mihomo-provider-update]')) void providerAction(provider, 'update');
    if (event.target.closest?.('[data-mihomo-provider-healthcheck]')) void providerAction(provider, 'healthcheck');
  });
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && logsOpen) { logsOpen = false; closeLogs({ restoreFocus: true }); renderLogs(); }
  });
}

export function initMihomoClashRules() {
  root = byId('mihomo-clash-rules');
  if (!root) return false;
  bind(); renderRules(); renderProviders(); renderLogs(); return true;
}

export function activateMihomoClashRules(nextCapabilities = {}) {
  if (!root && !initMihomoClashRules()) return false;
  deactivateMihomoClashRules();
  active = true; capabilities = nextCapabilities || {}; generation += 1;
  const logsButton = byId('mihomo-clash-logs-open');
  if (logsButton) logsButton.disabled = capabilities.logs_stream !== true;
  void loadRuntime(generation); return true;
}

export function deactivateMihomoClashRules() {
  active = false; generation += 1; abortRequests(); logsOpen = false; closeLogs(); root?.setAttribute('aria-busy', 'false'); return true;
}

export function focusMihomoClashRule(rule, payload = '') {
  query = [rule, payload].filter(Boolean).join(' ');
  const filter = byId('mihomo-clash-rules-filter');
  if (filter) filter.value = query;
  renderRules();
}

export const mihomoClashRulesApi = Object.freeze({
  init: initMihomoClashRules,
  activate: activateMihomoClashRules,
  deactivate: deactivateMihomoClashRules,
  focusRule: focusMihomoClashRule,
});
