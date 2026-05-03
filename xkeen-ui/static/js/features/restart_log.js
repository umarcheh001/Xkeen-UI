import { getXrayLogLineClass } from './xray_log_line_class.js';
import { ansiToXkeenHtml, escapeXkeenHtml, getXkeenCommandJobApi, toastXkeen } from './xkeen_runtime.js';

let restartLogModuleApi = null;

(() => {
  'use strict';

  const RL = restartLogModuleApi || {};
  restartLogModuleApi = RL;

  RL._rawText = typeof RL._rawText === 'string' ? RL._rawText : '';
  RL._knownEntryKeys = RL._knownEntryKeys instanceof Set ? RL._knownEntryKeys : new Set();
  RL._hasBaseline = !!RL._hasBaseline;
  RL._pollTimer = RL._pollTimer || null;

  const RESTART_LOG_POLL_MS = 15000;
  const RESTART_SUMMARY_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+source=([^\s]+)\s+result=([A-Z]+)(?:\s+(.*?))?\s*$/i;
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
  });

  const XRAY_TS_LINE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:\[([^\]]+)\])?\s*(.*)$/;

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

    const duration = formatDurationMs(meta.duration_ms);
    if (duration) parts.push(duration);

    return parts.join(' · ');
  }

  function buildRestartSummaryMessage(source, ok, baseMessage, details) {
    const message = String(baseMessage || '');
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

  function buildStructuredLineHtml(summary) {
    if (!summary) return '';

    const bucket = String(summary.bucket || 'generic').trim().toLowerCase() || 'generic';
    const tsHtml = safeEscapeHtml(`[${summary.ts}]`);
    const labelHtml = safeEscapeHtml(summary.label || 'Событие');
    const messageHtml = safeEscapeHtml(summary.message || '');
    const rawSourceHtml = summary.rawSourceText ? safeEscapeHtml(summary.rawSourceText) : '';

    return [
      '<span class="restart-log-entry">',
      `<span class="log-ts restart-log-ts">${tsHtml}</span>`,
      `<span class="restart-log-pill restart-log-pill-${bucket}">${labelHtml}</span>`,
      `<span class="restart-log-message">${messageHtml}</span>`,
      rawSourceHtml ? `<span class="restart-log-meta">${rawSourceHtml}</span>` : '',
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
    const levelRaw = String(match[5] || '').trim().toLowerCase();
    let level = 'INFO';
    if (levelRaw.startsWith('warn')) level = 'WARN';
    else if (levelRaw.startsWith('error')) level = 'ERROR';
    else if (levelRaw.startsWith('fatal')) level = 'FATA';
    else if (levelRaw.startsWith('debug')) level = 'DEBUG';

    const message = String(match[6] || '').replace(/^\s+/, '');
    return message ? `${level}[${iso}] ${message}` : `${level}[${iso}]`;
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
    const entries = parseRenderedEntries(rawText || '');
    const html = entries
      .map((entry) => {
        const summary = entry && entry.summary ? entry.summary : null;
        if (summary) {
          const cls = `log-line restart-log-line log-line-${summary.kind} restart-log-line-${summary.bucket}`;
          return `<span class="${cls}">${buildStructuredLineHtml(summary)}</span>`;
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
        return `<span class="${cls}">${ansiToHtml(normalized)}</span>`;
      })
      .join('');

    el.innerHTML = html;
    try { el.scrollTop = el.scrollHeight; } catch (error) {}
  }

  function renderAll() {
    const els = getLogEls();
    if (!els.length) return;
    const raw = RL._rawText || '';
    els.forEach((el) => {
      try { el.dataset.rawText = raw; } catch (error) {}
      renderInto(el, raw);
    });
  }

  function ensurePolling() {
    if (RL._pollTimer) return;
    RL._pollTimer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (!getLogEls().length) return;
      try { RL.load({ toastNewSubscription: true, silent: true }); } catch (error) {}
    }, RESTART_LOG_POLL_MS);
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

  RL.init = function init() {
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
      const refreshBtn = document.getElementById('restart-log-refresh-btn');
      const clearBtn = document.getElementById('restart-log-clear-btn');
      const copyBtn = document.getElementById('restart-log-copy-btn');
      bindOnce(refreshBtn, (event) => { event.preventDefault(); RL.load({ toastNewSubscription: false }); });
      bindOnce(clearBtn, (event) => { event.preventDefault(); RL.clear(); });
      bindOnce(copyBtn, (event) => { event.preventDefault(); RL.copy(); });
    } catch (error) {}

    try {
      if (getLogEls().length) RL.load({ toastNewSubscription: false });
    } catch (error) {}

    ensurePolling();
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
  copy: copyRestartLog,
  reveal: revealRestartLog,
  prepareLiveStream: prepareRestartLogLiveStream,
  waitForJob: waitForRestartLogJob,
  streamJob: streamRestartLogJob,
});
