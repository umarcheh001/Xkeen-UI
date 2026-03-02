(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.restartLog = XKeen.features.restartLog || {};

  const RL = XKeen.features.restartLog;

  // Keep one canonical raw buffer so multiple log blocks (across sections)
  // can render the same output.
  RL._rawText = (typeof RL._rawText === 'string') ? RL._rawText : '';

  // ANSI -> HTML formatter.
  // Prefer shared util (it also strips non-SGR control sequences like ESC[H/ESC[J).
  function ansiToHtml(line) {
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.ansiToHtml === 'function') {
        return XKeen.util.ansiToHtml(line || '');
      }
    } catch (e) {}
    // ultra-fallback: plain text
    try {
      if (window.XKeen && XKeen.util && typeof XKeen.util.escapeHtml === 'function') {
        return XKeen.util.escapeHtml(line || '');
      }
    } catch (e) {}
    return String(line || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
        const cls = (typeof window.getXrayLogLineClass === 'function')
          ? window.getXrayLogLineClass(line)
          : 'log-line';
        const inner = ansiToHtml(line || '');
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
      if (typeof window.showToast === 'function') window.showToast('Журнал скопирован в буфер обмена', false);
    } catch (e) {
      console.error(e);
      if (typeof window.showToast === 'function') window.showToast('Не удалось скопировать журнал', true);
    }
    try { ta.remove(); } catch (e) {}
  }

  RL.copy = function copy() {
    const text = RL._rawText || '';
    if (!text) return;

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => { if (typeof window.showToast === 'function') window.showToast('Журнал скопирован в буфер обмена', false); },
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

  // Back-compat: old code calls `loadRestartLog()`.
  if (typeof window.loadRestartLog !== 'function') {
    window.loadRestartLog = function loadRestartLog() {
      return RL.load();
    };
  }
})();
