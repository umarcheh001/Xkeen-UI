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
    const el = byId('dt-branding-status');
    if (!el) return;
    el.textContent = msg ? String(msg) : '';
    try { el.style.color = isErr ? '#fca5a5' : ''; } catch (e) {}
  }

  function isDataUrl(s) {
    return typeof s === 'string' && s.trim().toLowerCase().startsWith('data:')
  }

  function setPreview(imgEl, src) {
    if (!imgEl) return;
    const v = String(src || '').trim();
    if (!v) {
      imgEl.src = '';
      imgEl.classList.add('hidden');
      return;
    }
    imgEl.src = v;
    imgEl.classList.remove('hidden');
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      try {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result || ''));
        fr.onerror = () => reject(fr.error || new Error('File read error'));
        fr.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  let _logoSrc = '';
  let _faviconSrc = '';

  function syncFormFromPrefs(prefs) {
    const p = prefs || {};
    const titleEl = byId('dt-branding-title');
    const logoUrlEl = byId('dt-branding-logo-url');
    const favUrlEl = byId('dt-branding-favicon-url');
    const logoPrev = byId('dt-branding-logo-preview');
    const favPrev = byId('dt-branding-favicon-preview');

    if (titleEl) titleEl.value = (p.title || '');

    // Avoid dumping big data: URIs into inputs.
    if (logoUrlEl) {
      const v = String(p.logoSrc || '').trim();
      logoUrlEl.value = (v && !v.startsWith('data:')) ? v : '';
      if (v && v.startsWith('data:')) logoUrlEl.placeholder = '[uploaded data URI]';
      else logoUrlEl.placeholder = 'https://... или data:image/...';
    }

    if (favUrlEl) {
      const v = String(p.faviconSrc || '').trim();
      favUrlEl.value = (v && !v.startsWith('data:')) ? v : '';
      if (v && v.startsWith('data:')) favUrlEl.placeholder = '[uploaded data URI]';
      else favUrlEl.placeholder = 'https://... или data:image/...';
    }

    _logoSrc = String(p.logoSrc || '').trim();
    _faviconSrc = String(p.faviconSrc || '').trim();

    setPreview(logoPrev, _logoSrc);
    setPreview(favPrev, _faviconSrc);

    // Tab rename inputs
    const wrap = byId('dt-branding-tab-rename');
    const mp = (p && p.tabRename) ? p.tabRename : {};
    if (wrap) {
      wrap.querySelectorAll('input.dt-rename-input[data-tab-key]').forEach((inp) => {
        const k = inp.dataset ? String(inp.dataset.tabKey || '').trim() : '';
        const v = (k && mp && typeof mp[k] === 'string') ? String(mp[k]).trim() : '';
        inp.value = v;
      });
    }
  }

  async function loadFromRouter() {
    if (!window.fetch) return null;
    try {
      const r = await fetch('/api/devtools/branding', { method: 'GET', cache: 'no-store' });
      if (!r.ok) return null;
      const j = await r.json().catch(() => ({}));
      if (!j || typeof j !== 'object') return null;
      const cfg = j.config || j;
      return cfg;
    } catch (e) {
      return null;
    }
  }

  function gatherPrefs() {
    const branding = XK.ui && XK.ui.branding;
    const base = branding ? branding.load() : {};

    const title = String((byId('dt-branding-title') && byId('dt-branding-title').value) || '').trim();

    const logoUrlEl = byId('dt-branding-logo-url');
    const favUrlEl = byId('dt-branding-favicon-url');

    const logoSrc = (logoUrlEl && String(logoUrlEl.value || '').trim()) || _logoSrc || '';
    const faviconSrc = (favUrlEl && String(favUrlEl.value || '').trim()) || _faviconSrc || '';

    const tabRename = {};
    const wrap = byId('dt-branding-tab-rename');
    if (wrap) {
      wrap.querySelectorAll('input.dt-rename-input[data-tab-key]').forEach((inp) => {
        const k = inp.dataset ? String(inp.dataset.tabKey || '').trim() : '';
        const v = String(inp.value || '').trim();
        if (!k) return;
        if (!v) return;
        tabRename[k] = v;
      });
    }

    return {
      ...base,
      title,
      logoSrc,
      faviconSrc,
      tabRename,
    };
  }

  async function wire() {
    const branding = XK.ui && XK.ui.branding;
    if (!branding) return;

    const titleEl = byId('dt-branding-title');

    const logoUploadBtn = byId('dt-branding-logo-upload-btn');
    const logoClearBtn = byId('dt-branding-logo-clear');
    const logoFileEl = byId('dt-branding-logo-file');
    const logoUrlEl = byId('dt-branding-logo-url');
    const logoPrev = byId('dt-branding-logo-preview');

    const favUploadBtn = byId('dt-branding-favicon-upload-btn');
    const favClearBtn = byId('dt-branding-favicon-clear');
    const favFileEl = byId('dt-branding-favicon-file');
    const favUrlEl = byId('dt-branding-favicon-url');
    const favPrev = byId('dt-branding-favicon-preview');

    const saveBtn = byId('dt-branding-save');
    const resetBtn = byId('dt-branding-reset');

    // Prefer router-stored branding (global)
    try {
      if (branding && typeof branding.refreshFromRouter === 'function') {
        await branding.refreshFromRouter();
      }
    } catch (e) {}
    syncFormFromPrefs(branding.load());

    const onUrlChange = () => {
      _logoSrc = (logoUrlEl && String(logoUrlEl.value || '').trim()) || _logoSrc;
      _faviconSrc = (favUrlEl && String(favUrlEl.value || '').trim()) || _faviconSrc;
      setPreview(logoPrev, _logoSrc);
      setPreview(favPrev, _faviconSrc);
    };

    if (logoUrlEl) {
      logoUrlEl.addEventListener('input', onUrlChange);
      logoUrlEl.addEventListener('change', onUrlChange);
    }
    if (favUrlEl) {
      favUrlEl.addEventListener('input', onUrlChange);
      favUrlEl.addEventListener('change', onUrlChange);
    }

    // File pickers: avoid programmatic input.click() — some embedded WebViews block it.
    // We use <label for="..."> in the template; here we only reset input.value so re-selecting the same file triggers change.
    function wireFileLabel(labelEl, fileEl) {
      if (!labelEl || !fileEl) return;
      const reset = () => { try { fileEl.value = ''; } catch (e) {} };
      // Reset before the OS dialog opens.
      labelEl.addEventListener('pointerdown', reset);
      labelEl.addEventListener('mousedown', reset);
      // Keyboard accessibility: open on Enter/Space.
      labelEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reset();
          try { fileEl.click(); } catch (err) {}
        }
      });
    }

    wireFileLabel(logoUploadBtn, logoFileEl);
    wireFileLabel(favUploadBtn, favFileEl);

    if (logoClearBtn) {
      logoClearBtn.addEventListener('click', () => {
        _logoSrc = '';
        if (logoUrlEl) {
          logoUrlEl.value = '';
          logoUrlEl.placeholder = 'https://... или data:image/...';
        }
        try { if (logoFileEl) logoFileEl.value = ''; } catch (e) {}
        setPreview(logoPrev, '');
        setStatus('Logo: cleared');
      });
    }

    if (favClearBtn) {
      favClearBtn.addEventListener('click', () => {
        _faviconSrc = '';
        if (favUrlEl) {
          favUrlEl.value = '';
          favUrlEl.placeholder = 'https://... или data:image/...';
        }
        try { if (favFileEl) favFileEl.value = ''; } catch (e) {}
        setPreview(favPrev, '');
        setStatus('Favicon: cleared');
      });
    }

    if (logoFileEl) {
      logoFileEl.addEventListener('change', async () => {
        const f = logoFileEl.files && logoFileEl.files[0];
        if (!f) return;
        try {
          const dataUrl = await readAsDataURL(f);
          _logoSrc = String(dataUrl || '').trim();
          if (logoUrlEl) {
            logoUrlEl.value = '';
            logoUrlEl.placeholder = '[uploaded data URI]';
          }
          setPreview(logoPrev, _logoSrc);
          setStatus('Logo: uploaded');
        } catch (e) {
          setStatus('Logo upload failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (favFileEl) {
      favFileEl.addEventListener('change', async () => {
        const f = favFileEl.files && favFileEl.files[0];
        if (!f) return;
        try {
          const dataUrl = await readAsDataURL(f);
          _faviconSrc = String(dataUrl || '').trim();
          if (favUrlEl) {
            favUrlEl.value = '';
            favUrlEl.placeholder = '[uploaded data URI]';
          }
          setPreview(favPrev, _faviconSrc);
          setStatus('Favicon: uploaded');
        } catch (e) {
          setStatus('Favicon upload failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        try {
          const next = gatherPrefs();
          const res = await branding.save(next);
          if (res && res.ok) {
            setStatus('Брендинг сохранён на роутере');
            toast('Брендинг сохранён');
          } else {
            setStatus('Сохранено локально (не удалось записать на роутере): ' + (res && res.error ? res.error : 'error'), true);
            toast('Сохранено локально (ошибка записи)', true);
          }
        } catch (e) {
          setStatus('Save failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', async () => {
        try {
          const ok = window.confirm('Сбросить брендинг на роутере (глобально)?');
          if (!ok) return;
          const res = await branding.reset();
          syncFormFromPrefs(branding.load());
          if (res && res.ok) {
            setStatus('Брендинг сброшен на роутере');
            toast('Брендинг: сброшено');
          } else {
            setStatus('Сброшено локально (ошибка сброса на роутере): ' + (res && res.error ? res.error : 'error'), true);
            toast('Сброшено локально (ошибка)', true);
          }
        } catch (e) {
          setStatus('Reset failed: ' + (e && e.message ? e.message : String(e)), true);
        }
      });
    }

    // Enter-to-save for title
    if (titleEl) {
      titleEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && saveBtn) {
          e.preventDefault();
          saveBtn.click();
        }
      });
    }
  }

  Feature.init = function init() {
    if (!byId('dt-branding-card')) return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => { wire(); });
    } else {
      wire();
    }
  };

  XK.features.brandingPrefs = Feature;

  try { Feature.init(); } catch (e) {}
})();
