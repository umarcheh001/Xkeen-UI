import { iconHtml } from '../../ui/operator_icons.js';
import { confirmMihomoAction } from '../mihomo_runtime.js';
import {
  fetchMihomoClashProviders,
  fetchMihomoRuleProviderContent,
  fetchMihomoClashRules,
  healthcheckMihomoClashProvider,
  updateMihomoClashProvider,
} from './client.js';
import { invalidateMihomoClashGroups } from './groups.js';

const MAX_RULE_ROWS = 300;
const PROVIDER_PAGE_SIZE = 200;
const PROVIDER_UPDATE_CONCURRENCY = 2;

let root = null;
let active = false;
let generation = 0;
let rulesPayload = null;
let providersPayload = null;
let capabilities = {};
let requests = new Set();
let query = '';
let providerKind = 'all';
let pendingProviders = new Set();
let providerBatch = null;
let relativeTimeTimer = 0;
let inspectedProvider = '';
let inspectorPayload = null;
let inspectorQuery = '';
let inspectorOffset = 0;
let inspectorRequest = null;
let inspectorSearchTimer = 0;

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

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 100_000_000_000 ? value : value * 1000;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatRelativeTime(value) {
  const timestamp = timestampMs(value);
  if (!timestamp) return 'Время обновления неизвестно';
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(seconds);
  let divisor = 1;
  let unit = 'second';
  if (absolute >= 86400) { divisor = 86400; unit = 'day'; }
  else if (absolute >= 3600) { divisor = 3600; unit = 'hour'; }
  else if (absolute >= 60) { divisor = 60; unit = 'minute'; }
  try {
    return `Обновлено ${new Intl.RelativeTimeFormat('ru', { numeric: 'auto' }).format(Math.round(seconds / divisor), unit)}`;
  } catch (error) {
    return `Обновлено ${new Date(timestamp).toLocaleString('ru-RU')}`;
  }
}

function formatExpiry(value) {
  const timestamp = timestampMs(Number(value));
  if (!timestamp) return '';
  const date = new Date(timestamp).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  return timestamp < Date.now() ? `Срок истёк ${date}` : `Действует до ${date}`;
}

function formatSize(value) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let amount = Math.max(0, Number(value) || 0);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 || amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function providerSubscriptionHtml(provider) {
  const subscription = provider?.kind === 'proxy' && provider?.subscription && typeof provider.subscription === 'object'
    ? provider.subscription : null;
  if (!subscription) return '';
  const used = Math.max(0, Number(subscription.used) || 0);
  const total = Math.max(0, Number(subscription.total) || 0);
  const expires = formatExpiry(subscription.expires_at);
  const quota = total > 0
    ? `Трафик <strong>${escapeHtml(formatSize(used))} из ${escapeHtml(formatSize(total))}</strong>`
    : (used > 0 ? `Использовано <strong>${escapeHtml(formatSize(used))}</strong>` : '');
  if (!quota && !expires) return '';
  return `<div class="xk-mihomo-provider-subscription">${quota ? `<span>${quota}</span>` : ''}${expires ? `<span>${escapeHtml(expires)}</span>` : ''}</div>`;
}

function httpProviders() {
  const source = Array.isArray(providersPayload?.providers) ? providersPayload.providers : [];
  return source.filter((provider) => String(provider.vehicle_type || '').trim().toLowerCase() === 'http');
}

function renderBatchAction() {
  const button = byId('mihomo-clash-providers-update-http');
  if (!button) return;
  const providers = httpProviders();
  const running = providerBatch?.running === true;
  const completed = Math.max(0, Number(providerBatch?.completed) || 0);
  const total = running ? Math.max(0, Number(providerBatch?.total) || 0) : providers.length;
  button.hidden = !running && (!providerActionEnabled('provider_update') || providers.length < 2);
  button.disabled = running || pendingProviders.size > 0 || providers.length < 2;
  button.setAttribute('aria-busy', running ? 'true' : 'false');
  button.innerHTML = `${iconHtml(running ? 'loading' : 'refresh')}<span class="xk-action-label">${running ? `Обновление ${completed}/${total}` : `Обновить HTTP (${providers.length})`}</span>`;
}

