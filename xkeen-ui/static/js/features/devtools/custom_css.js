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

  const confirmAction = SH.confirmAction || (async (opts) => {
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') return !!(await XKeen.ui.confirm(opts || {}));
    return !!window.confirm(String((opts && opts.message) || 'Продолжить?'));
  });
  const openModal = SH.openModal || ((modal, source) => {
    try { modal.classList.remove('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e2) {}
    } else {
      try { document.body.classList.add('modal-open'); } catch (e3) {}
    }
    return true;
  });
  const closeModal = SH.closeModal || ((modal, source) => {
    try { modal.classList.add('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e2) {}
    } else {
      try { document.body.classList.remove('modal-open'); } catch (e3) {}
    }
    return true;
  });

  function getEditorEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) { return null; }
  }

  function getEditorRuntime(engine) {
    const helper = getEditorEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEditorEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, opts || {});
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine);
    } catch (e) {}
    return null;
  }


  function _formatBytes(n) {
    try { if (SH && typeof SH.formatBytes === "function") return SH.formatBytes(n); } catch (e) {}
    return "0 B";
  }

  function _formatAgeRu(mtime) {
    try { if (SH && typeof SH.formatAgeRu === "function") return SH.formatAgeRu(mtime); } catch (e) {}
    return "обновлён —";
  }


