import { redactMihomoImportDiagnostic } from './mihomo_import_result.js';

const normalize = value => String(value || '').replace(/\r\n?/g, '\n');
const comparable = value => {
  const lines = normalize(value).split('\n').map(line => line.trim());
  while (lines.length && (!lines[lines.length - 1] || lines[lines.length - 1].startsWith('#'))) lines.pop();
  return lines.filter(Boolean).join('\n');
};
const proxyBlocks = value => {
  const lines = normalize(value).split('\n');
  const headers = lines.map((line, index) => /^proxies\s*:\s*(?:#.*)?$/.test(line) ? index : -1).filter(index => index >= 0);
  if (headers.length !== 1) return [];
  const section = [];
  for (const line of lines.slice(headers[0] + 1)) {
    if (/^[^\s#-]/.test(line)) break;
    section.push(line);
  }
  const first = section.find(line => /^\s*-\s+/.test(line));
  if (!first) return [];
  const indent = first.match(/^\s*/)[0].length;
  const blocks = [];
  let block = [];
  for (const line of section) {
    if (/^\s*-\s+/.test(line) && line.match(/^\s*/)[0].length === indent) {
      if (block.length) blocks.push(comparable(block.join('\n')));
      block = [line];
    } else if (block.length) block.push(line);
  }
  if (block.length) blocks.push(comparable(block.join('\n')));
  return blocks;
};

/** Shared, page-owned operation state; closing a dialog does not erase a job. */
export function createMihomoConfigOperations({
  request,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  jobTimeoutMs = 120000,
} = {}) {
  let owner = null;
  let operation = null;
  let monitoring = null;
  const pending = new Map();
  const listeners = new Set();
  const emit = () => { for (const listener of listeners) { try { listener(operation); } catch (_) {} } };
  const api = {
    get busy() { return owner !== null; },
    get operation() { return operation; },
    acquire({ recovery = false } = {}) {
      if (owner) throw new Error('Операция с конфигом уже выполняется. Дождитесь результата.');
      if (operation?.state === 'unknown' && !recovery) throw new Error('Сначала восстановите наблюдение за предыдущей операцией.');
      const identity = Symbol('config operation');
      owner = identity;
      return () => { if (owner === identity) owner = null; };
    },
    isCurrent(snapshot, editorText, context) {
      return !!snapshot && normalize(snapshot.sourceEditorContent) === normalize(editorText)
        && snapshot.context === context;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    remember(value) {
      operation = { ...value };
      emit();
      return operation;
    },
    addPending(intents) {
      for (const value of intents || []) {
        const intent = JSON.parse(JSON.stringify(value));
        const key = JSON.stringify([intent.url, intent.refresh_parser, intent.interval_hours, intent.groups, intent.proxies]);
        if (!pending.has(key)) pending.set(key, { intent, done: false });
      }
    },
    async registerPending(content) {
      let failed = 0;
      let registered = 0;
      const errors = [];
      const blocks = proxyBlocks(content);
      for (const entry of pending.values()) {
        if (entry.done) continue;
        const proxies = entry.intent.proxies || [];
        if (!proxies.length || !proxies.every(proxy => blocks.includes(comparable(proxy.proxy_yaml)))) continue;
        try {
          const result = await request('/api/mihomo/subscriptions/imported-xray', {
            method: 'POST', body: { ...entry.intent, config: content },
          });
          if (!result?.ok) throw new Error(result?.error || 'Не удалось зарегистрировать автообновление.');
          entry.done = true;
          registered++;
        } catch (error) {
          failed++;
          errors.push(redactMihomoImportDiagnostic(error?.message || 'Ошибка регистрации.'));
        }
      }
      return { failed, registered, errors };
    },
    async commit({ content, restart = false, baseRevision = '', operationId, url = '/api/mihomo/import/commit' }) {
      return request(url, { method: 'POST', body: {
        content, restart: restart === true, base_revision: baseRevision, operation_id: operationId,
      } });
    },
    monitor() {
      if (monitoring) return monitoring;
      if (!operation?.jobId) return Promise.resolve(operation);
      const current = operation;
      const update = patch => {
        if (operation === current) { Object.assign(current, patch); emit(); }
        return current;
      };
      monitoring = (async () => {
        const deadline = now() + jobTimeoutMs;
        update({ state: 'applying' });
        try {
          while (now() < deadline) {
            const result = await request(`/api/restart-job/${encodeURIComponent(current.jobId)}`);
            const log = result.output ? redactMihomoImportDiagnostic(result.output) : '';
            update({ log });
            if (result.status === 'error' || result.error || (result.status === 'finished' && result.exit_code !== 0)) {
              return update({ state: 'apply-failed', error: redactMihomoImportDiagnostic(result.error || `Код завершения: ${result.exit_code ?? 'неизвестен'}`) });
            }
            if (result.status === 'finished' && result.exit_code === 0) {
              const runtime = await request('/api/mihomo/import/runtime');
              let apiChecked = runtime.api_checked === true;
              if (runtime.running === true && !apiChecked) {
                try {
                  const health = await request('/api/mihomo/clash/status');
                  apiChecked = health.state === 'ready' && health.ok === true;
                } catch (_) { /* Controller unavailable does not mean the process stopped. */ }
              }
              return update({ state: runtime.running === true ? 'applied' : 'apply-failed',
                apiChecked,
                error: runtime.running === true ? '' : 'После перезапуска процесс Mihomo не найден.' });
            }
            await sleep(800);
          }
          return update({ state: 'unknown', error: 'Время ожидания истекло. Восстановите наблюдение за заданием.' });
        } catch (_) {
          return update({ state: 'unknown', error: 'Результат применения неизвестен. Восстановите наблюдение за заданием.' });
        }
      })().finally(() => { monitoring = null; });
      return monitoring;
    },
  };
  return api;
}

let shared;
export function getMihomoConfigOperations() {
  if (!shared) shared = createMihomoConfigOperations({ request: async (url, options = {}) => {
    const response = await fetch(url, {
      method: options.method || 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.data = data;
      error.status = response.status;
      throw error;
    }
    return data;
  } });
  return shared;
}