function renderProviders() {
  const list = byId('mihomo-clash-providers-list');
  const empty = byId('mihomo-clash-providers-empty');
  const count = byId('mihomo-clash-providers-count');
  if (!list || !empty) return;
  const providers = filteredProviders();
  list.innerHTML = providers.map((provider) => {
    const key = providerKey(provider);
    const pending = pendingProviders.has(key);
    const updateEnabled = providerActionEnabled('provider_update');
    const healthcheckEnabled = provider.healthcheck && providerActionEnabled('provider_healthcheck');
    const state = provider.kind === 'proxy'
      ? `${provider.alive ?? 0} доступны · ${provider.failed ?? 0} недоступны`
      : `${provider.count || 0} правил · ${provider.behavior || provider.format || 'rule set'}`;
    return `<article class="xk-mihomo-provider" data-provider-key="${escapeHtml(key)}">
      <div class="xk-mihomo-provider-copy"><strong>${escapeHtml(provider.name)}</strong><small>${provider.kind === 'proxy' ? 'Proxy provider' : 'Rule provider'} · ${escapeHtml(provider.vehicle_type || provider.type || '—')}</small></div>
      <div class="xk-mihomo-provider-state"><strong>${escapeHtml(state)}</strong><small>${escapeHtml(formatRelativeTime(provider.updated_at))}</small></div>
      ${providerSubscriptionHtml(provider)}
      <div class="xk-mihomo-provider-actions">
        ${provider.kind === 'rule' ? `<button type="button" class="btn-secondary btn-icon" data-mihomo-provider-inspect aria-label="Просмотреть rule-provider ${escapeHtml(provider.name)}">${iconHtml('preview')}</button>` : ''}
        ${provider.healthcheck ? `<button type="button" class="btn-secondary btn-icon" data-mihomo-provider-healthcheck aria-label="Проверить provider ${escapeHtml(provider.name)}" ${pending || !healthcheckEnabled ? 'disabled' : ''}>${iconHtml(pending ? 'loading' : 'ping')}</button>` : ''}
        <button type="button" class="btn-secondary btn-icon" data-mihomo-provider-update aria-label="Обновить provider ${escapeHtml(provider.name)}" ${pendingProviders.size || providerBatch?.running || !updateEnabled ? 'disabled' : ''}>${iconHtml(pending ? 'loading' : 'refresh')}</button>
      </div>
    </article>`;
  }).join('');
  empty.hidden = providers.length > 0;
  if (count) count.textContent = `${providersPayload?.total_providers || 0} providers`;
  renderBatchAction();
}

function providerByKey(key) {
  return (providersPayload?.providers || []).find((item) => providerKey(item) === key) || null;
}

function renderProviderInspector() {
  const inspector = byId('mihomo-clash-provider-inspector');
  const title = byId('mihomo-clash-provider-inspector-title');
  const meta = byId('mihomo-clash-provider-inspector-meta');
  const list = byId('mihomo-clash-provider-rules');
  const empty = byId('mihomo-clash-provider-rules-empty');
  const previous = byId('mihomo-clash-provider-previous');
  const next = byId('mihomo-clash-provider-next');
  if (!inspector || !list || !empty) return;
  inspector.hidden = !inspectedProvider;
  if (!inspectedProvider) return;
  const provider = inspectorPayload?.provider || {};
  if (title) title.textContent = provider.name || inspectedProvider;
  const source = inspectorPayload?.source || {};
  const cache = inspectorPayload?.cache || {};
  if (meta) meta.textContent = inspectorPayload
    ? `${String(provider.format || '—').toUpperCase()} · ${provider.behavior || '—'} · ${inspectorPayload.total_rules || 0} правил · ${formatSize(source.size_bytes)}${cache.hit ? ' · кэш' : ''}`
    : 'Загрузка содержимого…';
  const rules = Array.isArray(inspectorPayload?.rules) ? inspectorPayload.rules : [];
  list.innerHTML = rules.map((rule, index) => `<li><span>${inspectorOffset + index + 1}</span><code>${escapeHtml(rule)}</code></li>`).join('');
  empty.hidden = rules.length > 0 || !inspectorPayload;
  if (!rules.length && inspectorPayload) empty.textContent = inspectorQuery
    ? 'Совпадений в пределах безопасного лимита нет.' : 'Rule-provider не содержит правил.';
  if (previous) previous.disabled = !inspectorPayload || inspectorOffset <= 0;
  if (next) next.disabled = !inspectorPayload || inspectorOffset + rules.length >= (inspectorPayload.matched_rules || 0);
}

