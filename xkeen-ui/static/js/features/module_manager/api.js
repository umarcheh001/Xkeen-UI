const BASE = '/api/modules';

function csrfToken() {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';
}

function normalizedError(code, message, status = 0) {
  return { code: String(code || 'module_request_failed'), message: String(message || 'Не удалось выполнить запрос.'), status };
}

export function createModuleLifecycleClient(fetchImpl = fetch) {
  async function request(path, method = 'GET', body) {
    const headers = { 'Cache-Control': 'no-store' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrfToken()) headers['X-CSRF-Token'] = csrfToken();
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw normalizedError('network_error', 'Не удалось связаться с сервером.');
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw normalizedError('invalid_response', 'Сервер вернул некорректный ответ.', response.status);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw normalizedError('invalid_response', 'Сервер вернул некорректный ответ.', response.status);
    }
    if (!response.ok || payload.ok === false) {
      throw normalizedError(payload.code, payload.message || payload.error, response.status);
    }
    return payload;
  }

  return {
    loadInstalled: () => request('/installed'),
    loadStatus: () => request('/operations/status'),
    loadAvailable: () => request('/available'),
    checkPanelUpdate: (forceRefresh = false) => request(
      '/panel/update-check',
      'POST',
      { force_refresh: Boolean(forceRefresh) },
    ),
    plan: (operation, moduleId) => request('/operations/plan', 'POST', { operation, ...(moduleId ? { module_id: moduleId } : {}) }),
    apply: (operation, moduleId, planId) => request('/operations/apply', 'POST', { operation, ...(moduleId ? { module_id: moduleId } : {}), plan_id: planId }),
    cancel: (operationId) => request(`/operations/${encodeURIComponent(operationId)}/cancel`, 'POST'),
    recover: () => request('/recovery', 'POST'),
    restart: () => request('/restart', 'POST'),
    setModuleEnabled: (moduleId, enabled) => request(`/${encodeURIComponent(moduleId)}`, 'PATCH', { enabled }),
  };
}
