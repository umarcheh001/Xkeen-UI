import { getMihomoPanelApi } from './mihomo_panel.js';
import { getMihomoYamlPatchApi } from './mihomo_yaml_patch.js';
import {
  getMihomoCoreHttpApi,
  getMihomoEditorEngineApi,
  refreshSharedMihomoEditor,
  syncMihomoModalBodyScrollLock,
} from './mihomo_runtime.js';
import { getXkeenFilePath } from './xkeen_runtime.js';

let mihomoImportModuleApi = null;

(() => {
  'use strict';

  // Mihomo Import (Parser) UI
  // - Paste vless/trojan/vmess/ss/hysteria2/hy2 or https-subscription
  // - Convert to Mihomo YAML and insert into config.yaml editor
  // Legacy globals are published by features/compat/mihomo_import.js.

  const MI = mihomoImportModuleApi || {};
  mihomoImportModuleApi = MI;

  const IDS = {
    btnOpen: 'mihomo-import-node-btn',

    modal: 'mihomo-import-modal',
    btnClose: 'mihomo-import-close-btn',
    btnCancel: 'mihomo-import-cancel-btn',

    input: 'mihomo-import-input',
    modeSelect: 'mihomo-import-mode',
    preview: 'mihomo-import-preview',


    engineSelect: 'mihomo-import-engine-select',
    monacoHost: 'mihomo-import-preview-monaco',
    status: 'mihomo-import-status',
    hint: 'mihomo-import-target-hint',

    groupsBox: 'mihomo-import-groups',
    groupsAllBtn: 'mihomo-import-groups-all-btn',
    groupsNoneBtn: 'mihomo-import-groups-none-btn',
    groupsRemember: 'mihomo-import-groups-remember',

    btnParse: 'mihomo-import-parse-btn',
    btnInsert: 'mihomo-import-insert-btn',
  };

  let _inited = false;
  let _lastResult = null; // { outputs: [{type, content, uri}] }
  let _previewCm = null;
  let _previewCmFacade = null;

  let _previewKind = 'codemirror';
  let _previewMonaco = null;
  let _previewMonacoFacade = null;
  let _previewLastText = '';
  let _engineUnsub = null;
  let _engineSyncing = false;

  // Groups selection (proxy-groups)
  const GROUPS_PREF_KEY = 'xkeen.mihomo.import.groups.v1';
  const GROUPS_REMEMBER_KEY = 'xkeen.mihomo.import.groups.remember_v1';


  // Import mode (Auto / Proxy / Subscription / WireGuard)
  const MODE_PREF_KEY = 'xkeen.mihomo.import.mode.v1';

  function getImportMode() {
    const sel = $(IDS.modeSelect);
    const v = sel ? String(sel.value || 'auto') : 'auto';
    return v || 'auto';
  }

  function setImportMode(mode) {
    const sel = $(IDS.modeSelect);
    if (!sel) return;
    try { sel.value = String(mode || 'auto'); } catch (e) {}
  }

  function loadImportModePref() {
    try {
      if (window.localStorage) {
        const v = localStorage.getItem(MODE_PREF_KEY);
        if (v) return String(v);
      }
    } catch (e) {}
    return 'auto';
  }

  function saveImportModePref(mode) {
    try { if (window.localStorage) localStorage.setItem(MODE_PREF_KEY, String(mode || 'auto')); } catch (e) {}
  }

  function updateModeUi() {
    const inp = $(IDS.input);
    if (!inp) return;
    const mode = getImportMode();
    if (mode === 'wireguard') {
      inp.placeholder = '[Interface]\nPrivateKey = ...\nAddress = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = host:port\nAllowedIPs = 0.0.0.0/0';
    } else if (mode === 'subscription') {
      inp.placeholder = 'https://...';
    } else if (mode === 'proxy') {
      inp.placeholder = 'vless://...\nили\ntrojan://...';
    } else {
      inp.placeholder = 'vless://...\nили\nhttps://...';
    }
  }


  function $(id) {
    return document.getElementById(id);
  }

  function toastMsg(msg, isErr) {
    try {
      if (window.toast) window.toast(String(msg || ''), isErr ? 'error' : 'success');
      else if (window.showToast) window.showToast(String(msg || ''), !!isErr);
    } catch (e) {}
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    const value = String(msg || '');
    const hasMsg = !!value.trim();
    el.textContent = value;
    el.classList.toggle('error', !!isErr);
    el.classList.toggle('success', hasMsg && !isErr);
    el.classList.toggle('hidden', !hasMsg);
  }

  function setHint(msg) {
    const el = $(IDS.hint);
    if (!el) return;
    const value = String(msg || '');
    el.textContent = value;
    el.classList.toggle('hidden', !value.trim());
  }

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  // ---------------------------------------------------------------------------
  // Proxy-groups UI helpers
  // ---------------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _stripQuotes(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  function parseProxyGroupNamesFromYaml(yamlText) {
    const lines = String(yamlText || '').replace(/\r\n?/g, '\n').split('\n');
    let inGroups = false;
    let baseIndent = 0;
    const out = [];

    for (let i = 0; i < lines.length; i++) {
      const ln = String(lines[i] || '');
      const mStart = ln.match(/^(\s*)proxy-groups\s*:\s*(#.*)?$/);
      if (mStart) {
        inGroups = true;
        baseIndent = (mStart[1] || '').length;
        continue;
      }
      if (!inGroups) continue;

      if (!ln.trim()) continue;

      const indent = (ln.match(/^(\s*)/) || ['', ''])[1].length;
      const ts = ln.replace(/^\s+/, '');

      // End of proxy-groups block when a new top-level key starts
      if (indent <= baseIndent && !ts.startsWith('#') && !ts.startsWith('-') && /^[A-Za-z0-9_\-]+\s*:/.test(ts)) {
        inGroups = false;
        continue;
      }

      const mName = ln.match(/^\s*-\s*name\s*:\s*(.+?)\s*(#.*)?$/);
      if (mName) {
        let raw = String(mName[1] || '').trim();
        // Remove trailing inline comment (best-effort)
        raw = raw.replace(/\s+#.*$/, '').trim();
        const name = _stripQuotes(raw);
        if (name && out.indexOf(name) === -1) out.push(name);
      }
    }
    return out;
  }

  function loadGroupPrefs() {
    let remember = false;
    let selected = [];
    try {
      if (window.localStorage) {
        remember = localStorage.getItem(GROUPS_REMEMBER_KEY) === '1';
        const raw = localStorage.getItem(GROUPS_PREF_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) selected = arr.map((x) => String(x || '').trim()).filter(Boolean);
        }
      }
    } catch (e) {}
    return { remember, selected };
  }

  function saveGroupPrefs(selected, remember) {
    try {
      if (!window.localStorage) return;
      localStorage.setItem(GROUPS_REMEMBER_KEY, remember ? '1' : '0');
      if (remember) localStorage.setItem(GROUPS_PREF_KEY, JSON.stringify(selected || []));
    } catch (e) {}
  }

  function renderGroupCheckboxes(names, selectedSet) {
    const box = $(IDS.groupsBox);
    if (!box) return;

    const sel = selectedSet || new Set();

    if (!names || !names.length) {
      box.innerHTML = '<div class="xk-card-desc" style="opacity:0.75;">Группы <code>proxy-groups</code> не найдены в текущем <code>config.yaml</code>.</div>';
      return;
    }

    const parts = [];
    for (const name of names) {
      const checked = sel.has(name) ? ' checked' : '';
      parts.push(
        '<label class="global-autorestart-toggle" style="display:flex; gap:10px; align-items:center; margin:4px 0;">' +
          '<input type="checkbox" class="mihomo-import-group-cb" data-group="' + escapeHtml(name) + '"' + checked + '>' +
          '<span>' + escapeHtml(name) + '</span>' +
        '</label>'
      );
    }
    box.innerHTML = parts.join('');
  }

  function readSelectedGroupsFromUi() {
    const box = $(IDS.groupsBox);
    if (!box) return [];
    const cbs = Array.from(box.querySelectorAll('input.mihomo-import-group-cb'));
    return cbs
      .filter((cb) => cb && cb.checked)
      .map((cb) => String(cb.dataset && cb.dataset.group ? cb.dataset.group : '').trim())
      .filter(Boolean);
  }

  function setAllGroupsChecked(checked) {
    const box = $(IDS.groupsBox);
    if (!box) return;
    const cbs = Array.from(box.querySelectorAll('input.mihomo-import-group-cb'));
    cbs.forEach((cb) => { try { cb.checked = !!checked; } catch (e) {} });
  }

  function refreshGroupsUiFromConfig() {
    const cfg = getEditorText() || '';
    const names = parseProxyGroupNamesFromYaml(cfg);

    const prefs = loadGroupPrefs();
    const rememberCb = $(IDS.groupsRemember);
    const remember = rememberCb ? !!rememberCb.checked : prefs.remember;

    // If remember checkbox exists, sync it from stored prefs when opening modal
    if (rememberCb) {
      try { rememberCb.checked = !!prefs.remember; } catch (e) {}
    }

    const selected = (prefs.remember && Array.isArray(prefs.selected)) ? new Set(prefs.selected) : new Set();
    renderGroupCheckboxes(names, selected);
  }

  function maybePersistGroupsSelection() {
    const rememberCb = $(IDS.groupsRemember);
    const remember = !!(rememberCb && rememberCb.checked);
    const selected = readSelectedGroupsFromUi();
    saveGroupPrefs(selected, remember);
  }


  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function getEngineHelper() {
    return getMihomoEditorEngineApi();
  }

  const CM6_SCOPE = 'mihomo-import';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function isCm6Runtime(runtime) {
    try { return !!(runtime && runtime.backend === 'cm6'); } catch (e) {}
    return false;
  }

  function isCm6Editor(editor) {
    try {
      if (!editor) return false;
      if (editor.__xkeenCm6Bridge || editor.backend === 'cm6') return true;
      const wrap = (typeof editor.getWrapperElement === 'function') ? editor.getWrapperElement() : null;
      return !!(wrap && wrap.classList && wrap.classList.contains('xkeen-cm6-editor'));
    } catch (e) {}
    return false;
  }

  function disposeCodeMirrorEditor(editor) {
    if (!editor) return false;
    try { if (typeof editor.dispose === 'function') return !!editor.dispose(); } catch (e) {}
    try {
      if (typeof editor.toTextArea === 'function') {
        editor.toTextArea();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function createCodeMirrorFacade(cm) {
    if (!cm) return null;
    const runtime = getEditorRuntime('codemirror');
    if (runtime && typeof runtime.toFacade === 'function') {
      try {
        return runtime.toFacade(cm, {
          layout: () => {
            try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
          },
        });
      } catch (e) {}
    }
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        layout: () => {
          try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
        },
      });
    } catch (e) {}
    return null;
  }

  function showNode(node) {
    if (!node) return;
    try { node.classList.remove('hidden'); } catch (e) {}
    try { node.style.display = ''; } catch (e2) {}
  }

  function hideNode(node) {
    if (!node) return;
    try { node.classList.add('hidden'); } catch (e) {}
    try { node.style.display = 'none'; } catch (e2) {}
  }

  function cmWrapper(cm) {
    try { return (cm && typeof cm.getWrapperElement === 'function') ? cm.getWrapperElement() : null; } catch (e) { return null; }
  }

  function modalOpen() {
    const m = $(IDS.modal);
    return !!(m && !m.classList.contains('hidden'));
  }

  function setEngineSelectValue(engine) {
    const sel = $(IDS.engineSelect);
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  async function resolvePreferredEngine() {
    let engine = 'codemirror';
    const ee = getEngineHelper();
    try {
      if (ee && typeof ee.ensureLoaded === 'function') engine = normalizeEngine(await ee.ensureLoaded());
      else if (ee && typeof ee.get === 'function') engine = normalizeEngine(ee.get());
    } catch (e) {
      try { engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror'); } catch (e2) { engine = 'codemirror'; }
    }
    return engine;
  }

  function previewTextFallback() {
    try { if (_previewLastText) return String(_previewLastText || ''); } catch (e) {}
    try {
      if (_previewKind === 'monaco' && _previewMonacoFacade && _previewMonacoFacade.getValue) return String(_previewMonacoFacade.getValue() || '');
    } catch (e2) {}
    try {
      if (_previewCmFacade && _previewCmFacade.getValue) return String(_previewCmFacade.getValue() || '');
    } catch (e3) {}
    try {
      if (_previewCm && _previewCm.getValue) return String(_previewCm.getValue() || '');
    } catch (e4) {}
    const ta = $(IDS.preview);
    return ta ? String(ta.value || '') : '';
  }

  function disposePreviewMonaco() {
    try {
      if (_previewMonacoFacade && _previewMonacoFacade.dispose) _previewMonacoFacade.dispose();
      else if (_previewMonaco && _previewMonaco.dispose) _previewMonaco.dispose();
    } catch (e) {}
    _previewMonaco = null;
    _previewMonacoFacade = null;
  }

  async function activatePreviewEngine(engine) {
    const next = normalizeEngine(engine);
    const host = $(IDS.monacoHost);
    const ta = $(IDS.preview);

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e0) {}
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set('codemirror'); } catch (e1) {}
        return activatePreviewEngine('codemirror');
      }

      // Hide CodeMirror/textarea, show Monaco host
      const w = cmWrapper(_previewCm);
      if (w) hideNode(w);
      if (ta) hideNode(ta);
      showNode(host);

      const value = previewTextFallback();

      if (!_previewMonaco) {
        const ed = await runtime.create(host, {
          language: 'yaml',
          readOnly: true,
          value: value,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
        });
        if (!ed) {
          try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e2) {}
          const ee = getEngineHelper();
          try { if (ee && ee.set) await ee.set('codemirror'); } catch (e3) {}
          if (host) hideNode(host);
          return activatePreviewEngine('codemirror');
        }
        _previewMonaco = ed;
        try {
          const helper = getEngineHelper();
          _previewMonacoFacade = (helper && typeof helper.fromMonaco === 'function') ? helper.fromMonaco(ed) : null;
        } catch (e4) {
          _previewMonacoFacade = null;
        }
        try { if (runtime.layoutOnVisible) runtime.layoutOnVisible(ed, host); } catch (e5) {}
      } else if (_previewMonacoFacade && _previewMonacoFacade.setValue) {
        _previewMonacoFacade.setValue(value);
      }

      _previewKind = 'monaco';
      try { if (_previewMonacoFacade) _previewMonacoFacade.scrollTo(0, 0); } catch (e6) {}
      return 'monaco';
    }

    // CodeMirror
    if (host) hideNode(host);
    try { disposePreviewMonaco(); } catch (e) {}

    try {
      const runtime = await ensureEditorRuntime('codemirror', { mode: 'yaml' });
      if (runtime && typeof runtime.ensureAssets === 'function') {
        await runtime.ensureAssets({ mode: 'yaml' });
      }
    } catch (e) {}

    const cm = ensurePreviewCm();
    const value = previewTextFallback();

    if (cm && cm.setOption) {
      try { cm.setOption('theme', cmThemeFromPage()); } catch (e1) {}
    }

    if (cm && cm.setValue) {
      try {
        cm.setValue(value);
        cm.scrollTo(0, 0);
        setTimeout(() => { try { cm.refresh(); } catch (e2) {} }, 30);
      } catch (e3) {}
      const w = cmWrapper(cm);
      if (w) showNode(w);
      if (ta) hideNode(ta);
    } else {
      if (ta) {
        try { ta.value = value; } catch (e4) {}
        showNode(ta);
      }
    }

    _previewKind = 'codemirror';
    return 'codemirror';
  }

  async function syncEngineNow() {
    if (_engineSyncing) return;
    _engineSyncing = true;
    try {
      const engine = await resolvePreferredEngine();
      setEngineSelectValue(engine);
      if (modalOpen()) await activatePreviewEngine(engine);
    } finally {
      _engineSyncing = false;
    }
  }

  function scheduleEngineSync() {
    try { setTimeout(() => { try { syncEngineNow(); } catch (e) {} }, 0); } catch (e) {}
  }


  function ensurePreviewCm() {
    const ta = $(IDS.preview);
    if (!ta) return null;

    const runtime = getEditorRuntime('codemirror');
    const preferCm6 = isCm6Runtime(runtime);

    if (_previewCm) {
      if (!preferCm6 || isCm6Editor(_previewCm)) return _previewCm;
      try { disposeCodeMirrorEditor(_previewCm); } catch (e) {}
      _previewCm = null;
      _previewCmFacade = null;
    }

    if (!runtime || typeof runtime.create !== 'function') return null;

    _previewCm = runtime.create(ta, {
      mode: 'yaml',
      theme: cmThemeFromPage(),
      lineNumbers: false,
      lineWrapping: true,
      readOnly: 'nocursor',
      tabSize: 2,
      indentUnit: 2,
      viewportMargin: Infinity,
    });

    try {
      const w = _previewCm.getWrapperElement();
      w.classList.add('xkeen-cm', 'xk-mihomo-import-preview');
      const previewHeight = window.innerWidth <= 720 ? '280px' : '360px';
      if (typeof _previewCm.setSize === 'function') _previewCm.setSize(null, previewHeight);
      else if (w) w.style.height = previewHeight;
    } catch (e) {}

    _previewCmFacade = createCodeMirrorFacade(_previewCm);
    return _previewCm;
  }

  function setPreview(text) {
    const v = String(text || '');
    _previewLastText = v;

    try {
      if (_previewKind === 'monaco' && _previewMonacoFacade && _previewMonacoFacade.setValue) {
        _previewMonacoFacade.setValue(v);
        try { _previewMonacoFacade.scrollTo(0, 0); } catch (e2) {}
        return;
      }
    } catch (e) {}

    if (_previewCmFacade && _previewCmFacade.set) {
      _previewCmFacade.set(v);
      try { _previewCmFacade.scrollTo(0, 0); } catch (e2) {}
      return;
    }
    if (_previewCm && _previewCm.setValue) {
      _previewCm.setValue(v);
      try { _previewCm.scrollTo(0, 0); } catch (e2) {}
      return;
    }
    const el = $(IDS.preview);
    if (el) el.value = v;
  }

  function getEditorText() {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.getEditorText === 'function') {
        return api.getEditorText();
      }
    } catch (e2) {}
    // fallback
    const ta = $('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.setEditorText === 'function') return api.setEditorText(text);
    } catch (e) {}
    const ta = $('mihomo-editor');
    if (ta) ta.value = String(text || '');
  }

  function refreshEditor() {
    refreshSharedMihomoEditor();
  }

  function showModal(show) {
    const modal = $(IDS.modal);
    if (!modal) return;
    try {
      if (show) modal.classList.remove('hidden');
      else modal.classList.add('hidden');
    } catch (e) {}
    try {
      syncMihomoModalBodyScrollLock();
    } catch (e2) {}

    if (show) {
      // reset
      _lastResult = null;
      setStatus('', false);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;

      // Load proxy-groups list from current config.yaml
      try { refreshGroupsUiFromConfig(); } catch (e4a) {}

      // Import mode (persisted)
      try { setImportMode(loadImportModePref()); } catch (e4b) {}
      try { updateModeUi(); } catch (e4c) {}

      // Activate preferred editor engine (CodeMirror / Monaco)
      try { scheduleEngineSync(); } catch (e4) {}

      try {
        const inp = $(IDS.input);
        if (inp) inp.focus();
      } catch (e3) {}
    }
  }

  function wireButton(id, fn) {
    const el = $(id);
    if (!el) return;
    if (el.dataset && el.dataset.xkWired === '1') return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        const r = fn(e);
        if (r && typeof r.then === 'function') {
          r.catch((err) => { try { console.error(err); } catch (e2) {} });
        }
      } catch (err) {
        console.error(err);
      }
    });
    if (el.dataset) el.dataset.xkWired = '1';
  }

  // ---------------------------------------------------------------------------
  // Parser (adapted from outboundParser.js) - Mihomo only
  // ---------------------------------------------------------------------------

  const safeBase64 = (str) =>
    atob(
      str
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(str.length + ((4 - (str.length % 4)) % 4), '='),
    );

  const toYaml = (obj, indent = 0) => {
    const padding = ' '.repeat(indent);
    return Object.entries(obj).reduce((result, [key, value]) => {
      if (value == null || (value === '' && key !== 'encryption')) return result;
      if (Array.isArray(value))
        return value.length
          ? result + `${padding}${key}:\n` + value.map((item) => `${padding}  - ${item}`).join('\n') + '\n'
          : result;
      if (typeof value === 'object') return result + `${padding}${key}:\n${toYaml(value, indent + 2)}`;
      const rendered =
        key === 'name'
          ? `'${String(value).replace(/'/g, "''")}'`
          : (key === 'encryption' && value === '' ? '""' : value);
      return result + `${padding}${key}: ${rendered}\n`;
    }, '');
  };

  const decodeMaybe = (value) => {
    if (value == null || value === '') return undefined;
    try { return decodeURIComponent(String(value)); } catch (e) {}
    return String(value);
  };

  const parseJsonMaybe = (raw) => {
    if (raw == null || raw === '') return undefined;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch (e) {}
    try { return JSON.parse(decodeURIComponent(String(raw))); } catch (e2) {}
    return undefined;
  };

  const firstDefined = (obj, ...keys) => {
    if (!obj || typeof obj !== 'object') return undefined;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  };

  const boolMaybe = (obj, ...keys) => {
    const raw = firstDefined(obj, ...keys);
    if (raw === undefined) return undefined;
    if (raw === true || raw === 1) return true;
    if (raw === false || raw === 0) return false;
    const text = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
    return undefined;
  };

  const cleanHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return undefined;
    const out = {};
    Object.entries(headers).forEach(([key, value]) => {
      const cleanKey = String(key || '').trim();
      if (!cleanKey || value == null || value === '') return;
      if (Array.isArray(value)) {
        const items = value.map((item) => String(item || '').trim()).filter(Boolean);
        if (items.length) out[cleanKey] = items;
        return;
      }
      out[cleanKey] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    });
    return Object.keys(out).length ? out : undefined;
  };

  const cleanReuseSettings = (reuse) => {
    if (!reuse || typeof reuse !== 'object') return undefined;
    const out = {};
    const mappings = {
      'max-concurrency': firstDefined(reuse, 'max-concurrency', 'maxConcurrency'),
      'max-connections': firstDefined(reuse, 'max-connections', 'maxConnections'),
      'c-max-reuse-times': firstDefined(reuse, 'c-max-reuse-times', 'cMaxReuseTimes'),
      'h-max-request-times': firstDefined(reuse, 'h-max-request-times', 'hMaxRequestTimes'),
      'h-max-reusable-secs': firstDefined(reuse, 'h-max-reusable-secs', 'hMaxReusableSecs'),
    };
    Object.entries(mappings).forEach(([key, value]) => {
      if (value === undefined) return;
      out[key] = typeof value === 'number' || typeof value === 'boolean' ? value : String(value);
    });
    return Object.keys(out).length ? out : undefined;
  };

  const cleanStringList = (value) => {
    if (value == null || value === '') return undefined;
    const rawItems = Array.isArray(value) ? value : String(value).split(',');
    const items = rawItems.map((item) => String(item ?? '').trim()).filter(Boolean);
    return items.length ? items : undefined;
  };

  const cleanValueTree = (value) => {
    if (value == null || value === '') return undefined;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const items = value.map((item) => cleanValueTree(item)).filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    if (typeof value === 'object') {
      const out = {};
      Object.entries(value).forEach(([key, nestedValue]) => {
        const cleanKey = String(key || '').trim();
        if (!cleanKey) return;
        const cleanNested = cleanValueTree(nestedValue);
        if (cleanNested === undefined) return;
        out[cleanKey] = cleanNested;
      });
      return Object.keys(out).length ? out : undefined;
    }
    return String(value);
  };

  const cleanDownloadSettings = (download) => {
    if (!download || typeof download !== 'object') return undefined;

    const out = {};

    const path = firstDefined(download, 'path');
    if (path !== undefined) out.path = String(path);

    const host = firstDefined(download, 'host');
    if (host !== undefined) out.host = String(host);

    const headers = cleanHeaders(firstDefined(download, 'headers'));
    if (headers) out.headers = headers;

    const noGrpcHeader = boolMaybe(download, 'no-grpc-header', 'noGrpcHeader', 'noGRPCHeader');
    if (noGrpcHeader !== undefined) out['no-grpc-header'] = noGrpcHeader;

    const xPaddingBytes = firstDefined(download, 'x-padding-bytes', 'xPaddingBytes');
    if (xPaddingBytes !== undefined) {
      out['x-padding-bytes'] = typeof xPaddingBytes === 'number' ? xPaddingBytes : String(xPaddingBytes);
    }

    const scMaxEachPostBytes = firstDefined(download, 'sc-max-each-post-bytes', 'scMaxEachPostBytes');
    if (scMaxEachPostBytes !== undefined) {
      out['sc-max-each-post-bytes'] =
        typeof scMaxEachPostBytes === 'number' ? scMaxEachPostBytes : String(scMaxEachPostBytes);
    }

    const reuseSettings = cleanReuseSettings(firstDefined(download, 'reuse-settings', 'reuseSettings'));
    if (reuseSettings) out['reuse-settings'] = reuseSettings;

    const server = firstDefined(download, 'server');
    if (server !== undefined) out.server = String(server);

    const port = firstDefined(download, 'port');
    if (port !== undefined) out.port = typeof port === 'number' ? port : String(port);

    const tls = boolMaybe(download, 'tls');
    if (tls !== undefined) out.tls = tls;

    const alpn = cleanStringList(firstDefined(download, 'alpn'));
    if (alpn) out.alpn = alpn;

    const echOpts = cleanValueTree(firstDefined(download, 'ech-opts', 'echOpts'));
    if (echOpts !== undefined) out['ech-opts'] = echOpts;

    const realityOpts = cleanValueTree(firstDefined(download, 'reality-opts', 'realityOpts'));
    if (realityOpts !== undefined) out['reality-opts'] = realityOpts;

    const skipCertVerify = boolMaybe(download, 'skip-cert-verify', 'skipCertVerify');
    if (skipCertVerify !== undefined) out['skip-cert-verify'] = skipCertVerify;

    const fingerprint = firstDefined(download, 'fingerprint');
    if (fingerprint !== undefined) out.fingerprint = String(fingerprint);

    const certificate = cleanValueTree(firstDefined(download, 'certificate'));
    if (certificate !== undefined) out.certificate = certificate;

    const privateKey = cleanValueTree(firstDefined(download, 'private-key', 'privateKey'));
    if (privateKey !== undefined) out['private-key'] = privateKey;

    const servername = firstDefined(download, 'servername', 'serverName');
    if (servername !== undefined) out.servername = String(servername);

    const clientFingerprint = firstDefined(download, 'client-fingerprint', 'clientFingerprint');
    if (clientFingerprint !== undefined) out['client-fingerprint'] = String(clientFingerprint);

    return Object.keys(out).length ? out : undefined;
  };

  const normalizeXhttpSettings = (params) => {
    const extra = parseJsonMaybe(params.extra);
    const xhttp = {
      path: decodeMaybe(params.path) || '/',
      host: decodeMaybe(params.host) || decodeMaybe(params.sni),
      mode: decodeMaybe(params.mode),
    };

    const headers = cleanHeaders(firstDefined(extra, 'headers'));
    if (headers) xhttp.headers = headers;

    const noGrpcHeader = boolMaybe(extra, 'no-grpc-header', 'noGrpcHeader', 'noGRPCHeader');
    if (noGrpcHeader === true) xhttp['no-grpc-header'] = true;

    const xPaddingBytes = firstDefined(extra, 'x-padding-bytes', 'xPaddingBytes');
    if (xPaddingBytes !== undefined) {
      xhttp['x-padding-bytes'] = typeof xPaddingBytes === 'number' ? xPaddingBytes : String(xPaddingBytes);
    }

    const scMaxEachPostBytes = firstDefined(extra, 'sc-max-each-post-bytes', 'scMaxEachPostBytes');
    if (scMaxEachPostBytes !== undefined) {
      xhttp['sc-max-each-post-bytes'] =
        typeof scMaxEachPostBytes === 'number' ? scMaxEachPostBytes : String(scMaxEachPostBytes);
    }

    const reuseSettings = cleanReuseSettings(firstDefined(extra, 'reuse-settings', 'reuseSettings'));
    if (reuseSettings) xhttp['reuse-settings'] = reuseSettings;

    const downloadSettings = cleanDownloadSettings(firstDefined(extra, 'download-settings', 'downloadSettings'));
    if (downloadSettings) xhttp['download-settings'] = downloadSettings;

    return Object.fromEntries(Object.entries(xhttp).filter(([, value]) => value != null && value !== ''));
  };

  const getStreamSettings = (type, params) => {
    const number = (val) => (val ? +val : undefined);
    const bool = (val) => val === 'true' || val === true || val === '1' || undefined;
    const string = (val) => val || undefined;
    const output = {
      network: type,
      security: string(params.security),
      tlsSettings:
        params.security === 'tls'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              alpn: params.alpn?.split(','),
              allowInsecure: bool(params.allowInsecure || params.insecure),
            }
          : undefined,
      realitySettings:
        params.security === 'reality'
          ? {
              fingerprint: string(params.fp) || 'chrome',
              serverName: string(params.sni),
              publicKey: string(params.pbk),
              shortId: string(params.sid),
              spiderX: string(params.spx),
              mldsa65Verify: string(params.pqv),
            }
          : undefined,
    };

    if (type === 'tcp' && params.headerType) output.tcpSettings = { header: { type: params.headerType } };
    if (type === 'raw' && params.headerType) output.rawSettings = { header: { type: params.headerType } };

    if (type === 'grpc')
      output.grpcSettings = {
        serviceName: string(params.serviceName || params.path),
        authority: string(params.authority),
        multiMode: params.mode === 'multi',
        user_agent: string(params.user_agent),
        idle_timeout: number(params.idle_timeout),
        health_check_timeout: number(params.health_check_timeout),
        permit_without_stream: bool(params.permit_without_stream),
        initial_windows_size: number(params.initial_windows_size),
      };

    if (type === 'ws')
      output.wsSettings = {
        path: params.path || '/',
        host: string(params.host),
        heartbeatPeriod: number(params.heartbeatPeriod),
      };

    if (type === 'httpupgrade') output.httpupgradeSettings = { path: params.path || '/', host: string(params.host) };
    if (type === 'xhttp') output.xhttpSettings = normalizeXhttpSettings(params);

    return output;
  };

  const parseUrl = (uri, protocol, settingsMapper) => {
    const url = new URL(uri);
    const params = Object.fromEntries(url.searchParams);

    const baseConfig = {
      tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
      protocol: protocol,
      settings: settingsMapper(url, params),
    };

    if (!['shadowsocks', 'hysteria2'].includes(protocol)) {
      baseConfig.streamSettings = getStreamSettings(params.type || 'tcp', { ...params, sni: params.sni });
    }

    return baseConfig;
  };

  const protocols = {
    vless: (uri) =>
      parseUrl(uri, 'vless', (url, params) => ({
        address: url.hostname,
        port: +url.port || 443,
        id: url.username,
        encryption: params.encryption || 'none',
        flow: params.flow || undefined,
      })),

    trojan: (uri) =>
      parseUrl(uri, 'trojan', (url) => ({
        address: url.hostname,
        port: +url.port || 443,
        password: url.username,
      })),

    hysteria2: (uri) =>
      parseUrl(uri, 'hysteria2', (url, params) => {
        // Hysteria2 URI auth formats:
        //  - hysteria2://<auth>@host:port
        //  - hy2://username:password@host:port
        const user = decodeURIComponent(url.username || '');
        const pass = decodeURIComponent(url.password || '');
        const auth = user && pass ? `${user}:${pass}` : user;

        const alpnRaw = params.alpn || '';
        const alpn = alpnRaw ? String(alpnRaw).split(',').map((s) => s.trim()).filter(Boolean) : ['h3'];
        const obfsPassword = params['obfs-password'] || params.obfsPassword || params['obfs_password'] || undefined;

        return {
          address: url.hostname,
          port: +url.port || 443,
          password: auth,
          sni: params.sni,
          insecure: params.insecure === '1' || params.allowInsecure === '1',
          alpn,
          obfs: params.obfs || undefined,
          obfsPassword,
        };
      }),

    // aliases
    hy2: (uri) => protocols.hysteria2(uri),
    hysteria: (uri) => protocols.hysteria2(uri),

    ss: (uri) => {
      const url = new URL(uri);
      let method, password;
      if (url.username && !url.password) {
        const decoded = safeBase64(url.username).split(':');
        method = decoded[0];
        password = decoded.slice(1).join(':');
      } else {
        method = url.username;
        password = url.password;
      }
      return {
        tag: decodeURIComponent(url.hash.slice(1)) || 'PROXY',
        protocol: 'shadowsocks',
        settings: { address: url.hostname, port: +url.port, method, password },
      };
    },

    vmess: (uri) => {
      const data = JSON.parse(safeBase64(uri.slice(8)));
      if (data.tls === 'tls') {
        data.security = 'tls';
        data.sni = data.sni || data.host;
      }
      return {
        tag: data.ps || 'PROXY',
        protocol: 'vmess',
        settings: {
          address: data.add,
          port: +data.port,
          id: data.id,
          alterId: +data.aid || 0,
          security: data.scy || 'auto',
        },
        streamSettings: getStreamSettings(data.net || 'tcp', data),
      };
    },
  };

  function parseProxyUri(uri) {
    const protocolRaw = String(uri.split(':')[0] || '').toLowerCase();
    const protocol = protocolRaw === 'hy2' || protocolRaw === 'hysteria' ? 'hysteria2' : protocolRaw;
    if (!protocols[protocol]) throw new Error('Неизвестная ссылка');
    return protocols[protocol](uri);
  }

  function convertToMihomoYaml(proxyConfig) {
    const settings = proxyConfig.settings;
    const streamSettings = proxyConfig.streamSettings || {};

    const common = {
      name: proxyConfig.tag,
      type: proxyConfig.protocol,
      server: settings.address,
      port: settings.port,
      udp: true,
    };

    if (proxyConfig.protocol === 'vless') {
      const enc = String(settings.encryption || '').trim().toLowerCase();
      Object.assign(common, {
        uuid: settings.id,
        flow: settings.flow,
        'packet-encoding': 'xudp',
        encryption: !enc || enc === 'none' ? '' : settings.encryption,
      });
    } else if (proxyConfig.protocol === 'vmess') {
      Object.assign(common, { uuid: settings.id, alterId: settings.alterId, cipher: settings.security });
    } else if (proxyConfig.protocol === 'trojan') {
      common.password = settings.password;
    } else if (proxyConfig.protocol === 'hysteria2') {
      // Hysteria2 (hy2://, hysteria2://)
      common.password = settings.password;
      common['fast-open'] = true;
      if (settings.sni) common.sni = settings.sni;
      if (settings.insecure) common['skip-cert-verify'] = true;
      if (settings.alpn && settings.alpn.length) common.alpn = settings.alpn;
      if (settings.obfs) common.obfs = settings.obfs;
      if (settings.obfsPassword) common['obfs-password'] = settings.obfsPassword;
    } else if (proxyConfig.protocol === 'shadowsocks') {
      Object.assign(common, { cipher: settings.method, password: settings.password });
    }

    if (streamSettings.network) common.network = streamSettings.network;

    if (['tls', 'reality'].includes(streamSettings.security)) {
      const tls = streamSettings.tlsSettings || {};
      const reality = streamSettings.realitySettings || {};
      const serverName = tls.serverName || reality.serverName;

      Object.assign(common, {
        tls: true,
        tfo: true,
        'client-fingerprint': tls.fingerprint || reality.fingerprint,
        alpn: tls.alpn,
      });

      if (['trojan', 'hysteria2'].includes(proxyConfig.protocol)) {
        if (serverName) common.sni = serverName;
      } else {
        if (serverName) common.servername = serverName;
      }

      if (tls.allowInsecure) common['skip-cert-verify'] = true;

      if (streamSettings.security === 'reality') {
        common['reality-opts'] = {
          'public-key': reality.publicKey,
          'short-id': reality.shortId,
          'support-x25519mlkem768': true,
        };
      }
    }

    if (streamSettings.network === 'xhttp' && proxyConfig.protocol !== 'vless') {
      throw new Error('XHTTP transport поддерживается в Mihomo только для VLESS');
    }

    if (streamSettings.network === 'ws') {
      common['ws-opts'] = {
        path: streamSettings.wsSettings?.path,
        headers: streamSettings.wsSettings?.host ? { Host: streamSettings.wsSettings.host } : undefined,
      };
    } else if (streamSettings.network === 'grpc') {
      common['grpc-opts'] = { 'grpc-service-name': streamSettings.grpcSettings?.serviceName };
    } else if (streamSettings.network === 'httpupgrade') {
      common['http-upgrade-opts'] = {
        path: streamSettings.httpupgradeSettings?.path,
        headers: streamSettings.httpupgradeSettings?.host ? { Host: streamSettings.httpupgradeSettings.host } : undefined,
      };
    } else if (streamSettings.network === 'xhttp') {
      common['xhttp-opts'] = {
        path: streamSettings.xhttpSettings?.path,
        host: streamSettings.xhttpSettings?.host,
        mode: streamSettings.xhttpSettings?.mode,
        headers: streamSettings.xhttpSettings?.headers,
        'no-grpc-header': streamSettings.xhttpSettings?.['no-grpc-header'],
        'x-padding-bytes': streamSettings.xhttpSettings?.['x-padding-bytes'],
        'sc-max-each-post-bytes': streamSettings.xhttpSettings?.['sc-max-each-post-bytes'],
        'reuse-settings': streamSettings.xhttpSettings?.['reuse-settings'],
        'download-settings': streamSettings.xhttpSettings?.['download-settings'],
      };
    }

    return `  - ${toYaml(common).trim().replace(/\n/g, '\n    ')}`;
  }

  function proxyYamlRawFromIndented(indented) {
    const s = String(indented || '');
    // convert from list-item under `proxies:` (2-space indent) to raw block starting with `- name:`
    return s.replace(/^ {2}/gm, '');
  }



  function generateConfigForMihomo(uri, existingConfig = '') {
    const generateName = (base, existsFn) => {
      let index = 1;
      while (existsFn(existingConfig, `${base}_${index}`)) index++;
      return `${base}_${index}`;
    };

    if (uri.startsWith('http')) {
      const name = generateName('subscription', configHasProviderName);
      return {
        type: 'proxy-provider',
        content: toYaml(
          {
            [name]: {
              type: 'http',
              url: uri,
              interval: 43200,
              'health-check': {
                enable: true,
                url: 'https://www.gstatic.com/generate_204',
                interval: 300,
                'expected-status': 204,
              },
              override: { udp: true, tfo: true },
            },
          },
          2,
        ),
      };
    }
    // Keep xhttp synchronous in the shared parser API used by import and proxy tools.
    if (uri.includes('type=xhttp')) {
      const config = parseProxyUri(uri);
      if (config.tag === 'PROXY' || configHasProxyName(existingConfig, config.tag)) {
        config.tag = generateName(config.protocol, configHasProxyName);
      }
      const indented = convertToMihomoYaml(config);
      const raw = proxyYamlRawFromIndented(indented);
      return { type: 'proxy', proxy_name: config.tag, content: raw + '\n' };
    }

    const config = parseProxyUri(uri);
    if (config.tag === 'PROXY' || configHasProxyName(existingConfig, config.tag)) {
      config.tag = generateName(config.protocol, configHasProxyName);
    }

    const indented = convertToMihomoYaml(config);
    const raw = proxyYamlRawFromIndented(indented);
    return { type: 'proxy', proxy_name: config.tag, content: raw + '\n' };
  }

  // Expose a minimal helper API for other modules (Proxy Tools, etc.)
  // NOTE: keep this stable; it is used as a shared parser/generator.
  MI.generateConfigForMihomo = MI.generateConfigForMihomo || generateConfigForMihomo;
  MI.proxyYamlRawFromIndented = MI.proxyYamlRawFromIndented || proxyYamlRawFromIndented;

  // ---------------------------------------------------------------------------
  // YAML insertion helpers (shared)
  // ---------------------------------------------------------------------------

  function yamlPatch() {
    try {
      return getMihomoYamlPatchApi();
    } catch (e) {
      return null;
    }
  }

  function insertProvidersIntoConfig(existingText, outputs) {
    let txt = String(existingText || '');
    const yp = yamlPatch();

    if (!yp || typeof yp.insertIntoSection !== 'function') {
      throw new Error('mihomoYamlPatch не загружен');
    }

    const providers = (outputs || []).filter((o) => o.type === 'proxy-provider');
    providers.forEach((o) => {
      txt = yp.insertIntoSection(txt, 'proxy-providers', o.content);
    });
    return txt;
  }

  async function applyInsertProxy(txt, proxyOut, groups) {
    const body = {
      content: String(txt || ''),
      proxy_yaml: String(proxyOut && proxyOut.content ? proxyOut.content : ''),
      proxy_name: String((proxyOut && (proxyOut.proxy_name || proxyOut.proxyName)) || '').trim(),
      groups: Array.isArray(groups) ? groups : [],
    };

    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const data = await post('/api/mihomo/patch/apply_insert', body);
    if (!data || data.ok === false) throw new Error((data && data.error) ? data.error : 'apply_insert failed');
    return String(data.content || '');
  }


  function escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function configHasProxyName(cfgText, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const re1 = new RegExp('^\\s*-\\s*name\\s*:\\s*(?:"' + escapeRegExp(n) + '"|\'' + escapeRegExp(n) + '\'|' + escapeRegExp(n) + ')\\s*(?:#.*)?$', 'm');
    return re1.test(String(cfgText || ''));
  }

  function configHasProviderName(cfgText, name) {
    const n = String(name || '').trim();
    if (!n) return false;
    const re1 = new RegExp('^\\s+' + escapeRegExp(n) + '\\s*:\\s*(?:#.*)?$', 'm');
    return re1.test(String(cfgText || ''));
  }

  function makeUniqueName(base, cfgText) {
    const b = String(base || 'WG').trim() || 'WG';
    if (!configHasProxyName(cfgText, b)) return b;
    let i = 2;
    while (i < 2000) {
      const cand = b + '_' + i;
      if (!configHasProxyName(cfgText, cand)) return cand;
      i++;
    }
    return b + '_' + Date.now();
  }

  async function parseWireguardViaApi(confText, desiredName) {
    const http = getMihomoCoreHttpApi();
    const post = http && typeof http.postJSON === 'function' ? http.postJSON : null;
    if (!post) throw new Error('core http.postJSON недоступен');

    const body = { text: String(confText || '') };
    if (desiredName) body.name = String(desiredName || '');

    const data = await post('/api/mihomo/parse/wireguard', body);
    if (!data || data.ok === false) throw new Error((data && data.error) ? data.error : 'parse/wireguard failed');

    const proxy_name = String(data.proxy_name || data.name || '').trim();
    const proxy_yaml = String(data.proxy_yaml || data.proxy || data.yaml || '').trimEnd() + '\n';
    if (!proxy_name || !proxy_yaml) throw new Error('WireGuard: пустой результат парсинга');

    return { type: 'proxy', proxy_name, content: proxy_yaml };
  }


  // ---------------------------------------------------------------------------
  // UI Actions
  // ---------------------------------------------------------------------------

  async function parseInput() {
    const inp = $(IDS.input);
    const rawText = inp ? String(inp.value || '') : '';
    const mode = getImportMode();

    if (!rawText.trim()) {
      const msg =
        mode === 'wireguard'
          ? 'Вставь WireGuard (.conf) и нажми «Преобразовать».'
          : 'Вставь ссылку узла или https-подписку.';
      setStatus(msg, true);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    const existing = getEditorText() || '';
    let tmp = existing;

    const outputs = [];
    const errors = [];

    // WireGuard mode: parse whole textarea as a single .conf
    if (mode === 'wireguard') {
      setStatus('Разбираю WireGuard…', false);
      try {
        let out = await parseWireguardViaApi(rawText, null);
        // Ensure unique name against current config.yaml
        if (configHasProxyName(existing, out.proxy_name)) {
          const unique = makeUniqueName(out.proxy_name, existing);
          out = await parseWireguardViaApi(rawText, unique);
        }
        outputs.push({ ...out, uri: 'wireguard.conf' });
      } catch (e) {
        const msg = e && e.message ? e.message : String(e || 'ошибка');
        // Make error a bit more readable for typical missing-key issue
        const human = msg.includes('missing mandatory keys')
          ? 'Некорректный WireGuard (.conf): нет PrivateKey/PublicKey/Endpoint'
          : msg;
        errors.push(human);
      }
    } else {
      // Line-based parsing (auto/proxy/subscription)
      const lines = rawText
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter(Boolean);

      if (!lines.length) {
        setStatus('Вставь данные и нажми «Преобразовать».', true);
        setHint('');
        setPreview('');
        const ins = $(IDS.btnInsert);
        if (ins) ins.disabled = true;
        return;
      }

      for (const line of lines) {
        try {
          if (mode === 'subscription' && !/^https?:\/\//i.test(line)) {
            throw new Error('Ожидается HTTPS‑подписка (URL начинается с http/https)');
          }
          if (mode === 'proxy' && /^https?:\/\//i.test(line)) {
            throw new Error('Это похоже на подписку. Выбери «HTTPS subscription» или «Auto».');
          }

          const out = generateConfigForMihomo(line, tmp);

          if (mode === 'subscription' && out.type !== 'proxy-provider') {
            throw new Error('Не удалось распознать URL подписки');
          }
          if (mode === 'proxy' && out.type !== 'proxy') {
            throw new Error('Не удалось распознать ссылку узла');
          }

          outputs.push({ ...out, uri: line });
          tmp += '\n' + out.content;
        } catch (e) {
          errors.push(`${line}: ${e && e.message ? e.message : 'ошибка'}`);
        }
      }
    }

    if (!outputs.length) {
      setStatus(errors.join('\n') || 'Не удалось распознать данные.', true);
      setHint('');
      setPreview('');
      const ins = $(IDS.btnInsert);
      if (ins) ins.disabled = true;
      return;
    }

    _lastResult = { outputs };

    // Build preview
    const preview = outputs
      .map((o) => {
        if (o.type === 'proxy-provider') {
          return `# proxy-providers\n${String(o.content || '').trimEnd()}`;
        }
        const raw = String(o.content || '').trimEnd();
        const ind = raw.split('\n').map((l) => (l ? '  ' + l : l)).join('\n');
        return `# proxies\n${ind}`;
      })
      .join('\n\n');

    setPreview(preview + '\n');

    const targets = Array.from(new Set(outputs.map((o) => (o.type === 'proxy-provider' ? 'proxy-providers' : 'proxies'))));
    setHint('Будет добавлено в секцию: ' + targets.join(' + '));

    if (errors.length) {
      setStatus('Часть данных распознана, часть — нет. Проверь строки ниже в preview.', true);
      setPreview(preview + '\n\n# Ошибки\n' + errors.map((x) => '# ' + x).join('\n') + '\n');
    } else {
      setStatus('Готово. Нажми «Вставить в конфиг».', false);
    }

    const ins = $(IDS.btnInsert);
    if (ins) ins.disabled = false;
  }

  async function insertIntoEditor() {
    if (!_lastResult || !_lastResult.outputs || !_lastResult.outputs.length) {
      setStatus('Сначала нажми «Преобразовать».', true);
      return;
    }

    const btnIns = $(IDS.btnInsert);
    const btnParse = $(IDS.btnParse);

    if (btnIns) {
      btnIns.disabled = true;
      try { btnIns.classList.add('loading'); } catch (e) {}
    }
    if (btnParse) {
      btnParse.disabled = true;
      try { btnParse.classList.add('loading'); } catch (e2) {}
    }

    setStatus('Вставляю в config.yaml…', false);

    try {
      let txt = getEditorText() || '';

      // 1) Providers — локальный патч (секция proxy-providers)
      txt = insertProvidersIntoConfig(txt, _lastResult.outputs);

      // 2) Proxies — через backend apply_insert (вставка + добавление в proxy-groups)
      const groups = readSelectedGroupsFromUi();
      const proxies = _lastResult.outputs.filter((o) => o.type === 'proxy');

      for (const o of proxies) {
        txt = await applyInsertProxy(txt, o, groups);
      }

      setEditorText(txt);
      refreshEditor();

      // Persist groups selection if requested
      try { maybePersistGroupsSelection(); } catch (e3) {}

      showModal(false);
      toastMsg('Добавлено в config.yaml ✅', false);

      try {
        // mark last activity badge
        if (typeof window.updateLastActivity === 'function') {
          const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
          window.updateLastActivity('modified', 'mihomo', fp);
        }
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      setStatus('Ошибка вставки: ' + (e && e.message ? e.message : String(e || 'ошибка')), true);
      // keep modal open
    } finally {
      if (btnIns) {
        btnIns.disabled = false;
        try { btnIns.classList.remove('loading'); } catch (e5) {}
      }
      if (btnParse) {
        btnParse.disabled = false;
        try { btnParse.classList.remove('loading'); } catch (e6) {}
      }
    }
  }


  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  MI.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoImportInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoImportInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnCancel, () => showModal(false));

    // Groups (proxy-groups) selection helpers
    wireButton(IDS.groupsAllBtn, () => { setAllGroupsChecked(true); maybePersistGroupsSelection(); });
    wireButton(IDS.groupsNoneBtn, () => { setAllGroupsChecked(false); maybePersistGroupsSelection(); });

    // Import mode selector
    const modeSel = $(IDS.modeSelect);
    if (modeSel && (!modeSel.dataset || modeSel.dataset.mihomoImportModeBound !== '1')) {
      modeSel.addEventListener('change', () => {
        try { updateModeUi(); } catch (e) {}
        try { saveImportModePref(getImportMode()); } catch (e2) {}
      });
      if (modeSel.dataset) modeSel.dataset.mihomoImportModeBound = '1';
    }

    wireButton(IDS.btnParse, () => parseInput());
    wireButton(IDS.btnInsert, () => insertIntoEditor());

    // Persist groups selection (if remember enabled)
    const rememberCb = $(IDS.groupsRemember);
    if (rememberCb && (!rememberCb.dataset || rememberCb.dataset.mihomoImportGroupsBound !== '1')) {
      rememberCb.addEventListener('change', () => { try { maybePersistGroupsSelection(); } catch (e) {} });
      if (rememberCb.dataset) rememberCb.dataset.mihomoImportGroupsBound = '1';
    }

    const groupsBox = $(IDS.groupsBox);
    if (groupsBox && (!groupsBox.dataset || groupsBox.dataset.mihomoImportGroupsBound !== '1')) {
      groupsBox.addEventListener('change', () => { try { maybePersistGroupsSelection(); } catch (e) {} });
      if (groupsBox.dataset) groupsBox.dataset.mihomoImportGroupsBound = '1';
    }

    // Engine toggle (preview)
    const sel = $(IDS.engineSelect);
    if (sel && !(sel.dataset && sel.dataset.xkWired === '1')) {
      if (sel.dataset) sel.dataset.xkWired = '1';
      sel.addEventListener('change', async () => {
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set(sel.value); } catch (e) {}
        scheduleEngineSync();
      });
    }

    // Listen for global engine changes
    if (!_engineUnsub) {
      const ee = getEngineHelper();
      if (ee && typeof ee.onChange === 'function') {
        _engineUnsub = ee.onChange((d) => {
          try { setEngineSelectValue(d && d.engine ? d.engine : 'codemirror'); } catch (e) {}
          if (modalOpen()) scheduleEngineSync();
        });
      }
    }

    // Close on backdrop click (outside content)
    if (!modal.dataset || modal.dataset.xkBackdrop !== '1') {
      modal.addEventListener('click', (e) => {
        try {
          const content = modal.querySelector('.modal-content');
          if (!content) return;
          if (e.target === modal) showModal(false);
        } catch (err) {}
      });
      if (modal.dataset) modal.dataset.xkBackdrop = '1';
    }

    // Ctrl+Enter = parse, Ctrl+Shift+Enter = insert
    const inp = $(IDS.input);
    if (inp && (!inp.dataset || inp.dataset.xkKeys !== '1')) {
      inp.addEventListener('keydown', (e) => {
        try {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) insertIntoEditor();
            else parseInput();
          }
        } catch (err) {}
      });
      if (inp.dataset) inp.dataset.xkKeys = '1';
    }
  };
})();
export function getMihomoImportApi() {
  try {
    if (mihomoImportModuleApi && typeof mihomoImportModuleApi.init === 'function') return mihomoImportModuleApi;
  }
  catch (error) {}
  return null;
}

function callMihomoImportApi(method, ...args) {
  const api = getMihomoImportApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initMihomoImport(...args) {
  return callMihomoImportApi('init', ...args);
}

export function generateMihomoImportConfig(...args) {
  return callMihomoImportApi('generateConfigForMihomo', ...args);
}

export function proxyYamlRawFromIndentedMihomo(...args) {
  return callMihomoImportApi('proxyYamlRawFromIndented', ...args);
}

export const mihomoImportApi = Object.freeze({
  get: getMihomoImportApi,
  init: initMihomoImport,
  generateConfigForMihomo: generateMihomoImportConfig,
  proxyYamlRawFromIndented: proxyYamlRawFromIndentedMihomo,
});
