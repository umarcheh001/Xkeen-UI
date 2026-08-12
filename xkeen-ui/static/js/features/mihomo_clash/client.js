import { getMihomoCoreHttpApi } from '../mihomo_runtime.js';

const STATUS_ENDPOINT = '/api/mihomo/clash/status';
const RUNTIME_MODE_ENDPOINT = '/api/mihomo/clash/runtime-mode';
const GROUPS_ENDPOINT = '/api/mihomo/clash/proxy-groups';
const DELAY_ENDPOINT = '/api/mihomo/clash/delay';
const CONNECTIONS_ENDPOINT = '/api/mihomo/clash/connections';
const RULES_ENDPOINT = '/api/mihomo/clash/rules';
const PROVIDERS_ENDPOINT = '/api/mihomo/clash/providers';
const MIGRATION_PREVIEW_ENDPOINT = '/api/mihomo/security/migration-preview';
const MIGRATION_APPLY_ENDPOINT = '/api/mihomo/security/migration-apply';
const PANEL_MODE_ENDPOINT = '/api/mihomo/security/panel-mode';
const PANEL_SWITCH_PREVIEW_ENDPOINT = '/api/mihomo/security/panel-switch-preview';
const PANEL_SWITCH_ENDPOINT = '/api/mihomo/security/panel-switch';
const WS_TOKEN_ENDPOINT = '/api/ws-token';

function httpApi() {
  return getMihomoCoreHttpApi();
}

async function requestJSON(url, init = {}) {
  const http = httpApi();
  if (http && typeof http.fetchJSON === 'function') return http.fetchJSON(url, init);

  const fallbackInit = { credentials: 'same-origin', ...init };
  const method = String(fallbackInit.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const token = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
    fallbackInit.headers = { ...(fallbackInit.headers || {}), 'X-CSRF-Token': token };
  }
  const response = await fetch(url, fallbackInit);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload && payload.error ? String(payload.error) : 'Mihomo Clash request failed');
    error.status = response.status;
    error.data = payload;
    throw error;
  }
  return payload;
}

export async function fetchMihomoClashStatus(options = {}) {
  const init = {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    timeoutMs: 5000,
    retry: 0,
    signal: options && options.signal ? options.signal : undefined,
  };
  return requestJSON(STATUS_ENDPOINT, init);
}

export function setMihomoClashRuntimeMode(mode, options = {}) {
  return requestJSON(RUNTIME_MODE_ENDPOINT, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: String(mode || '').toLowerCase() }),
    credentials: 'same-origin',
    timeoutMs: 8000,
    retry: 0,
    signal: options.signal,
  });
}

export function fetchMihomoPanelMode() {
  return requestJSON(PANEL_MODE_ENDPOINT, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin', timeoutMs: 5000, retry: 0,
  });
}

export function previewMihomoPanelSwitch(target) {
  return requestJSON(PANEL_SWITCH_PREVIEW_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: String(target || '') }),
    credentials: 'same-origin', timeoutMs: 10000, retry: 0,
  });
}

export function switchMihomoPanel(target, previewId) {
  return requestJSON(PANEL_SWITCH_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: String(target || ''), preview_id: String(previewId || ''), confirmed: true }),
    credentials: 'same-origin', timeoutMs: 60000, retry: 0,
  });
}

export function fetchMihomoClashGroups(options = {}) {
  return requestJSON(GROUPS_ENDPOINT, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    timeoutMs: 10000,
    retry: 0,
    signal: options.signal,
  });
}

