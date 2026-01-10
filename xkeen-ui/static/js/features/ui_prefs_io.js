(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const Feature = {};

  function byId(id) { return document.getElementById(id); }

  function toast(msg, isErr) {
    try {
      if (typeof window.toast === 'function') return window.toast(String(msg || ''), isErr ? 'error' : 'info');
    } catch (e) {}
    try { console.log('[xkeen]', msg); } catch (e) {}
  }

  function setStatus(msg, isErr) {
    const el = byId('dt-ui-prefs-io-status');
    if (!el) return;
    el.textContent = msg ? String(msg) : '';
    try { el.style.color = isErr ? 'var(--sem-error, #fca5a5)' : ''; } catch (e) {}
  }

  // Note: branding is global now (stored on the router), so we export it separately
  // as `routerBranding`.
  const STATIC_KEYS = [
    'xkeen-theme',
    'xkeen-typography-v1',
    'xkeen-layout-v1',
    // branding cache (current builds)
    'xkeen-branding-cache-v1',
    // legacy only (older builds)
    'xkeen-branding-v1',
    'xkeen_ui_hide_donate',
    'xkeen.devtools.logs.live',
    'xkeen.devtools.logs.live_touched',
  ];

  const PREFIXES = [
    'xk.devtools.collapse.',
  ];

  function shouldExportKey(k) {
    if (!k) return false;
    if (STATIC_KEYS.indexOf(k) >= 0) return true;
    for (const pre of PREFIXES) {
      if (k.startsWith(pre)) return true;
    }
    // allow a small safe subset for devtools
    if (k.startsWith('xkeen.devtools.')) return true;
    return false;
  }

  function listMatchingKeys() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (shouldExportKey(k)) keys.push(k);
      }
    } catch (e) {}
    keys.sort();
    return keys;
  }

  function collectPrefs() {
    const prefs = {};
    const keys = listMatchingKeys();
    keys.forEach((k) => {
      try { prefs[k] = localStorage.getItem(k); } catch (e) {}
    });
    return prefs;
  }

  function csrfToken() {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      return (el && el.getAttribute('content')) ? String(el.getAttribute('content') || '') : '';
    } catch (e) {
      return '';
    }
  }

  async function fetchRouterBranding() {
    if (!window.fetch) return null;
    try {
      const r = await fetch('/api/devtools/branding', { method: 'GET', cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      if (!j || typeof j !== 'object') return null;
      return j.config || null;
    } catch (e) {
      return null;
    }
  }

  async function buildExportObject() {
    const routerBranding = await fetchRouterBranding();
    return {
      kind: 'xkeen-ui-prefs',
      version: 2,
      exportedAt: new Date().toISOString(),
      prefs: collectPrefs(),
      routerBranding: routerBranding || undefined,
    };
  }

  async function exportToTextarea() {
    const ta = byId('dt-ui-prefs-export-text');
    if (!ta) return { text: null, obj: null };
    const obj = await buildExportObject();
    const txt = JSON.stringify(obj, null, 2);
    ta.value = txt;
    return { text: txt, obj };
  }

  async function copyToClipboard(text) {
    const t = String(text || '');
    if (!t) return false;
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
        return true;
      }
    } catch (e) {}

    // Fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-10000px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  function downloadText(filename, text) {
    try {
      const blob = new Blob([String(text || '')], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (e) {}
        try { a.remove(); } catch (e) {}
      }, 0);
    } catch (e) {
      toast('Download failed: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  function parseImport(text) {
    const raw = String(text || '').trim();
    if (!raw) throw new Error('Empty JSON');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON');

    // Accept both {prefs:{...}} and direct mapping.
    // v2: { prefs: {...}, routerBranding: {...} }
    if (obj.kind === 'xkeen-ui-prefs') {
      const prefs = (obj.prefs && typeof obj.prefs === 'object') ? obj.prefs : {};
      const routerBranding = (obj.routerBranding && typeof obj.routerBranding === 'object') ? obj.routerBranding : null;
      return { prefs, routerBranding };
    }

    if (obj.prefs && typeof obj.prefs === 'object') {
      return { prefs: obj.prefs, routerBranding: (obj.routerBranding && typeof obj.routerBranding === 'object') ? obj.routerBranding : null };
    }

    // direct mapping (compat)
    return { prefs: obj, routerBranding: null };
  }

  function applyAll() {
    // theme
    try {
      if (XK && XK.ui && typeof XK.ui.applyTheme === 'function') {
        let t = null;
        try { t = localStorage.getItem('xkeen-theme'); } catch (e) {}
        if (t === 'light' || t === 'dark') XK.ui.applyTheme(t);
      }
    } catch (e) {}

    // typography
    try {
      if (XK && XK.ui && XK.ui.typography && typeof XK.ui.typography.apply === 'function') {
        XK.ui.typography.apply(XK.ui.typography.load());
      }
    } catch (e) {}

    // layout
    try {
      if (XK && XK.ui && XK.ui.layout && typeof XK.ui.layout.apply === 'function') {
        XK.ui.layout.apply(XK.ui.layout.load());
      }
    } catch (e) {}

    // branding
    try {
      if (XK && XK.ui && XK.ui.branding && typeof XK.ui.branding.apply === 'function') {
        XK.ui.branding.apply(XK.ui.branding.load());
      }
    } catch (e) {}

    // donate visibility / devtools toggle
    try {
      if (XK && XK.features && XK.features.donate && typeof XK.features.donate.init === 'function') {
        XK.features.donate.init();
      }
    } catch (e) {}
  }

  function doImport(prefsMap) {
    if (!prefsMap || typeof prefsMap !== 'object') throw new Error('Invalid prefs');

    // Only write keys we consider safe.
    let applied = 0;
    Object.keys(prefsMap).forEach((k) => {
      if (!shouldExportKey(k)) return;
      const v = prefsMap[k];
      try {
        if (v === null || typeof v === 'undefined') {
          localStorage.removeItem(k);
        } else {
          localStorage.setItem(k, String(v));
        }
        applied++;
      } catch (e) {}
    });

    applyAll();
    return applied;
  }

  async function importRouterBranding(cfg) {
    if (!cfg || typeof cfg !== 'object') return false;
    if (!window.fetch) return false;
    try {
      const headers = { 'Content-Type': 'application/json' };
      const tok = csrfToken();
      if (tok) headers['X-CSRF-Token'] = tok;
      const r = await fetch('/api/devtools/branding', {
        method: 'POST',
        headers,
        body: JSON.stringify({ config: cfg }),
      });
      const j = await r.json().catch(() => ({}));
      return !!(r.ok && j && j.ok);
    } catch (e) {
      return false;
    }
  }

  async function resetRouterBranding() {
    if (!window.fetch) return false;
    try {
      const headers = { 'Content-Type': 'application/json' };
      const tok = csrfToken();
      if (tok) headers['X-CSRF-Token'] = tok;
      const r = await fetch('/api/devtools/branding/reset', { method: 'POST', headers, body: '{}' });
      const j = await r.json().catch(() => ({}));
      return !!(r.ok && j && j.ok);
    } catch (e) {
      return false;
    }
  }

  function resetAll() {
    const keys = listMatchingKeys();
    let n = 0;
    keys.forEach((k) => {
      try { localStorage.removeItem(k); n++; } catch (e) {}
    });
    applyAll();
    return n;
  }

  function wire() {
    if (!byId('dt-ui-prefs-io-card')) return;

    const exportBtn = byId('dt-ui-prefs-export');
    const copyBtn = byId('dt-ui-prefs-copy');
    const dlBtn = byId('dt-ui-prefs-download');
    const exportTa = byId('dt-ui-prefs-export-text');

    const importTa = byId('dt-ui-prefs-import-text');
    const importBtn = byId('dt-ui-prefs-import');
    const importFileBtn = byId('dt-ui-prefs-import-file-btn');
    const importFileEl = byId('dt-ui-prefs-import-file');

    const resetBtn = byId('dt-ui-prefs-resetall');

    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        try {
          const res = await exportToTextarea();
          const obj = (res && res.obj) ? res.obj : {};
          const txt = res ? res.text : '';
          setStatus('Exported (' + Object.keys(obj.prefs || {}).length + ' keys)');
          if (txt) toast('Экспорт: готово');
        } catch (e) {
          setStatus('Export failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        try {
          const txt = (exportTa && exportTa.value) ? exportTa.value : (await exportToTextarea()).text;
          const ok = await copyToClipboard(txt || '');
          if (ok) {
            setStatus('Copied to clipboard');
            toast('Скопировано');
          } else {
            setStatus('Copy failed (clipboard blocked)', true);
            toast('Clipboard недоступен', true);
          }
        } catch (e) {
          setStatus('Copy failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (dlBtn) {
      dlBtn.addEventListener('click', async () => {
        try {
          const txt = (exportTa && exportTa.value) ? exportTa.value : (await exportToTextarea()).text;
          const ts = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const name = `xkeen-ui-prefs-${ts.getFullYear()}${pad(ts.getMonth()+1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.json`;
          downloadText(name, txt || '');
          setStatus('Downloaded: ' + name);
        } catch (e) {
          setStatus('Download failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    // File picker: avoid programmatic input.click() — some embedded WebViews block it.
    // We use <label for="..."> in the template; here we only reset input.value so re-selecting the same file triggers change.
    if (importFileBtn && importFileEl) {
      const reset = () => { try { importFileEl.value = ''; } catch (e) {} };
      importFileBtn.addEventListener('pointerdown', reset);
      importFileBtn.addEventListener('mousedown', reset);
      importFileBtn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reset();
          try { importFileEl.click(); } catch (err) {}
        }
      });
    }

    if (importFileEl) {
      importFileEl.addEventListener('change', async () => {
        const f = importFileEl.files && importFileEl.files[0];
        if (!f) return;
        try {
          const text = await f.text();
          if (importTa) importTa.value = text;
          setStatus('File loaded: ' + f.name);
        } catch (e) {
          setStatus('Read file failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        try {
          const raw = importTa ? importTa.value : '';
          const parsed = parseImport(raw);
          const prefs = parsed && parsed.prefs ? parsed.prefs : {};
          const rb = parsed ? parsed.routerBranding : null;

          let rbOk = null;
          if (rb) rbOk = await importRouterBranding(rb);
          try {
            if (rbOk === true && XK && XK.ui && XK.ui.branding && typeof XK.ui.branding.refreshFromRouter === 'function') {
              await XK.ui.branding.refreshFromRouter();
            }
          } catch (e) {}

          const n = doImport(prefs);
          let msg = 'Imported: ' + n + ' keys.';
          if (rbOk === true) msg += ' Branding: applied on router.';
          if (rbOk === false) msg += ' Branding: failed to apply.';
          msg += ' (May require page reload for some UI)';
          setStatus(msg, rbOk === false);
          toast('Импорт применён');
        } catch (e) {
          setStatus('Import failed: ' + (e && e.message ? e.message : String(e)), true);
          toast('Import failed', true);
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        try {
          const ok = window.confirm('Сбросить все UI-настройки (тема/типографика/layout/скрытые/брендинг/DevTools)?');
          if (!ok) return;
          const n = resetAll();
          const rbOk = await resetRouterBranding();
          try {
            if (XK && XK.ui && XK.ui.branding && typeof XK.ui.branding.refreshFromRouter === 'function') {
              await XK.ui.branding.refreshFromRouter();
            }
          } catch (e) {}
          if (exportTa) exportTa.value = '';
          if (importTa) importTa.value = '';
          setStatus('Reset: removed ' + n + ' keys. Branding reset: ' + (rbOk ? 'ok' : 'failed') + '. (May require page reload for some UI)', !rbOk);
          toast('UI-настройки сброшены');
        } catch (e) {
          setStatus('Reset failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    // Hint: export once on load to show current data size
    try {
      if (exportTa && !exportTa.value) {
        exportToTextarea();
      }
    } catch (e) {}
  }

  Feature.init = function init() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  };

  XK.features.uiPrefsIO = Feature;

  try { Feature.init(); } catch (e) {}
})();