async function loadProviderInspector({ reset = false } = {}) {
  if (!active || !inspectedProvider) return;
  if (reset) inspectorOffset = 0;
  if (inspectorRequest) { try { inspectorRequest.abort(); } catch (error) {} }
  const controller = new AbortController();
  inspectorRequest = controller;
  inspectorPayload = null; renderProviderInspector();
  try {
    const payload = await fetchMihomoRuleProviderContent(inspectedProvider, {
      query: inspectorQuery, limit: PROVIDER_PAGE_SIZE, offset: inspectorOffset, signal: controller.signal,
    });
    if (!active || controller.signal.aborted || inspectedProvider !== payload?.provider?.name) return;
    inspectorPayload = payload;
    renderProviderInspector();
    setNotice(payload.truncated
      ? `Rule-provider показан частично: ${payload.matched_rules} совпадений, по ${payload.limit} на страницу.`
      : `Rule-provider ${payload.provider.name}: ${payload.matched_rules} правил.`, 'neutral');
  } catch (error) {
    if (!controller.signal.aborted && active) {
      inspectorPayload = { rules: [], matched_rules: 0, total_rules: 0, provider: { name: inspectedProvider } };
      renderProviderInspector();
      setNotice(error?.data?.error || 'Не удалось открыть содержимое rule-provider.', 'danger');
    }
  } finally { if (inspectorRequest === controller) inspectorRequest = null; }
}

function openProviderInspector(provider) {
  if (!provider || provider.kind !== 'rule') return;
  inspectedProvider = provider.name;
  inspectorPayload = null; inspectorOffset = 0; inspectorQuery = '';
  const input = byId('mihomo-clash-provider-filter');
  if (input) input.value = '';
  renderProviderInspector();
  void loadProviderInspector({ reset: true });
}

function closeProviderInspector() {
  window.clearTimeout(inspectorSearchTimer);
  if (inspectorRequest) { try { inspectorRequest.abort(); } catch (error) {} }
  inspectorRequest = null; inspectedProvider = ''; inspectorPayload = null; inspectorOffset = 0;
  renderProviderInspector();
}

function abortRequests() {
  for (const controller of requests) { try { controller.abort(); } catch (error) {} }
  requests.clear();
  if (inspectorRequest) { try { inspectorRequest.abort(); } catch (error) {} }
  inspectorRequest = null;
  window.clearTimeout(inspectorSearchTimer);
}

async function loadRuntime(runGeneration, { preserveNotice = false } = {}) {
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
    if (!preserveNotice) setNotice('Правила read-only. Обновление providers выполняется только вручную.', 'neutral');
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
  if (!active || pendingProviders.size || providerBatch?.running || !provider) return;
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
  pendingProviders.add(key); renderProviders();
  try {
    if (healthcheck) await healthcheckMihomoClashProvider(provider.name);
    else await updateMihomoClashProvider(provider.kind, provider.name);
    invalidateMihomoClashGroups();
    if (!active) return;
    setNotice(healthcheck ? 'Healthcheck запущен.' : 'Provider обновлён.', 'positive');
    await loadRuntime(generation);
  } catch (error) {
    setNotice(healthcheck ? 'Не удалось запустить healthcheck.' : 'Не удалось обновить provider.', 'danger');
  } finally { pendingProviders.delete(key); renderProviders(); }
}