export function selectMihomoClashProxy(group, name, options = {}) {
  return requestJSON(`${GROUPS_ENDPOINT}/${encodeURIComponent(String(group || ''))}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: String(name || ''),
      disconnect_affected: options.disconnectAffected === true,
    }),
    credentials: 'same-origin',
    timeoutMs: 12000,
    retry: 0,
    signal: options.signal,
  });
}

export function unfixMihomoClashProxy(group, options = {}) {
  return requestJSON(`${GROUPS_ENDPOINT}/${encodeURIComponent(String(group || ''))}/fixed`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ disconnect_affected: options.disconnectAffected === true }),
    credentials: 'same-origin',
    timeoutMs: 20000,
    retry: 0,
    signal: options.signal,
  });
}

export function testMihomoClashDelay(scope, name, options = {}) {
  return requestJSON(DELAY_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scope: String(scope || ''),
      name: String(name || ''),
      preset: String(options.preset || 'google'),
      ...(options.provider ? { provider: String(options.provider) } : {}),
    }),
    credentials: 'same-origin',
    timeoutMs: 12000,
    retry: 0,
    signal: options.signal,
  });
}

export function fetchMihomoClashConnections(options = {}) {
  return requestJSON(CONNECTIONS_ENDPOINT, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'same-origin',
    timeoutMs: 8000,
    retry: 0,
    signal: options.signal,
  });
}

export function fetchMihomoClashRules(options = {}) {
  return requestJSON(RULES_ENDPOINT, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
    timeoutMs: 12000, retry: 0, signal: options.signal,
  });
}

export function fetchMihomoClashProviders(options = {}) {
  return requestJSON(PROVIDERS_ENDPOINT, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
    timeoutMs: 20000, retry: 0, signal: options.signal,
  });
}

export function fetchMihomoRuleProviderContent(name, options = {}) {
  const params = new URLSearchParams();
  const query = String(options.query || '').trim();
  if (query) params.set('q', query);
  params.set('limit', String(Math.max(1, Math.min(500, Number(options.limit) || 200))));
  params.set('offset', String(Math.max(0, Number(options.offset) || 0)));
  return requestJSON(`${PROVIDERS_ENDPOINT}/rule/${encodeURIComponent(String(name || ''))}/content?${params}`, {
    method: 'GET', cache: 'no-store', credentials: 'same-origin',
    timeoutMs: 20000, retry: 0, signal: options.signal,
  });
}

export function updateMihomoClashProvider(kind, name, options = {}) {
  const providerKind = String(kind || '');
  return requestJSON(`${PROVIDERS_ENDPOINT}/${encodeURIComponent(providerKind)}/${encodeURIComponent(String(name || ''))}/update`, {
    method: 'POST', credentials: 'same-origin', timeoutMs: 25000, retry: 0, signal: options.signal,
  });
}

export function healthcheckMihomoClashProvider(name, options = {}) {
  return requestJSON(`${PROVIDERS_ENDPOINT}/proxy/${encodeURIComponent(String(name || ''))}/healthcheck`, {
    method: 'POST', credentials: 'same-origin', timeoutMs: 25000, retry: 0, signal: options.signal,
  });
}

export function disconnectMihomoClashConnection(id, options = {}) {
  return requestJSON(`${CONNECTIONS_ENDPOINT}/${encodeURIComponent(String(id || ''))}`, {
    method: 'DELETE',
    credentials: 'same-origin',
    timeoutMs: 8000,
    retry: 0,
    signal: options.signal,
  });
}

export function disconnectAllMihomoClashConnections(count, options = {}) {
  return requestJSON(CONNECTIONS_ENDPOINT, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, count: Number(count) || 0 }),
    credentials: 'same-origin',
    timeoutMs: 8000,
    retry: 0,
    signal: options.signal,
  });
}

export async function requestMihomoClashWsToken(options = {}) {
  const scope = String(options.scope || 'mihomo-clash');
  const payload = await requestJSON(WS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, ttl: 60 }),
    credentials: 'same-origin',
    timeoutMs: 5000,
    retry: 0,
    signal: options.signal,
  });
  return payload && typeof payload.token === 'string' ? payload.token : '';
}

export function mihomoClashConnectionsWsUrl(token) {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL('/ws/mihomo-clash/connections', `${scheme}//${window.location.host}`);
  url.searchParams.set('token', String(token || ''));
  return url.toString();
}

export function mihomoClashLogsWsUrl(token) {
  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = new URL('/ws/mihomo-clash/logs', `${scheme}//${window.location.host}`);
  url.searchParams.set('token', String(token || ''));
  return url.toString();
}

export function previewMihomoClashMigration(transport, options = {}) {
  return requestJSON(MIGRATION_PREVIEW_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transport: String(transport || 'unix') }),
    credentials: 'same-origin', timeoutMs: 12000, retry: 0, signal: options.signal,
  });
}

export function applyMihomoClashMigration(transport, previewId, options = {}) {
  return requestJSON(MIGRATION_APPLY_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transport: String(transport || 'unix'),
      preview_id: String(previewId || ''),
      confirmed: true,
    }),
    credentials: 'same-origin', timeoutMs: 45000, retry: 0, signal: options.signal,
  });
}

export const mihomoClashClientApi = Object.freeze({
  fetchStatus: fetchMihomoClashStatus,
  setRuntimeMode: setMihomoClashRuntimeMode,
  fetchGroups: fetchMihomoClashGroups,
  selectProxy: selectMihomoClashProxy,
  unfixProxy: unfixMihomoClashProxy,
  testDelay: testMihomoClashDelay,
  fetchConnections: fetchMihomoClashConnections,
  fetchRules: fetchMihomoClashRules,
  fetchProviders: fetchMihomoClashProviders,
  fetchRuleProviderContent: fetchMihomoRuleProviderContent,
  updateProvider: updateMihomoClashProvider,
  healthcheckProvider: healthcheckMihomoClashProvider,
  disconnectConnection: disconnectMihomoClashConnection,
  disconnectAllConnections: disconnectAllMihomoClashConnections,
  requestWsToken: requestMihomoClashWsToken,
  previewMigration: previewMihomoClashMigration,
  applyMigration: applyMihomoClashMigration,
});
