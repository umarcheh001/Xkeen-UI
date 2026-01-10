(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });


  function _formatAgeRu(mtime) {
    try { if (SH && typeof SH.formatAgeRu === "function") return SH.formatAgeRu(mtime); } catch (e) {}
    return "обновлён —";
  }

  function _toColorPickerValue(v) {
    try { if (SH && typeof SH.toColorPickerValue === "function") return SH.toColorPickerValue(v); } catch (e) {}
    return "#000000";
  }

  function _parseHexWithAlpha(v) {
    try { if (SH && typeof SH.parseHexWithAlpha === "function") return SH.parseHexWithAlpha(v); } catch (e) {}
    return null;
  }

  function _hex8(hex6, a) {
    try { if (SH && typeof SH.hex8 === "function") return SH.hex8(hex6, a); } catch (e) {}
    return "#000000ff";
  }


  // ------------------------- Terminal Theme editor (xterm.js) -------------------------

  let _termCfg = null;
  let _termMeta = { enabled: false, exists: false, version: 0 };
  let _termSelected = 'dark';

  const _TERM_BASE_FIELDS = [
    { id: 'background', key: 'background', label: 'background' },
    { id: 'foreground', key: 'foreground', label: 'foreground' },
    { id: 'cursor', key: 'cursor', label: 'cursor' },
    { id: 'cursor_accent', key: 'cursor_accent', label: 'cursor_accent' },
    { id: 'cursor_blink', key: 'cursor_blink', label: 'cursor_blink (cursorBlink=true)' },
    { id: 'cursor_blink_accent', key: 'cursor_blink_accent', label: 'cursor_blink_accent' },
    { id: 'selection', key: 'selection', label: 'selection (bg)' },
    { id: 'selection_foreground', key: 'selection_foreground', label: 'selection (text)' },
    { id: 'scrollbar_track', key: 'scrollbar_track', label: 'scrollbar_track' },
    { id: 'scrollbar_thumb', key: 'scrollbar_thumb', label: 'scrollbar_thumb' },
    { id: 'scrollbar_thumb_hover', key: 'scrollbar_thumb_hover', label: 'scrollbar_thumb_hover' },
  ];

  const _TERM_FIELD_HINTS = {
    background: 'Фон терминала.',
    foreground: 'Цвет текста (по умолчанию).',
    cursor: 'Цвет курсора.',
    cursor_accent: 'Цвет текста под курсором (акцент).',
    cursor_blink: 'Цвет курсора при cursorBlink=true.',
    cursor_blink_accent: 'Цвет текста под мигающим курсором (акцент).',
    selection: 'Фон выделения (selection).',
    selection_foreground: 'Цвет текста выделения (selectionForeground).',
    scrollbar_track: 'Фон трека скроллбара.',
    scrollbar_thumb: 'Цвет ползунка скроллбара.',
    scrollbar_thumb_hover: 'Цвет ползунка при наведении.'
  };

  const _TERM_PALETTE_FIELDS = [
    { id: 'black', key: 'black', label: 'black' },
    { id: 'red', key: 'red', label: 'red' },
    { id: 'green', key: 'green', label: 'green' },
    { id: 'yellow', key: 'yellow', label: 'yellow' },
    { id: 'blue', key: 'blue', label: 'blue' },
    { id: 'magenta', key: 'magenta', label: 'magenta' },
    { id: 'cyan', key: 'cyan', label: 'cyan' },
    { id: 'white', key: 'white', label: 'white' },

    { id: 'brightBlack', key: 'brightBlack', label: 'brightBlack' },
    { id: 'brightRed', key: 'brightRed', label: 'brightRed' },
    { id: 'brightGreen', key: 'brightGreen', label: 'brightGreen' },
    { id: 'brightYellow', key: 'brightYellow', label: 'brightYellow' },
    { id: 'brightBlue', key: 'brightBlue', label: 'brightBlue' },
    { id: 'brightMagenta', key: 'brightMagenta', label: 'brightMagenta' },
    { id: 'brightCyan', key: 'brightCyan', label: 'brightCyan' },
    { id: 'brightWhite', key: 'brightWhite', label: 'brightWhite' },
  ];

  const _TERM_PALETTE_HINTS = {
    black: 'ANSI цвет 0 (black).',
    red: 'ANSI цвет 1 (red).',
    green: 'ANSI цвет 2 (green).',
    yellow: 'ANSI цвет 3 (yellow).',
    blue: 'ANSI цвет 4 (blue).',
    magenta: 'ANSI цвет 5 (magenta).',
    cyan: 'ANSI цвет 6 (cyan).',
    white: 'ANSI цвет 7 (white).',
    brightBlack: 'ANSI цвет 8 (bright black).',
    brightRed: 'ANSI цвет 9 (bright red).',
    brightGreen: 'ANSI цвет 10 (bright green).',
    brightYellow: 'ANSI цвет 11 (bright yellow).',
    brightBlue: 'ANSI цвет 12 (bright blue).',
    brightMagenta: 'ANSI цвет 13 (bright magenta).',
    brightCyan: 'ANSI цвет 14 (bright cyan).',
    brightWhite: 'ANSI цвет 15 (bright white).'
  };

  function _setTerminalThemeLinkVersion(version) {
    const link = document.getElementById('xk-terminal-theme-link');
    if (!link) return;
    try {
      const u = new URL(link.getAttribute('href') || link.href || '', window.location.href);
      u.searchParams.set('v', String(version || 0));
      link.href = u.toString();
    } catch (e) {}
  }

  function _termStatus(text, isErr) {
    const el = byId('dt-term-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.style.color = isErr ? 'var(--sem-error, #fca5a5)' : '';
  }

  function _renderTermMeta(meta) {
    const el = byId('dt-term-meta');
    if (!el) return;
    const m = meta || _termMeta || {};
    const enabled = !!(m.config ? m.config.enabled : m.enabled);
    const exists = !!m.exists;
    const v = Number(m.version || 0);
    const age = _formatAgeRu(v);

    const badge = `<span class="dt-custom-css-badge ${enabled ? 'is-on' : 'is-off'}">${enabled ? '● Enabled' : '● Disabled'}</span>`;
    const parts = [];
    parts.push(badge);
    parts.push(exists ? 'file: ok' : 'empty');
    if (v) parts.push(age);
    try {
      el.innerHTML = parts.join(' &nbsp;•&nbsp; ');
    } catch (e) {
      el.textContent = `${enabled ? 'Enabled' : 'Disabled'} • ${exists ? 'file: ok' : 'empty'}${v ? ' • ' + age : ''}`;
    }
  }

  function _termSetSelected(mode) {
    const t = (mode === 'light') ? 'light' : 'dark';
    _termSelected = t;

    const bDark = byId('dt-term-target-dark');
    const bLight = byId('dt-term-target-light');
    if (bDark) {
      bDark.classList.toggle('active', t === 'dark');
      bDark.setAttribute('aria-selected', t === 'dark' ? 'true' : 'false');
    }
    if (bLight) {
      bLight.classList.toggle('active', t === 'light');
      bLight.setAttribute('aria-selected', t === 'light' ? 'true' : 'false');
    }

    // Re-render to keep optional alpha controls in sync
    _termRenderFields();
    _termSyncUiFromState();
  }

  function _termUpdateValue(key, val) {
    if (!_termCfg) return;
    if (!_termCfg[_termSelected]) _termCfg[_termSelected] = {};
    _termCfg[_termSelected][key] = String(val || '').trim();
  }

  function _termUpdatePaletteValue(key, val) {
    if (!_termCfg) return;
    if (!_termCfg[_termSelected]) _termCfg[_termSelected] = {};
    if (!_termCfg[_termSelected].palette) _termCfg[_termSelected].palette = {};
    _termCfg[_termSelected].palette[key] = String(val || '').trim();
  }

  function _mkThemeField(prefix, fid, label, value, onChange, hint, opts) {
    const wrap = document.createElement('div');
    wrap.className = 'dt-theme-field';

    const name = document.createElement('div');
    name.className = 'dt-theme-name';
    name.textContent = label;
    const _hint = String(hint || '').trim();
    if (_hint) {
      // Native tooltip (same approach as in the global Theme/CSS blocks)
      name.title = _hint;
    }
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

    const parsed0 = _parseHexWithAlpha(value) || { hex6: '#000000', a: 255, hasAlpha: false };
    let aByte = parsed0.a;

    try { c.value = _toColorPickerValue(parsed0.hex6); } catch (e) { c.value = '#000000'; }
    try { tx.value = wantAlpha ? _hex8(parsed0.hex6, aByte) : String(value || ''); } catch (e2) { tx.value = ''; }

    let alphaRange = null;
    let alphaVal = null;

    const syncAlphaUi = () => {
      if (!wantAlpha || !alphaRange) return;
      const pct = Math.max(0, Math.min(100, Math.round((aByte / 255) * 100)));
      try { alphaRange.value = String(pct); } catch (e) {}
      if (alphaVal) alphaVal.textContent = String(pct) + '%';
    };

    const commit = (hex6, a) => {
      const h6 = _toColorPickerValue(hex6);
      aByte = Math.max(0, Math.min(255, Math.round(Number(a))));
      try { c.value = h6; } catch (e) {}
      try { tx.value = wantAlpha ? _hex8(h6, aByte) : String(hex6 || '').trim(); } catch (e2) {}
      syncAlphaUi();
      try { onChange(String(tx.value || '').trim()); } catch (e3) {}
    };

    c.addEventListener('input', () => {
      commit(c.value, aByte);
    });

    tx.addEventListener('change', () => {
      const v = String(tx.value || '').trim();
      try { onChange(v); } catch (e) {}
      const p = _parseHexWithAlpha(v);
      if (p) {
        aByte = p.a;
        try { c.value = _toColorPickerValue(p.hex6); } catch (e2) {}
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
        try { tx.value = _hex8(c.value, aByte); } catch (e) {}
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

  function _termSyncUiFromState() {
    const enabledEl = byId('dt-term-enabled');
    if (enabledEl && _termCfg) {
      try { enabledEl.checked = !!_termCfg.enabled; } catch (e) {}
    }

    const t = (_termCfg && _termCfg[_termSelected]) ? _termCfg[_termSelected] : {};
    const pal = (t && t.palette) ? t.palette : {};

    // base
    for (const f of _TERM_BASE_FIELDS) {
      const c = byId(`dt-term-${f.id}-color`);
      const tx = byId(`dt-term-${f.id}-text`);
      const v = t[f.key];
      if (c) { try { c.value = _toColorPickerValue(v); } catch (e) {} }
      if (tx) { try { tx.value = String(v || ''); } catch (e2) {} }
    }

    // palette
    for (const f of _TERM_PALETTE_FIELDS) {
      const c = byId(`dt-term-pal-${f.id}-color`);
      const tx = byId(`dt-term-pal-${f.id}-text`);
      const v = pal[f.key];
      if (c) { try { c.value = _toColorPickerValue(v); } catch (e) {} }
      if (tx) { try { tx.value = String(v || ''); } catch (e2) {} }
    }
  }

  function _termRenderFields() {
    const host = byId('dt-term-fields');
    if (!host) return;
    host.innerHTML = '';

    const baseGrid = document.createElement('div');
    baseGrid.className = 'dt-theme-grid';

    for (const f of _TERM_BASE_FIELDS) {
      const t = (_termCfg && _termCfg[_termSelected]) ? _termCfg[_termSelected] : {};
      const alpha = (f.key === 'selection' || f.key === 'scrollbar_track' || f.key === 'scrollbar_thumb' || f.key === 'scrollbar_thumb_hover');
      baseGrid.appendChild(
        _mkThemeField('dt-term', f.id, f.label, t[f.key], (v) => _termUpdateValue(f.key, v), _TERM_FIELD_HINTS[f.key], alpha ? { alpha: true } : null)
      );
    }

    host.appendChild(baseGrid);

    const sep = document.createElement('div');
    sep.style.marginTop = '12px';
    sep.style.opacity = '0.85';
    sep.textContent = 'ANSI palette (16 colors)';
    host.appendChild(sep);

    const palGrid = document.createElement('div');
    palGrid.className = 'dt-theme-grid';
    palGrid.style.marginTop = '8px';

    for (const f of _TERM_PALETTE_FIELDS) {
      const t = (_termCfg && _termCfg[_termSelected]) ? _termCfg[_termSelected] : {};
      const pal = (t && t.palette) ? t.palette : {};
      palGrid.appendChild(
        _mkThemeField('dt-term-pal', f.id, f.label, pal[f.key], (v) => _termUpdatePaletteValue(f.key, v), _TERM_PALETTE_HINTS[f.key])
      );
    }
    host.appendChild(palGrid);
  }

  async function _termLoadFromServer() {
    try {
      const resp = await getJSON('/api/devtools/terminal_theme');
      if (!resp || !resp.config) {
        _termStatus('Не удалось загрузить конфиг.', true);
        return;
      }
      _termCfg = resp.config;
      _termMeta = resp;
      _renderTermMeta(resp);
      _termRenderFields();
      _termSyncUiFromState();
      _termStatus(resp.exists ? `Загружено (v=${resp.version || 0}).` : 'Загружено (empty).', false);
    } catch (e) {
      _termStatus('Ошибка загрузки: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function _termSaveToServer() {
    if (!_termCfg) return;
    try {
      const resp = await postJSON('/api/devtools/terminal_theme', { config: _termCfg });
      if (!resp || !resp.config) {
        _termStatus('Save: invalid response', true);
        return;
      }
      _termCfg = resp.config;
      _termMeta = resp;
      _renderTermMeta(resp);
      _setTerminalThemeLinkVersion(resp.version || Math.floor(Date.now() / 1000));
      try { document.dispatchEvent(new CustomEvent('xkeen-theme-change')); } catch (e2) {}
      _termStatus(`Сохранено (v=${resp.version || 0}).`, false);
    } catch (e) {
      _termStatus('Ошибка сохранения: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function _termResetOnServer() {
    try {
      const resp = await postJSON('/api/devtools/terminal_theme/reset', {});
      if (!resp || !resp.config) {
        _termStatus('Reset: invalid response', true);
        return;
      }
      _termCfg = resp.config;
      _termMeta = resp;
      _renderTermMeta(resp);
      _setTerminalThemeLinkVersion(resp.version || Math.floor(Date.now() / 1000));
      try { document.dispatchEvent(new CustomEvent('xkeen-theme-change')); } catch (e2) {}
      _termRenderFields();
      _termSyncUiFromState();
      _termStatus('Сброшено.', false);
    } catch (e) {
      _termStatus('Ошибка сброса: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  function _wireTerminalThemeEditor() {
    const card = byId('dt-terminal-theme-card');
    if (!card) return;

    const bDark = byId('dt-term-target-dark');
    const bLight = byId('dt-term-target-light');
    if (bDark) bDark.addEventListener('click', () => _termSetSelected('dark'));
    if (bLight) bLight.addEventListener('click', () => _termSetSelected('light'));

    const enabledEl = byId('dt-term-enabled');
    if (enabledEl) {
      enabledEl.addEventListener('change', () => {
        if (!_termCfg) return;
        _termCfg.enabled = !!enabledEl.checked;
      });
    }

    const save = byId('dt-term-save');
    if (save) save.addEventListener('click', () => _termSaveToServer());

    const reset = byId('dt-term-reset');
    if (reset) reset.addEventListener('click', () => _termResetOnServer());

    _termSetSelected('dark');
    _termLoadFromServer();
  }



  function init() {
    try { _wireTerminalThemeEditor(); } catch (e) {}
  }

  XK.features.devtoolsTerminalTheme = { init };
})();
