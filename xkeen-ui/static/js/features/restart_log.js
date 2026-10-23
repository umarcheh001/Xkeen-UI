import { ansiToXkeenHtml, escapeXkeenHtml, getXkeenCommandJobApi, getXkeenUiApi, syncXkeenBodyScrollLock, toastXkeen } from './xkeen_runtime.js';
import { iconHtml } from '../ui/operator_icons.js';

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
  RL._query = typeof RL._query === 'string' ? RL._query : '';
  RL._preflightPayloads = RL._preflightPayloads instanceof Map ? RL._preflightPayloads : new Map();
  RL._autoScrollByScope = RL._autoScrollByScope instanceof Map ? RL._autoScrollByScope : new Map();
  RL._fullscreenCard = RL._fullscreenCard && RL._fullscreenCard.nodeType === 1 ? RL._fullscreenCard : null;
  // Rows the owner opened; output with no result line is open until closed.
  RL._openGroups = RL._openGroups instanceof Set ? RL._openGroups : new Set();
  RL._shutGroups = RL._shutGroups instanceof Set ? RL._shutGroups : new Set();
  let restartLogScopeSeq = 0;

  const RESTART_LOG_POLL_MS = 15000;
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
    loglevel: 'Уровень',
    xray_restarted: 'Xray перезапущен',
    detail: 'Итог',
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
    'mihomo-security-migration': {
      label: 'Mihomo security',
      successText: 'безопасная миграция применена, xkeen перезапущен',
      failureText: 'миграция сохранена, но перезапуск xkeen завершился ошибкой',
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
    'dns-over-vless': {
      label: 'DNS-over-VLESS',
      successText: 'настройка применена, xkeen перезапущен',
      failureText: 'настройка применена, но перезапуск xkeen завершился ошибкой',
      bucket: 'routing',
    },
    'dns-over-vless-rollback': {
      label: 'DNS-over-VLESS',
      successText: 'настройка отменена, xkeen перезапущен',
      failureText: 'настройка отменена, но перезапуск xkeen завершился ошибкой',
      bucket: 'routing',
    },
    'dns-over-vless-watchdog-release': {
      label: 'DNS-over-VLESS',
      successText: 'сторож вернул DNS роутеру, xkeen перезапущен',
      failureText: 'сторож вернул DNS роутеру, но перезапуск xkeen завершился ошибкой',
      bucket: 'routing',
    },
    'xray-subscriptions-batch': {
      label: 'Подписки Xray',
      successText: 'обновлены одной пачкой, xkeen перезапущен',
      failureText: 'обновлены, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
    },
    'xray-subscriptions-delete-all': {
      label: 'Подписки Xray',
      successText: 'удалены все, xkeen перезапущен',
      failureText: 'удалены все, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
    },
    'xray-subscriptions-pause': {
      label: 'Подписки Xray',
      successText: 'приостановлены, xkeen перезапущен',
      failureText: 'приостановлены, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
    },
    'xray-subscriptions-resume': {
      label: 'Подписки Xray',
      successText: 'возобновлены, xkeen перезапущен',
      failureText: 'возобновлены, но перезапуск xkeen завершился ошибкой',
      bucket: 'subscription',
    },
    'xray-preflight': {
      label: 'Xray preflight',
      successText: 'конфиг прошёл проверку',
      failureText: 'конфиг отклонён, xkeen не перезапускался',
      bucket: 'preflight',
    },
    'xray-logs-enable': {
      label: 'Логи Xray',
      successText: 'запись включена, Xray перезапущен',
      failureText: 'запись не включена',
      bucket: 'service',
    },
    'xray-logs-disable': {
      label: 'Логи Xray',
      successText: 'запись выключена, Xray перезапущен',
      failureText: 'запись не выключена',
      bucket: 'service',
    },
  });

  const XRAY_TS_LINE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:(?:\[([^\]]+)\])|((?:INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)))?\s*(.*)$/i;
  const XRAY_BRACKET_LINE_RE = /^(INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)\[([^\]]+)\]\s*(.*)$/i;
  const RUNTIME_LOGFMT_LINE_RE = /^time=(?:"([^"]+)"|([^\s]+))\s+level=(?:"?([A-Za-z]+)"?)\s+msg=(?:"((?:\\.|[^"\\])*)"|(.+))\s*$/i;

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

  function decodeLogfmtValue(value) {
    const raw = String(value || '');
    if (!raw) return '';
    return raw
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
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
    if (rawKey === 'timed_out' || rawKey === 'xray_restarted') return formatBooleanValue(rawValue);
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
    if ((source === 'xray-logs-enable' || source === 'xray-logs-disable') && ok
      && formatBooleanValue(details && details.xray_restarted) === 'нет') {
      return message.replace(/, Xray перезапущен$/, '');
    }
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

  function normalizeRestartLogSearchQuery(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function buildRestartLogSearchText(entry) {
    if (!entry) return '';
    const parts = [entry.raw || ''];
    const summary = entry.summary || null;
    if (summary) {
      parts.push(summary.source, summary.bucket, summary.label, summary.message, summary.rawSourceText);
      const details = summary.details && typeof summary.details === 'object' ? summary.details : {};
      Object.keys(details).forEach((key) => {
        parts.push(key, formatRestartDetailValue(key, details[key]), String(details[key] == null ? '' : details[key]));
      });
    }
    return parts.join(' ').toLowerCase();
  }

  function entryMatchesSearch(entry) {
    const query = normalizeRestartLogSearchQuery(RL._query);
    if (!query) return true;
    const haystack = buildRestartLogSearchText(entry);
    if (!haystack) return false;

    const groups = query
      .split('|')
      .map((group) => group.trim())
      .filter(Boolean);
    if (!groups.length) return true;

    return groups.some((group) => {
      const terms = group.split(/\s+/).map((term) => term.trim().toLowerCase()).filter(Boolean);
      if (!terms.length) return true;
      return terms.every((term) => haystack.includes(term));
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

  function getRestartLogScopeId(el) {
    if (!el) return 'root';
    try {
      if (!el.dataset) return 'root';
      const current = String(el.dataset.xkRestartLogScope || '').trim();
      if (current) return current;
      restartLogScopeSeq += 1;
      const next = `log-${restartLogScopeSeq}`;
      el.dataset.xkRestartLogScope = next;
      return next;
    } catch (error) {}
    return 'root';
  }

  function isRestartLogAtBottom(el) {
    if (!el) return true;
    try {
      return (el.scrollHeight - el.clientHeight) <= (el.scrollTop + 40);
    } catch (error) {}
    return true;
  }

  function isRestartLogScrollable(el) {
    if (!el) return false;
    try {
      return el.scrollHeight > el.clientHeight + 4;
    } catch (error) {}
    return false;
  }

  function getRestartLogCard(el) {
    try {
      return el && typeof el.closest === 'function' ? el.closest('.log-card') : null;
    } catch (error) {}
    return null;
  }

  function shouldAutoScrollRestartLog(el) {
    const scopeId = getRestartLogScopeId(el);
    if (!RL._autoScrollByScope.has(scopeId)) return true;
    return RL._autoScrollByScope.get(scopeId) !== false;
  }

  function updateRestartLogScrollButton(el) {
    const card = getRestartLogCard(el);
    if (!card) return;
    const btn = card.querySelector('[data-xk-restart-log-bottom]');
    if (!btn) return;
    const show = isRestartLogScrollable(el) && !isRestartLogAtBottom(el);
    btn.hidden = !show;
  }

  function scrollRestartLogToBottom(el) {
    if (!el) return;
    try {
      el.scrollTop = el.scrollHeight;
      RL._autoScrollByScope.set(getRestartLogScopeId(el), true);
    } catch (error) {}
    updateRestartLogScrollButton(el);
  }

  function updateRestartLogAutoScroll(el) {
    if (!el) return;
    const atBottom = isRestartLogAtBottom(el);
    RL._autoScrollByScope.set(getRestartLogScopeId(el), atBottom);
    updateRestartLogScrollButton(el);
  }

  function updateAllRestartLogScrollButtons() {
    getLogEls().forEach((el) => updateRestartLogScrollButton(el));
  }

  // ---------- Journal rows ----------
  // The panel writes the output of a command (xkeen, the core) right before
  // the result line of the same operation, so that output folds under it.
  // Output with no result line after it is a command still running or one
  // that reports nothing: it stays open at the end of the journal.

  const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function stripAnsi(text) {
    return String(text || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  }

  function groupJournalEntries(entries) {
    const groups = [];
    let pending = [];
    (Array.isArray(entries) ? entries : []).forEach((entry) => {
      if (!entry) return;
      if (entry.summary) {
        groups.push({ key: entry.key, entry, summary: entry.summary, out: pending, live: false });
        pending = [];
      } else if (String(entry.raw || '').trim()) {
        pending.push(entry);
      }
    });
    if (pending.length) {
      groups.push({ key: `out@@${pending[0].key}`, entry: null, summary: null, out: pending, live: true });
    }
    return groups;
  }

  function groupHasError(group) {
    if (!group) return false;
    if (group.summary) return !group.summary.ok;
    return group.out.some((entry) => rawLineLooksLikeError(entry.raw));
  }

  function groupMatchesFilter(group) {
    if (RL._filter === 'errors' && !groupHasError(group)) return false;
    if (!normalizeRestartLogSearchQuery(RL._query)) return true;
    if (group.entry && entryMatchesSearch(group.entry)) return true;
    return group.out.some((entry) => entryMatchesSearch(entry));
  }

  function isGroupOpen(group) {
    return group.live ? !RL._shutGroups.has(group.key) : RL._openGroups.has(group.key);
  }

  function toggleGroup(key, live) {
    if (!key) return;
    const set = live ? RL._shutGroups : RL._openGroups;
    if (set.has(key)) set.delete(key);
    else set.add(key);
  }

  // "10:40:12" from the panel's, Xray's and Mihomo's stamps; Mihomo writes
  // UTC, shown here in the router's local time like the rest.
  function clockOf(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const utc = raw.match(/^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/);
    if (utc) {
      const date = new Date(Date.UTC(+utc[1], +utc[2] - 1, +utc[3], +utc[4], +utc[5], +utc[6]));
      return [date.getHours(), date.getMinutes(), date.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
    }
    const match = raw.match(/(\d{2}:\d{2}:\d{2})/);
    return match ? match[1] : '';
  }

  function journalDayLabel(day) {
    const match = String(day || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return String(day || '');
    const date = new Date(+match[1], +match[2] - 1, +match[3]);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const name = `${+match[3]} ${MONTHS_GENITIVE[date.getMonth()]}${date.getFullYear() !== today.getFullYear() ? ` ${date.getFullYear()}` : ''}`;
    const daysAgo = Math.round((today.getTime() - date.getTime()) / 86400000);
    if (daysAgo === 0) return `Сегодня, ${name}`;
    if (daysAgo === 1) return `Вчера, ${name}`;
    return name;
  }

  // The one detail worth reading in the row itself; the rest is in details.
  function journalRowMeta(summary) {
    const details = summary.details && typeof summary.details === 'object' ? summary.details : {};
    const parts = [];
    if (details.file) parts.push(details.file);
    if (summary.source === 'core-switch') {
      const core = humanCoreName(details.core);
      const previous = humanCoreName(details.previous);
      if (previous && previous !== core) parts.push(`было: ${previous}`);
    }
    if (details.loglevel) parts.push(`уровень: ${details.loglevel}`);
    if (!summary.ok && details.phase) parts.push(`этап: ${details.phase}`);
    if (!summary.ok && details.returncode) parts.push(`код: ${details.returncode}`);
    if (!parts.length && !RESTART_SOURCE_META[summary.source]) parts.push(summary.source);
    return parts.join(' · ');
  }

  function journalDetailRows(summary) {
    const details = summary.details && typeof summary.details === 'object' ? summary.details : {};
    const keys = RESTART_DETAIL_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(details, key));
    Object.keys(details).sort().forEach((key) => {
      if (keys.indexOf(key) === -1) keys.push(key);
    });
    const rows = [];
    keys.forEach((key) => {
      if (key === 'preflight_ref') return;
      const value = formatRestartDetailValue(key, details[key]);
      if (value) rows.push([formatRestartDetailLabel(key), value]);
    });
    rows.push(['Операция', summary.source]);
    if (summary.ts) rows.push(['Время', summary.ts]);
    return rows;
  }

  function journalOutLineHtml(entry) {
    const raw = String(entry && entry.raw ? entry.raw : '');
    const parsed = parseRuntimeLogLine(raw) || parseRuntimeLogLine(normalizeLineForTerminal(raw));
    if (parsed) {
      const parts = splitRuntimeMessage(parsed.message);
      const text = `${parts.source ? `<b>${safeEscapeHtml(parts.source)}:</b> ` : ''}${safeEscapeHtml(parts.body)}`;
      return `<div class="xk-jr-oline k-${parsed.kind}"><i>${safeEscapeHtml(clockOf(parsed.ts))}</i><span>${text}</span><em>${safeEscapeHtml(parsed.level)}</em></div>`;
    }
    const kind = serviceStatusKind(raw) || (rawLineLooksLikeError(raw) ? 'error' : 'plain');
    return `<div class="xk-jr-oline k-${kind}"><i></i><span>${ansiToHtml(raw.trim())}</span><em></em></div>`;
  }

  function journalGroupText(group) {
    const lines = group.out.map((entry) => normalizeLineForTerminal(stripAnsi(entry.raw)));
    if (group.summary) lines.push(group.summary.copyText);
    return lines.join('\n');
  }

  function journalGroupHtml(group, open) {
    const esc = safeEscapeHtml;
    const summary = group.summary;
    const kind = summary ? (summary.ok ? 'ok' : 'err') : (groupHasError(group) ? 'err' : 'run');
    const first = group.out[0] || null;
    const firstParsed = first ? parseRuntimeLogLine(first.raw) : null;
    const time = summary ? clockOf(summary.ts) : clockOf(firstParsed && firstParsed.ts);
    const label = summary ? summary.label : 'Вывод';
    const token = summary ? (summary.source || summary.label) : '';
    const message = summary ? summary.message : stripAnsi(first ? first.raw : '').trim();
    const meta = summary
      ? journalRowMeta(summary)
      : (group.out.length > 1 ? `строк: ${group.out.length}` : '');
    const duration = summary ? formatDurationMs(summary.details && summary.details.duration_ms) : '';
    const count = group.out.length;
    // The row is the one control: the source filters on a click with the
    // mouse, and "Только «…»" in the details does the same from the keyboard.
    const source = token
      ? `<span class="xk-jr-src" data-xk-restart-log-token="${esc(token)}" title="Показать только «${esc(label)}»">${esc(label)}</span>`
      : `<span class="xk-jr-src">${esc(label)}</span>`;
    let html = `<div class="xk-jr-row k-${kind}${open ? ' is-open' : ''}" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}" data-xk-restart-log-group="${esc(group.key)}"${group.live ? ' data-live="1"' : ''}>`
      + `<span class="lv"></span><span class="ts">${esc(time)}</span>${source}`
      + `<span class="msg">${esc(message)}${meta ? `<small>${esc(meta)}</small>` : ''}</span>`
      + `<span class="outn">${count && summary ? `вывод · ${count}` : ''}</span>`
      + `<span class="dur">${esc(duration)}</span>`
      + `<span class="chev" data-xk-restart-log-group-toggle="1" aria-hidden="true">${iconHtml('chevron-down')}</span>`
      + '</div>';
    if (!open) return html;

    if (count) html += `<div class="xk-jr-out">${group.out.map(journalOutLineHtml).join('')}</div>`;
    const acts = [];
    let rows = '';
    if (summary) {
      rows = journalDetailRows(summary).map(([name, value]) => `<div><dt>${esc(name)}</dt><dd>${esc(value)}</dd></div>`).join('');
      const ref = summary.source === 'xray-preflight'
        ? normalizePreflightRef(summary.details && summary.details.preflight_ref)
        : '';
      if (ref) acts.push(`<button type="button" class="xk-jr-btn is-danger" data-xk-restart-log-preflight-ref="${esc(ref)}">Открыть разбор ошибки</button>`);
      acts.push(`<button type="button" class="xk-jr-btn" data-xk-restart-log-copy-group="${esc(group.key)}">Копировать запись</button>`);
      acts.push(`<button type="button" class="xk-jr-btn" data-xk-restart-log-token="${esc(token)}">Только «${esc(label)}»</button>`);
    } else {
      acts.push(`<button type="button" class="xk-jr-btn" data-xk-restart-log-copy-group="${esc(group.key)}">Копировать вывод</button>`);
    }
    html += `<div class="xk-jr-more">${rows ? `<dl>${rows}</dl>` : ''}<div class="xk-jr-acts">${acts.join('')}</div></div>`;
    return html;
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
    if (bracketMatch) {
      const level = normalizeRuntimeLevel(bracketMatch[1]);
      return {
        level,
        kind: runtimeLevelKind(level),
        ts: formatRuntimeTimestamp(bracketMatch[2]),
        message: String(bracketMatch[3] || '').replace(/^\s+/, ''),
      };
    }

    const logfmtMatch = raw.match(RUNTIME_LOGFMT_LINE_RE);
    if (!logfmtMatch) return null;
    const level = normalizeRuntimeLevel(logfmtMatch[3]);
    return {
      level,
      kind: runtimeLevelKind(level),
      ts: formatRuntimeTimestamp(logfmtMatch[1] || logfmtMatch[2]),
      message: decodeLogfmtValue(logfmtMatch[4] || logfmtMatch[5] || '').replace(/^\s+/, ''),
    };
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

  function syncFilterButtons() {
    const active = RL._filter === 'errors' ? 'errors' : 'all';
    try {
      document.querySelectorAll('[data-xk-restart-log-filter]').forEach((btn) => {
        const value = String(btn.getAttribute('data-xk-restart-log-filter') || '').trim();
        const on = value === active;
        btn.classList.toggle('is-on', on);
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
      });
    } catch (error) {}
  }

  function syncFilterCounts(groups) {
    const list = Array.isArray(groups) ? groups : [];
    const counts = { all: list.length, errors: list.filter(groupHasError).length };
    try {
      document.querySelectorAll('[data-xk-restart-log-count]').forEach((node) => {
        const value = counts[String(node.getAttribute('data-xk-restart-log-count') || '')];
        const text = value ? String(value) : '';
        if (node.textContent !== text) node.textContent = text;
      });
    } catch (error) {}
  }

  function syncSearchControls() {
    const query = String(RL._query || '');
    try {
      document.querySelectorAll('[data-xk-restart-log-search]').forEach((input) => {
        if (!input) return;
        if (input.value !== query) input.value = query;
      });
    } catch (error) {}

    try {
      document.querySelectorAll('[data-xk-restart-log-search-clear]').forEach((btn) => {
        if (!btn) return;
        btn.hidden = !normalizeRestartLogSearchQuery(query);
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
      parts.push({ label: 'Ядро', value: lastCore, kind: 'info' });
    }
    parts.push({
      label: 'Ошибок',
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
        const kind = String(part && part.kind ? part.kind : 'muted').trim();
        return `<span class="k-${kind}">${safeEscapeHtml(part.label)}: <b>${safeEscapeHtml(part.value)}</b></span>`;
      })
      .join('');
    el.hidden = false;
    if (el.innerHTML !== html) el.innerHTML = html;
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
    const stickToBottom = shouldAutoScrollRestartLog(el);
    const rawState = String(rawText || '').trim();
    const loadError = /^(?:Не удалось загрузить журнал|Ошибка загрузки журнала)\.?$/i.test(rawState);
    const empty = loadError || /^Журнал пуст\.?$/i.test(rawState);
    const groups = empty ? [] : groupJournalEntries(parseRenderedEntries(rawText || ''));
    const shown = groups.filter(groupMatchesFilter);
    let html = '';
    if (loadError) {
      html = '<div class="xk-jr-empty is-error" role="alert"><b>Не удалось загрузить журнал</b>'
        + '<span>Проверьте связь с панелью и выберите «Обновить» в меню «⋯».</span></div>';
    } else if (!shown.length) {
      const emptyText = normalizeRestartLogSearchQuery(RL._query)
        ? 'Совпадений нет.'
        : (RL._filter === 'errors' ? 'Ошибок нет.' : 'Журнал пуст.');
      html = `<div class="xk-jr-empty" role="status"><b>${safeEscapeHtml(emptyText)}</b></div>`;
    } else {
      let day = '';
      shown.forEach((group) => {
        const groupDay = group.summary ? String(group.summary.ts || '').slice(0, 10) : '';
        if (groupDay && groupDay !== day) {
          day = groupDay;
          html += `<div class="xk-jr-day">${safeEscapeHtml(journalDayLabel(day))}</div>`;
        }
        html += journalGroupHtml(group, isGroupOpen(group));
      });
    }
    el.dataset.state = loadError ? 'error' : (shown.length ? 'ready' : 'empty');
    if (el._jrHtml !== html) {
      el._jrHtml = html;
      el.innerHTML = html;
    }
    if (stickToBottom) scrollRestartLogToBottom(el);
    else updateRestartLogScrollButton(el);
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
    const allEntries = parseRenderedEntries(raw);
    syncFilterButtons();
    syncFilterCounts(groupJournalEntries(allEntries));
    syncSearchControls();
    renderAllSummary(allEntries);
    bindLogInteractions();
    updateAllRestartLogScrollButtons();
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
    if (!canUseRestartLogWs()) return;
    RL._wsAttached = true;
    connectRestartLogWs().catch(() => {});
  }

  function canUseRestartLogWs() {
    try {
      const runtime = window.XKeen?.pageConfig?.runtime;
      // A page produced by the current backend explicitly reports whether its
      // serving process can upgrade WebSocket requests. Keep legacy pages
      // compatible when that field is absent.
      if (runtime && runtime.websocket === false) return false;
      const active = window.XKeen?.pageConfig?.frontendModules?.activeModuleIds;
      // No descriptor means an older panel page. Preserve its existing WS
      // behaviour instead of deriving a capability from absent metadata.
      if (!Array.isArray(active)) return true;
      return active.includes('core');
    } catch (error) {
      return true;
    }
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

  RL.setSearch = function setSearch(query, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const next = String(query || '');
    let changed = RL._query !== next;
    if (opts.resetFilter === true && RL._filter !== 'all') {
      RL._filter = 'all';
      changed = true;
    }
    if (!changed) {
      syncSearchControls();
      syncFilterButtons();
      return;
    }
    RL._query = next;
    renderAll();
  };

  RL.applyTokenFilter = function applyTokenFilter(token) {
    const value = normalizeRestartLogSearchQuery(token);
    if (!value) return false;
    RL.setSearch(value, { resetFilter: true });
    return true;
  };

  RL.rememberXrayPreflightPayload = function rememberXrayPreflightPayload(payload) {
    return rememberPreflightPayload(payload);
  };

  // An opened row shows its output and details inside the journal box, its
  // own line kept in view when everything does not fit.
  function revealGroup(el, key) {
    const row = findGroupRow(el, key);
    if (!row) return;
    let last = row;
    while (last.nextElementSibling && !last.nextElementSibling.matches('.xk-jr-row, .xk-jr-day')) {
      last = last.nextElementSibling;
    }
    const box = el.getBoundingClientRect();
    const bottom = last.getBoundingClientRect().bottom;
    if (bottom > box.bottom) el.scrollTop += bottom - box.bottom;
    const rowTop = row.getBoundingClientRect().top;
    if (rowTop < box.top) el.scrollTop -= box.top - rowTop;
  }

  function findGroupRow(el, key) {
    return Array.from(el.querySelectorAll('[data-xk-restart-log-group]'))
      .find((node) => node.getAttribute('data-xk-restart-log-group') === key) || null;
  }

  function toggleRow(el, row) {
    const key = row.getAttribute('data-xk-restart-log-group') || '';
    const hadFocus = document.activeElement === row;
    const top = el.scrollTop;
    // The row stays where it was clicked instead of following the end.
    RL._autoScrollByScope.set(getRestartLogScopeId(el), false);
    toggleGroup(key, row.getAttribute('data-live') === '1');
    renderAll();
    el.scrollTop = top;
    revealGroup(el, key);
    updateRestartLogAutoScroll(el);
    if (hadFocus) {
      const next = findGroupRow(el, key);
      if (next) next.focus({ preventScroll: true });
    }
  }

  function bindLogInteractions() {
    getLogEls().forEach((el) => {
      if (!el) return;
      try {
        if (el.dataset && el.dataset.xkeenRestartLogInteractions === '1') return;
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
        el.addEventListener('scroll', () => {
          updateRestartLogAutoScroll(el);
        }, { passive: true });
        el.addEventListener('click', (event) => {
          const target = event && event.target;
          const closest = (selector) => {
            const node = target && typeof target.closest === 'function' ? target.closest(selector) : null;
            return node && el.contains(node) ? node : null;
          };

          const tokenButton = closest('[data-xk-restart-log-token]');
          if (tokenButton) {
            event.preventDefault();
            RL.applyTokenFilter(tokenButton.getAttribute('data-xk-restart-log-token') || tokenButton.textContent || '');
            return;
          }

          const preflightButton = closest('[data-xk-restart-log-preflight-ref]');
          if (preflightButton) {
            event.preventDefault();
            void openPreflightPayload(preflightButton.getAttribute('data-xk-restart-log-preflight-ref') || '');
            return;
          }

          const copyButton = closest('[data-xk-restart-log-copy-group]');
          if (copyButton) {
            event.preventDefault();
            copyJournalGroup(copyButton.getAttribute('data-xk-restart-log-copy-group') || '');
            return;
          }

          const row = closest('[data-xk-restart-log-group]');
          if (!row) return;
          // A drag that selected text in the row is not a click on it.
          if (!closest('[data-xk-restart-log-group-toggle]')) {
            try {
              if (String(window.getSelection ? window.getSelection() : '').trim()) return;
            } catch (error) {}
          }
          event.preventDefault();
          toggleRow(el, row);
        });
        el.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const row = event.target;
          if (!row || !row.matches || !row.matches('[data-xk-restart-log-group]')) return;
          event.preventDefault();
          toggleRow(el, row);
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

  function fallbackCopyText(text, message) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toastXkeen(message, false);
    } catch (error) {
      console.error(error);
      toastXkeen('Не удалось скопировать', true);
    }
    try { ta.remove(); } catch (error) {}
  }

  function copyText(text, message) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => { toastXkeen(message, false); },
        () => fallbackCopyText(text, message)
      );
    } else {
      fallbackCopyText(text, message);
    }
  }

  function copyJournalGroup(key) {
    const group = groupJournalEntries(parseRenderedEntries(RL._rawText || '')).find((item) => item.key === key);
    if (!group) return;
    copyText(journalGroupText(group), group.summary ? 'Запись скопирована' : 'Вывод скопирован');
  }

  RL.copy = function copy() {
    copyText(normalizeTextForTerminal(RL._rawText || ''), 'Журнал скопирован в буфер обмена');
  };

  function bindOnce(el, handler) {
    if (!el) return;
    try {
      if (el.dataset && el.dataset.xkeenBound === '1') return;
      el.addEventListener('click', handler);
      if (el.dataset) el.dataset.xkeenBound = '1';
    } catch (error) {}
  }

  function ensureRestartLogBottomButton(card) {
    if (!card) return;
    try {
      if (card.querySelector('[data-xk-restart-log-bottom]')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-secondary log-btn restart-log-bottom-btn';
      btn.setAttribute('data-xk-restart-log-bottom', '1');
      btn.setAttribute('aria-label', 'Прокрутить журнал вниз');
      btn.hidden = true;
      btn.textContent = 'Вниз';
      card.appendChild(btn);
    } catch (error) {}
  }

  function syncRestartLogFullscreenButtons() {
    try {
      document.querySelectorAll('[data-xk-restart-log-action="fullscreen"]').forEach((btn) => {
        const card = getRestartLogCard(btn);
        const active = !!(card && card.classList && card.classList.contains('is-fullscreen'));
        btn.innerHTML = iconHtml(active ? 'fullscreen-exit' : 'fullscreen');
        btn.setAttribute('title', active ? 'Восстановить' : 'Полный экран');
        btn.setAttribute('aria-label', active ? 'Восстановить' : 'Полный экран');
      });
    } catch (error) {}
  }

  function setRestartLogFullscreen(card, on) {
    if (!card) return false;
    const next = !!on;
    try {
      if (next && RL._fullscreenCard && RL._fullscreenCard !== card) {
        RL._fullscreenCard.classList.remove('is-fullscreen');
      }
      card.classList.toggle('is-fullscreen', next);
      RL._fullscreenCard = next ? card : null;
      syncXkeenBodyScrollLock(!!RL._fullscreenCard);
      syncRestartLogFullscreenButtons();
      setTimeout(updateAllRestartLogScrollButtons, 0);
      return true;
    } catch (error) {}
    return false;
  }

  function toggleRestartLogFullscreen(card) {
    if (!card) return false;
    return setRestartLogFullscreen(card, !(card.classList && card.classList.contains('is-fullscreen')));
  }

  function normalizeRestartLogChrome() {
    try {
      getLogEls().forEach((el) => {
        const card = getRestartLogCard(el);
        if (!card) return;
        card.classList.add('xk-restart-log-card');
        ensureRestartLogBottomButton(card);
      });
      syncSearchControls();
      syncRestartLogFullscreenButtons();
    } catch (error) {}
  }

  RL.init = function init() {
    normalizeRestartLogChrome();

    try {
      const buttons = document.querySelectorAll('[data-xk-restart-log-action]');
      buttons.forEach((btn) => {
        const action = btn.getAttribute('data-xk-restart-log-action');
        if (!action) return;
        // Menu items close their menu: the answer shows in the journal itself.
        const closeMenu = () => {
          try {
            const menu = btn.closest('details');
            if (menu) menu.open = false;
          } catch (error) {}
        };
        if (action === 'clear') {
          bindOnce(btn, (event) => { event.preventDefault(); closeMenu(); RL.clear(); });
        } else if (action === 'copy') {
          bindOnce(btn, (event) => { event.preventDefault(); closeMenu(); RL.copy(); });
        } else if (action === 'refresh') {
          bindOnce(btn, (event) => { event.preventDefault(); closeMenu(); RL.load({ toastNewSubscription: false }); });
        } else if (action === 'fullscreen') {
          bindOnce(btn, (event) => {
            event.preventDefault();
            toggleRestartLogFullscreen(getRestartLogCard(btn));
          });
        }
      });
    } catch (error) {}

    try {
      document.querySelectorAll('[data-xk-restart-log-search]').forEach((input) => {
        if (input.dataset && input.dataset.xkeenRestartLogSearchBound === '1') return;
        input.addEventListener('input', () => {
          RL.setSearch(input.value || '');
        });
        if (input.dataset) input.dataset.xkeenRestartLogSearchBound = '1';
      });
      document.querySelectorAll('[data-xk-restart-log-search-clear]').forEach((btn) => {
        bindOnce(btn, (event) => {
          event.preventDefault();
          RL.setSearch('');
        });
      });
    } catch (error) {}

    try {
      document.querySelectorAll('[data-xk-restart-log-bottom]').forEach((btn) => {
        bindOnce(btn, (event) => {
          event.preventDefault();
          const card = getRestartLogCard(btn);
          const logEl = card && card.querySelector('[data-xk-restart-log="1"], #restart-log');
          scrollRestartLogToBottom(logEl);
        });
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
      if (!RL._escapeBound) {
        RL._escapeBound = true;
        document.addEventListener('keydown', (event) => {
          if (!event || event.key !== 'Escape') return;
          if (!RL._fullscreenCard) return;
          setRestartLogFullscreen(RL._fullscreenCard, false);
        });
      }
    } catch (error) {}

    bindLogInteractions();
    syncFilterButtons();
    syncSearchControls();
    syncRestartLogFullscreenButtons();

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
