import { getMihomoCoreHttpApi } from '../mihomo_runtime.js';

const STATUS_ENDPOINT = '/api/mihomo/clash/status';
const GROUPS_ENDPOINT = '/api/mihomo/clash/proxy-groups';
const DELAY_ENDPOINT = '/api/mihomo/clash/delay';
const CONNECTIONS_ENDPOINT = '/api/mihomo/clash/connections';
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
    body: JSON.stringify({ name: String(name || '') }),
    credentials: 'same-origin',
    timeoutMs: 12000,
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
  const payload = await requestJSON(WS_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'mihomo-clash', ttl: 60 }),
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

export const mihomoClashClientApi = Object.freeze({
  fetchStatus: fetchMihomoClashStatus,
  fetchGroups: fetchMihomoClashGroups,
  selectProxy: selectMihomoClashProxy,
  testDelay: testMihomoClashDelay,
  fetchConnections: fetchMihomoClashConnections,
  disconnectConnection: disconnectMihomoClashConnection,
  disconnectAllConnections: disconnectAllMihomoClashConnections,
  requestWsToken: requestMihomoClashWsToken,
});
