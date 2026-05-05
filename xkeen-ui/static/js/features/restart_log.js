import { getXrayLogLineClass } from './xray_log_line_class.js';
import { ansiToXkeenHtml, escapeXkeenHtml, getXkeenCommandJobApi, getXkeenUiApi, toastXkeen } from './xkeen_runtime.js';

let restartLogModuleApi = null;

(() => {
  'use strict';

  const RL = restartLogModuleApi || {};
  restartLogModuleApi = RL;

  RL._rawText = typeof RL._rawText === 'string' ? RL._rawText : '';
  RL._knownEntryKeys = RL._knownEntryKeys instanceof Set ? RL._knownEntryKeys : new Set();
  RL._hasBaseline = !!RL._hasBaseline;
  RL._pollTimer = RL._pollTimer || null;
  RL._filter = RL._filter === 'errors' ? 'errors' : 'all';
  RL._preflightPayloads = RL._preflightPayloads instanceof Map ? RL._preflightPayloads : new Map();

  const RESTART_LOG_POLL_MS = 15000;
  const RESTART_LOG_TITLE = 'Журнал операций Xkeen';
  const LEGACY_RESTART_LOG_TITLE_RE = /^журнал\s+перезапуска$/i;
  const PREFLIGHT_PAYLOAD_STORAGE_PREFIX = 'xkeen.restartLog.preflight.';
  const PREFLIGHT_PAYLOAD_INDEX_KEY = 'xkeen.restartLog.preflight.index';
  const PREFLIGHT_PAYLOAD_LIMIT = 8;
  const RESTART_SUMMARY_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+source=([^\s]+)\s+result=([A-Z]+)(?:\s+(.*?))?\s*$/i;
  const RESTART_DETAIL_LABELS = Object.freeze({
    core: 'Целевое ядро',
    previous: 'Предыдущее ядро',
    runtime_status: 'Статус после операции',
    runtime_core: 'Активное ядро',
    duration_ms: 'Длительность',
    phase: 'Этап',
    returncode: 'Код возврата',
    file: 'Файл',
    timeout_s: 'Таймаут',
    timed_out: 'Таймаут сработал',
    preflight_ref: 'Диагностика',
    summary: 'Причина',
  });
  const RESTART_DETAIL_ORDER = Object.freeze([
    'file',
    'core',
    'previous',
    'runtime_status',
    'runtime_core',
    'duration_ms',
    'phase',
    'returncode',
    'timeout_s',
    'timed_out',
    'summary',
    'preflight_ref',
  ]);
  const RESTART_SOURCE_META = Object.freeze({
    api: {
      label: 'Xkeen',
      successText: 'перезапущен успешно',
      failureText: 'перезапуск завершился ошибкой',
      bucket: 'service',
    },
    'api-button': {
      label: 'Xkeen',
      successText: 'перезапущен вручную',
      failureText: 'ручной перезапуск завершился ошибкой',
      bucket: 'service',
    },
    'api-start': {
      label: 'Xkeen',
      successText: 'запущен',
      failureText: 'не удалось запустить',
      bucket: 'service',
    },
    'api-stop': {
      label: 'Xkeen',
      successText: 'остановлен',
      failureText: 'не удалось остановить',
      bucket: 'service',
    },
    'core-switch': {
      label: 'Ядро Xkeen',
      successText: 'ядро переключено, xkeen перезапущен',
      failureText: 'смена ядра завершилась ошибкой',
      bucket: 'core',
    },
    routing: {
      label: 'Routing',
      successText: 'сохранён, xkeen перезапущен',
      failureText: 'сохранён, но перезапуск xkeen завершился ошибкой',
      bucket: 'routing',
    },
    inbounds: {
      label: 'Inbounds',
      successText: 'сохранены, xkeen перезапущен',
      failureText: 'сохранены, но перезапуск xkeen завершился ошибкой',
      bucket: 'xray',
    },
    outbounds: {
      label: 'Outbounds',
      successText: 'сохранены, xkeen перезапущен',
      failureText: 'сохранены, но перезапуск xkeen завершился ошибкой',
      bucket: 'xray',
    },
    'observatory-preset': {
      label: 'Observatory',
      successText: 'пресет применён, xkeen перезапущен',
      failureText: 'пресет применён, но перезапуск xkeen завершился ошибкой',
      bucket: 'xray',
    },
    'mihomo-config': {
      label: 'Mihomo',
      successText: 'конфиг применён, xkeen перезапущен',
      failureText: 'конфиг применён, но перезапуск xkeen завершился ошибкой',
      bucket: 'mihomo',
    },
    'mihomo-profile-activate': {
      label: 'Mihomo',
      successText: 'профиль активирован, xkeen перезапущен',
      failureText: 'профиль активирован, но перезапуск xkeen завершился ошибкой',
      bucket: 'mihomo',
    },
    'mihomo-backup-restore': {
      label: 'Mihomo',
      successText: 'бэкап восстановлен, xkeen перезапущен',
      failureText: 'бэкап восстановлен, но перезапуск xkeen завершился ошибкой',
      bucket: 'mihomo',
    },
    'manual-mihomo': {
      label: 'Xkeen',
      successText: 'перезапущен вручную',
      failureText: 'ручной перезапуск завершился ошибкой',
      bucket: 'service',
    },
    'snapshot-restore': {
      label: 'Бэкап',
      successText: 'восстановлен, xkeen перезапущен',
      failureText: 'восстановлен, но перезапуск xkeen завершился ошибкой',
      bucket: 'backup',
    },
    'backups-page': {
      label: 'Бэкап',
      successText: 'операция выполнена, xkeen перезапущен',
      failureText: 'операция выполнена, но перезапуск xkeen завершился ошибкой',
      bucket: 'backup',
    },
    'port-proxying': {
      label: 'Port proxying',
      successText: 'список сохранён, xkeen перезапущен',
      failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
      bucket: 'service',
    },
    'port-exclude': {
      label: 'Port exclude',
      successText: 'список сохранён, xkeen перезапущен',
      failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
      bucket: 'service',
    },
    'ip-exclude': {
      label: 'IP exclude',
      successText: 'список сохранён, xkeen перезапущен',
      failureText: 'список сохранён, но перезапуск xkeen завершился ошибкой',
      bucket: 'service',
    },
    'xkeen-config': {
      label: 'xkeen.json',
      successText: 'сохранён, xkeen перезапущен',
      failureText: 'сохранён, но перезапуск xkeen завершился ошибкой',
      bucket: 'service',
    },
    'xray-subscription-delete': {
      label: 'Подписка Xray',
      successText: 'удалена, xkeen перезапущен',
      failureText: 'удалена, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
    },
    'xray-subscription-refresh': {
      label: 'Подписка Xray',
      successText: 'обновлена, xkeen перезапущен',
      failureText: 'обновлена, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
      toastSuccess: 'Подписка Xray обновлена. xkeen перезапущен.',
      toastFailure: 'Подписка Xray обновлена, но перезапуск xkeen завершился ошибкой.',
    },
    'xray-preflight': {
      label: 'Xray preflight',
      successText: 'конфиг прошёл проверку',
      failureText: 'конфиг отклонён, xkeen не перезапускался',
      bucket: 'preflight',
    },
  });

  const XRAY_TS_LINE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:(?:\[([^\]]+)\])|((?:INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)))?\s*(.*)$/i;
  const XRAY_BRACKET_LINE_RE = /^(INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)\[([^\]]+)\]\s*(.*)$/i;

  function safeEscapeHtml(text) {
    try {
      return escapeXkeenHtml(text || '');
    } catch (error) {}
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function ansiToHtml(line) {
    return ansiToXkeenHtml(line || '');
  }

  function titleCaseWords(text) {
    return String(text || '').replace(/\b([a-zа-яё])/gi, (match) => match.toUpperCase());
  }

  function fallbackRestartSourceLabel(source) {
    const raw = String(source || '').trim();
    if (!raw) return 'Событие';
    return titleCaseWords(raw.replace(/[-_]+/g, ' '));
  }

  function decodeRestartMetaValue(value) {
    const raw = String(value || '');
    if (!raw) return '';
    try {
      return decodeURIComponent(raw.replace(/\+/g, '%20'));
    } catch (error) {
      return raw;
    }
  }

  function parseRestartMeta(rawText) {
    const text = String(rawText || '').trim();
    if (!text) return {};

    const out = {};
    const re = /([A-Za-z0-9_.-]+)=([^\s]+)/g;
    let match = null;
    while ((match = re.exec(text))) {
      const key = String(match[1] || '').trim();
      if (!key) continue;
      out[key] = decodeRestartMetaValue(match[2]);
    }
    return out;
  }

  function humanCoreName(core) {
    const value = String(core || '').trim().toLowerCase();
    if (!value || value === 'none' || value === 'null' || value === '-') return '';
    if (value === 'xray') return 'Xray';
    if (value === 'mihomo') return 'Mihomo';
    if (value === 'unknown') return 'неизвестно';
    return value ? titleCaseWords(value.replace(/[-_]+/g, ' ')) : '';
  }

  function formatDurationMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return '';
    if (ms >= 1000) {
      const seconds = ms / 1000;
      return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}с`;
    }
    return `${Math.round(ms)}мс`;
  }

  function formatRuntimeStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'running' || raw === 'run' || raw === 'started' || raw === '1' || raw === 'true') return 'работает';
    if (raw === 'stopped' || raw === 'stop' || raw === '0' || raw === 'false') return 'остановлен';
    return raw ? titleCaseWords(raw.replace(/[-_]+/g, ' ')) : '';
  }

  function formatBooleanValue(value) {
    const raw = String(value == null ? '' : value).trim().toLowerCase();
    if (!raw) return '';
    if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return 'да';
    if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return 'нет';
    return raw;
  }

  function formatRestartDetailLabel(key) {
    const raw = String(key || '').trim();
    if (!raw) return 'Параметр';
    return RESTART_DETAIL_LABELS[raw] || titleCaseWords(raw.replace(/[-_]+/g, ' '));
  }

  function formatRestartDetailValue(key, value) {
    const rawKey = String(key || '').trim();
    const rawValue = String(value == null ? '' : value).trim();
    if (!rawValue) return '';
    if (rawKey === 'duration_ms') return formatDurationMs(rawValue);
    if (rawKey === 'timeout_s') return `${rawValue}с`;
    if (rawKey === 'timed_out') return formatBooleanValue(rawValue);
    if (rawKey === 'core' || rawKey === 'previous' || rawKey === 'runtime_core') {
      return humanCoreName(rawValue);
    }
    if (rawKey === 'runtime_status') return formatRuntimeStatus(rawValue);
    return rawValue;
  }

  function formatRestartMetaDetails(source, details) {
    const meta = details && typeof details === 'object' ? details : {};
    const parts = [];

    if (source === 'core-switch') {
      const core = humanCoreName(meta.core);
      const previous = humanCoreName(meta.previous);
      if (core) parts.push(`цель: ${core}`);
      if (previous && previous !== core) parts.push(`было: ${previous}`);
      if (meta.phase) parts.push(`этап: ${meta.phase}`);
      if (meta.returncode) parts.push(`код: ${meta.returncode}`);
    }

    const runtimeStatus = formatRuntimeStatus(meta.runtime_status);
    const runtimeCore = humanCoreName(meta.runtime_core);
    if (runtimeStatus) parts.push(`статус: ${runtimeStatus}`);
    if (runtimeCore) parts.push(`ядро: ${runtimeCore}`);

    const duration = formatDurationMs(meta.duration_ms);
    if (duration) parts.push(duration);

    return parts.join(' · ');
  }

  function buildRestartSummaryMessage(source, ok, baseMessage, details) {
    const message = String(baseMessage || '');
    if (source === 'xray-preflight') {
      return ok ? message : 'конфиг отклонён preflight-проверкой';
    }

    if (source !== 'core-switch') return message;

    const core = humanCoreName(details && details.core);
    if (!core) return message;
    return ok
      ? `переключено на ${core}, xkeen перезапущен`
      : `не удалось переключить на ${core}`;
  }

  function parseStructuredRestartLine(line) {
    const raw = String(line || '');
    if (!raw) return null;

    const match = raw.match(RESTART_SUMMARY_RE);
    if (!match) return null;

    const ts = String(match[1] || '').trim();
    const source = decodeRestartMetaValue(match[2] || '').trim();
    const result = String(match[3] || '').trim().toUpperCase();
    const details = parseRestartMeta(match[4] || '');
    const ok = result === 'OK';
    const meta = RESTART_SOURCE_META[source] || null;
    const label = meta && meta.label ? meta.label : fallbackRestartSourceLabel(source);
    const baseMessage = ok
      ? (meta && meta.successText ? meta.successText : 'операция завершилась успешно')
      : (meta && meta.failureText ? meta.failureText : 'операция завершилась с ошибкой');
    const message = buildRestartSummaryMessage(source, ok, baseMessage, details);
    const kind = ok ? 'success' : 'error';
    const bucket = meta && meta.bucket ? meta.bucket : 'generic';
    const detailsText = formatRestartMetaDetails(source, details);
    const copyText = `[${ts}] ${label} — ${message}${detailsText ? ` · ${detailsText}` : ''}`;
    const rawSourceText = detailsText || (meta ? '' : `Источник: ${source}`);

    return {
      ts,
      source,
      result,
      details,
      ok,
      kind,
      bucket,
      label,
      message,
      copyText,
      rawSourceText,
      isSubscriptionRefresh: source === 'xray-subscription-refresh',
      toastMessage: source === 'xray-subscription-refresh'
        ? (ok
          ? (meta && meta.toastSuccess ? meta.toastSuccess : 'Подписка Xray обновлена.')
          : (meta && meta.toastFailure ? meta.toastFailure : 'Подписка Xray обновлена с ошибкой перезапуска.'))
        : '',
    };
  }

  function parseRenderedEntries(rawText) {
    const text = String(rawText || '');
    if (!text) return [];

    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();

    const duplicateCounts = new Map();
    return lines.map((line, index) => {
      const raw = String(line || '');
      const seen = Number(duplicateCounts.get(raw) || 0) + 1;
      duplicateCounts.set(raw, seen);
      return {
        raw,
        index,
        key: `${raw}@@${seen}`,
        summary: parseStructuredRestartLine(raw),
      };
    });
  }

  function showSubscriptionRefreshToast(events) {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    if (!list.length) return;

    if (list.length === 1) {
      const event = list[0];
      try {
        toastXkeen({
          id: `xray-subscription-refresh:${event.ts}:${event.result}`,
          dedupeKey: `xray-subscription-refresh:${event.ts}:${event.result}`,
          message: event.toastMessage || 'Подписка Xray обновлена.',
          kind: event.kind || 'success',
          duration: event.ok ? 3800 : 5200,
        });
      } catch (error) {}
      return;
    }

    const successCount = list.filter((event) => event && event.ok).length;
    const errorCount = list.length - successCount;
    const tail = list[list.length - 1];
    const keyTail = tail && tail.ts ? tail.ts : String(Date.now());
    const message = errorCount
      ? `Обновления подписок Xray: успешно ${successCount}, с ошибкой ${errorCount}.`
      : `Подписки Xray обновлены: ${successCount}.`;
    const kind = errorCount ? (successCount ? 'warning' : 'error') : 'success';

    try {
      toastXkeen({
        id: `xray-subscription-refresh-batch:${keyTail}`,
        dedupeKey: `xray-subscription-refresh-batch:${keyTail}`,
        message,
        kind,
        duration: errorCount ? 5200 : 4200,
      });
    } catch (error) {}
  }

  function syncKnownEntries(entries, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const shouldToast = opts.toastNewSubscription !== false;
    const previousKeys = RL._knownEntryKeys instanceof Set ? RL._knownEntryKeys : new Set();
    const nextKeys = new Set();
    const freshSubscriptionEvents = [];

    entries.forEach((entry) => {
      if (!entry || !entry.key) return;
      nextKeys.add(entry.key);
      if (!RL._hasBaseline || !shouldToast || previousKeys.has(entry.key)) return;
      if (entry.summary && entry.summary.isSubscriptionRefresh) {
        freshSubscriptionEvents.push(entry.summary);
      }
    });

    RL._knownEntryKeys = nextKeys;
    RL._hasBaseline = true;

    if (freshSubscriptionEvents.length) {
      showSubscriptionRefreshToast(freshSubscriptionEvents);
    }
  }

  function normalizePreflightRef(value) {
    return String(value || '').trim();
  }

  function readStoredPreflightIndex() {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(PREFLIGHT_PAYLOAD_INDEX_KEY) : '';
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(normalizePreflightRef).filter(Boolean) : [];
    } catch (error) {
      return [];
    }
  }

  function writeStoredPreflightIndex(refs) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(PREFLIGHT_PAYLOAD_INDEX_KEY, JSON.stringify(refs || []));
    } catch (error) {}
  }

  function rememberPreflightPayload(payload) {
    const data = payload && typeof payload === 'object' ? payload : {};
    const ref = normalizePreflightRef(data.preflight_ref || data.preflightRef);
    if (!ref) return false;

    const safePayload = Object.assign({}, data, { preflight_ref: ref });
    RL._preflightPayloads.set(ref, safePayload);

    try {
      if (window.localStorage) {
        window.localStorage.setItem(PREFLIGHT_PAYLOAD_STORAGE_PREFIX + ref, JSON.stringify(safePayload));
        const ordered = [ref].concat(readStoredPreflightIndex().filter((item) => item !== ref));
        const nextIndex = ordered.slice(0, PREFLIGHT_PAYLOAD_LIMIT);
        writeStoredPreflightIndex(nextIndex);
        ordered.slice(PREFLIGHT_PAYLOAD_LIMIT).forEach((oldRef) => {
          try { window.localStorage.removeItem(PREFLIGHT_PAYLOAD_STORAGE_PREFIX + oldRef); } catch (error) {}
        });
      }
    } catch (error) {}

    return true;
  }

  function readPreflightPayload(refValue) {
    const ref = normalizePreflightRef(refValue);
    if (!ref) return null;
    if (RL._preflightPayloads.has(ref)) return RL._preflightPayloads.get(ref);
    try {
      const raw = window.localStorage ? window.localStorage.getItem(PREFLIGHT_PAYLOAD_STORAGE_PREFIX + ref) : '';
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      RL._preflightPayloads.set(ref, parsed);
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function extractPreflightPayloadFromDiagnostic(data, refValue) {
    if (!data || typeof data !== 'object') return null;
    const ref = normalizePreflightRef(refValue || data.preflight_ref || data.ref);
    const rawPayload = data.payload && typeof data.payload === 'object' ? data.payload : data;
    if (!rawPayload || typeof rawPayload !== 'object') return null;
    const payloadRef = normalizePreflightRef(rawPayload.preflight_ref || ref);
    if (!payloadRef) return null;
    return Object.assign({}, rawPayload, { preflight_ref: payloadRef });
  }

  async function fetchPreflightPayload(refValue) {
    const ref = normalizePreflightRef(refValue);
    if (!ref) return null;
    try {
      const res = await fetch(`/api/operation-diagnostics/${encodeURIComponent(ref)}`, {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!res || !res.ok) return null;
      const data = await res.json();
      const payload = extractPreflightPayloadFromDiagnostic(data, ref);
      if (!payload) return null;
      rememberPreflightPayload(payload);
      return payload;
    } catch (error) {
      return null;
    }
  }

  async function openPreflightPayload(ref) {
    let payload = readPreflightPayload(ref);
    if (!payload) {
      payload = await fetchPreflightPayload(ref);
    }
    if (!payload) {
      try {
        toastXkeen('Диагностика preflight недоступна. Повторите сохранение конфига, чтобы открыть разбор.', 'warning');
      } catch (error) {}
      return false;
    }

    const present = () => {
      try {
        const ui = getXkeenUiApi();
        if (ui && typeof ui.showXrayPreflightError === 'function') {
          ui.showXrayPreflightError(payload);
          return true;
        }
      } catch (error) {}
      return false;
    };

    if (present()) return true;
    try {
      await import('../ui/xray_preflight_modal.js');
    } catch (error) {}
    if (present()) return true;
    try { toastXkeen('Не удалось открыть окно диагностики Xray.', 'error'); } catch (error) {}
    return false;
  }

  function stableHash(text) {
    const raw = String(text || '');
    let hash = 0;
    for (let i = 0; i < raw.length; i += 1) {
      hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
  }

  function buildRestartDetailRows(summary) {
    if (!summary) return [];
    const details = summary.details && typeof summary.details === 'object' ? summary.details : {};
    const keys = [];
    RESTART_DETAIL_ORDER.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(details, key)) keys.push(key);
    });
    Object.keys(details).sort().forEach((key) => {
      if (keys.indexOf(key) === -1) keys.push(key);
    });

    const rows = [
      ['Время', summary.ts],
      ['Источник', summary.source],
      ['Результат', summary.ok ? 'OK' : 'FAIL'],
    ];

    keys.forEach((key) => {
      const value = formatRestartDetailValue(key, details[key]);
      if (!value) return;
      rows.push([formatRestartDetailLabel(key), value]);
    });

    return rows;
  }

  function buildStructuredDetailsHtml(summary, entry) {
    const rows = buildRestartDetailRows(summary);
    const detailsCount = summary && summary.details && typeof summary.details === 'object'
      ? Object.keys(summary.details).length
      : 0;
    if (!detailsCount && summary && RESTART_SOURCE_META[summary.source]) return '';

    const id = `restart-log-detail-${entry && typeof entry.index === 'number' ? entry.index : 0}-${stableHash(entry && entry.key)}`;
    const rowsHtml = rows.map(([label, value]) => [
      '<span class="restart-log-detail-row">',
      `<span class="restart-log-detail-label">${safeEscapeHtml(label)}</span>`,
      `<span class="restart-log-detail-value">${safeEscapeHtml(value)}</span>`,
      '</span>',
    ].join('')).join('');
    const preflightRef = summary && summary.source === 'xray-preflight'
      ? normalizePreflightRef(summary.details && summary.details.preflight_ref)
      : '';
    const preflightActionHtml = preflightRef
      ? `<button type="button" class="restart-log-preflight-open" data-xk-restart-log-preflight-ref="${safeEscapeHtml(preflightRef)}">Открыть разбор ошибки</button>`
      : '';

    return [
      `<button type="button" class="restart-log-details-toggle" data-xk-restart-log-detail-toggle="1" aria-expanded="false" aria-controls="${id}">Детали</button>`,
      `<span class="restart-log-details" id="${id}" hidden>${rowsHtml}${preflightActionHtml}</span>`,
    ].join('');
  }

  function buildStructuredLineHtml(summary, entry) {
    if (!summary) return '';

    const bucket = String(summary.bucket || 'generic').trim().toLowerCase() || 'generic';
    const tsHtml = safeEscapeHtml(`[${summary.ts}]`);
    const labelHtml = safeEscapeHtml(summary.label || 'Событие');
    const messageHtml = safeEscapeHtml(summary.message || '');
    const rawSourceHtml = summary.rawSourceText ? safeEscapeHtml(summary.rawSourceText) : '';
    const detailsHtml = buildStructuredDetailsHtml(summary, entry || null);

    return [
      '<span class="restart-log-entry-wrap">',
      '<span class="restart-log-entry">',
      `<span class="log-ts restart-log-ts">${tsHtml}</span>`,
      `<span class="restart-log-pill restart-log-pill-${bucket}">${labelHtml}</span>`,
      `<span class="restart-log-message">${messageHtml}</span>`,
      rawSourceHtml ? `<span class="restart-log-meta">${rawSourceHtml}</span>` : '',
      '</span>',
      detailsHtml,
      '</span>',
    ].join('');
  }

  function normalizeLineForTerminal(line) {
    const s = String(line || '');
    if (!s) return s;

    const summary = parseStructuredRestartLine(s);
    if (summary) return summary.copyText;

    if (s.indexOf('\x1b') !== -1) return s;
    if (/^(?:INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)\[/.test(s)) return s;

    const match = s.match(XRAY_TS_LINE_RE);
    if (!match) return s;

    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}`;
    const levelRaw = String(match[5] || match[6] || '').trim().toLowerCase();
    let level = 'INFO';
    if (levelRaw.startsWith('warn')) level = 'WARN';
    else if (levelRaw.startsWith('error')) level = 'ERROR';
    else if (levelRaw.startsWith('fatal')) level = 'FATA';
    else if (levelRaw.startsWith('debug')) level = 'DEBUG';

    const message = String(match[7] || '').replace(/^\s+/, '');
    return message ? `${level}[${iso}] ${message}` : `${level}[${iso}]`;
  }

  function normalizeRuntimeLevel(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (!raw) return 'INFO';
    if (raw === 'WARNING') return 'WARN';
    if (raw === 'ERROR') return 'ERRO';
    return raw;
  }

  function runtimeLevelKind(level) {
    const raw = normalizeRuntimeLevel(level).toLowerCase();
    if (raw === 'warn' || raw === 'warning') return 'warning';
    if (raw === 'erro' || raw === 'error' || raw === 'fata' || raw === 'fatal') return 'error';
    if (raw === 'debug') return 'debug';
    return 'info';
  }

  function formatRuntimeTimestamp(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(.+)$/);
    if (iso) return `${iso[1]}/${iso[2]}/${iso[3]} ${iso[4]}`;
    return raw;
  }

  function splitRuntimeMessage(message) {
    const raw = String(message || '').replace(/^\s+/, '');
    const match = raw.match(/^([A-Za-z0-9_.\/-]+):\s+(.*)$/);
    if (!match) return { source: '', body: raw };
    return {
      source: String(match[1] || '').trim(),
      body: String(match[2] || '').trim(),
    };
  }

  function parseRuntimeLogLine(line) {
    const raw = String(line || '');
    if (!raw) return null;

    const tsMatch = raw.match(XRAY_TS_LINE_RE);
    if (tsMatch) {
      const level = normalizeRuntimeLevel(tsMatch[5] || tsMatch[6] || 'INFO');
      return {
        level,
        kind: runtimeLevelKind(level),
        ts: `${tsMatch[1]}/${tsMatch[2]}/${tsMatch[3]} ${tsMatch[4]}`,
        message: String(tsMatch[7] || '').replace(/^\s+/, ''),
      };
    }

    const bracketMatch = raw.match(XRAY_BRACKET_LINE_RE);
    if (!bracketMatch) return null;
    const level = normalizeRuntimeLevel(bracketMatch[1]);
    return {
      level,
      kind: runtimeLevelKind(level),
      ts: formatRuntimeTimestamp(bracketMatch[2]),
      message: String(bracketMatch[3] || '').replace(/^\s+/, ''),
    };
  }

  function buildRuntimeLogLineHtml(line) {
    const parsed = parseRuntimeLogLine(line);
    if (!parsed) return '';
    const parts = splitRuntimeMessage(parsed.message);
    const sourceHtml = parts.source
      ? `<span class="restart-log-runtime-source">${safeEscapeHtml(parts.source)}:</span>`
      : '';
    const bodyHtml = parts.body ? safeEscapeHtml(parts.body) : '';
    return [
      `<span class="restart-log-runtime-line restart-log-runtime-${parsed.kind}">`,
      `<span class="restart-log-runtime-ts">${safeEscapeHtml(parsed.ts)}</span>`,
      `<span class="restart-log-level restart-log-level-${parsed.kind}">${safeEscapeHtml(parsed.level)}</span>`,
      '<span class="restart-log-runtime-message">',
      sourceHtml,
      sourceHtml && bodyHtml ? ' ' : '',
      bodyHtml,
      '</span>',
      '</span>',
    ].join('');
  }

  function serviceStatusKind(line) {
    const lower = String(line || '').toLowerCase();
    if (!lower.trim()) return '';
    if (
      lower.includes('остановлен') ||
      lower.includes('не активна') ||
      lower.includes('not active') ||
      lower.includes('stopped')
    ) {
      return 'error';
    }
    if (
      lower.includes('запущен') ||
      lower.includes('started') ||
      lower.includes('running')
    ) {
      return 'success';
    }
    if (
      lower.includes('прокси-клиент') ||
      lower.includes('прозрачного прокси') ||
      lower.includes('mihomo') ||
      lower.includes('xkeen')
    ) {
      return 'warning';
    }
    return '';
  }

  function buildServiceStatusLineHtml(line) {
    const raw = String(line || '').trim();
    const kind = serviceStatusKind(raw);
    if (!raw || !kind) return '';
    return [
      `<span class="restart-log-service-line restart-log-service-${kind}">`,
      '<span class="restart-log-service-spacer" aria-hidden="true"></span>',
      `<span class="restart-log-service-message">${ansiToHtml(raw)}</span>`,
      '</span>',
    ].join('');
  }

  function buildPlainLogLineHtml(rawLine, normalizedLine) {
    const raw = String(rawLine || '');
    const normalized = String(normalizedLine || raw);
    return (
      buildRuntimeLogLineHtml(raw) ||
      buildRuntimeLogLineHtml(normalized) ||
      buildServiceStatusLineHtml(raw) ||
      `<span class="restart-log-raw-line">${ansiToHtml(normalized)}</span>`
    );
  }

  function normalizeTextForTerminal(text) {
    const raw = String(text || '');
    if (!raw) return raw;
    const hasTrailingNl = raw.endsWith('\n');
    const lines = raw.split(/\r?\n/);
    if (hasTrailingNl && lines.length && lines[lines.length - 1] === '') lines.pop();
    const normalized = lines.map(normalizeLineForTerminal).join('\n');
    return hasTrailingNl ? `${normalized}\n` : normalized;
  }

  function rawLineLooksLikeError(line) {
    const lower = String(line || '').toLowerCase();
    return (
      lower.includes('error') ||
      lower.includes('fail') ||
      lower.includes('failed') ||
      lower.includes('fatal') ||
      lower.includes('timeout') ||
      lower.includes('ошиб')
    );
  }

  function entryMatchesCurrentFilter(entry) {
    if (RL._filter !== 'errors') return true;
    if (!entry) return false;
    if (entry.summary) return !entry.summary.ok;
    return rawLineLooksLikeError(entry.raw);
  }

  function filterRenderedEntries(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.filter(entryMatchesCurrentFilter);
  }

  function syncFilterButtons() {
    const active = RL._filter === 'errors' ? 'errors' : 'all';
    try {
      document.querySelectorAll('[data-xk-restart-log-filter]').forEach((btn) => {
        const value = String(btn.getAttribute('data-xk-restart-log-filter') || '').trim();
        const pressed = value === active;
        btn.classList.toggle('is-active', pressed);
        btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
      });
    } catch (error) {}
  }

  function getLogEls() {
    const els = [];
    try {
      document.querySelectorAll('[data-xk-restart-log="1"]').forEach((el) => {
        if (el) els.push(el);
      });
    } catch (error) {}

    try {
      const legacy = document.getElementById('restart-log');
      if (legacy && els.indexOf(legacy) === -1) els.push(legacy);
    } catch (error) {}

    return els;
  }

  function getSummaryEls() {
    const els = [];
    try {
      document.querySelectorAll('[data-xk-restart-log-summary="1"]').forEach((el) => {
        if (el) els.push(el);
      });
    } catch (error) {}
    return els;
  }

  function formatSummaryTimestamp(ts) {
    const raw = String(ts || '').trim();
    if (!raw) return '';
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?::\d{2})?$/);
    if (!match) return raw;
    try {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      if (match[1] === todayStr) return match[2];
    } catch (error) {}
    return `${match[1]} ${match[2]}`;
  }

  function buildRestartLogSummary(entries) {
    const list = Array.isArray(entries) ? entries : [];
    let lastSummary = null;
    let lastCore = '';
    let errorCount = 0;
    let totalStructured = 0;

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      if (!entry || !entry.summary) continue;
      totalStructured += 1;
      if (!lastSummary) lastSummary = entry.summary;
      if (!lastCore) {
        const details = entry.summary.details && typeof entry.summary.details === 'object'
          ? entry.summary.details
          : {};
        const detailsCore = humanCoreName(details.runtime_core || details.core);
        if (detailsCore && detailsCore !== 'неизвестно') lastCore = detailsCore;
      }
      if (!entry.summary.ok) errorCount += 1;
    }

    if (!totalStructured) {
      return { hidden: true, parts: [] };
    }

    const parts = [];
    if (lastSummary) {
      const time = formatSummaryTimestamp(lastSummary.ts) || lastSummary.ts || '';
      const status = lastSummary.ok ? 'успешно' : 'ошибка';
      parts.push({
        label: 'Последний перезапуск',
        value: time ? `${status}, ${time}` : status,
        kind: lastSummary.ok ? 'success' : 'error',
      });
    }
    if (lastCore) {
      parts.push({ label: 'Активное ядро', value: lastCore, kind: 'info' });
    }
    parts.push({
      label: 'Всего ошибок',
      value: String(errorCount),
      kind: errorCount ? 'error' : 'muted',
    });

    return { hidden: parts.length === 0, parts };
  }

  function renderSummaryInto(el, summary) {
    if (!el) return;
    if (!summary || summary.hidden || !Array.isArray(summary.parts) || !summary.parts.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    const html = summary.parts
      .map((part) => {
        const kind = String(part && part.kind ? part.kind : '').trim();
        const cls = `restart-log-summary-part${kind ? ' restart-log-summary-part-' + kind : ''}`;
        return [
          `<span class="${cls}">`,
          `<span class="restart-log-summary-label">${safeEscapeHtml(part.label)}:</span>`,
          ' ',
          `<span class="restart-log-summary-value">${safeEscapeHtml(part.value)}</span>`,
          '</span>',
        ].join('');
      })
      .join('<span class="restart-log-summary-sep" aria-hidden="true">·</span>');
    el.hidden = false;
    el.innerHTML = html;
  }

  function renderAllSummary(allEntries) {
    const els = getSummaryEls();
    if (!els.length) return;
    const summary = buildRestartLogSummary(allEntries);
    els.forEach((el) => renderSummaryInto(el, summary));
  }

  function isElementVisible(el) {
    if (!el) return false;
    try {
      if (el.hidden) return false;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      if (!rect) return !!el.offsetParent;
      return rect.width > 0 && rect.height > 0;
    } catch (error) {}
    return false;
  }

  function getVisibleLogEls() {
    return getLogEls().filter(isElementVisible);
  }

  function getRevealTarget(el) {
    if (!el) return null;
    try {
      return el.closest('.log-card') || el.closest('.card') || el;
    } catch (error) {}
    return el;
  }

  function focusLogEl(el) {
    if (!el || typeof el.focus !== 'function') return;
    try {
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
    } catch (error) {}
  }

  async function waitForCommandJob(jobId, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;
    const maxWaitMs = typeof opts.maxWaitMs === 'number' && opts.maxWaitMs > 0
      ? opts.maxWaitMs
      : (5 * 60 * 1000);

    const jobsApi = getXkeenCommandJobApi();
    if (jobsApi && typeof jobsApi.waitForCommandJob === 'function') {
      return jobsApi.waitForCommandJob(String(jobId), {
        maxWaitMs,
        onChunk: (chunk, meta) => {
          if (!chunk || !onChunk) return;
          try { onChunk(chunk, meta || null); } catch (error) {}
        },
      });
    }

    let lastLen = 0;
    while (true) {
      const res = await fetch(`/api/run-command/${encodeURIComponent(String(jobId))}`);
      const data = await res.json().catch(() => ({}));
      const output = data && typeof data.output === 'string' ? data.output : '';
      if (output.length > lastLen) {
        const chunk = output.slice(lastLen);
        lastLen = output.length;
        if (chunk && onChunk) {
          try { onChunk(chunk, { via: 'http', jobId: String(jobId) }); } catch (error) {}
        }
      }
      if (!res.ok || data.ok === false || data.status === 'finished' || data.status === 'error') {
        return data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  function renderInto(el, rawText) {
    if (!el) return;
    const allEntries = parseRenderedEntries(rawText || '');
    const entries = filterRenderedEntries(allEntries);
    const html = entries
      .map((entry) => {
        const summary = entry && entry.summary ? entry.summary : null;
        if (summary) {
          const cls = `log-line restart-log-line log-line-${summary.kind} restart-log-line-${summary.bucket}`;
          return `<span class="${cls}">${buildStructuredLineHtml(summary, entry)}</span>`;
        }

        const normalized = normalizeLineForTerminal(entry && entry.raw ? entry.raw : '');
        let cls = 'log-line';
        if (typeof getXrayLogLineClass === 'function') {
          cls = getXrayLogLineClass(normalized);
        } else {
          const lower = normalized.toLowerCase();
          if (
            lower.includes('error') ||
            lower.includes('fail') ||
            lower.includes('failed') ||
            lower.includes('fatal')
          ) {
            cls = 'log-line log-line-error';
          } else if (lower.includes('warning') || lower.includes('warn')) {
            cls = 'log-line log-line-warning';
          } else if (lower.includes('info')) {
            cls = 'log-line log-line-info';
          } else if (lower.includes('debug')) {
            cls = 'log-line log-line-debug';
          }
        }
        return `<span class="${cls} restart-log-terminal-entry">${buildPlainLogLineHtml(entry && entry.raw ? entry.raw : '', normalized)}</span>`;
      })
      .join('');

    el.innerHTML = html || `<span class="log-line restart-log-empty">${RL._filter === 'errors' ? 'Ошибок нет.' : 'Журнал пуст.'}</span>`;
    try { el.scrollTop = el.scrollHeight; } catch (error) {}
  }

  function renderAll() {
    const els = getLogEls();
    const raw = RL._rawText || '';
    if (els.length) {
      els.forEach((el) => {
        try { el.dataset.rawText = raw; } catch (error) {}
        renderInto(el, raw);
      });
    }
    syncFilterButtons();
    renderAllSummary(parseRenderedEntries(raw));
    bindLogInteractions();
  }

  function ensurePolling() {
    if (RL._pollTimer) return;
    RL._pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!getLogEls().length) return;
      try { RL.load({ toastNewSubscription: true, silent: true }); } catch (error) {}
    }, RESTART_LOG_POLL_MS);
  }

  const RESTART_LOG_WS_BACKOFF_MIN_MS = 1500;
  const RESTART_LOG_WS_BACKOFF_MAX_MS = 30000;
  const RESTART_LOG_WS_REFRESH_DEBOUNCE_MS = 250;
  const RESTART_LOG_WS_EVENTS = new Set([
    'restart_log_appended',
    'xkeen_restarted',
    'core_changed',
    'core_change_error',
  ]);

  RL._wsBackoffMs = Number(RL._wsBackoffMs) > 0 ? Number(RL._wsBackoffMs) : RESTART_LOG_WS_BACKOFF_MIN_MS;
  RL._ws = RL._ws || null;
  RL._wsRefreshTimer = RL._wsRefreshTimer || null;
  RL._wsAttached = !!RL._wsAttached;
  RL._wsReconnectTimer = RL._wsReconnectTimer || null;

  function isRestartLogRelevantEvent(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const name = String(payload.event || '').trim().toLowerCase();
    return RESTART_LOG_WS_EVENTS.has(name);
  }

  async function fetchEventsWsToken() {
    try {
      const res = await fetch('/api/ws-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ scope: 'events' }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data && data.ok && data.token) return String(data.token || '');
    } catch (error) {}
    return '';
  }

  function scheduleRestartLogWsReconnect() {
    if (RL._wsReconnectTimer) return;
    const delay = RL._wsBackoffMs;
    RL._wsBackoffMs = Math.min(RESTART_LOG_WS_BACKOFF_MAX_MS, Math.round(RL._wsBackoffMs * 2));
    RL._wsReconnectTimer = setTimeout(() => {
      RL._wsReconnectTimer = null;
      connectRestartLogWs().catch(() => {});
    }, delay);
  }

  function debouncedRestartLogReload() {
    if (RL._wsRefreshTimer) return;
    RL._wsRefreshTimer = setTimeout(() => {
      RL._wsRefreshTimer = null;
      try { RL.load({ silent: true, toastNewSubscription: true }); } catch (error) {}
    }, RESTART_LOG_WS_REFRESH_DEBOUNCE_MS);
  }

  async function connectRestartLogWs() {
    if (typeof window === 'undefined' || !window.WebSocket) return;
    const existing = RL._ws;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const token = await fetchEventsWsToken();
    if (!token) {
      scheduleRestartLogWsReconnect();
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws/events?token=${encodeURIComponent(token)}`;

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      scheduleRestartLogWsReconnect();
      return;
    }

    RL._ws = ws;

    ws.addEventListener('open', () => {
      RL._wsBackoffMs = RESTART_LOG_WS_BACKOFF_MIN_MS;
    });

    ws.addEventListener('message', (event) => {
      let payload = null;
      try { payload = JSON.parse(String((event && event.data) || '')); } catch (e) {}
      if (!isRestartLogRelevantEvent(payload)) return;
      debouncedRestartLogReload();
    });

    ws.addEventListener('close', () => {
      if (RL._ws === ws) RL._ws = null;
      scheduleRestartLogWsReconnect();
    });

    ws.addEventListener('error', () => {
      try { ws.close(); } catch (e) {}
    });
  }

  function ensureRestartLogWs() {
    if (RL._wsAttached) return;
    if (!getLogEls().length) return;
    RL._wsAttached = true;
    connectRestartLogWs().catch(() => {});
  }

  RL.renderFromRaw = function renderFromRaw(rawText, options) {
    RL._rawText = String(rawText || '');
    syncKnownEntries(parseRenderedEntries(RL._rawText), options);
    renderAll();
  };

  RL.setRaw = function setRaw(rawText, options) {
    RL.renderFromRaw(rawText, options);
  };

  RL.load = async function load(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const els = getLogEls();
    if (!els.length) return false;

    try {
      const res = await fetch('/api/restart-log', { cache: 'no-store' });
      if (!res.ok) {
        RL.setRaw('Не удалось загрузить журнал.', { toastNewSubscription: false });
        return false;
      }
      const data = await res.json().catch(() => ({}));
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const text = lines.length ? lines.join('') : 'Журнал пуст.';
      RL.setRaw(text, { toastNewSubscription: opts.toastNewSubscription !== false });
      return true;
    } catch (error) {
      if (opts.silent !== true) console.error(error);
      RL.setRaw('Ошибка загрузки журнала.', { toastNewSubscription: false });
      return false;
    }
  };

  RL.append = function append(text) {
    if (!text) return;
    let raw = RL._rawText || '';
    if (raw && !raw.endsWith('\n')) raw += '\n';
    raw += String(text);
    RL._rawText = raw;
    renderAll();
  };

  RL.clear = function clear() {
    RL._knownEntryKeys = new Set();
    RL._hasBaseline = true;
    RL.setRaw('', { toastNewSubscription: false });
    try {
      fetch('/api/restart-log/clear', { method: 'POST' });
    } catch (error) {
      console.error(error);
    }
  };

  RL.setFilter = function setFilter(filter) {
    const next = String(filter || '').trim() === 'errors' ? 'errors' : 'all';
    if (RL._filter === next) {
      syncFilterButtons();
      return;
    }
    RL._filter = next;
    renderAll();
  };

  RL.rememberXrayPreflightPayload = function rememberXrayPreflightPayload(payload) {
    return rememberPreflightPayload(payload);
  };

  function bindLogInteractions() {
    getLogEls().forEach((el) => {
      if (!el) return;
      try {
        if (el.dataset && el.dataset.xkeenRestartLogInteractions === '1') return;
        el.addEventListener('click', (event) => {
          const target = event && event.target;
          const preflightButton = target && typeof target.closest === 'function'
            ? target.closest('[data-xk-restart-log-preflight-ref]')
            : null;
          if (preflightButton && el.contains(preflightButton)) {
            event.preventDefault();
            const ref = preflightButton.getAttribute('data-xk-restart-log-preflight-ref') || '';
            void openPreflightPayload(ref);
            return;
          }

          const button = target && typeof target.closest === 'function'
            ? target.closest('[data-xk-restart-log-detail-toggle]')
            : null;
          if (!button || !el.contains(button)) return;
          event.preventDefault();

          const id = button.getAttribute('aria-controls') || '';
          let details = id ? document.getElementById(id) : null;
          if (!details) {
            const next = button.nextElementSibling;
            if (next && next.classList && next.classList.contains('restart-log-details')) details = next;
          }
          if (!details) return;

          const expanded = button.getAttribute('aria-expanded') === 'true';
          button.setAttribute('aria-expanded', expanded ? 'false' : 'true');
          button.textContent = expanded ? 'Детали' : 'Скрыть';
          details.hidden = expanded;
        });
        if (el.dataset) el.dataset.xkeenRestartLogInteractions = '1';
      } catch (error) {}
    });
  }

  RL.reveal = function reveal(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const target = getVisibleLogEls()[0] || getLogEls()[0] || null;
    if (!target) return false;

    const anchor = getRevealTarget(target) || target;
    try {
      if (typeof anchor.scrollIntoView === 'function') {
        anchor.scrollIntoView({
          behavior: String(opts.behavior || 'smooth'),
          block: String(opts.block || 'center'),
          inline: 'nearest',
        });
      }
    } catch (error) {}

    if (opts.focus !== false) {
      try {
        setTimeout(() => { focusLogEl(target); }, 0);
      } catch (error) {}
    }

    return true;
  };

  RL.prepareLiveStream = function prepareLiveStream(options) {
    const opts = options && typeof options === 'object' ? options : {};

    if (opts.clear !== false) {
      RL.clear();
    } else if (opts.resetRaw === true) {
      RL.setRaw('', { toastNewSubscription: false });
    }

    if (opts.intro) {
      RL.append(String(opts.intro));
    }

    if (opts.reveal !== false) {
      RL.reveal(opts.revealOptions || {});
    }

    return true;
  };

  RL.waitForJob = async function waitForJob(jobId, options) {
    if (!jobId) return { ok: false, status: 'error', error: 'missing job id' };
    return waitForCommandJob(jobId, options || {});
  };

  RL.streamJob = async function streamJob(jobId, options) {
    const opts = options && typeof options === 'object' ? options : {};

    RL.prepareLiveStream({
      clear: opts.clear !== false,
      resetRaw: !!opts.resetRaw,
      reveal: opts.reveal !== false,
      revealOptions: opts.revealOptions || {},
      intro: typeof opts.intro === 'string' ? opts.intro : '',
    });

    return waitForCommandJob(jobId, {
      maxWaitMs: opts.maxWaitMs,
      onChunk: (chunk, meta) => {
        if (!chunk) return;
        RL.append(String(chunk));
        if (opts.revealOnChunk === true) {
          try {
            RL.reveal(Object.assign({ focus: false, behavior: 'auto' }, opts.revealOptions || {}));
          } catch (error) {}
        }
        if (typeof opts.onChunk === 'function') {
          try { opts.onChunk(chunk, meta || null); } catch (error) {}
        }
      },
    });
  };

  function fallbackCopyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toastXkeen('Журнал скопирован в буфер обмена', false);
    } catch (error) {
      console.error(error);
      toastXkeen('Не удалось скопировать журнал', true);
    }
    try { ta.remove(); } catch (error) {}
  }

  RL.copy = function copy() {
    const text = normalizeTextForTerminal(RL._rawText || '');
    if (!text) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => { toastXkeen('Журнал скопирован в буфер обмена', false); },
        () => fallbackCopyText(text)
      );
    } else {
      fallbackCopyText(text);
    }
  };

  function bindOnce(el, handler) {
    if (!el) return;
    try {
      if (el.dataset && el.dataset.xkeenBound === '1') return;
      el.addEventListener('click', handler);
      if (el.dataset) el.dataset.xkeenBound = '1';
    } catch (error) {}
  }

  function normalizeRestartLogTitleText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isRestartLogTitleText(value) {
    const text = normalizeRestartLogTitleText(value);
    return text === RESTART_LOG_TITLE || LEGACY_RESTART_LOG_TITLE_RE.test(text);
  }

  function insertRestartLogButton(actions, btn, before) {
    if (!actions || !btn) return;
    try {
      if (before && before.parentElement === actions) actions.insertBefore(btn, before);
      else actions.appendChild(btn);
    } catch (error) {}
  }

  function ensureRestartLogFilterButton(actions, value, text) {
    if (!actions || !value) return;
    try {
      if (actions.querySelector(`[data-xk-restart-log-filter="${value}"]`)) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary log-btn restart-log-filter-btn';
      btn.setAttribute('data-xk-restart-log-filter', value);
      btn.setAttribute('aria-pressed', value === RL._filter ? 'true' : 'false');
      btn.textContent = text;
      const anchor = actions.querySelector('[data-xk-restart-log-action]');
      insertRestartLogButton(actions, btn, anchor);
    } catch (error) {}
  }

  function ensureRestartLogActionButton(actions, action, text) {
    if (!actions || !action) return;
    try {
      if (actions.querySelector(`[data-xk-restart-log-action="${action}"]`)) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary log-btn';
      btn.setAttribute('data-xk-restart-log-action', action);
      btn.textContent = text;
      const anchor = action === 'refresh'
        ? actions.querySelector('[data-xk-restart-log-action="clear"]')
        : null;
      insertRestartLogButton(actions, btn, anchor);
    } catch (error) {}
  }

  function normalizeRestartLogChrome() {
    try {
      const cards = new Set();
      getLogEls().forEach((el) => {
        const card = el && typeof el.closest === 'function' ? el.closest('.log-card') : null;
        if (card) cards.add(card);
      });
      document.querySelectorAll('.log-card').forEach((card) => {
        try {
          if (card.querySelector('[data-xk-restart-log="1"], #restart-log')) cards.add(card);
        } catch (error) {}
      });
      cards.forEach((card) => {
        try {
          const title = Array.from(card.querySelectorAll('h1,h2,h3')).find((node) => isRestartLogTitleText(node.textContent));
          if (title && normalizeRestartLogTitleText(title.textContent) !== RESTART_LOG_TITLE) {
            title.textContent = RESTART_LOG_TITLE;
          }
          const actions = card.querySelector('.log-header-actions');
          if (!actions) return;
          ensureRestartLogFilterButton(actions, 'all', 'Все');
          ensureRestartLogFilterButton(actions, 'errors', 'Ошибки');
          ensureRestartLogActionButton(actions, 'refresh', 'Обновить');
        } catch (error) {}
      });
    } catch (error) {}
  }

  RL.init = function init() {
    normalizeRestartLogChrome();

    try {
      const buttons = document.querySelectorAll('[data-xk-restart-log-action]');
      buttons.forEach((btn) => {
        const action = btn.getAttribute('data-xk-restart-log-action');
        if (!action) return;
        if (action === 'clear') {
          bindOnce(btn, (event) => { event.preventDefault(); RL.clear(); });
        } else if (action === 'copy') {
          bindOnce(btn, (event) => { event.preventDefault(); RL.copy(); });
        } else if (action === 'refresh') {
          bindOnce(btn, (event) => { event.preventDefault(); RL.load({ toastNewSubscription: false }); });
        }
      });
    } catch (error) {}

    try {
      document.querySelectorAll('[data-xk-restart-log-filter]').forEach((btn) => {
        const value = btn.getAttribute('data-xk-restart-log-filter') || 'all';
        bindOnce(btn, (event) => {
          event.preventDefault();
          RL.setFilter(value);
        });
      });
    } catch (error) {}

    try {
      const refreshBtn = document.getElementById('restart-log-refresh-btn');
      const clearBtn = document.getElementById('restart-log-clear-btn');
      const copyBtn = document.getElementById('restart-log-copy-btn');
      bindOnce(refreshBtn, (event) => { event.preventDefault(); RL.load({ toastNewSubscription: false }); });
      bindOnce(clearBtn, (event) => { event.preventDefault(); RL.clear(); });
      bindOnce(copyBtn, (event) => { event.preventDefault(); RL.copy(); });
    } catch (error) {}

    bindLogInteractions();
    syncFilterButtons();

    try {
      if (getLogEls().length) RL.load({ toastNewSubscription: false });
    } catch (error) {}

    ensurePolling();
    ensureRestartLogWs();
  };
})();

export function getRestartLogApi() {
  try {
    return restartLogModuleApi && typeof restartLogModuleApi.load === 'function' ? restartLogModuleApi : null;
  } catch (error) {
    return null;
  }
}

function callRestartLogApi(method, ...args) {
  const api = getRestartLogApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initRestartLog(...args) {
  return callRestartLogApi('init', ...args);
}

export function loadRestartLog(...args) {
  return callRestartLogApi('load', ...args);
}

export function appendRestartLog(...args) {
  return callRestartLogApi('append', ...args);
}

export function setRestartLogRaw(...args) {
  return callRestartLogApi('setRaw', ...args);
}

export function clearRestartLog(...args) {
  return callRestartLogApi('clear', ...args);
}

export function setRestartLogFilter(...args) {
  return callRestartLogApi('setFilter', ...args);
}

export function rememberXrayPreflightPayload(...args) {
  return callRestartLogApi('rememberXrayPreflightPayload', ...args);
}

export function copyRestartLog(...args) {
  return callRestartLogApi('copy', ...args);
}

export function revealRestartLog(...args) {
  return callRestartLogApi('reveal', ...args);
}

export function prepareRestartLogLiveStream(...args) {
  return callRestartLogApi('prepareLiveStream', ...args);
}

export function waitForRestartLogJob(...args) {
  return callRestartLogApi('waitForJob', ...args);
}

export function streamRestartLogJob(...args) {
  return callRestartLogApi('streamJob', ...args);
}

export const restartLogApi = Object.freeze({
  get: getRestartLogApi,
  init: initRestartLog,
  load: loadRestartLog,
  append: appendRestartLog,
  setRaw: setRestartLogRaw,
  clear: clearRestartLog,
  setFilter: setRestartLogFilter,
  rememberXrayPreflightPayload,
  copy: copyRestartLog,
  reveal: revealRestartLog,
  prepareLiveStream: prepareRestartLogLiveStream,
  waitForJob: waitForRestartLogJob,
  streamJob: streamRestartLogJob,
});