async function updateHttpProviders() {
  if (!active || providerBatch?.running || pendingProviders.size || !providerActionEnabled('provider_update')) return;
  const providers = httpProviders();
  if (providers.length < 2) return;
  const accepted = await confirmMihomoAction({
    title: `Обновить HTTP providers (${providers.length})?`,
    message: `Будут обновлены ${providers.length} HTTP providers. Запросы выполняются безопасной очередью по ${PROVIDER_UPDATE_CONCURRENCY} одновременно. Persistent YAML не изменяется.`,
    okText: `Обновить ${providers.length}`,
    cancelText: 'Отменить',
  }, `Обновить ${providers.length} HTTP providers?`);
  if (!accepted || !active) return;

  const runGeneration = generation;
  const batch = { running: true, completed: 0, total: providers.length, updated: 0, failed: 0 };
  providerBatch = batch;
  for (const provider of providers) pendingProviders.add(providerKey(provider));
  renderProviders();
  setNotice(`Обновление HTTP providers: 0/${providers.length}.`, 'neutral');

  let nextIndex = 0;
  async function worker() {
    while (active && generation === runGeneration) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= providers.length) return;
      const provider = providers[index];
      try {
        await updateMihomoClashProvider(provider.kind, provider.name);
        batch.updated += 1;
      } catch (error) {
        batch.failed += 1;
      } finally {
        pendingProviders.delete(providerKey(provider));
        batch.completed += 1;
        if (active && generation === runGeneration) {
          setNotice(`Обновление HTTP providers: ${batch.completed}/${batch.total}.`, batch.failed ? 'danger' : 'neutral');
          renderProviders();
        }
      }
    }
  }

  const workers = [];
  const workerCount = Math.min(PROVIDER_UPDATE_CONCURRENCY, providers.length);
  for (let index = 0; index < workerCount; index += 1) workers.push(worker());
  // Await the bounded workers rather than starting one Promise per provider.
  for (const workerPromise of workers) await workerPromise;
  if (!active || generation !== runGeneration) return;
  const result = batch;
  providerBatch = null;
  pendingProviders.clear();
  invalidateMihomoClashGroups();
  renderProviders();
  setNotice(`Массовое обновление завершено: обновлено ${result.updated}, с ошибкой ${result.failed}.`, result.failed ? 'danger' : 'positive');
  await loadRuntime(generation, { preserveNotice: true });
}

function bind() {
  if (!root || root.dataset.bound === '1') return;
  root.dataset.bound = '1';
  byId('mihomo-clash-rules-filter')?.addEventListener('input', (event) => { query = event.target.value || ''; renderRules(); });
  byId('mihomo-clash-provider-kind')?.addEventListener('change', (event) => { providerKind = event.target.value || 'all'; renderProviders(); });
  byId('mihomo-clash-providers-update-http')?.addEventListener('click', () => { void updateHttpProviders(); });
  byId('mihomo-clash-rules-refresh')?.addEventListener('click', () => { if (active) void loadRuntime(generation); });
  byId('mihomo-clash-provider-filter')?.addEventListener('input', (event) => {
    inspectorQuery = event.target.value || '';
    window.clearTimeout(inspectorSearchTimer);
    inspectorSearchTimer = window.setTimeout(() => void loadProviderInspector({ reset: true }), 250);
  });
  byId('mihomo-clash-provider-previous')?.addEventListener('click', () => { inspectorOffset = Math.max(0, inspectorOffset - PROVIDER_PAGE_SIZE); void loadProviderInspector(); });
  byId('mihomo-clash-provider-next')?.addEventListener('click', () => { inspectorOffset += PROVIDER_PAGE_SIZE; void loadProviderInspector(); });
  root.addEventListener('click', (event) => {
    if (event.target.closest?.('[data-mihomo-provider-inspector-close]')) { closeProviderInspector(); return; }
    const card = event.target.closest?.('[data-provider-key]');
    if (!card) return;
    const provider = providerByKey(card.dataset.providerKey);
    if (event.target.closest?.('[data-mihomo-provider-inspect]')) { openProviderInspector(provider); return; }
    if (event.target.closest?.('[data-mihomo-provider-update]')) void providerAction(provider, 'update');
    if (event.target.closest?.('[data-mihomo-provider-healthcheck]')) void providerAction(provider, 'healthcheck');
  });
}

export function initMihomoClashRules() {
  root = byId('mihomo-clash-rules');
  if (!root) return false;
  bind(); renderRules(); renderProviders(); renderProviderInspector(); return true;
}

export function activateMihomoClashRules(nextCapabilities = {}) {
  if (!root && !initMihomoClashRules()) return false;
  deactivateMihomoClashRules();
  active = true; capabilities = nextCapabilities || {}; generation += 1;
  window.clearInterval(relativeTimeTimer);
  relativeTimeTimer = window.setInterval(() => { if (active) renderProviders(); }, 60000);
  void loadRuntime(generation); return true;
}

export function deactivateMihomoClashRules() {
  active = false; generation += 1; window.clearInterval(relativeTimeTimer); relativeTimeTimer = 0;
  providerBatch = null; pendingProviders.clear(); abortRequests(); closeProviderInspector(); root?.setAttribute('aria-busy', 'false'); return true;
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
