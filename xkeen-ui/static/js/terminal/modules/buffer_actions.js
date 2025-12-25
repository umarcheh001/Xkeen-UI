// Terminal module: buffer actions (Stage 6/7)
//
// Responsibilities extracted from terminal.js:
//   - copy / copyAll / paste / clear
//   - download txt/html/vt snapshot (via SerializeAddon from core/xterm_manager)
//   - scrollToBottom
//
// Exposes: ctx.bufferActions
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function safeToast(ctx, msg, kind) {
    const m = String(msg || '');
    const k = kind || 'info';
    try {
      if (ctx && ctx.ui && typeof ctx.ui.toast === 'function') return ctx.ui.toast(m, k);
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(m, k);
    } catch (e2) {}
  }

  function byId(ctx, id) {
    try {
      if (ctx && ctx.ui && typeof ctx.ui.byId === 'function') return ctx.ui.byId(id);
    } catch (e) {}
    try {
      if (ctx && ctx.core && typeof ctx.core.byId === 'function') return ctx.core.byId(id);
    } catch (e2) {}
    try {
      return document.getElementById(id);
    } catch (e3) {}
    return null;
  }

  function getRefs(ctx) {
    try {
      if (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') return ctx.xterm.getRefs() || {};
    } catch (e) {}
    return {};
  }

  function getTerm(ctx) {
    const refs = getRefs(ctx);
    return refs.term || refs.xterm || null;
  }

  function getSerializeAddon(ctx) {
    const refs = getRefs(ctx);
    return refs.serializeAddon || null;
  }

  function getXtermManager(ctx) {
    try {
      return ctx && ctx.xterm && typeof ctx.xterm.getManager === 'function' ? ctx.xterm.getManager() : null;
    } catch (e) {}
    return null;
  }

  function isPtyConnected(ctx) {
    try {
      if (ctx && ctx.session && typeof ctx.session.getMode === 'function') {
        const mode = ctx.session.getMode();
        if (mode === 'pty' && typeof ctx.session.isConnected === 'function') return !!ctx.session.isConnected();
      }
    } catch (e) {}
    try {
      if (ctx && ctx.transport && typeof ctx.transport.isConnected === 'function') return !!ctx.transport.isConnected();
    } catch (e2) {}
    return false;
  }

  function getAllBufferText(ctx) {
    try {
      const term = getTerm(ctx);
      if (term && term.buffer && term.buffer.active) {
        const buf = term.buffer.active;
        const rows = term.rows || 0;
        let end = 0;
        if (typeof buf.baseY === 'number') end = buf.baseY + rows;
        else if (typeof buf.length === 'number') end = buf.length;
        if (typeof buf.length === 'number') end = Math.min(Math.max(end, 0), buf.length);
        if (!end && typeof buf.length === 'number') end = buf.length;

        const lines = [];
        for (let i = 0; i < end; i++) {
          const line = buf.getLine(i);
          if (!line) {
            lines.push('');
            continue;
          }
          lines.push(line.translateToString(true));
        }
        return lines.join('\n');
      }
    } catch (e) {}

    const pre = byId(ctx, 'terminal-output');
    try {
      return pre ? (pre.innerText || pre.textContent || '') : '';
    } catch (e2) {}
    return '';
  }

  function getSelectionOrViewportText(ctx) {
    let text = '';
    try {
      const term = getTerm(ctx);
      if (term && typeof term.getSelection === 'function') text = term.getSelection() || '';

      if (!text && term && term.buffer && term.buffer.active) {
        const buf = term.buffer.active;
        const start = (typeof buf.viewportY === 'number')
          ? buf.viewportY
          : (typeof buf.baseY === 'number' ? buf.baseY : 0);
        const end = start + (term.rows || 0);
        const lines = [];
        for (let i = start; i < end; i++) {
          const line = buf.getLine(i);
          if (!line) continue;
          lines.push(line.translateToString(true));
        }
        text = lines.join('\n');
      }
    } catch (e) {}

    if (!text) {
      const pre = byId(ctx, 'terminal-output');
      try {
        if (pre) text = pre.innerText || pre.textContent || '';
      } catch (e2) {}
    }

    return String(text || '');
  }

  function serializeHtml(ctx) {
    try {
      const addon = getSerializeAddon(ctx);
      if (addon && typeof addon.serializeAsHTML === 'function') {
        return String(addon.serializeAsHTML({ includeGlobalBackground: true }) || '');
      }
    } catch (e) {}
    return '';
  }

  function serializeVT(ctx) {
    try {
      const addon = getSerializeAddon(ctx);
      if (addon && typeof addon.serialize === 'function') {
        return String(addon.serialize({ excludeAltBuffer: true, excludeModes: true }) || '');
      }
    } catch (e) {}
    return '';
  }

  function isoStamp() {
    try {
      return new Date().toISOString().replace(/[:.]/g, '-');
    } catch (e) {}
    return String(Date.now());
  }

  function downloadBlob(ctx, filename, blob, okToast, errToast) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      try {
        URL.revokeObjectURL(url);
      } catch (e) {}
      safeToast(ctx, okToast || 'Скачивание начато', 'success');
      return true;
    } catch (e2) {
      safeToast(ctx, errToast || 'Не удалось скачать', 'error');
    }
    return false;
  }

  async function copy(ctx) {
    const text = getSelectionOrViewportText(ctx);
    if (!text.trim()) {
      safeToast(ctx, 'Нечего копировать', 'info');
      return;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        safeToast(ctx, 'Скопировано в буфер', 'success');
        return;
      }
    } catch (e) {}

    // Fallback for older browsers
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      safeToast(ctx, 'Скопировано в буфер', 'success');
    } catch (e2) {
      safeToast(ctx, 'Не удалось скопировать', 'error');
    }
  }

  async function copyAll(ctx) {
    const text = String(getAllBufferText(ctx) || '');
    if (!text.trim()) {
      safeToast(ctx, 'Нечего копировать', 'info');
      return;
    }

    const html = serializeHtml(ctx);

    try {
      if (navigator.clipboard) {
        if (html && typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
          const item = new ClipboardItem({
            'text/plain': new Blob([text], { type: 'text/plain;charset=utf-8' }),
            'text/html': new Blob([html], { type: 'text/html;charset=utf-8' })
          });
          await navigator.clipboard.write([item]);
          safeToast(ctx, 'Скопировано: весь буфер (HTML + текст)', 'success');
          return;
        }

        if (navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          safeToast(ctx, 'Скопировано: весь буфер', 'success');
          return;
        }
      }
    } catch (e) {}

    // Fallback for older browsers
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      safeToast(ctx, 'Скопировано: весь буфер', 'success');
    } catch (e2) {
      safeToast(ctx, 'Не удалось скопировать', 'error');
    }
  }

  function downloadTxt(ctx) {
    const text = String(getAllBufferText(ctx) || '');
    if (!text.trim()) {
      safeToast(ctx, 'Нечего скачивать', 'info');
      return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    downloadBlob(
      ctx,
      'xkeen-terminal-' + isoStamp() + '.txt',
      blob,
      'Скачивание начато (.txt)',
      'Не удалось скачать .txt'
    );
  }

  function downloadHtml(ctx) {
    const html = String(serializeHtml(ctx) || '');
    if (!html.trim()) {
      safeToast(ctx, 'HTML-экспорт недоступен', 'info');
      return;
    }
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    downloadBlob(
      ctx,
      'xkeen-terminal-' + isoStamp() + '.html',
      blob,
      'Скачивание начато (.html)',
      'Не удалось скачать .html'
    );
  }

  function downloadVtSnapshot(ctx) {
    const vt = String(serializeVT(ctx) || '');
    if (!vt.trim()) {
      safeToast(ctx, 'VT-снапшот недоступен', 'info');
      return;
    }
    const blob = new Blob([vt], { type: 'text/plain;charset=utf-8' });
    downloadBlob(
      ctx,
      'xkeen-terminal-' + isoStamp() + '.vt',
      blob,
      'Скачивание начато (.vt)',
      'Не удалось скачать .vt'
    );
  }

  async function paste(ctx) {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (!text) return;

        // PTY: paste into terminal (preferred)
        if (isPtyConnected(ctx)) {
          try {
            if (ctx && ctx.transport && typeof ctx.transport.send === 'function') ctx.transport.send(text, { prefer: 'pty' });
          } catch (e) {}
          try {
            const term = getTerm(ctx);
            if (term && typeof term.focus === 'function') term.focus();
          } catch (e2) {}
          return;
        }

        // Non-PTY fallback: paste into command/confirm inputs (useful on mobile)
        const cmdEl = byId(ctx, 'terminal-command');
        const inputEl = byId(ctx, 'terminal-input');
        const active = document.activeElement;
        const target = (active && (active === cmdEl || active === inputEl))
          ? active
          : (cmdEl && cmdEl.style.display !== 'none' ? cmdEl : inputEl);

        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
          try {
            const start = (typeof target.selectionStart === 'number') ? target.selectionStart : (target.value || '').length;
            const end = (typeof target.selectionEnd === 'number') ? target.selectionEnd : (target.value || '').length;
            const before = (target.value || '').slice(0, start);
            const after = (target.value || '').slice(end);
            target.value = before + text + after;
            const pos = start + text.length;
            try { target.selectionStart = target.selectionEnd = pos; } catch (e3) {}
            try { target.focus(); } catch (e4) {}
            return;
          } catch (e5) {}
        }

        safeToast(ctx, 'Нет активной сессии PTY — вставка в терминал недоступна', 'info');
        return;
      }
    } catch (e) {}

    safeToast(ctx, 'Вставка из буфера недоступна в этом браузере', 'info');
  }

  function clear(ctx) {
    // Clear screen without breaking the PTY session.
    try {
      const mgr = getXtermManager(ctx);
      if (mgr && typeof mgr.clear === 'function') {
        mgr.clear();
      } else {
        const term = getTerm(ctx);
        if (term && typeof term.clear === 'function') term.clear();
      }
    } catch (e) {}

    try {
      const pre = byId(ctx, 'terminal-output');
      const term = getTerm(ctx);
      if (!term && pre) pre.textContent = '';
    } catch (e2) {}

    // Ask the remote shell to clear too (keeps session alive).
    if (isPtyConnected(ctx)) {
      try {
        if (ctx && ctx.transport && typeof ctx.transport.send === 'function') ctx.transport.send('clear\r', { prefer: 'pty' });
      } catch (e3) {}
    }
  }

  function scrollToBottom(ctx) {
    try {
      const term = getTerm(ctx);
      if (term && typeof term.scrollToBottom === 'function') {
        term.scrollToBottom();
        return;
      }
    } catch (e) {}

    try {
      const out = byId(ctx, 'terminal-output');
      if (out) out.scrollTop = out.scrollHeight;
    } catch (e2) {}
  }

  function createActions(ctx) {
    const api = {
      copy: () => copy(ctx),
      copyAll: () => copyAll(ctx),
      paste: () => paste(ctx),
      clear: () => clear(ctx),
      downloadTxt: () => downloadTxt(ctx),
      downloadHtml: () => downloadHtml(ctx),
      downloadVtSnapshot: () => downloadVtSnapshot(ctx),
      scrollToBottom: () => scrollToBottom(ctx),

      // Helpers (useful for tests / future modules)
      _getAllBufferText: () => getAllBufferText(ctx),
      _serializeHtml: () => serializeHtml(ctx),
      _serializeVT: () => serializeVT(ctx),
    };

    try {
      if (ctx) ctx.bufferActions = api;
    } catch (e) {}
    return api;
  }

  function createModule(ctx) {
    const api = createActions(ctx);
    return {
      id: 'buffer_actions',
      priority: 35,
      init: () => {
        try {
          if (ctx) ctx.bufferActions = api;
        } catch (e) {}
      },
      onOpen: () => {},
      onClose: () => {},
    };
  }

  window.XKeen.terminal.buffer_actions = {
    createActions,
    createModule,
  };
})();
