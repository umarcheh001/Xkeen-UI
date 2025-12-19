(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.restartLog = XKeen.features.restartLog || {};

  const RL = XKeen.features.restartLog;

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

  function getLogEl() {
    return document.getElementById('restart-log');
  }

  RL.renderFromRaw = function renderFromRaw(rawText) {
    const logEl = getLogEl();
    if (!logEl) return;

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

    logEl.innerHTML = html;
    logEl.scrollTop = logEl.scrollHeight;
  };

  RL.load = async function load() {
    const logEl = getLogEl();
    if (!logEl) return false;

    try {
      const res = await fetch('/api/restart-log');
      if (!res.ok) {
        const msg = 'Не удалось загрузить журнал.';
        logEl.dataset.rawText = msg;
        RL.renderFromRaw(msg);
        return false;
      }
      const data = await res.json().catch(() => ({}));
      const lines = Array.isArray(data.lines) ? data.lines : [];
      const text = lines.length ? lines.join('') : 'Журнал пуст.';
      logEl.dataset.rawText = text;
      RL.renderFromRaw(text);
      return true;
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка загрузки журнала.';
      logEl.dataset.rawText = msg;
      RL.renderFromRaw(msg);
      return false;
    }
  };

  RL.append = function append(text) {
    const logEl = getLogEl();
    if (!logEl || !text) return;
    const current = logEl.dataset.rawText || '';
    let raw = current;
    if (raw && !raw.endsWith('\n')) raw += '\n';
    raw += String(text);
    logEl.dataset.rawText = raw;
    RL.renderFromRaw(raw);
  };

  RL.clear = function clear() {
    const logEl = getLogEl();
    if (!logEl) return;
    logEl.dataset.rawText = '';
    logEl.innerHTML = '';
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
    const logEl = getLogEl();
    if (!logEl) return;
    const text = logEl.dataset.rawText || '';
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

  RL.init = function init() {
    const clearBtn = document.getElementById('restart-log-clear-btn');
    const copyBtn = document.getElementById('restart-log-copy-btn');

    if (clearBtn && (!clearBtn.dataset || clearBtn.dataset.xkeenBound !== '1')) {
      clearBtn.addEventListener('click', (e) => {
        e.preventDefault();
        RL.clear();
      });
      if (clearBtn.dataset) clearBtn.dataset.xkeenBound = '1';
    }

    if (copyBtn && (!copyBtn.dataset || copyBtn.dataset.xkeenBound !== '1')) {
      copyBtn.addEventListener('click', (e) => {
        e.preventDefault();
        RL.copy();
      });
      if (copyBtn.dataset) copyBtn.dataset.xkeenBound = '1';
    }

    // Auto-load when restart log block exists.
    try {
      RL.load();
    } catch (e) {}
  };

  // Back-compat: old code calls `loadRestartLog()`.
  if (typeof window.loadRestartLog !== 'function') {
    window.loadRestartLog = function loadRestartLog() {
      return RL.load();
    };
  }
})();