// ------------------------- Custom CSS editor (global custom.css) -------------------------

  let _customCssEditor = null;
  let _customCssMeta = { enabled: false, exists: false, version: 0, size: 0, truncated: false, css: '' };
  let _customCssLoading = false;

  function _isSafeMode() {
    try {
      const sp = new URLSearchParams(window.location.search || '');
      const v = String(sp.get('safe') || '').trim().toLowerCase();
      return ['1', 'true', 'yes', 'on', 'y'].includes(v);
    } catch (e) {
      return false;
    }
  }

  function _renderCustomCssMeta(meta) {
    const el = byId('dt-custom-css-meta');
    if (!el) return;
    const m = meta || _customCssMeta || {};
    const enabled = !!m.enabled;
    const exists = !!m.exists;
    const v = Number(m.version || 0);
    const size = Number(m.size || 0);
    const age = _formatAgeRu(v);

    const badge = `<span class="dt-custom-css-badge ${enabled ? 'is-on' : 'is-off'}">${enabled ? '● Enabled' : '● Disabled'}</span>`;
    const parts = [];
    parts.push(badge);
    parts.push(exists ? ('size: ' + _formatBytes(size)) : 'empty');
    if (v) parts.push(age);
    if (m.truncated) parts.push('⚠️ показан не весь файл');
    try {
      el.innerHTML = parts.join(' &nbsp;•&nbsp; ');
    } catch (e) {
      el.textContent = `${enabled ? 'Enabled' : 'Disabled'} • ${exists ? _formatBytes(size) : 'empty'}${v ? ' • ' + age : ''}`;
    }
  }

  function _customCssStatus(text, isErr) {
    const el = byId('dt-custom-css-status');
    if (!el) return;
    el.textContent = String(text || '');
    el.style.color = isErr ? 'var(--sem-error, #fca5a5)' : '';
  }

  function _customCssGetValue() {
    try {
      if (_customCssEditor && typeof _customCssEditor.getValue === 'function') {
        return String(_customCssEditor.getValue() || '');
      }
    } catch (e) {}
    const ta = byId('dt-custom-css-textarea');
    return ta ? String(ta.value || '') : '';
  }

  function _customCssSetValue(text) {
    const v = String(text || '');
    try {
      if (_customCssEditor && typeof _customCssEditor.setValue === 'function') {
        _customCssEditor.setValue(v);
        return;
      }
    } catch (e) {}
    const ta = byId('dt-custom-css-textarea');
    if (ta) ta.value = v;
  }

  function _ensureCustomCssLink(version) {
    if (_isSafeMode()) return; // never auto-apply in safe mode
    try {
      let link = document.getElementById('xk-custom-css-link');
      const hrefBase = '/ui/custom.css';
      const v = Number(version || 0) || Math.floor(Date.now() / 1000);
      const href = hrefBase + '?v=' + encodeURIComponent(String(v));

      if (!link) {
        link = document.createElement('link');
        link.rel = 'stylesheet';
        link.id = 'xk-custom-css-link';
        link.href = href;
        document.head.appendChild(link);
        return;
      }

      // Replace href to bust cache.
      link.href = href;
    } catch (e) {}
  }

  function _removeCustomCssLink() {
    try {
      const link = document.getElementById('xk-custom-css-link');
      if (link && link.parentNode) link.parentNode.removeChild(link);
    } catch (e) {}
  }

  const CM6_SCOPE = 'devtools';

  function getCmTheme() {
    return (document.documentElement.getAttribute('data-theme') === 'light') ? 'default' : 'material-darker';
  }

  function getCodeMirrorRuntimeOptions(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function registerEditorForThemeSync(editor) {
    if (!editor) return;
    try {
      window.__xkeenEditors = window.__xkeenEditors || [];
      if (!window.__xkeenEditors.includes(editor)) window.__xkeenEditors.push(editor);
      document.dispatchEvent(new CustomEvent('xkeen-editors-ready'));
    } catch (e) {}
  }

  async function _ensureCustomCssEditor() {
    const ta = byId('dt-custom-css-textarea');
    if (!ta) return null;
    if (_customCssEditor) return _customCssEditor;

    try {
      const cmTheme = getCmTheme();
      const runtime = await ensureEditorRuntime('codemirror', getCodeMirrorRuntimeOptions({ theme: cmTheme }));
      if (!runtime || typeof runtime.create !== 'function') return null;
      _customCssEditor = runtime.create(ta, {
        mode: 'text/plain',
        lineWrapping: true,
        readOnly: false,
        theme: cmTheme,
        lint: false,
        links: false,
        onSave: () => _customCssSaveToServer(),
      });
      registerEditorForThemeSync(_customCssEditor);
      setTimeout(() => { try { if (_customCssEditor && _customCssEditor.refresh) _customCssEditor.refresh(); } catch (e) {} }, 0);
    } catch (e) {
      // Fallback to textarea when runtime is unavailable.
    }

    return _customCssEditor;
  }


  async function _customCssLoadFromServer() {
    if (_customCssLoading) return;
    _customCssLoading = true;
    try {
      const data = await getJSON('/api/devtools/custom_css');
      _customCssMeta = data || _customCssMeta;
      _customCssSetValue((_customCssMeta && typeof _customCssMeta.css !== 'undefined') ? _customCssMeta.css : '');
      _renderCustomCssMeta(_customCssMeta);
      _customCssStatus(_customCssMeta.enabled ? 'Включено.' : 'Отключено.', false);
      if (_customCssMeta.truncated) {
        _customCssStatus('⚠️ Файл большой: показан не весь текст (лимит ' + (_customCssMeta.max_chars || 0) + ' символов).', true);
      }
    } catch (e) {
      _customCssStatus('Ошибка загрузки: ' + (e && e.message ? e.message : String(e)), true);
    } finally {
      _customCssLoading = false;
    }
  }

  function _prettyCustomCssError(err) {
    const msg = String(err || '');
    if (msg === 'unsafe_css') return 'Отклонено: найден потенциально опасный фрагмент (JS/"javascript:"). Разрешён только CSS.';
    if (msg === 'too_large') return 'Отклонено: файл слишком большой.';
    return msg || 'Ошибка';
  }

  async function _customCssSaveToServer() {
    const text = _customCssGetValue();
    try {
      const data = await postJSON('/api/devtools/custom_css/save', { css: text });
      _customCssMeta = data || _customCssMeta;
      _renderCustomCssMeta(_customCssMeta);
      toast('Custom CSS saved');
      if (_isSafeMode()) {
        _customCssStatus('Сохранено. Safe mode активен — стили не применяются, пока есть ?safe=1.', false);
      } else {
        _customCssStatus('Сохранено и включено.', false);
        _ensureCustomCssLink(_customCssMeta.version || 0);
      }
    } catch (e) {
      const em = _prettyCustomCssError(e && e.message ? e.message : String(e));
      _customCssStatus('Save failed: ' + em, true);
      toast('Save failed: ' + em, true);
    }
  }

  async function _customCssDisableOnServer() {
    try {
      const data = await postJSON('/api/devtools/custom_css/disable', {});
      _customCssMeta = data || _customCssMeta;
      _renderCustomCssMeta(_customCssMeta);
      _removeCustomCssLink();
      toast('Custom CSS disabled');
      _customCssStatus('Отключено.', false);
    } catch (e) {
      _customCssStatus('Disable failed: ' + (e && e.message ? e.message : String(e)), true);
      toast('Disable failed', true);
    }
  }

  async function _customCssResetOnServer() {
    const ok = await confirmAction({
      title: 'Reset custom.css?',
      message: 'Удалить custom.css и отключить кастомизацию? Это действие необратимо.',
      okText: 'Reset',
      cancelText: 'Отменить',
      danger: true,
    });
    if (!ok) return;

    try {
      const data = await postJSON('/api/devtools/custom_css/reset', {});
      _customCssMeta = data || _customCssMeta;
      _customCssSetValue('');
      _renderCustomCssMeta(_customCssMeta);
      _removeCustomCssLink();
      toast('Custom CSS reset');
      _customCssStatus('Сброшено.', false);
    } catch (e) {
      _customCssStatus('Reset failed: ' + (e && e.message ? e.message : String(e)), true);
      toast('Reset failed', true);
    }
  }

  function _wireCustomCssEditor() {
    const card = byId('dt-custom-css-card');
    const ta = byId('dt-custom-css-textarea');
    if (!card || !ta) return;

    const btnSave = byId('dt-custom-css-save');
    const btnDisable = byId('dt-custom-css-disable');
    const btnReset = byId('dt-custom-css-reset');

    if (btnSave) btnSave.addEventListener('click', () => _customCssSaveToServer());
    if (btnDisable) btnDisable.addEventListener('click', () => _customCssDisableOnServer());
    if (btnReset) btnReset.addEventListener('click', () => _customCssResetOnServer());

    // Create CodeMirror only when the block is opened (or on init if already open).
    async function ensureAndRefresh() {
      await _ensureCustomCssEditor();
      try { if (_customCssEditor && _customCssEditor.refresh) _customCssEditor.refresh(); } catch (e) {}
    }

    card.addEventListener('toggle', () => {
      if (card.open) ensureAndRefresh();
    });

    if (card.open) {
      ensureAndRefresh();
    }

    // Initial load of content/meta.
    _customCssLoadFromServer();
  }



// --- Custom CSS help modal -------------------------------------------

let _customCssHelpEditors = [];
let _customCssHelpIndex = null;
let _customCssHelpExtrasWired = false;


function _showCustomCssHelpModal() {
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return;
  openModal(modal, 'devtools_custom_css_help');

  // Lazy-highlight snippets when opened.
  _ensureCustomCssHelpHighlights();
  _wireCustomCssHelpExtras();
  try { const si = byId('dt-custom-css-help-search'); if (si) { si.focus(); si.select && si.select(); } } catch (e) {}
}

function _hideCustomCssHelpModal() {
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return;
  closeModal(modal, 'devtools_custom_css_help');
}

async function _ensureCustomCssHelpHighlights() {
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return;
  const nodes = modal.querySelectorAll('textarea.dt-help-code');
  if (!nodes || !nodes.length) return;

  for (const ta of nodes) {
    if (!ta || (ta.dataset && ta.dataset.cmInited === '1')) continue;
    try {
      if (ta.dataset) ta.dataset.cmInited = '1';
      ta.readOnly = true;
      ta.spellcheck = false;
    } catch (e) {}
  }
}


function _wireCustomCssHelpExtras() {
  if (_customCssHelpExtrasWired) return;
  _customCssHelpExtrasWired = true;
  _wireCustomCssHelpInsertButtons();
  _wireCustomCssHelpSearch();
}

function _buildCustomCssHelpIndex() {
  if (_customCssHelpIndex) return _customCssHelpIndex;
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return null;
  const root = modal.querySelector('.dt-help') || modal;
  const details = Array.from(root.querySelectorAll('details')) || [];
  let examples = byId('dt-custom-css-help-examples');
  if (!examples) {
    examples = details.find((d) => {
      try {
        const s = d.querySelector('summary');
        return s && String(s.textContent || '').includes('Примеры');
      } catch (e) { return false; }
    }) || null;
  }

  const groups = [];
  if (examples) {
    const headers = Array.from(examples.querySelectorAll('h3')) || [];
    for (const h3 of headers) {
      const nodes = [h3];
      let n = h3.nextElementSibling;
      while (n && !(n.tagName && String(n.tagName).toLowerCase() === 'h3')) {
        nodes.push(n);
        n = n.nextElementSibling;
      }
      let ta = null;
      for (const nd of nodes) {
        try {
          const t = nd.querySelector ? nd.querySelector('textarea.dt-help-code') : null;
          if (t) { ta = t; break; }
        } catch (e) {}
      }
      const code = ta ? String(ta.value || '') : '';
      groups.push({ h3, nodes, code });
    }
  }

  _customCssHelpIndex = { modal, root, details, examples, groups };
  return _customCssHelpIndex;
}

function _offsetToEditorPos(text, offset) {
  const source = String(text || '');
  const safe = Math.max(0, Math.min(source.length, Number(offset || 0)));
  let line = 0;
  let ch = 0;
  for (let i = 0; i < safe; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      ch = 0;
    } else {
      ch += 1;
    }
  }
  return { line, ch };
}

