import { getXrayLogLineClass } from './xray_log_line_class.js';
import { ansiToXkeenHtml, toastXkeen } from './xkeen_runtime.js';

let restartLogModuleApi = null;

(() => {
  'use strict';

  const RL = restartLogModuleApi || {};
  restartLogModuleApi = RL;

  // Keep one canonical raw buffer so multiple log blocks (across sections)
  // can render the same output.
  RL._rawText = (typeof RL._rawText === 'string') ? RL._rawText : '';

  // ANSI -> HTML formatter.
  // Prefer shared util (it also strips non-SGR control sequences like ESC[H/ESC[J).
  function ansiToHtml(line) {
    return ansiToXkeenHtml(line || '');
  }

  // Normalize Xray-style log lines into a more terminal-like format.
  // Example:
  //   2026/03/02 21:48:55.631491 [Info] infra/conf/serial: ...
  // becomes:
  //   INFO[2026-03-02T21:48:55.631491] infra/conf/serial: ...
  const XRAY_TS_LINE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s*(?:\[([^\]]+)\])?\s*(.*)$/;

  function normalizeLineForTerminal(line) {
    const s = String(line || '');
    if (!s) return s;

    // Keep ANSI / already-terminal lines intact.
    if (s.indexOf('\x1b') !== -1) return s;
    if (/^(?:INFO|WARN|WARNING|ERROR|ERRO|FATA|DEBUG)\[/.test(s)) return s;

    const m = s.match(XRAY_TS_LINE_RE);
    if (!m) return s;

    const y = m[1];
    const mo = m[2];
    const d = m[3];
    const t = m[4];
    const iso = `${y}-${mo}-${d}T${t}`;

    let lvl = 'INFO';
    const low = String(m[5] || '').trim().toLowerCase();
    if (low.startsWith('warn')) lvl = 'WARN';
    else if (low.startsWith('error')) lvl = 'ERROR';
    else if (low.startsWith('fatal')) lvl = 'FATA';
    else if (low.startsWith('debug')) lvl = 'DEBUG';
    else if (low.startsWith('info')) lvl = 'INFO';

    const msg = String(m[6] || '').replace(/^\s+/, '');
    return msg ? `${lvl}[${iso}] ${msg}` : `${lvl}[${iso}]`;
  }

  function normalizeTextForTerminal(text) {
    const raw = String(text || '');
    if (!raw) return raw;
    const hasTrailingNl = raw.endsWith('\n');
    const lines = raw.split(/\r?\n/);
    if (hasTrailingNl && lines.length && lines[lines.length - 1] === '') lines.pop();
    const norm = lines.map(normalizeLineForTerminal).join('\n');
    return hasTrailingNl ? (norm + '\n') : norm;
  }

  function getLogEls() {
    const els = [];
    try {
      const q = document.querySelectorAll('[data-xk-restart-log="1"]');
      q.forEach((el) => { if (el) els.push(el); });
    } catch (e) {}

    // Back-compat: old markup
    try {
      const legacy = document.getElementById('restart-log');
      if (legacy && els.indexOf(legacy) === -1) els.push(legacy);
    } catch (e) {}

    return els;
  }

  function renderInto(el, rawText) {
    if (!el) return;
    const text = rawText || '';
    const lines = String(text).split(/\r?\n/);
    // Avoid an extra empty block caused by trailing newline in the raw text.
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const html = lines
      .map((line) => {
        const normalized = normalizeLineForTerminal(line || '');
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
        const inner = ansiToHtml(normalized);
        return '<span class="' + cls + '">' + inner + '</span>';
      })
      // Each line is rendered as a block-level <span>. Adding <br> creates empty rows in <pre>.
      .join('');

    el.innerHTML = html;
    try { el.scrollTop = el.scrollHeight; } catch (e) {}
  }

  function renderAll() {
    const els = getLogEls();
    if (!els.length) return;
    const raw = RL._rawText || '';
    els.forEach((el) => {
      try { el.dataset.rawText = raw; } catch (e) {}
      renderInto(el, raw);
    });
  }

  RL.renderFromRaw = function renderFromRaw(rawText) {
    RL._rawText = String(rawText || '');
    renderAll();
  };

  RL.setRaw = function setRaw(rawText) {
    RL._rawText = String(rawText || '');
    renderAll();
  };

  RL.load = async function load() {
    const els = getLogEls();
    if (!els.length) return false;

    try {
      const res = await fetch('/api/restart-log');
      if (!res.ok) {
        const msg = 'Не удалось загрузить журнал.';
        RL.setRaw(msg);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const text = lines.length ? lines.join('') : 'Журнал пуст.';
      RL.setRaw(text);
      return true;
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка загрузки журнала.';
      RL.setRaw(msg);
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
    RL.setRaw('');
    try {
      fetch('/api/restart-log/clear', { method: 'POST' });
    } catch (e) {
      console.error(e);
    }
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
    } catch (e) {
      console.error(e);
      toastXkeen('Не удалось скопировать журнал', true);
    }
    try { ta.remove(); } catch (e) {}
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
    } catch (e) {}
  }

  RL.init = function init() {
    // Data-attr buttons (preferred)
    try {
      const btns = document.querySelectorAll('[data-xk-restart-log-action]');
      btns.forEach((btn) => {
        const act = btn.getAttribute('data-xk-restart-log-action');
        if (!act) return;
        if (act === 'clear') {
          bindOnce(btn, (e) => { e.preventDefault(); RL.clear(); });
        } else if (act === 'copy') {
          bindOnce(btn, (e) => { e.preventDefault(); RL.copy(); });
        }
      });
    } catch (e) {}

    // Back-compat: old ids
    try {
      const clearBtn = document.getElementById('restart-log-clear-btn');
      const copyBtn = document.getElementById('restart-log-copy-btn');
      bindOnce(clearBtn, (e) => { e.preventDefault(); RL.clear(); });
      bindOnce(copyBtn, (e) => { e.preventDefault(); RL.copy(); });
    } catch (e) {}

    // Auto-load when any restart log block exists.
    try {
      if (getLogEls().length) RL.load();
    } catch (e) {}
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

export const restartLogApi = Object.freeze({
  get: getRestartLogApi,
  init: initRestartLog,
  load: loadRestartLog,
  append: appendRestartLog,
  setRaw: setRestartLogRaw,
  clear: clearRestartLog,
  copy: copyRestartLog,
});
