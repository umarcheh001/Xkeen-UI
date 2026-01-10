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

  function _mkThemeField(prefix, fid, label, value, onChange, hint, opts) {
    try {
      if (SH && typeof SH.mkThemeField === "function") {
        return SH.mkThemeField(prefix, fid, label, value, onChange, hint, opts);
      }
    } catch (e) {}
    const fallback = document.createElement("div");
    fallback.className = "dt-theme-field";
    fallback.textContent = String(label || "");
    return fallback;
  }


  // ------------------------- CodeMirror Theme editor -------------------------

  let _cmCfg = null;
  let _cmMeta = { enabled: false, exists: false, version: 0 };
  let _cmSelected = 'dark';

  const _CM_BASE_FIELDS_UI = [
    { id: 'background', key: 'background', label: 'background' },
    { id: 'text', key: 'text', label: 'text' },
    { id: 'gutter_bg', key: 'gutter_bg', label: 'gutter_bg' },
    { id: 'gutter_text', key: 'gutter_text', label: 'gutter_text' },
    { id: 'cursor', key: 'cursor', label: 'cursor' },
    { id: 'selection', key: 'selection', label: 'selection' },
    { id: 'selection_text', key: 'selection_text', label: 'selection text' },
    { id: 'active_line', key: 'active_line', label: 'active_line' },
    { id: 'search_match', key: 'search_match', label: 'search match' },
    { id: 'ruler', key: 'ruler', label: 'ruler' },
    { id: 'indent_guide', key: 'indent_guide', label: 'indent guide' },
    { id: 'trailingspace', key: 'trailingspace', label: 'trailing space' },
    { id: 'lint_tooltip_bg', key: 'lint_tooltip_bg', label: 'lint tooltip bg' },
    { id: 'lint_tooltip_text', key: 'lint_tooltip_text', label: 'lint tooltip text' },
    { id: 'lint_tooltip_border', key: 'lint_tooltip_border', label: 'lint tooltip border' },
    { id: 'lint_error_line', key: 'lint_error_line', label: 'lint error line' },
    { id: 'lint_warning_line', key: 'lint_warning_line', label: 'lint warning line' },
    { id: 'bracket_bg', key: 'bracket_bg', label: 'matching bracket bg' },
    { id: 'bracket_border', key: 'bracket_border', label: 'matching bracket border' },
    { id: 'bad_bracket_bg', key: 'bad_bracket_bg', label: 'non-matching bracket bg' },
    { id: 'bad_bracket_border', key: 'bad_bracket_border', label: 'non-matching bracket border' },
    { id: 'dialog_bg', key: 'dialog_bg', label: 'dialog bg' },
    { id: 'dialog_text', key: 'dialog_text', label: 'dialog text' },
    { id: 'dialog_border', key: 'dialog_border', label: 'dialog border' },
    { id: 'dialog_input_bg', key: 'dialog_input_bg', label: 'dialog input bg' },
    { id: 'dialog_input_text', key: 'dialog_input_text', label: 'dialog input text' },
    { id: 'dialog_btn_bg', key: 'dialog_btn_bg', label: 'dialog button bg' },
    { id: 'dialog_btn_text', key: 'dialog_btn_text', label: 'dialog button text' },
    { id: 'dialog_btn_border', key: 'dialog_btn_border', label: 'dialog button border' },
  ];

  const _CM_ALPHA_KEYS = new Set([
    'selection', 'active_line', 'search_match',
    'indent_guide', 'trailingspace',
    'lint_error_line', 'lint_warning_line',
    'bracket_bg', 'bad_bracket_bg'
  ]);

  const _CM_FIELD_HINTS = {
    background: 'Фон редактора (CodeMirror).',
    text: 'Цвет основного текста.',
    gutter_bg: 'Фон gutter (нумерация строк).',
    gutter_text: 'Цвет текста в gutter (нумерация строк).',
    cursor: 'Цвет курсора.',
    selection: 'Фон выделения текста.',
    selection_text: 'Цвет текста в выделении (используется для ::selection и CodeMirror-selectedtext).',
    active_line: 'Подсветка активной строки.',
    search_match: 'Подсветка совпадений поиска (.cm-searching).',
    ruler: 'Цвет вертикальных линеек (rulers).',
    indent_guide: 'Цвет вертикальных направляющих отступов (indent guides).',
    trailingspace: 'Подсветка хвостовых пробелов (trailing spaces).',
    lint_tooltip_bg: 'Lint: фон тултипа (CodeMirror-lint-tooltip).',
    lint_tooltip_text: 'Lint: текст тултипа.',
    lint_tooltip_border: 'Lint: граница тултипа.',
    lint_error_line: 'Lint: подсветка строки ошибки (background).',
    lint_warning_line: 'Lint: подсветка строки предупреждения (background).',
    bracket_bg: 'Фон подсветки парных скобок.',
    bracket_border: 'Граница подсветки парных скобок.',
    bad_bracket_bg: 'Фон подсветки непарных/ошибочных скобок.',
    bad_bracket_border: 'Граница подсветки непарных/ошибочных скобок.',
    dialog_bg: 'Фон диалогов CodeMirror (Find/Replace и т.п.).',
    dialog_text: 'Текст в диалогах CodeMirror.',
    dialog_border: 'Граница диалогов CodeMirror.',
    dialog_input_bg: 'Фон инпутов в диалогах CodeMirror.',
    dialog_input_text: 'Текст в инпутах диалогов CodeMirror.',
    dialog_btn_bg: 'Фон кнопок в диалогах CodeMirror.',
    dialog_btn_text: 'Текст кнопок в диалогах CodeMirror.',
    dialog_btn_border: 'Граница кнопок в диалогах CodeMirror.'
  };

  const _CM_TOKEN_FIELDS_UI = [
    'keyword','string','number','comment','atom','def','variable','variable2','builtin','meta','tag','attribute','error',
    'property','operator','qualifier','bracket','link','header'
  ];

  const _CM_TOKEN_HINTS = {
    keyword: 'Подсветка синтаксиса: ключевые слова (keyword).',
    string: 'Подсветка синтаксиса: строки (string).',
    number: 'Подсветка синтаксиса: числа (number).',
    comment: 'Подсветка синтаксиса: комментарии (comment).',
    atom: 'Подсветка синтаксиса: atom/литералы (atom).',
    def: 'Подсветка синтаксиса: определения (def).',
    variable: 'Подсветка синтаксиса: переменные (variable).',
    variable2: 'Подсветка синтаксиса: переменные 2 (variable2).',
    builtin: 'Подсветка синтаксиса: встроенные (builtin).',
    meta: 'Подсветка синтаксиса: meta (meta).',
    tag: 'Подсветка синтаксиса: теги (tag).',
    attribute: 'Подсветка синтаксиса: атрибуты (attribute).',
    error: 'Подсветка синтаксиса: ошибки (error).',
    property: 'Подсветка синтаксиса: свойства (property).',
    operator: 'Подсветка синтаксиса: операторы (operator).',
    qualifier: 'Подсветка синтаксиса: qualifier (qualifier).',
    bracket: 'Подсветка синтаксиса: скобки (bracket).',
    link: 'Подсветка синтаксиса: ссылки (link).',
    header: 'Подсветка синтаксиса: заголовки (header).'
  };

  function _setCodeMirrorThemeLinkVersion(version) {
    const link = document.getElementById('xk-codemirror-theme-link');
    if (!link) return;
    try {
      const u = new URL(link.getAttribute('href') || link.href || '', window.location.href);
      u.searchParams.set('v', String(version || 0));
      link.href = u.toString();
    } catch (e) {}
  }

  function _cmStatus(text, isErr) {
    const el = byId('dt-cm-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.style.color = isErr ? 'var(--sem-error, #fca5a5)' : '';
  }

  function _renderCmMeta(meta) {
    const el = byId('dt-cm-meta');
    if (!el) return;
    const m = meta || _cmMeta || {};
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

  function _cmSetSelected(mode) {
    const t = (mode === 'light') ? 'light' : 'dark';
    _cmSelected = t;

    const bDark = byId('dt-cm-target-dark');
    const bLight = byId('dt-cm-target-light');
    if (bDark) {
      bDark.classList.toggle('active', t === 'dark');
      bDark.setAttribute('aria-selected', t === 'dark' ? 'true' : 'false');
    }
    if (bLight) {
      bLight.classList.toggle('active', t === 'light');
      bLight.setAttribute('aria-selected', t === 'light' ? 'true' : 'false');
    }

    // Re-render to keep optional alpha controls in sync
    _cmRenderFields();
    _cmSyncUiFromState();
  }

  function _cmUpdateValue(key, val) {
    if (!_cmCfg) return;
    if (!_cmCfg[_cmSelected]) _cmCfg[_cmSelected] = {};
    _cmCfg[_cmSelected][key] = String(val || '').trim();
  }

  function _cmUpdateToken(key, val) {
    if (!_cmCfg) return;
    if (!_cmCfg[_cmSelected]) _cmCfg[_cmSelected] = {};
    if (!_cmCfg[_cmSelected].tokens) _cmCfg[_cmSelected].tokens = {};
    _cmCfg[_cmSelected].tokens[key] = String(val || '').trim();
  }

  function _cmSyncUiFromState() {
    const enabledEl = byId('dt-cm-enabled');
    if (enabledEl && _cmCfg) {
      try { enabledEl.checked = !!_cmCfg.enabled; } catch (e) {}
    }

    const t = (_cmCfg && _cmCfg[_cmSelected]) ? _cmCfg[_cmSelected] : {};
    const tok = (t && t.tokens) ? t.tokens : {};

    for (const f of _CM_BASE_FIELDS_UI) {
      const c = byId(`dt-cm-${f.id}-color`);
      const tx = byId(`dt-cm-${f.id}-text`);
      const v = t[f.key];
      if (c) { try { c.value = _toColorPickerValue(v); } catch (e) {} }
      if (tx) { try { tx.value = String(v || ''); } catch (e2) {} }
    }

    for (const k of _CM_TOKEN_FIELDS_UI) {
      const c = byId(`dt-cm-tok-${k}-color`);
      const tx = byId(`dt-cm-tok-${k}-text`);
      const v = tok[k];
      if (c) { try { c.value = _toColorPickerValue(v); } catch (e) {} }
      if (tx) { try { tx.value = String(v || ''); } catch (e2) {} }
    }
  }

  function _cmRenderFields() {
    const host = byId('dt-cm-fields');
    if (!host) return;
    host.innerHTML = '';

    const baseTitle = document.createElement('div');
    baseTitle.style.opacity = '0.85';
    baseTitle.textContent = 'Surfaces';
    host.appendChild(baseTitle);

    const baseGrid = document.createElement('div');
    baseGrid.className = 'dt-theme-grid';
    baseGrid.style.marginTop = '8px';

    for (const f of _CM_BASE_FIELDS_UI) {
      const t = (_cmCfg && _cmCfg[_cmSelected]) ? _cmCfg[_cmSelected] : {};
      const alpha = _CM_ALPHA_KEYS.has(f.key);
      baseGrid.appendChild(
        _mkThemeField('dt-cm', f.id, f.label, t[f.key], (v) => _cmUpdateValue(f.key, v), _CM_FIELD_HINTS[f.key], alpha ? { alpha: true } : null)
      );
    }
    host.appendChild(baseGrid);

    const tokTitle = document.createElement('div');
    tokTitle.style.marginTop = '12px';
    tokTitle.style.opacity = '0.85';
    tokTitle.textContent = 'Tokens';
    host.appendChild(tokTitle);

    const tokGrid = document.createElement('div');
    tokGrid.className = 'dt-theme-grid';
    tokGrid.style.marginTop = '8px';

    for (const k of _CM_TOKEN_FIELDS_UI) {
      const t = (_cmCfg && _cmCfg[_cmSelected]) ? _cmCfg[_cmSelected] : {};
      const tok = (t && t.tokens) ? t.tokens : {};
      tokGrid.appendChild(
        _mkThemeField('dt-cm-tok', k, k, tok[k], (v) => _cmUpdateToken(k, v), _CM_TOKEN_HINTS[k])
      );
    }
    host.appendChild(tokGrid);
  }

  async function _cmLoadFromServer() {
    try {
      const resp = await getJSON('/api/devtools/codemirror_theme');
      if (!resp || !resp.config) {
        _cmStatus('Не удалось загрузить конфиг.', true);
        return;
      }
      _cmCfg = resp.config;
      _cmMeta = resp;
      _renderCmMeta(resp);
      _cmRenderFields();
      _cmSyncUiFromState();
      _cmStatus(resp.exists ? `Загружено (v=${resp.version || 0}).` : 'Загружено (empty).', false);
    } catch (e) {
      _cmStatus('Ошибка загрузки: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function _cmSaveToServer() {
    if (!_cmCfg) return;
    try {
      const resp = await postJSON('/api/devtools/codemirror_theme', { config: _cmCfg });
      if (!resp || !resp.config) {
        _cmStatus('Save: invalid response', true);
        return;
      }
      _cmCfg = resp.config;
      _cmMeta = resp;
      _renderCmMeta(resp);
      _setCodeMirrorThemeLinkVersion(resp.version || Math.floor(Date.now() / 1000));
      try { document.dispatchEvent(new CustomEvent('xkeen-theme-change')); } catch (e2) {}
      _cmStatus(`Сохранено (v=${resp.version || 0}).`, false);
    } catch (e) {
      _cmStatus('Ошибка сохранения: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  async function _cmResetOnServer() {
    try {
      const resp = await postJSON('/api/devtools/codemirror_theme/reset', {});
      if (!resp || !resp.config) {
        _cmStatus('Reset: invalid response', true);
        return;
      }
      _cmCfg = resp.config;
      _cmMeta = resp;
      _renderCmMeta(resp);
      _setCodeMirrorThemeLinkVersion(resp.version || Math.floor(Date.now() / 1000));
      try { document.dispatchEvent(new CustomEvent('xkeen-theme-change')); } catch (e2) {}
      _cmRenderFields();
      _cmSyncUiFromState();
      _cmStatus('Сброшено.', false);
    } catch (e) {
      _cmStatus('Ошибка сброса: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  function _wireCodeMirrorThemeEditor() {
    const card = byId('dt-codemirror-theme-card');
    if (!card) return;

    const bDark = byId('dt-cm-target-dark');
    const bLight = byId('dt-cm-target-light');
    if (bDark) bDark.addEventListener('click', () => _cmSetSelected('dark'));
    if (bLight) bLight.addEventListener('click', () => _cmSetSelected('light'));

    const enabledEl = byId('dt-cm-enabled');
    if (enabledEl) {
      enabledEl.addEventListener('change', () => {
        if (!_cmCfg) return;
        _cmCfg.enabled = !!enabledEl.checked;
      });
    }

    const save = byId('dt-cm-save');
    if (save) save.addEventListener('click', () => _cmSaveToServer());

    const reset = byId('dt-cm-reset');
    if (reset) reset.addEventListener('click', () => _cmResetOnServer());

    _cmSetSelected('dark');
    _cmLoadFromServer();
  }


  function init() {
    try { _wireCodeMirrorThemeEditor(); } catch (e) {}
  }

  XK.features.devtoolsCodeMirrorTheme = { init };
})();