async function _insertSnippetIntoCustomCssEditor(snippet) {
  const code = String(snippet || '');
  if (!code.trim()) return;

  // Ensure the main editor block is visible/open.
  const card = byId('dt-custom-css-card');
  try { if (card && !card.open) card.open = true; } catch (e) {}

  // Ensure editor exists (CodeMirror optional).
  try { await _ensureCustomCssEditor(); } catch (e) {}

  // Editor path (CM6 bridge / facade-compatible raw editor).
  try {
    if (_customCssEditor && typeof _customCssEditor.getValue === 'function' && typeof _customCssEditor.setValue === 'function') {
      const full = String(_customCssEditor.getValue() || '');
      let start = full.length;
      let end = full.length;
      let selectedText = '';

      if (_customCssEditor.view && _customCssEditor.view.state && _customCssEditor.view.state.selection) {
        const sel = _customCssEditor.view.state.selection.main;
        start = Number(sel && sel.from || 0);
        end = Number(sel && sel.to || start);
        selectedText = String(_customCssEditor.view.state.doc.sliceString(start, end) || '');
      } else if (typeof _customCssEditor.getDoc === 'function') {
        const doc = _customCssEditor.getDoc();
        selectedText = String(doc && doc.getSelection ? (doc.getSelection() || '') : '');
        const cur = doc && doc.getCursor ? doc.getCursor('from') : (_customCssEditor.getCursor ? _customCssEditor.getCursor() : null);
        const anchor = doc && doc.getCursor ? doc.getCursor('to') : cur;
        const from = cur && typeof cur.line === 'number' && typeof cur.ch === 'number' ? cur : { line: 0, ch: full.length };
        const to = anchor && typeof anchor.line === 'number' && typeof anchor.ch === 'number' ? anchor : from;
        const lines = full.split('\n');
        const toOffset = (pos) => {
          let out = 0;
          for (let i = 0; i < Math.max(0, Number(pos.line || 0)); i += 1) out += String(lines[i] || '').length + 1;
          return out + Math.max(0, Number(pos.ch || 0));
        };
        start = toOffset(from);
        end = toOffset(to);
      }

      let ins = code;
      if (!selectedText) {
        if (full.trim().length > 0 && start > 0) {
          const prevChar = full.charAt(start - 1);
          if (prevChar && prevChar !== '\n') ins = '\n\n' + ins;
          else if (!ins.startsWith('\n')) ins = '\n' + ins;
        }
      }

      const nextValue = full.slice(0, start) + ins + full.slice(end);
      _customCssEditor.setValue(nextValue);
      try {
        if (typeof _customCssEditor.setCursor === 'function') {
          _customCssEditor.setCursor(_offsetToEditorPos(nextValue, start + ins.length));
        }
      } catch (e) {}
      try { _customCssEditor.focus(); } catch (e) {}
      toast('Вставлено в редактор');
      return;
    }
  } catch (e) {}

  // Fallback: textarea
  const ta = byId('dt-custom-css-textarea');
  if (!ta) return;
  try {
    const start = Number(ta.selectionStart || 0);
    const end = Number(ta.selectionEnd || 0);
    const v = String(ta.value || '');
    let ins = code;
    if (v.trim().length > 0 && start > 0) {
      const prev = v.charAt(start - 1);
      if (prev && prev !== '\n') ins = '\n\n' + ins;
      else if (!ins.startsWith('\n')) ins = '\n' + ins;
    }
    if (typeof ta.setRangeText === 'function') {
      ta.setRangeText(ins, start, end, 'end');
    } else {
      ta.value = v.slice(0, start) + ins + v.slice(end);
    }
    ta.focus();
    toast('Вставлено в редактор');
  } catch (e) {}
}


