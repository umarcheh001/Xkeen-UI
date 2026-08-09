import { getMihomoCoreHttpApi } from '../mihomo_runtime.js';

const STATUS_ENDPOINT = '/api/mihomo/clash/status';
const GROUPS_ENDPOINT = '/api/mihomo/clash/proxy-groups';
const DELAY_ENDPOINT = '/api/mihomo/clash/delay';

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

export const mihomoClashClientApi = Object.freeze({
  fetchStatus: fetchMihomoClashStatus,
  fetchGroups: fetchMihomoClashGroups,
  selectProxy: selectMihomoClashProxy,
  testDelay: testMihomoClashDelay,
});
