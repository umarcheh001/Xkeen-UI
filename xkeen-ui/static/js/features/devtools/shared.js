(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};
  const api = XK.features.devtoolsShared = XK.features.devtoolsShared || {};

  function toast(msg, isError) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(msg, !!isError);
      if (XK.ui && typeof XK.ui.showToast === 'function') return XK.ui.showToast(msg, !!isError);
      console.log(msg);
    } catch (e) {}
  }

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return data;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = (data && data.error) ? String(data.error) : ('HTTP ' + res.status);
      throw new Error(err);
    }
    return data;
  }

  function byId(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function escapeHtml(s) {
    try {
      if (window.XKeen && window.XKeen.util && typeof window.XKeen.util.escapeHtml === 'function') {
        return window.XKeen.util.escapeHtml(String(s || ''));
      }
    } catch (e) {}
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ANSI -> HTML formatter (reuses shared util when available)
  function ansiToHtml(text) {
    try {
      if (window.XKeen && window.XKeen.util && typeof window.XKeen.util.ansiToHtml === 'function') {
        return window.XKeen.util.ansiToHtml(String(text || ''));
      }
    } catch (e) {}
    return escapeHtml(text || '');
  }

  function fallbackCopyText(text, okMsg, errMsg) {
    const ta = document.createElement('textarea');
    ta.value = String(text || '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand('copy');
      toast(okMsg || 'Скопировано');
    } catch (e) {
      toast(errMsg || 'Не удалось скопировать', true);
    }
    try { ta.remove(); } catch (e) {}
  }

  function formatBytes(n) {
    try {
      const v = Math.max(0, Number(n || 0));
      if (v < 1024) return v.toFixed(0) + ' B';
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
      if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
      return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    } catch (e) {
      return '0 B';
    }
  }

  function formatAgeRu(mtime) {
    try {
      const t = Number(mtime || 0);
      if (!t || t <= 0) return 'обновлён —';
      const now = Date.now() / 1000;
      let d = Math.max(0, now - t);
      if (d < 60) return 'обновлён ' + Math.floor(d) + 'с назад';
      d = d / 60;
      if (d < 60) return 'обновлён ' + Math.floor(d) + 'м назад';
      d = d / 60;
      if (d < 48) return 'обновлён ' + Math.floor(d) + 'ч назад';
      d = d / 24;
      return 'обновлён ' + Math.floor(d) + 'д назад';
    } catch (e) {
      return 'обновлён —';
    }
  }

  function isHexColor(s) {
    if (!s) return false;
    const v = String(s).trim();
    return /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/.test(v);
  }

  function expandShortHex(v) {
    const s = String(v || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    }
    return s.toLowerCase();
  }

  function toColorPickerValue(v) {
    // <input type=color> expects #RRGGBB. Drop alpha if present.
    if (!isHexColor(v)) return '#000000';
    let s = expandShortHex(v);
    if (s.length === 9) s = s.slice(0, 7);
    if (s.length !== 7) return '#000000';
    return s;
  }

  function parseHexWithAlpha(v) {
    const s = String(v || '').trim();
    if (/^#[0-9a-fA-F]{3}$/.test(s)) {
      return { hex6: expandShortHex(s), a: 255, hasAlpha: false };
    }
    if (/^#[0-9a-fA-F]{6}$/.test(s)) {
      return { hex6: s.toLowerCase(), a: 255, hasAlpha: false };
    }
    if (/^#[0-9a-fA-F]{8}$/.test(s)) {
      return { hex6: s.slice(0, 7).toLowerCase(), a: parseInt(s.slice(7, 9), 16), hasAlpha: true };
    }
    return null;
  }

  function hex8(hex6, a) {
    const to2 = (n) => {
      const x = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
      const h = x.toString(16);
      return (h.length === 1) ? ('0' + h) : h;
    };
    const base = String(hex6 || '').trim();
    const h6 = (/^#[0-9a-fA-F]{6}$/.test(base) ? base : '#000000').toLowerCase();
    return h6 + to2(a);
  }

  function mkThemeField(prefix, fid, label, value, onChange, hint, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'dt-theme-field';

    const name = document.createElement('div');
    name.className = 'dt-theme-name';
    name.textContent = label;

    const _hint = String(hint || '').trim();
    if (_hint) name.title = _hint;
    wrap.appendChild(name);

    const inputs = document.createElement('div');
    inputs.className = 'dt-theme-inputs';

    const c = document.createElement('input');
    c.type = 'color';
    c.className = 'dt-theme-color';
    c.id = `${prefix}-${fid}-color`;

    const tx = document.createElement('input');
    tx.type = 'text';
    tx.className = 'dt-pill-field';
    tx.id = `${prefix}-${fid}-text`;
    tx.placeholder = '#RRGGBB or #RRGGBBAA';

    if (_hint) {
      c.title = _hint;
      tx.title = _hint;
    }

    const wantAlpha = !!((opts && opts.alpha) || (/^#[0-9a-fA-F]{8}$/.test(String(value || '').trim())));

    const parsed0 = parseHexWithAlpha(value) || { hex6: '#000000', a: 255, hasAlpha: false };
    let aByte = parsed0.a;

    try { c.value = toColorPickerValue(parsed0.hex6); } catch (e) { c.value = '#000000'; }
    try {
      if (wantAlpha) tx.value = hex8(toColorPickerValue(parsed0.hex6), aByte);
      else tx.value = String(value || '');
    } catch (e2) { tx.value = ''; }

    let alphaRange = null;
    let alphaVal = null;

    const syncAlphaUi = () => {
      if (!wantAlpha || !alphaRange) return;
      const pct = Math.max(0, Math.min(100, Math.round((aByte / 255) * 100)));
      try { alphaRange.value = String(pct); } catch (e) {}
      if (alphaVal) alphaVal.textContent = String(pct) + '%';
    };

    const commit = (hex6, a) => {
      const h6 = toColorPickerValue(hex6);
      aByte = Math.max(0, Math.min(255, Math.round(Number(a))));
      try { c.value = h6; } catch (e) {}
      try { tx.value = wantAlpha ? hex8(h6, aByte) : String(hex6 || '').trim(); } catch (e2) {}
      syncAlphaUi();
      try { onChange(String(tx.value || '').trim()); } catch (e3) {}
    };

    c.addEventListener('input', () => {
      commit(c.value, aByte);
    });

    tx.addEventListener('change', () => {
      const v = String(tx.value || '').trim();
      try { onChange(v); } catch (e) {}
      const p = parseHexWithAlpha(v);
      if (p) {
        aByte = p.a;
        try { c.value = toColorPickerValue(p.hex6); } catch (e2) {}
        syncAlphaUi();
      }
    });

    inputs.appendChild(c);
    inputs.appendChild(tx);
    wrap.appendChild(inputs);

    if (wantAlpha) {
      const a = document.createElement('div');
      a.className = 'dt-theme-alpha';

      const n = document.createElement('div');
      n.className = 'dt-theme-alpha-name';
      n.textContent = 'Opacity';

      alphaRange = document.createElement('input');
      alphaRange.type = 'range';
      alphaRange.min = '0';
      alphaRange.max = '100';
      alphaRange.step = '1';

      alphaVal = document.createElement('div');
      alphaVal.className = 'dt-theme-alpha-val';

      alphaRange.addEventListener('input', () => {
        const pct = Math.max(0, Math.min(100, parseInt(alphaRange.value, 10) || 0));
        aByte = Math.round((pct / 100) * 255);
        try { tx.value = hex8(c.value, aByte); } catch (e) {}
        if (alphaVal) alphaVal.textContent = String(pct) + '%';
        try { onChange(String(tx.value || '').trim()); } catch (e2) {}
      });

      a.appendChild(n);
      a.appendChild(alphaRange);
      a.appendChild(alphaVal);
      wrap.appendChild(a);
      syncAlphaUi();
    }

    return wrap;
  }

  api.toast = toast;
  api.getJSON = getJSON;
  api.postJSON = postJSON;
  api.byId = byId;
  api.escapeHtml = escapeHtml;
  api.ansiToHtml = ansiToHtml;
  api.fallbackCopyText = fallbackCopyText;
  api.formatBytes = formatBytes;
  api.formatAgeRu = formatAgeRu;
  api.toColorPickerValue = toColorPickerValue;
  api.parseHexWithAlpha = parseHexWithAlpha;
  api.hex8 = hex8;
  api.mkThemeField = mkThemeField; 
})();