function _wireCustomCssHelpInsertButtons() {
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return;
  const areas = Array.from(modal.querySelectorAll('textarea.dt-help-code')) || [];
  for (const ta of areas) {
    if (!ta) continue;
    try {
      if (ta.dataset && ta.dataset.insertWired === '1') continue;
      if (ta.dataset) ta.dataset.insertWired = '1';
    } catch (e) {}

    let codeWrap = null;
    try { codeWrap = ta.closest('.dt-help-code-wrap'); } catch (e) {}
    let h3 = null;
    let prev = codeWrap ? codeWrap.previousElementSibling : null;

    // Some examples have extra helper text between <h3> and the code block.
    while (prev) {
      const tg = prev.tagName ? String(prev.tagName).toLowerCase() : '';
      if (tg === 'h3') { h3 = prev; break; }
      prev = prev.previousElementSibling;
    }
    if (!h3) continue;

    try { h3.classList.add('dt-help-example-title'); } catch (e) {}
    try {
      if (h3.querySelector && h3.querySelector('.dt-help-insert-btn')) continue;
    } catch (e) {}

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-secondary dt-help-insert-btn';
    btn.textContent = 'Вставить в редактор';
    btn.title = 'Вставить этот пример в редактор Custom CSS (в позицию курсора).';

    btn.addEventListener('click', async (ev) => {
      ev && ev.preventDefault && ev.preventDefault();
      await _insertSnippetIntoCustomCssEditor(String(ta.value || ''));
      // Keep modal open: user may вставлять несколько примеров.
    });

    try { h3.appendChild(btn); } catch (e) {}
  }
}

function _wireCustomCssHelpSearch() {
  const modal = byId('dt-custom-css-help-modal');
  if (!modal) return;

  const input = byId('dt-custom-css-help-search');
  const clearBtn = byId('dt-custom-css-help-search-clear');
  const status = byId('dt-custom-css-help-search-status');

  if (!input) return;

  try {
    if (input.dataset && input.dataset.wired === '1') return;
    if (input.dataset) input.dataset.wired = '1';
  } catch (e) {}

  function setStatus(t) {
    if (!status) return;
    status.textContent = String(t || '');
  }

  function apply(q) {
    const idx = _buildCustomCssHelpIndex();
    if (!idx) return;
    const qq = String(q || '').trim().toLowerCase();

    // Reset: show everything
    if (!qq) {
      try {
        for (const d of idx.details) d.style.display = '';
      } catch (e) {}
      try {
        // show all nodes inside examples
        for (const g of idx.groups) {
          for (const n of g.nodes) n.style.display = '';
        }
      } catch (e) {}
      setStatus('');
      try {
        // Refresh CodeMirror to fix layout after filtering
        for (const cm of _customCssHelpEditors) { try { cm.refresh(); } catch (e) {} }
      } catch (e) {}
      return;
    }

    // Filter examples
    let shownGroups = 0;
    for (const g of idx.groups) {
      const title = String(g.h3 && g.h3.textContent ? g.h3.textContent : '');
      const hay = (title + '\n' + String(g.code || '') + '\n' + String(g.nodes.map(n => n && n.textContent ? n.textContent : '').join('\n'))).toLowerCase();
      const match = hay.includes(qq);
      for (const n of g.nodes) {
        try { n.style.display = match ? '' : 'none'; } catch (e) {}
      }
      if (match) shownGroups += 1;
    }

    // Sections: hide those without matches (but keep examples section if any example matched)
    for (const d of idx.details) {
      if (idx.examples && d === idx.examples) {
        try { d.style.display = shownGroups > 0 ? '' : 'none'; } catch (e) {}
        if (shownGroups > 0) { try { d.open = true; } catch (e) {} }
        continue;
      }
      try {
        const text = String(d.textContent || '').toLowerCase();
        const match = text.includes(qq);
        d.style.display = match ? '' : 'none';
        if (match) d.open = true;
      } catch (e) {}
    }

    setStatus(`Найдено примеров: ${shownGroups}`);

    // Scroll to first match
    try {
      const first = idx.groups.find(g => g.nodes && g.nodes.length && g.nodes[0].style.display !== 'none');
      if (first && first.h3 && typeof first.h3.scrollIntoView === 'function') {
        first.h3.scrollIntoView({ block: 'nearest' });
      }
    } catch (e) {}

    // Refresh CodeMirror (help snippets) after display changes
    setTimeout(() => {
      try { for (const cm of _customCssHelpEditors) { try { cm.refresh(); } catch (e) {} } } catch (e) {}
    }, 0);
  }

  input.addEventListener('input', () => apply(input.value));

  input.addEventListener('keydown', (e) => {
    if (!e) return;
    if (e.key === 'Enter') {
      apply(input.value);
      return;
    }
    if (e.key === 'Escape' || e.key === 'Esc') {
      if (String(input.value || '').length) {
        input.value = '';
        apply('');
        e.preventDefault();
        e.stopPropagation();
      }
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      apply('');
      try { input.focus(); } catch (e) {}
    });
  }

  // Ctrl+F inside modal focuses search, instead of browser find.
  document.addEventListener('keydown', (e) => {
    try {
      const isOpen = modal && !modal.classList.contains('hidden');
      if (!isOpen) return;
    } catch (e2) { return; }

    if (!e) return;
    const key = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && key === 'f') {
      try { input.focus(); input.select && input.select(); } catch (e3) {}
      e.preventDefault();
      e.stopPropagation();
    }
  });

  // Initial index build (once)
  _buildCustomCssHelpIndex();
}


function _wireCustomCssHelp() {
  const btn = byId('dt-custom-css-help-btn');
  const modal = byId('dt-custom-css-help-modal');
  const btnClose = byId('dt-custom-css-help-close-btn');
  const btnOk = byId('dt-custom-css-help-ok-btn');

  if (btn) btn.addEventListener('click', () => _showCustomCssHelpModal());
  if (btnClose) btnClose.addEventListener('click', () => _hideCustomCssHelpModal());
  if (btnOk) btnOk.addEventListener('click', () => _hideCustomCssHelpModal());

  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e && e.target === modal) _hideCustomCssHelpModal();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (!e) return;
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    try {
      const isOpen = modal && !modal.classList.contains('hidden');
      if (isOpen) _hideCustomCssHelpModal();
    } catch (e2) {}
  });
}



  function init() {
    try { _wireCustomCssEditor(); } catch (e) {}
    try { _wireCustomCssHelp(); } catch (e) {}
  }

  XK.features.devtoolsCustomCss = { init };
})();
