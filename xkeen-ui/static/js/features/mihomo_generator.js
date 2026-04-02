import {
  getMihomoCommandJobApi,
  getMihomoEditorActionsApi,
  getMihomoEditorEngineApi,
} from './mihomo_runtime.js';
import {
  attachXkeenEditorToolbar,
  buildXkeenEditorCommonKeys,
  getXkeenEditorToolbarDefaultItems,
  getXkeenEditorToolbarIcons,
  getXkeenEditorToolbarMiniItems,
} from './xkeen_runtime.js';

let mihomoGeneratorModuleApi = null;

(() => {
  mihomoGeneratorModuleApi = (() => {
    let inited = false;

    function afterNextPaint(fn) {
      if (typeof fn !== 'function') return;
      try {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            window.setTimeout(fn, 0);
          });
          return;
        }
      } catch (e) {}
      window.setTimeout(fn, 0);
    }

    function duringIdle(fn, timeout = 240) {
      if (typeof fn !== 'function') return;
      try {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => fn(), { timeout });
          return;
        }
      } catch (e) {}
      afterNextPaint(fn);
    }

    function init() {
      if (inited) return;
      inited = true;

      // The generator UI exists only on mihomo_generator.html
      if (!document.getElementById('profileSelect')) return;

        // ---- constants ----
        const RULE_GROUP_PRESETS = [
          // Контентные сервисы
          { id: "YouTube",   label: "YouTube / видео" },
          { id: "Discord",   label: "Discord" },
          { id: "Twitch",    label: "Twitch" },
          { id: "Reddit",    label: "Reddit" },
          { id: "Spotify",   label: "Spotify" },
          { id: "Steam",     label: "Steam / игры" },
          { id: "Telegram",  label: "Telegram" },

          // Крупные сети / соцсети
          { id: "Meta",      label: "Meta / Facebook" },
          { id: "Twitter",   label: "Twitter / X" },

          // CDN / хостинги
          { id: "CDN",       label: "CDN / хостинги" },

          // Общие сервисы
          { id: "Google",    label: "Google" },
          { id: "GitHub",    label: "GitHub" },
          { id: "AI",        label: "AI сервисы" },

          // QUIC и базовая группа блокировок всегда включены и не управляются из UI
        ];


        // Active list of rule IDs that should be shown for the current profile.
        // Filled from backend (/api/mihomo/profile_defaults).
        let availableRuleGroupIds = RULE_GROUP_PRESETS.map(p => p.id);
      
        // To avoid duplicating listeners on the "select all" checkbox when
        // re-rendering the list.
        let ruleGroupsSelectAllInited = false;
      
        const SKELETON = `#######################################################################################################
      # Описание:
      # Веб-интерфейс доступен по адресу http://192.168.1.1:9090/ui (вместо 192.168.1.1 может быть любой IP, где запущен данный конфиг). После добавления сервера и запуска mihomo необходимо зайти в веб-интерфейс и выбрать нужное подключение для прокси-групп
      # Группа "Заблок. сервисы" содержит список доменов большинства заблокированных ресурсов (как снаружи, так и внутри)
      # Остальные группы YouTube/Discord и тд имеют приоритет над группой "Заблок. сервисы". Eсли переопределение не нужно, можно выбрать "Заблок. сервисы" в качестве подключения и управлять всеми группами разом в группе "Заблок. сервисы"
      #######################################################################################################
      # Для работы Discord требуется проксировать порты XKeen: 80,443,2000:2300,8443,19200:19400,50000:50030
      # Для работы Whatsapp/Telegram требуется проксировать порты Xkeen: 80,443,596:599,1400,3478,5222
      #######################################################################################################
      
      log-level: silent
      allow-lan: true
      redir-port: 5000
      tproxy-port: 5001
      ipv6: true
      mode: rule
      external-controller: 0.0.0.0:9090
      external-ui: zashboard
      external-ui-url: https://github.com/Zephyruso/zashboard/releases/latest/download/dist.zip
      profile: { store-selected: true }
      
      sniffer:
        enable: true
        sniff:
          HTTP:
          TLS:
          QUIC:
      
      anchors:
        a1: &domain { type: http, format: mrs, behavior: domain, interval: 86400 }
        a2: &ipcidr { type: http, format: mrs, behavior: ipcidr, interval: 86400 }
        a3: &classical { type: http, format: text, behavior: classical, interval: 86400 }
        a4: &inline { type: inline, behavior: classical }
      
      #############################################################################################
      # Пример VLESS подключения БЕЗ использования подписки #
      #############################################################################################
      
      
      ######################################################################################
      # Подключение С использованием подписки #
      ######################################################################################
      
      
      proxy-groups:
        - name: Заблок. сервисы
          type: select
          icon: https://cdn.jsdelivr.net/gh/Koolson/Qure@master/IconSet/Color/Reject.png
          include-all: true
      
        - name: QUIC
          type: select
          icon: https://github.com/zxc-rv/assets/raw/refs/heads/main/group-icons/quic.png
          proxies: [REJECT, PASS]
      
        - MATCH,DIRECT
      `;
      
      
        // ---- DOM refs ----
        const profileSelect = document.getElementById("profileSelect");
        const defaultGroupsInput = document.getElementById("defaultGroupsInput");
        const subscriptionsList = document.getElementById("subscriptionsList");
        const addSubscriptionBtn = document.getElementById("addSubscriptionBtn");
        const ruleGroupsList = document.getElementById("ruleGroupsList");
        const ruleGroupsSelectAll = document.getElementById("ruleGroupsSelectAll");
        const proxiesList = document.getElementById("proxiesList");
        const addProxyBtn = document.getElementById("addProxyBtn");
        const bulkImportBtn = document.getElementById("bulkImportBtn");
        const normalizeProxiesBtn = document.getElementById("normalizeProxiesBtn");
        const generateBtn = document.getElementById("generateBtn");
        const saveBtn = document.getElementById("saveBtn");
        const validateBtn = document.getElementById("validateBtn");
        const applyBtn = document.getElementById("applyBtn");
        const editToggle = document.getElementById("editToggle");
        const copyBtn = document.getElementById("copyBtn");
        const statusMessage = document.getElementById("statusMessage");
        const previewTextarea = document.getElementById("previewTextarea");
        const previewEngineSelect = document.getElementById("mihomo-preview-engine-select");
        const previewMonacoHost = document.getElementById("previewMonaco");
        const validationLogEl = document.getElementById("validationLog");
        const clearValidationLogBtn = document.getElementById("clearValidationLogBtn");
        const corePillEl = document.getElementById("xkeen-core-pill");

        // Bulk import modal
        const bulkImportModal = document.getElementById("bulkImportModal");
        const bulkImportTextarea = document.getElementById("bulkImportTextarea");
        const bulkImportClearExisting = document.getElementById("bulkImportClearExisting");
        const bulkImportToSubscriptions = document.getElementById("bulkImportToSubscriptions");
        const bulkImportDedup = document.getElementById("bulkImportDedup");
        const bulkImportNameTemplate = document.getElementById("bulkImportNameTemplate");
        const bulkImportGroupsTemplate = document.getElementById("bulkImportGroupsTemplate");
        const bulkImportAutoGeo = document.getElementById("bulkImportAutoGeo");
        const bulkImportAutoRegionGroup = document.getElementById("bulkImportAutoRegionGroup");
        const bulkImportApplyBtn = document.getElementById("bulkImportApplyBtn");
        const bulkImportOverwriteName = document.getElementById("bulkImportOverwriteName");
        const bulkImportOverwriteGroups = document.getElementById("bulkImportOverwriteGroups");
        const bulkImportApplyExistingBtn = document.getElementById("bulkImportApplyExistingBtn");

        // Unified premium result modal (preview / validate / apply)
        const mihomoResultModal = document.getElementById("mihomoResultModal");
        const mihomoResultModalKicker = document.getElementById("mihomoResultModalKicker");
        const mihomoResultModalTitle = document.getElementById("mihomoResultModalTitle");
        const mihomoResultModalSubtitle = document.getElementById("mihomoResultModalSubtitle");
        const mihomoResultModalIcon = document.getElementById("mihomoResultModalIcon");
        const mihomoResultModalLeadTitle = document.getElementById("mihomoResultModalLeadTitle");
        const mihomoResultModalLeadDesc = document.getElementById("mihomoResultModalLeadDesc");
        const mihomoResultModalBadge = document.getElementById("mihomoResultModalBadge");
        const mihomoResultSummaryWrap = document.getElementById("mihomoResultSummaryWrap");
        const mihomoResultSummary = document.getElementById("mihomoResultSummary");
        const mihomoResultWarningsWrap = document.getElementById("mihomoResultWarningsWrap");
        const mihomoResultWarnings = document.getElementById("mihomoResultWarnings");
        const mihomoResultErrorsWrap = document.getElementById("mihomoResultErrorsWrap");
        const mihomoResultErrors = document.getElementById("mihomoResultErrors");
        const mihomoResultMetaWrap = document.getElementById("mihomoResultMetaWrap");
        const mihomoResultLogWrap = document.getElementById("mihomoResultLogWrap");
        const mihomoResultModalLog = document.getElementById("mihomoResultModalLog");
        const mihomoResultJumpBtn = document.getElementById("mihomoResultJumpBtn");
        const mihomoResultCopyBtn = document.getElementById("mihomoResultCopyBtn");

        let validationLogRaw = "";
        let _lastMihomoResultPayload = null;

        // ---- active core indicator (Mihomo generator page) ----
        let _lastKnownCore = '';

        function _setCorePill(core, running) {
          if (!corePillEl) return;
          const c = String(core || '').toLowerCase();
          const isRunning = !!running;

          let label = '';
          if (!isRunning) label = 'не запущено';
          else if (c === 'mihomo') label = 'mihomo';
          else if (c === 'xray') label = 'xray';
          else label = 'неизвестно';

          corePillEl.textContent = 'Ядро: ' + label;
          if (corePillEl.dataset) corePillEl.dataset.core = (c === 'mihomo' || c === 'xray') ? c : '';
          corePillEl.classList.toggle('has-core', isRunning && (c === 'mihomo' || c === 'xray'));
        }

        async function refreshActiveCorePill(opts) {
          const o = opts || {};
          try {
            const res = await fetch('/api/xkeen/status');
            const data = await res.json().catch(() => ({}));
            if (!res.ok || data.ok === false) throw new Error((data && data.error) ? data.error : ('HTTP ' + res.status));

            const core = (data && data.core) ? String(data.core) : '';
            const running = !!(data && data.running);

            if (core) _lastKnownCore = core;
            _setCorePill(core, running);

            if (!o.silent && running) {
              try {
                const label = core ? String(core) : 'неизвестно';
                toast('Активное ядро: ' + label, 'info');
              } catch (e) {}
            }
            return { core, running };
          } catch (e) {
            _setCorePill(_lastKnownCore, true);
            return { core: _lastKnownCore, running: true, error: String(e || '') };
          }
        }
      
        function escapeHtml(str) {
          if (!str) return "";
          return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }
      
        function formatLogHtml(text) {
          if (!text) return "";
          const lines = String(text).replace(/\r\n/g, "\n").split("\n");
          return lines.map((line) => {
            const safe = escapeHtml(line);
            let cls = "log-line";
            if (/fatal|panic/i.test(line)) cls += " log-fatal";
            else if (/error|\berr\b|err\[/i.test(line)) cls += " log-error";
            else if (/warn/i.test(line)) cls += " log-warn";
            else if (/info/i.test(line)) cls += " log-info";
            else if (/debug/i.test(line)) cls += " log-debug";
            return '<div class="' + cls + '">' + (safe || "&nbsp;") + "</div>";
          }).join("");
        }
      
        let editor = null;

// ----- Engine toggle (CodeMirror / Monaco) -----
let _engine = 'codemirror';
let _engineTouched = false;
let _engineSyncing = false;
let _monaco = null;
let _monacoFacade = null;
let _monacoFsWired = false;
let _active = null; // facade: {getValue,setValue,focus,layout,dispose}
let _isEditable = false;

const CM6_SCOPE = 'mihomo-generator';

function withCm6Scope(opts) {
  return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
}

function normalizeEngine(v) {
  const s = String(v || '').toLowerCase();
  return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
}

function getEngineHelper() {
  return getMihomoEditorEngineApi();
}

function getEditorActions() {
  return getMihomoEditorActionsApi();
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

function showCmToolbar(show) {
  try {
    if (editor && editor._xkeenToolbarEl) editor._xkeenToolbarEl.style.display = show ? '' : 'none';
  } catch (e) {}
}

function cmFacade() {
  const cm = editor;
  const helper = getEngineHelper();
  if (!cm || !helper || typeof helper.fromCodeMirror !== 'function') return null;
  try {
    return helper.fromCodeMirror(cm, {
      layout: () => {
        try { cm.refresh(); } catch (e) {}
      },
    });
  } catch (e) {}
  return null;
}

function showCodeMirror(show) {
  const w = cmWrapper(editor);
  if (w) {
    if (show) showNode(w); else hideNode(w);
    if (show) { try { if (editor && editor.refresh) editor.refresh(); } catch (e) {} }
  }
}

function showMonaco(show) {
  const host = previewMonacoHost;
  if (!host) return;
  if (show) showNode(host); else hideNode(host);
  if (show && _monaco && typeof _monaco.layout === 'function') {
    try {
      const runtime = getEditorRuntime('monaco');
      if (runtime && typeof runtime.layoutOnVisible === 'function') runtime.layoutOnVisible(_monaco, host);
      else _monaco.layout();
    } catch (e) {}
    try { setTimeout(() => { try { _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
  }
}

// ------------------------ fullscreen (CodeMirror + Monaco) ------------------------

function _syncToolbarFsClass(isFs) {
  try {
    if (editor && editor._xkeenToolbarEl) editor._xkeenToolbarEl.classList.toggle('is-fullscreen', !!isFs);
  } catch (e) {}
}

function syncToolbarForEngine(engine) {
  try {
    if (!editor || !editor._xkeenToolbarEl || !editor._xkeenToolbarEl.querySelectorAll) return;
    const bar = editor._xkeenToolbarEl;
    const isMonaco = (String(engine || '').toLowerCase() === 'monaco');

    bar.style.display = '';
    const btns = bar.querySelectorAll('button.xkeen-cm-tool');

    // Prefer the real CodeMirror fullscreen action when it exists; otherwise fall back to fs_any.
    let hasFs = false;
    (btns || []).forEach((btn) => {
      try {
        const id = (btn.dataset && btn.dataset.actionId) ? String(btn.dataset.actionId) : '';
        if (id === 'fs') hasFs = true;
      } catch (e) {}
    });

    (btns || []).forEach((btn) => {
      const id = (btn.dataset && btn.dataset.actionId) ? String(btn.dataset.actionId) : '';
      const isFs = (id === 'fs');
      const isFsAny = (id === 'fs_any');

      if (isMonaco) {
        // In Monaco mode show only one fullscreen button: fs (preferred) or fs_any.
        btn.style.display = hasFs ? (isFs ? '' : 'none') : (isFsAny ? '' : 'none');
      } else {
        // In CodeMirror mode hide the fallback button to avoid duplicates.
        btn.style.display = isFsAny ? 'none' : '';
      }
    });
  } catch (e) {}
}


function isMonacoFullscreen() {
  try {
    return !!(previewMonacoHost && previewMonacoHost.classList && previewMonacoHost.classList.contains('is-fullscreen'));
  } catch (e) {}
  return false;
}

function setMonacoFullscreen(on) {
  if (!previewMonacoHost) return;
  const host = previewMonacoHost;
  const enabled = !!on;

  const st = host.__xkFs || (host.__xkFs = { on: false, placeholder: null, parent: null, next: null });

  if (enabled) {
    if (!st.on) {
      st.on = true;
      try {
        st.parent = host.parentNode;
        st.next = host.nextSibling;
        st.placeholder = document.createComment('xk-monaco-fs');
        if (st.parent) st.parent.insertBefore(st.placeholder, st.next);
      } catch (e) {}
      try { document.body.appendChild(host); } catch (e) {}
    }

    try { host.classList.add('is-fullscreen'); } catch (e) {}
    try { document.body.classList.add('xk-no-scroll'); } catch (e) {}
  } else {
    try { host.classList.remove('is-fullscreen'); } catch (e) {}
    try { document.body.classList.remove('xk-no-scroll'); } catch (e) {}

    if (st.on) {
      st.on = false;
      try {
        if (st.placeholder && st.placeholder.parentNode) {
          st.placeholder.parentNode.replaceChild(host, st.placeholder);
        } else if (st.parent) {
          st.parent.insertBefore(host, st.next || null);
        }
      } catch (e) {}
      st.placeholder = null;
      st.parent = null;
      st.next = null;
    }
  }

  // Keep toolbar above fullscreen editor.
  try { _syncToolbarFsClass(enabled); } catch (e) {}
  try { setTimeout(() => { try { _syncToolbarFsClass(enabled); } catch (e2) {} }, 0); } catch (e3) {}

  try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e) {}
  try { setTimeout(() => { try { if (_monaco && typeof _monaco.layout === 'function') _monaco.layout(); } catch (e2) {} }, 0); } catch (e3) {}
  try { if (_monaco && typeof _monaco.focus === 'function') _monaco.focus(); } catch (e) {}
}

function wireMonacoFullscreenOnce() {
  if (_monacoFsWired) return;
  _monacoFsWired = true;
  document.addEventListener('keydown', (e) => {
    try {
      if (!e || e.key !== 'Escape') return;
      if (_engine !== 'monaco') return;
      if (!isMonacoFullscreen()) return;
      setMonacoFullscreen(false);
    } catch (err) {}
  }, true);
}

function toggleEditorFullscreen(cm) {
  if (_engine === 'monaco') {
    try { wireMonacoFullscreenOnce(); } catch (e) {}
    setMonacoFullscreen(!isMonacoFullscreen());
    return;
  }

  const ed = cm || editor;
  try {
    const actions = getEditorActions();
    if (actions && typeof actions.toggleFullscreen === 'function' && actions.toggleFullscreen(ed)) return;
  } catch (e) {}
  try {
    if (ed && typeof ed.getOption === 'function' && typeof ed.setOption === 'function') ed.setOption('fullScreen', !ed.getOption('fullScreen'));
  } catch (e) {}
}

async function ensureMonacoEditor(initialValue) {
  if (_monaco) return _monaco;
  if (!previewMonacoHost) return null;
  const runtime = await ensureEditorRuntime('monaco');
  if (!runtime || typeof runtime.create !== 'function') return null;

  const value = String(initialValue ?? '');
  try {
    _monaco = await runtime.create(previewMonacoHost, {
      language: 'yaml',
      value,
      readOnly: !_isEditable,
      tabSize: 2,
      insertSpaces: true,
      wordWrap: 'on',
    });
    if (!_monaco) return null;
    try {
      const helper = getEngineHelper();
      _monacoFacade = (helper && typeof helper.fromMonaco === 'function') ? helper.fromMonaco(_monaco) : null;
    } catch (e) {
      _monacoFacade = null;
    }
    return _monaco;
  } catch (e) {
    try { console.error(e); } catch (e2) {}
    return null;
  }
}

function getEditorText() {
  try { return _active ? String(_active.get() || '') : (editor ? String(editor.getValue() || '') : ''); } catch (e) { return ''; }
}

function setEditorText(text) {
  if (!_active) return;
  try { _active.set(String(text ?? '')); } catch (e) {}
}

function setEngineSelectValue(engine) {
  if (!previewEngineSelect) return;
  try { previewEngineSelect.value = normalizeEngine(engine); } catch (e) {}
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

async function switchEngine(nextEngine, opts) {
  const next = normalizeEngine(nextEngine);
  if (!next) return _engine;
  if (next === _engine && !(opts && opts.force)) return _engine;
  if (_engineSyncing) return _engine;

  _engineSyncing = true;
  try {
    const currentText = getEditorText();

    if (next === 'monaco') {
      // If CodeMirror was in fullscreen, exit it first to avoid CSS/layout glitches.
      try {
        const actions = getEditorActions();
        if (actions && typeof actions.setFullscreen === 'function') actions.setFullscreen(editor, false);
        else if (editor && editor.getOption && editor.setOption && editor.getOption('fullScreen')) editor.setOption('fullScreen', false);
      } catch (e0) {}

      const ed = await ensureMonacoEditor(currentText);
      if (!ed) {
        // Fallback to CodeMirror and persist it to global helper (best-effort).
        try {
          const ee = getEngineHelper();
          if (ee && typeof ee.set === 'function') ee.set('codemirror');
        } catch (e2) {}
        setEngineSelectValue('codemirror');
        showMonaco(false);
        showCodeMirror(true);
        showCmToolbar(true);
        try { syncToolbarForEngine('codemirror'); } catch (e) {}
        _active = cmFacade();
        _engine = 'codemirror';
        return _engine;
      }

      // Sync text from CodeMirror to Monaco on entry.
      try {
        if (_monacoFacade && typeof _monacoFacade.set === 'function') _monacoFacade.set(String(currentText || ''));
        else if (ed && ed.setValue) ed.setValue(String(currentText || ''));
      } catch (e3) {}

      // Apply current editable flag
      try { if (ed && ed.updateOptions) ed.updateOptions({ readOnly: !_isEditable }); } catch (e4) {}

      showCodeMirror(false);
      // Keep toolbar visible in Monaco mode (only fullscreen button is shown).
      showCmToolbar(true);
      showMonaco(true);

      try { syncToolbarForEngine('monaco'); } catch (e) {}
      try { wireMonacoFullscreenOnce(); } catch (e) {}

      _engine = 'monaco';
      _active = _monacoFacade;
      try { if (_active && _active.focus) _active.focus(); } catch (e5) {}
      return _engine;
    }

    // Switch to CodeMirror (sync text back from Monaco).
    // If Monaco is fullscreen, exit it before hiding to avoid leaving body scroll locked.
    try { if (isMonacoFullscreen()) setMonacoFullscreen(false); } catch (e0) {}
    try {
      if (!editor) initEditor();
    } catch (e0) {}

    try { if (editor && editor.setValue) editor.setValue(String(currentText || '')); } catch (e6) {}

    // Apply current editable flag
    try { if (editor && editor.setOption) editor.setOption('readOnly', !_isEditable); } catch (e7) {}

    showMonaco(false);
    showCodeMirror(true);
    showCmToolbar(true);

    try { syncToolbarForEngine('codemirror'); } catch (e) {}

    _engine = 'codemirror';
    _active = cmFacade();
    try { if (editor && editor.focus) editor.focus(); } catch (e8) {}
    return _engine;
  } finally {
    _engineSyncing = false;
  }
}

function initEngineToggle() {
  if (!previewEngineSelect) return;
  if (previewEngineSelect.dataset && previewEngineSelect.dataset.xkWired === '1') return;

  // Initial value from settings/local fallback (async, non-blocking).
  (async () => {
    try {
      const pref = await resolvePreferredEngine();
      setEngineSelectValue(pref);
      await switchEngine(pref, { force: false });
    } catch (e) {}
  })();

  previewEngineSelect.addEventListener('change', async () => {
    const next = normalizeEngine(previewEngineSelect.value);
    _engineTouched = true;
    try {
      await switchEngine(next, { force: false });
      const ee = getEngineHelper();
      if (ee && typeof ee.set === 'function') {
        try { await ee.set(next); } catch (e) {}
      }
    } finally {
      try { setTimeout(() => { _engineTouched = false; }, 0); } catch (e) { _engineTouched = false; }
    }
  });

  if (previewEngineSelect.dataset) previewEngineSelect.dataset.xkWired = '1';

  // Keep in sync with other editors when preference changes globally.
  const ee = getEngineHelper();
  const onGlobal = (detail) => {
    try {
      if (_engineTouched) return;
      const eng = normalizeEngine(detail && detail.engine);
      if (!eng) return;
      try { if (previewEngineSelect.value !== eng) previewEngineSelect.value = eng; } catch (e) {}
      if (eng !== _engine) {
        switchEngine(eng, { force: false }).catch(() => {});
      }
    } catch (e) {}
  };

  try {
    if (ee && typeof ee.onChange === 'function') ee.onChange(onGlobal);
    else document.addEventListener('xkeen-editor-engine-change', (ev) => onGlobal(ev && ev.detail ? ev.detail : {}));
  } catch (e) {}
}

        function moveToolbarToHeader() {
          try {
            const host = document.getElementById('previewToolbarHost');
            if (host && editor && editor._xkeenToolbarEl) {
              host.appendChild(editor._xkeenToolbarEl);
            }
          } catch (e) {
            // ignore
          }
        }

        function resetToolbar() {
          if (!editor) return;
          try {
            if (editor._xkeenToolbarEl && editor._xkeenToolbarEl.parentNode) {
              editor._xkeenToolbarEl.parentNode.removeChild(editor._xkeenToolbarEl);
            }
          } catch (e) {}
          try { delete editor._xkeenToolbarEl; } catch (e) { editor._xkeenToolbarEl = null; }
        }

        function syncToolbarForEditable(isEditable) {
          try {
            if (!editor) return;
            resetToolbar();
            const baseItems = isEditable
              ? getXkeenEditorToolbarDefaultItems()
              : (getXkeenEditorToolbarMiniItems().length
                ? getXkeenEditorToolbarMiniItems()
                : getXkeenEditorToolbarDefaultItems());
            const icons = getXkeenEditorToolbarIcons();

            // Replace fullscreen action: it must work for the active engine (CodeMirror/Monaco).
            const items = baseItems.map((it) => {
              if (it && it.id === 'fs') return Object.assign({}, it, { onClick: (cm) => toggleEditorFullscreen(cm) });
              return it;
            });

            // Fallback fullscreen button for Monaco even when CM fullscreen addon isn't loaded.
            try {
              if (icons.fullscreen && !items.some((it) => it && it.id === 'fs_any')) {
                items.push({
                  id: 'fs_any',
                  svg: icons.fullscreen,
                  label: 'Фулскрин',
                  fallbackHint: 'F11 / Esc',
                  onClick: () => toggleEditorFullscreen(editor),
                });
              }
            } catch (e) {}

            attachXkeenEditorToolbar(editor, items);
            moveToolbarToHeader();
            try { syncToolbarForEngine(_engine); } catch (e) {}
          } catch (e) {
            // ignore
          }
        }
      
        // ---- auto-preview helpers ----
        let previewTimeout = null;
      
        function schedulePreview(delay = 300) {
          if (!_active) return;
          clearTimeout(previewTimeout);
          previewTimeout = setTimeout(() => {
            generatePreviewDemo(false);
          }, delay);
        }
      
        /**
         * Вешает автопредпросмотр на элемент.
         * @param {HTMLElement|null} el - элемент
         * @param {string[]} events - список событий, по умолчанию ["change", "blur"]
         * @param {number} delay - задержка перед запросом в мс
         */
        function autoPreviewOnChange(el, events = ["change", "blur"], delay = 300) {
          if (!el) return;
          const handler = () => schedulePreview(delay);
          events.forEach(ev => el.addEventListener(ev, handler));
        }
      
        // Обновление сводки состояния над предпросмотром
        function updateStateSummary(state) {
          const el = document.getElementById("stateSummary");
          if (!el) return;
          const profile = state.profile || "router_custom";
          const subs = (state.subscriptions || []).length;
          const proxies = (state.proxies || []).length;
          const enabledRuleGroups = state.enabledRuleGroups || [];
          const rgCount = enabledRuleGroups.length || 0;
          el.textContent =
            "Профиль: " + profile +
            " · Rule-групп: " + rgCount +
            " · Подписок: " + subs +
            " · Прокси: " + proxies;
        }
      
                // Мини-валидация состояния перед предпросмотром / применением
        function extractYamlProxyName(yamlText) {
          const s = String(yamlText || "");
          if (!s) return "";
          const m = s.match(/^\s*-\s*name\s*:\s*(.+?)\s*$/m);
          if (!m) return "";
          let raw = String(m[1] || "").trim();
          if (raw && !(raw.startsWith('"') || raw.startsWith("'"))) raw = raw.replace(/\s+#.*$/, "").trim();
          return raw.replace(/^['"]|['"]$/g, "").trim();
        }

        function extractWireguardEndpointHost(confText) {
          const s = String(confText || "");
          if (!s) return "";
          const m = s.match(/^\s*Endpoint\s*=\s*(.+?)\s*$/mi);
          if (!m) return "";
          const endpoint = String(m[1] || "").trim();
          if (!endpoint) return "";
          if (endpoint.startsWith("[")) {
            const idx = endpoint.indexOf("]");
            if (idx > 1) return endpoint.slice(1, idx).trim();
          }
          const lastColon = endpoint.lastIndexOf(":");
          if (lastColon > 0) return endpoint.slice(0, lastColon).trim();
          return endpoint;
        }

        function getProxyDisplayNameForValidation(proxy, idx) {
          if (!proxy || typeof proxy !== "object") return "";
          const explicit = String(proxy.name || "").trim();
          if (explicit) return explicit;

          const kind = String(proxy.kind || "").toLowerCase();
          if (kind === "yaml") return extractYamlProxyName(proxy.yaml || "");
          if (kind === "wireguard") return extractWireguardEndpointHost(proxy.config || "");

          const link = String(proxy.link || "").trim();
          if (link) {
            const meta = extractLinkMeta(link);
            return meta.nameFromLink || guessNameFromLink(link) || (meta.host ? (meta.host + (meta.port ? (":" + meta.port) : "")) : "");
          }

          return idx ? `proxy#${idx}` : "";
        }

        function validateState(state, mode) {
          const warnings = [];
          const errors = [];
          const subs = Array.isArray(state.subscriptions) ? state.subscriptions : [];
          const proxies = Array.isArray(state.proxies) ? state.proxies : [];

          // Нет ни одного источника прокси
          if (!subs.length && !proxies.length) {
            if (mode === "apply") {
              errors.push("Нет ни одной подписки и ни одного узла-прокси – применять такой конфиг опасно.");
            } else {
              warnings.push("Нет ни одной подписки и ни одного узла-прокси – конфиг будет без прокси.");
            }
          }

          // Дубли имён узлов создают неоднозначный YAML и ломают proxy-groups.
          const seenProxyNames = new Map();
          proxies.forEach((proxy, idx) => {
            const displayName = getProxyDisplayNameForValidation(proxy, idx + 1);
            if (!displayName) return;
            const key = String(displayName || "").trim();
            if (!key) return;
            if (seenProxyNames.has(key)) {
              errors.push(`Повторяющееся имя узла: ${key}. Имена узлов должны быть уникальны.`);
              return;
            }
            seenProxyNames.set(key, idx + 1);
          });

          proxies.forEach((proxy, idx) => {
            const groups = Array.isArray(proxy && proxy.groups) ? proxy.groups : [];
            if (!groups.length) return;
            const cleaned = groups.map((g) => String(g || "").trim()).filter(Boolean);
            if (cleaned.length !== groups.length) {
              warnings.push(`Узел #${idx + 1}: в списке групп были пустые значения, они будут проигнорированы.`);
            }
            const unique = uniqueStrings(cleaned);
            if (unique.length !== cleaned.length) {
              warnings.push(`Узел ${getProxyDisplayNameForValidation(proxy, idx + 1) || ("#" + (idx + 1))}: дубли групп будут автоматически схлопнуты.`);
            }
          });

          // Профиль app – просто предупреждение
          if (state.profile === "app") {
            warnings.push("Профиль «app»: прозрачная маршрутизация роутера отключена, конфиг работает как обычный клиент.");
          }

          return { valid: errors.length === 0, warnings: uniqueStrings(warnings), errors: uniqueStrings(errors) };
        }

        // ---- YAML helpers: validate default proxy-groups against generated config ----
        function _yamlParseScalar(raw) {
          if (raw == null) return "";
          let s = String(raw).trim();
          if (!s) return "";

          // Strip inline comment for plain scalars
          if (!(s.startsWith("'") || s.startsWith('"'))) {
            const idx = s.indexOf(" #");
            if (idx !== -1) s = s.slice(0, idx).trim();
          }

          if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
            return s.slice(1, -1).replace(/''/g, "'");
          }

          if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
            let inner = s.slice(1, -1);
            inner = inner
              .replace(/\\\\/g, "\\")
              .replace(/\\\"/g, '"')
              .replace(/\\n/g, "\n")
              .replace(/\\r/g, "\r")
              .replace(/\\t/g, "\t");
            return inner;
          }

          return s;
        }

        function _extractProxyGroupNamesFromYaml(yamlText) {
          const names = new Set();
          if (typeof yamlText !== "string" || !yamlText.trim()) return names;

          const lines = yamlText.split(/\r?\n/);
          let inSection = false;
          let baseIndent = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!inSection) {
              // Only accept top-level "proxy-groups:"
              if (/^proxy-groups\s*:/.test(line)) {
                inSection = true;
                baseIndent = (line.match(/^(\s*)/)?.[1] || "").length;
              }
              continue;
            }

            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) continue;

            const indent = (line.match(/^(\s*)/)?.[1] || "").length;

            // Stop when we reach a new top-level key
            if (indent <= baseIndent && /^[A-Za-z0-9_.-]+\s*:/.test(line)) break;

            const m = line.match(/^\s*-\s*name\s*:\s*(.+?)\s*$/);
            if (m) {
              const name = _yamlParseScalar(m[1]);
              if (name) names.add(name);
            }
          }
          return names;
        }

        function validateDefaultGroupsAgainstConfig(defaultGroups, yamlText) {
          const unknown = [];
          if (!Array.isArray(defaultGroups) || !defaultGroups.length) return { unknown };

          const known = _extractProxyGroupNamesFromYaml(yamlText);
          if (!known || !known.size) return { unknown }; // can't parse, do not warn

          defaultGroups.forEach(g => {
            if (g && !known.has(g)) unknown.push(g);
          });
          return { unknown };
        }

        function getBulkImportOptions() {
          return {
            clearExisting: !!(bulkImportClearExisting && bulkImportClearExisting.checked),
            toSubs: !!(bulkImportToSubscriptions && bulkImportToSubscriptions.checked),
            dedup: !!(bulkImportDedup && bulkImportDedup.checked),
            nameTemplate: (bulkImportNameTemplate && bulkImportNameTemplate.value) ? String(bulkImportNameTemplate.value) : "{name}",
            groupsTemplate: (bulkImportGroupsTemplate && bulkImportGroupsTemplate.value) ? String(bulkImportGroupsTemplate.value) : "",
            autoGeo: !!(bulkImportAutoGeo && bulkImportAutoGeo.checked),
            autoRegionGroup: !!(bulkImportAutoRegionGroup && bulkImportAutoRegionGroup.checked),
            overwriteName: !!(bulkImportOverwriteName && bulkImportOverwriteName.checked),
            overwriteGroups: !!(bulkImportOverwriteGroups && bulkImportOverwriteGroups.checked),
          };
        }

      
        // Автопредпросмотр для профиля / шаблона / списков групп
        autoPreviewOnChange(profileSelect, ["change"]);
      
        // При смене профиля подгружаем пресет групп/правил с бэкенда
        if (profileSelect) {
          profileSelect.addEventListener("change", () => {
            loadProfileDefaults(profileSelect.value);
          });
        }
          autoPreviewOnChange(defaultGroupsInput, ["input", "change", "blur"]);
      
        // Делегированный автопредпросмотр для карточек прокси
        if (proxiesList) {
          // input/select внутри карточек
          proxiesList.addEventListener("change", (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.matches("input, select")) {
              schedulePreview();
            }
          });
      
          // textarea (WG/yaml конфиги) — по input
          proxiesList.addEventListener("input", (e) => {
            const target = e.target;
            if (!(target instanceof HTMLElement)) return;
            if (target.matches("textarea")) {
              schedulePreview(400);
            }
          });
      
          // страхуемся на blur
          proxiesList.addEventListener(
            "blur",
            (e) => {
              const target = e.target;
              if (!(target instanceof HTMLElement)) return;
              if (target.matches("input, textarea, select")) {
                schedulePreview();
              }
            },
            true
          );
        }
      
      
        function setStatus(text, type) {
          statusMessage.textContent = text;
          statusMessage.classList.remove("ok", "warn", "err");
          if (type === "ok") statusMessage.classList.add("ok");
          if (type === "warn") statusMessage.classList.add("warn");
          if (type === "err") statusMessage.classList.add("err");
        }
        function setValidationLog(text) {
          if (!validationLogEl) return;
          validationLogRaw = text || "";
          validationLogEl.innerHTML = formatLogHtml(validationLogRaw);
          validationLogEl.scrollTop = validationLogEl.scrollHeight;
        }
      
        function appendValidationLog(text) {
          if (!validationLogEl) return;
          const extra = text || "";
          validationLogRaw = validationLogRaw
            ? validationLogRaw + "\n" + extra
            : extra;
          validationLogEl.innerHTML = formatLogHtml(validationLogRaw);
          validationLogEl.scrollTop = validationLogEl.scrollHeight;
        }

        let _restartLogModulePromise = null;

        function loadRestartLogModule() {
          if (!_restartLogModulePromise) {
            _restartLogModulePromise = import('./restart_log.js').catch((error) => {
              _restartLogModulePromise = null;
              throw error;
            });
          }
          return _restartLogModulePromise;
        }

        async function getSharedRestartLogApi() {
          try {
            const mod = await loadRestartLogModule();
            const api = mod && typeof mod.getRestartLogApi === 'function' ? mod.getRestartLogApi() : null;
            return api || null;
          } catch (e) {}
          return null;
        }

        async function clearSharedRestartLog() {
          try {
            const api = await getSharedRestartLogApi();
            if (api && typeof api.prepareLiveStream === 'function') {
              api.prepareLiveStream({ clear: true, reveal: true });
              return;
            }
          } catch (e) {}
          try {
            const api = await getSharedRestartLogApi();
            if (api && typeof api.reveal === 'function') {
              api.reveal();
            }
          } catch (e) {}
          try {
            const api = await getSharedRestartLogApi();
            if (api && typeof api.setRaw === 'function') {
              api.setRaw('');
              return;
            }
          } catch (e) {}
          try {
            const api = await getSharedRestartLogApi();
            if (api && typeof api.clear === 'function') {
              api.clear();
            }
          } catch (e) {}
        }

        async function appendSharedRestartLog(text) {
          if (!text) return;
          try {
            const api = await getSharedRestartLogApi();
            if (api && typeof api.append === 'function') {
              api.append(String(text));
            }
          } catch (e) {}
        }
      
        function jumpToErrorPositionFromLog(log) {
  if (!log) return;
  // Ищем паттерны вида "line 12 column 5" или "at line 23, column 1"
  const re = /(line|строка)[^0-9]*(\d+)[^0-9]+(column|col|столбец)?[^0-9]*(\d+)?/i;
  const m = log.match(re);
  if (!m) return;
  const lineNum = parseInt(m[2], 10);
  const colNum = m[4] ? parseInt(m[4], 10) : 1;
  if (!Number.isFinite(lineNum) || lineNum <= 0) return;

  try {
    if (_engine === 'monaco' && _monaco) {
      const pos = { lineNumber: lineNum, column: (colNum > 0 ? colNum : 1) };
      try { _monaco.setPosition(pos); } catch (e) {}
      try { _monaco.revealPositionInCenter(pos); } catch (e) {}
      try { _monaco.focus(); } catch (e) {}
      setStatus("Ошибка около строки " + lineNum + ", столбец " + colNum + ".", "err");
      return;
    }
  } catch (e) {}

  if (!editor) return;

  const line = lineNum - 1;
  const ch = colNum > 0 ? colNum - 1 : 0;
  try {
    editor.setCursor({ line, ch });
    editor.scrollIntoView({ line, ch }, 100);
    setStatus("Ошибка около строки " + lineNum + ", столбец " + colNum + ".", "err");
  } catch (e) {
    console.warn("Failed to move cursor to error position", e);
  }
        }
      
      
        // ----- CodeMirror init -----
        function getCurrentCmTheme() {
          try {
            return (document.documentElement.getAttribute('data-theme') === 'light') ? 'default' : 'material-darker';
          } catch (e) {
            return 'material-darker';
          }
        }

        function getPreviewEditorExtraKeys() {
          return Object.assign({}, buildXkeenEditorCommonKeys(), {
            'Ctrl-F': 'findPersistent',
            'Cmd-F': 'findPersistent',
            'Ctrl-G': 'findNext',
            'Cmd-G': 'findNext',
            'Shift-Ctrl-G': 'findPrev',
            'Shift-Cmd-G': 'findPrev',
            'Ctrl-H': 'replace',
            'Shift-Ctrl-H': 'replaceAll'
          });
        }

        function enhanceEditorOptions() {
          if (!editor || editor._xkeenEnhanced) return;
          try { editor._xkeenEnhanced = true; } catch (e) {}

          try { editor.setOption('styleActiveLine', true); } catch (e) {}
          try { editor.setOption('showIndentGuides', true); } catch (e) {}
          try { editor.setOption('matchBrackets', true); } catch (e) {}
          try { editor.setOption('autoCloseBrackets', true); } catch (e) {}
          try { editor.setOption('highlightSelectionMatches', true); } catch (e) {}
          try { editor.setOption('foldGutter', true); } catch (e) {}
          try { editor.setOption('gutters', ['CodeMirror-linenumbers', 'CodeMirror-foldgutter']); } catch (e) {}
          try { editor.setOption('extraKeys', getPreviewEditorExtraKeys()); } catch (e) {}
          try { if (editor.refresh) editor.refresh(); } catch (e) {}
        }

        function attachPreviewToolbar() {
          if (!editor || editor._xkeenToolbarAttached) return;
          try { editor._xkeenToolbarAttached = true; } catch (e) {}

          try {
            const baseItems = getXkeenEditorToolbarDefaultItems();
            if (baseItems.length) {
              const icons = getXkeenEditorToolbarIcons();
              const items = baseItems.map((it) => {
                if (it && it.id === 'fs') return Object.assign({}, it, { onClick: (cm) => toggleEditorFullscreen(cm) });
                return it;
              });
              try {
                if (icons.fullscreen && !items.some((it) => it && it.id === 'fs_any')) {
                  items.push({
                    id: 'fs_any',
                    svg: icons.fullscreen,
                    label: 'Фулскрин',
                    fallbackHint: 'F11 / Esc',
                    onClick: () => toggleEditorFullscreen(editor),
                  });
                }
              } catch (e) {}

              attachXkeenEditorToolbar(editor, items);
              moveToolbarToHeader();
              try { syncToolbarForEngine(_engine); } catch (e) {}
            }
          } catch (e) {
            // ignore
          }
        }

        function wireLazyPreviewToolbar() {
          if (!editor || editor._xkeenToolbarLazyWired) return;
          try { editor._xkeenToolbarLazyWired = true; } catch (e) {}

          const kick = () => {
            try { attachPreviewToolbar(); } catch (e) {}
          };

          try {
            const w = editor.getWrapperElement && editor.getWrapperElement();
            if (w) {
              w.addEventListener('mouseenter', kick, { once: true, passive: true });
              w.addEventListener('focusin', kick, { once: true });
            }
          } catch (e) {}

          try {
            if (previewEngineSelect) {
              previewEngineSelect.addEventListener('mousedown', kick, { once: true, passive: true });
              previewEngineSelect.addEventListener('focus', kick, { once: true });
            }
          } catch (e) {}
        }
      
        function initEditor() {
          if (editor) return;
          if (previewTextarea && previewTextarea.value !== SKELETON) {
            previewTextarea.value = SKELETON;
          }
          const runtime = getEditorRuntime('codemirror');
          if (!runtime || typeof runtime.create !== 'function' || !previewTextarea) return;
          editor = runtime.create(previewTextarea, {
            mode: 'yaml',
            theme: getCurrentCmTheme(),
            lineNumbers: true,
            lineWrapping: true,
            tabSize: 2,
            indentUnit: 2,
            indentWithTabs: false,
            viewportMargin: 10,
            // Preview is read-only, но с курсором и поиском
            readOnly: true
          });

          // Mark as XKeen editor so shared CSS fixes apply in light theme
          try {
            const w = editor.getWrapperElement && editor.getWrapperElement();
            if (w) w.classList.add('xkeen-cm');
          } catch (e) {}

          // Register in global list so main.js theme toggle can sync it
          try {
            window.__xkeenEditors = window.__xkeenEditors || [];
            window.__xkeenEditors.push(editor);
          } catch (e) {}

          try { wireLazyPreviewToolbar(); } catch (e) {}

          // Default active engine is CodeMirror until overridden by global preference.
          try { _engine = 'codemirror'; _active = cmFacade(); } catch (e) {}
        }
      
        // React on theme changes (main.js dispatches xkeen-theme-change)
        document.addEventListener('xkeen-theme-change', (e) => {
          if (!editor) return;
          const cmTheme = (e && e.detail && e.detail.cmTheme) ? e.detail.cmTheme : getCurrentCmTheme();
          try {
            editor.setOption('theme', cmTheme);
            editor.refresh();
          } catch (err) {}
        });
      
        // ----- subscriptions -----
        function createSubscriptionRow(value) {
          const row = document.createElement("div");
          row.className = "subscription-row";
      
          const input = document.createElement("input");
          input.type = "text";
          input.placeholder = "https://example.com/sub";
          input.value = value || "";
      
          // Автопредпросмотр при изменении URL подписки
          autoPreviewOnChange(input, ["change", "blur", "input"], 400);
      
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn btn-ghost btn-xs";
          btn.textContent = "✕";
          btn.onclick = () => {
            subscriptionsList.removeChild(row);
            if (!subscriptionsList.children.length) {
              subscriptionsList.appendChild(createSubscriptionRow(""));
            }
            schedulePreview();
          };
      
          row.appendChild(input);
          row.appendChild(btn);
          return row;
        }
      
        function addInitialSubscriptionRow() {
          if (!subscriptionsList.children.length) {
            subscriptionsList.appendChild(createSubscriptionRow(""));
          }
        }
      
        // ----- rule groups -----
        function getAllRuleGroupCheckboxes() {
          return Array.from(document.querySelectorAll(".rule-group-checkbox"));
        }
      
        function setEnabledRuleGroupsInUI(ids) {
          const set = new Set(ids || []);
          getAllRuleGroupCheckboxes().forEach(cb => {
            cb.checked = set.has(cb.value);
          });
        }
      
        function getEnabledRuleGroupsFromUI() {
          return getAllRuleGroupCheckboxes()
            .filter(cb => cb.checked)
            .map(cb => cb.value);
        }
      
        function updateSelectAllCheckbox() {
          if (!ruleGroupsSelectAll) return;
          const checkboxes = getAllRuleGroupCheckboxes();
          if (!checkboxes.length) {
            ruleGroupsSelectAll.checked = false;
            ruleGroupsSelectAll.indeterminate = false;
            return;
          }
          const allChecked = checkboxes.every(cb => cb.checked);
          const anyChecked = checkboxes.some(cb => cb.checked);
          ruleGroupsSelectAll.checked = allChecked;
          ruleGroupsSelectAll.indeterminate = !allChecked && anyChecked;
        }
      
        
        async function loadProfileDefaults(profile) {
          const p = profile || (profileSelect && profileSelect.value) || "router_custom";
          try {
            const res = await fetch("/api/mihomo/profile_defaults?profile=" + encodeURIComponent(p));
            if (!res.ok) return;
            const data = await res.json();
            if (!data || data.ok === false) return;
      
            const enabled = Array.isArray(data.enabledRuleGroups)
              ? data.enabledRuleGroups
              : [];
      
            const availableFromBackend = Array.isArray(data.availableRuleGroups)
              ? data.availableRuleGroups
              : null;
      
            if (availableFromBackend && availableFromBackend.length) {
              availableRuleGroupIds = availableFromBackend;
            } else {
              // Fallback: if backend does not yet expose availableRuleGroups,
              // show all known presets so that the UI still works.
              availableRuleGroupIds = RULE_GROUP_PRESETS.map(preset => preset.id);
            }
      
            // Re-render the checkbox list for the current profile.
            renderRuleGroups();
            setEnabledRuleGroupsInUI(enabled);
            updateSelectAllCheckbox();
            // Авто-обновление предпросмотра при смене профиля / пресета групп
            schedulePreview();
          } catch (err) {
            console.error("Failed to load profile defaults", err);
          }
        }
      
        function renderRuleGroups() {
          if (!ruleGroupsList) return;
      
          // Сначала очищаем список, затем рисуем только релевантные этому профилю группы.
          ruleGroupsList.textContent = "";
      
          const allowed = Array.isArray(availableRuleGroupIds) && availableRuleGroupIds.length
            ? new Set(availableRuleGroupIds)
            : null;
      
          const presetsToRender = RULE_GROUP_PRESETS.filter(preset =>
            !allowed || allowed.has(preset.id)
          );

          const frag = document.createDocumentFragment();
      
          presetsToRender.forEach(preset => {
            const label = document.createElement("label");
            label.className = "rule-group-item";
      
            const cb = document.createElement("input");
            cb.type = "checkbox";
            cb.value = preset.id;
            cb.className = "rule-group-checkbox";
      
            const span = document.createElement("span");
            span.innerHTML = "<strong>" + preset.label + "</strong>";
      
            label.appendChild(cb);
            label.appendChild(span);
            frag.appendChild(label);
      
            cb.addEventListener("change", () => {
              updateSelectAllCheckbox();
              // Авто-обновление предпросмотра при переключении пакетов правил
              schedulePreview();
            });
          });

          ruleGroupsList.appendChild(frag);
      
          // Обработчик "Отметить всё" вешаем один раз, он работает с текущим набором чекбоксов.
          if (ruleGroupsSelectAll && !ruleGroupsSelectAllInited) {
            ruleGroupsSelectAll.addEventListener("change", () => {
              const checked = ruleGroupsSelectAll.checked;
              getAllRuleGroupCheckboxes().forEach(cb => {
                cb.checked = checked;
              });
              updateSelectAllCheckbox();
              schedulePreview();
            });
            ruleGroupsSelectAllInited = true;
          }
        }
      
      // ----- proxies -----
        const proxyControllers = [];
      
        function createProxyCard(initial) {
          const idx = proxyControllers.length + 1;
          const wrapper = document.createElement("div");
          wrapper.className = "proxy-card";
      
          const header = document.createElement("div");
          header.className = "proxy-header";
      
          const title = document.createElement("div");
          title.className = "proxy-header-title";
          title.textContent = "Узел #" + idx;
      
          const typeBadge = document.createElement("span");
          typeBadge.className = "proxy-header-type";
          typeBadge.textContent = "Тип: vless";
      
          const actions = document.createElement("div");
      
          const delBtn = document.createElement("button");
          delBtn.type = "button";
          delBtn.className = "btn btn-danger btn-xs";
          delBtn.textContent = "Удалить";
          delBtn.onclick = () => {
            const pos = proxyControllers.indexOf(ctrl);
            if (pos >= 0) proxyControllers.splice(pos, 1);
            proxiesList.removeChild(wrapper);
            Array.from(proxiesList.children).forEach((card, i) => {
              const t = card.querySelector(".proxy-header-title");
              if (t) t.textContent = "Узел #" + (i + 1);
            });
          };
      
          actions.appendChild(delBtn);
          header.appendChild(title);
          header.appendChild(typeBadge);
          header.appendChild(actions);
      
          const body = document.createElement("div");
          body.className = "proxy-body";
      
          const typeWrap = document.createElement("div");
          const typeLabel = document.createElement("label");
          typeLabel.textContent = "Тип узла";
          const typeSelect = document.createElement("select");
          // Tooltip (portal tooltips will pick it from title)
          typeSelect.title = "Выберите формат узла: авто-распознавание ссылки, конкретный тип (VLESS/Trojan/VMess/SS/Hysteria2), подписка (provider), WireGuard или YAML блок.";
          typeSelect.innerHTML = `
            <option value="auto">Ссылка (auto)</option>
            <option value="vless">VLESS ссылка</option>
            <option value="trojan">Trojan ссылка</option>
            <option value="vmess">VMess ссылка</option>
            <option value="ss">Shadowsocks ссылка</option>
            <option value="hysteria2">Hysteria2 ссылка</option>
            <option value="provider">Подписка (proxy-provider)</option>
            <option value="wireguard">WireGuard конфиг</option>
            <option value="yaml">YAML блок proxy</option>
          `;
          typeWrap.appendChild(typeLabel);
          typeWrap.appendChild(typeSelect);
      
          const nameWrap = document.createElement("div");
          const nameLabel = document.createElement("label");
          nameLabel.textContent = "Имя узла";
          const nameInput = document.createElement("input");
          nameInput.type = "text";
          nameInput.placeholder = "My Node";
          nameInput.title = "Имя узла (отображается в Clash/Mihomo UI и в селекторах).";
          nameWrap.appendChild(nameLabel);
          nameWrap.appendChild(nameInput);

          const prioWrap = document.createElement("div");
          const prioLabel = document.createElement("label");
          prioLabel.textContent = "Приоритет (опц.)";
          const prioInput = document.createElement("input");
          prioInput.type = "number";
          prioInput.min = "0";
          prioInput.step = "1";
          prioInput.placeholder = "0";
          prioInput.title = "Приоритет узла (опционально). Можно использовать для сортировки/удобства. 0 = по умолчанию.";
          prioWrap.appendChild(prioLabel);
          prioWrap.appendChild(prioInput);

          const iconWrap = document.createElement("div");
          const iconLabel = document.createElement("label");
          iconLabel.textContent = "Icon URL (опц.)";
          const iconInput = document.createElement("input");
          iconInput.type = "text";
          iconInput.placeholder = "https://.../icon.png";
          iconInput.title = "URL иконки (опционально). Используется в Clash/Mihomo UI как значок узла.";
          iconWrap.appendChild(iconLabel);
          iconWrap.appendChild(iconInput);
          const tagsWrap = document.createElement("div");
          const tagsLabel = document.createElement("label");
          tagsLabel.textContent = "Теги (опц.)";
          const tagsInput = document.createElement("input");
          tagsInput.type = "text";
          tagsInput.placeholder = "work,home";
          tagsInput.title = "Теги узла (опционально). Укажите через запятую: work,home";
          tagsWrap.appendChild(tagsLabel);
          tagsWrap.appendChild(tagsInput);


          const groupsWrap = document.createElement("div");
          groupsWrap.className = "full";
          const groupsLabel = document.createElement("label");
          groupsLabel.textContent = "Группы (через запятую)";
          const groupsInput = document.createElement("input");
          groupsInput.type = "text";
          groupsInput.placeholder = "Заблок. сервисы,YouTube";
          groupsInput.title = "Группы (через запятую). Узел будет добавлен в эти селекторы/группы.";
          groupsWrap.appendChild(groupsLabel);
          groupsWrap.appendChild(groupsInput);
      
          const dataWrap = document.createElement("div");
          dataWrap.className = "full";
          const dataLabel = document.createElement("label");
          dataLabel.textContent = "VLESS ссылка";
          const dataArea = document.createElement("textarea");
          dataArea.rows = 4;
          dataArea.placeholder = "vless://...";
          dataArea.title = "Вставьте ссылку/конфиг для узла. Тип зависит от выбранного формата выше.";
          dataWrap.appendChild(dataLabel);
          dataWrap.appendChild(dataArea);
      
          body.appendChild(typeWrap);
          body.appendChild(nameWrap);
          body.appendChild(prioWrap);
          body.appendChild(iconWrap);
          body.appendChild(tagsWrap);
          body.appendChild(groupsWrap);
          body.appendChild(dataWrap);
      
          function updateTypeUI() {
            const t = typeSelect.value;
            if (t === "auto") {
              typeBadge.textContent = "Тип: auto";
              dataLabel.textContent = "Ссылка (auto)";
              dataArea.placeholder = "vless://... или https://sub...";
              dataArea.title = "Авто-режим: вставьте ссылку (vless/trojan/vmess/ss/hysteria2/hy2) или URL подписки (https://...).";
              dataArea.rows = 4;
            } else if (t === "provider") {
              typeBadge.textContent = "Тип: provider";
              dataLabel.textContent = "URL подписки";
              dataArea.placeholder = "https://example.com/subscription";
              dataArea.title = "URL подписки (proxy-provider). Будет добавлен в proxy-providers.";
              dataArea.rows = 3;
            } else if (t === "vless" || t === "trojan" || t === "vmess" || t === "ss" || t === "hysteria2") {
              typeBadge.textContent = `Тип: ${t}`;
              if (t === "vless") {
                dataLabel.textContent = "VLESS ссылка";
                dataArea.placeholder = "vless://...";
                dataArea.title = "Вставьте VLESS ссылку (vless://...).";
              } else if (t === "trojan") {
                dataLabel.textContent = "Trojan ссылка";
                dataArea.placeholder = "trojan://...";
                dataArea.title = "Вставьте Trojan ссылку (trojan://...).";
              } else if (t === "vmess") {
                dataLabel.textContent = "VMess ссылка";
                dataArea.placeholder = "vmess://...";
                dataArea.title = "Вставьте VMess ссылку (vmess://...).";
              } else if (t === "ss") {
                dataLabel.textContent = "Shadowsocks ссылка";
                dataArea.placeholder = "ss://...";
                dataArea.title = "Вставьте Shadowsocks ссылку (ss://...).";
              } else {
                dataLabel.textContent = "Hysteria2 ссылка";
                dataArea.placeholder = "hysteria2://... или hy2://...";
                dataArea.title = "Вставьте Hysteria2 ссылку (hysteria2://... или hy2://...).";
              }
              dataArea.rows = 4;
            } else if (t === "wireguard") {
              typeBadge.textContent = "Тип: wireguard";
              dataLabel.textContent = "WireGuard конфиг";
              dataArea.placeholder = "[Interface]\nAddress = ...";
              dataArea.title = "Вставьте содержимое WireGuard-конфига (.conf): [Interface]/[Peer] и т.д.";
              dataArea.rows = 6;
            } else {
              typeBadge.textContent = "Тип: yaml";
              dataLabel.textContent = "YAML блок proxy";
              dataArea.placeholder = "- name: MyNode\n  type: trojan\n  server: ...";
              dataArea.title = "Вставьте YAML-блок узла proxy (как в конфиге Mihomo).";
              dataArea.rows = 6;
            }
          }
          typeSelect.addEventListener("change", updateTypeUI);
          updateTypeUI();
      
          if (initial) {
            if (initial.kind) typeSelect.value = initial.kind;
            if (initial.name) nameInput.value = initial.name;
            if (initial.groups) groupsInput.value = initial.groups;
            if (initial.priority !== undefined && initial.priority !== null && String(initial.priority) !== "") prioInput.value = initial.priority;
            if (initial.icon) iconInput.value = initial.icon;
            if (initial.tags) tagsInput.value = initial.tags;
            if (initial.data) dataArea.value = initial.data;
            updateTypeUI();
          }
      
          wrapper.appendChild(header);
          wrapper.appendChild(body);
      
          const ctrl = {
            el: wrapper,
            _inputs: { typeSelect, nameInput, groupsInput, dataArea, iconInput, prioInput, tagsInput },
            getState: () => {
              const kind = typeSelect.value;
              const name = nameInput.value.trim();
              const groups = uniqueStrings((groupsInput.value || "")
                .split(",")
                .map(s => s.trim())
                .filter(Boolean));
              const data = dataArea.value;
              const icon = String(iconInput.value || "").trim();
              const tagsRaw = String(tagsInput.value || "").trim();
              const tags = uniqueStrings(tagsRaw
                .split(/[,;]+/)
                .map(s => s.trim())
                .filter(Boolean));
              const prioRaw = String(prioInput.value || "").trim();
              const prio = prioRaw ? parseInt(prioRaw, 10) : null;

              if (!data.trim()) return null;
              const out = { kind };
              if (name) out.name = name;
              if (groups.length) out.groups = groups;
              if (icon) out.icon = icon;
              if (tags.length) out.tags = tags;
              if (prio !== null && !Number.isNaN(prio)) out.priority = prio;

              if (kind === "wireguard") out.config = data;
              else if (kind === "yaml") out.yaml = data;
              else out.link = data.trim();
              return out;
            },
          };
      
          proxiesList.appendChild(wrapper);
          proxyControllers.push(ctrl);
        }

        // ----- bulk import (like Outbound Generator) -----
        function getExistingSubscriptionUrls() {
          try {
            return Array.from(subscriptionsList.querySelectorAll("input[type='text']"))
              .map(i => (i.value || "").trim())
              .filter(Boolean);
          } catch (e) {
            return [];
          }
        }

        function getExistingProxyLinks() {
          const out = [];
          try {
            proxyControllers.forEach((c) => {
              const st = c && typeof c.getState === 'function' ? c.getState() : null;
              if (!st) return;
              if (st.link) out.push(String(st.link).trim());
            });
          } catch (e) {}
          return out.filter(Boolean);
        }

        function normalizeImportedLine(line) {
          if (!line) return "";
          return String(line)
            .replace(/\uFEFF/g, "")
            .trim();
        }

        function safeDecodeURIComponent(s) {
          try { return decodeURIComponent(s); } catch (e) { return s; }
        }

        function parseGroupList(groupsStr) {
          const raw = String(groupsStr || "").trim();
          if (!raw) return [];
          const cleaned = raw
            .replace(/^\[|\]$/g, "")
            .replace(/^\(|\)$/g, "")
            .replace(/^\{|\}$/g, "")
            .trim();
          if (!cleaned) return [];
          return cleaned
            .split(/[,;]+/)
            .map(s => String(s || "").trim())
            .filter(Boolean);
        }

        function uniqueStrings(items) {
          const out = [];
          const seen = new Set();
          (Array.isArray(items) ? items : []).forEach((item) => {
            const value = String(item || "").trim();
            if (!value || seen.has(value)) return;
            seen.add(value);
            out.push(value);
          });
          return out;
        }

        function looksLikeForcedGroupsToken(token) {
          const t = String(token || "").trim();
          if (!t) return false;
          if (t.startsWith("@")) return true;
          if (t.includes(",") || t.includes(";")) return true;
          if (/^[\[{(].+[\]})]$/.test(t)) return true;
          return false;
        }

        function looksLikeGroupsToken(token) {
          const t = String(token || "").trim();
          if (!t) return false;
          if (t.includes(",") || t.includes(";")) return true;
          // short codes like HK/SG/JP/US etc
          if (/^[A-Z0-9]{2,5}$/.test(t)) return true;
          // Allow forcing groups with @ prefix for short GEO codes or multi-groups
          if (t.startsWith("@")) {
            const rest = t.slice(1).trim();
            if (rest.includes(",") || rest.includes(";")) return true;
            if (/^[A-Z0-9]{2,5}$/.test(rest)) return true;
          }
          // Emoji flags or icons in a single token
          try {
            if (/^\p{Extended_Pictographic}{1,3}$/u.test(t)) return true;
          } catch (e) {
            // ignore if unicode properties unsupported
          }
          return false;
        }

        function looksLikeIconToken(token) {
          const t = String(token || "").trim();
          if (!t) return false;
          const raw = t.replace(/^icon\s*:\s*/i, "").trim();
          if (!raw) return false;
          if (/^https?:\/\//i.test(raw)) {
            if (/\.(png|jpe?g|svg|webp)(\?|#|$)/i.test(raw)) return true;
            if (/IconSet|Qure@|group-icons|koolson|qure/i.test(raw)) return true;
          }
          return false;
        }

        function stripIconPrefix(token) {
          return String(token || "").trim().replace(/^icon\s*:\s*/i, "").trim();
        }

        function parsePriorityToken(token) {
          const t = String(token || "").trim();
          if (!t) return null;
          let m = t.match(/^(?:p|prio|priority)\s*[:=]?\s*(\d{1,4})$/i);
          if (m) {
            try {
              const v = parseInt(m[1], 10);
              if (!Number.isNaN(v)) return v;
            } catch (e) {}
          }
          m = t.match(/^(\d{1,4})$/);
          if (m) {
            try {
              const v = parseInt(m[1], 10);
              if (!Number.isNaN(v)) return v;
            } catch (e) {}
          }
          return null;
        }

        function parseTagsToken(token) {
          const t = String(token || "").trim();
          if (!t) return "";
          const m = t.match(/^(?:tag|tags|label|labels|t)\s*[:=]\s*(.+)$/i);
          if (m) return String(m[1] || "").trim();
          return "";
        }


        function isHttpUrlToken(token) {
          const t = String(token || "").trim();
          return /^https?:\/\//i.test(t);
        }

        function isProxyUriToken(token) {
          const t = String(token || "").trim();
          return /^(vless|trojan|vmess|ss|hysteria2|hy2):\/\//i.test(t);
        }

        function guessGeoFromText(text) {
          const s = String(text || "").toUpperCase();
          if (!s) return "";

          // Emoji flags (most common)
          const emojiMap = {
            "🇭🇰": "HK", "🇸🇬": "SG", "🇯🇵": "JP", "🇰🇷": "KR", "🇺🇸": "US",
            "🇬🇧": "GB", "🇩🇪": "DE", "🇳🇱": "NL", "🇫🇷": "FR", "🇷🇺": "RU",
            "🇹🇷": "TR", "🇦🇪": "AE", "🇮🇳": "IN", "🇨🇦": "CA", "🇦🇺": "AU",
            "🇮🇹": "IT", "🇪🇸": "ES", "🇸🇪": "SE", "🇳🇴": "NO", "🇫🇮": "FI",
          };
          for (const k in emojiMap) {
            if (Object.prototype.hasOwnProperty.call(emojiMap, k) && String(text || "").includes(k)) {
              return emojiMap[k];
            }
          }

          const rules = [
            [/\bHK\b|HONG\s*KONG|HKG/i, "HK"],
            [/\bSG\b|SINGAPORE/i, "SG"],
            [/\bJP\b|JAPAN|TOKYO|OSAKA/i, "JP"],
            [/\bKR\b|KOREA|SEOUL/i, "KR"],
            [/\bUS\b|USA|UNITED\s*STATES|NEW\s*YORK|LOS\s*ANGELES|CHICAGO/i, "US"],
            [/\bGB\b|UK\b|UNITED\s*KINGDOM|LONDON/i, "GB"],
            [/\bDE\b|GERMANY|BERLIN|FRANKFURT/i, "DE"],
            [/\bNL\b|NETHERLANDS|AMSTERDAM/i, "NL"],
            [/\bFR\b|FRANCE|PARIS/i, "FR"],
            [/\bTR\b|TURKEY|ISTANBUL/i, "TR"],
            [/\bAE\b|UAE\b|DUBAI|ABU\s*DHABI/i, "AE"],
          ];
          for (const [rx, geo] of rules) {
            if (rx.test(s)) return geo;
          }
          return "";
        }

        function geoToFlag(geo) {
          const g = String(geo || "").trim().toUpperCase();
          if (!g) return "";
          if (g.length === 2 && /^[A-Z]{2}$/.test(g)) {
            try {
              const A = 0x1F1E6;
              const cp1 = A + (g.charCodeAt(0) - 65);
              const cp2 = A + (g.charCodeAt(1) - 65);
              return String.fromCodePoint(cp1, cp2);
            } catch (e) {
              return "";
            }
          }
          return "";
        }

        function geoToRegionName(geo) {
          const g = String(geo || "").trim().toUpperCase();
          const m = {
            "HK": "Hong Kong",
            "SG": "Singapore",
            "JP": "Japan",
            "KR": "Korea",
            "US": "USA",
            "GB": "UK",
            "DE": "Germany",
            "NL": "Netherlands",
            "FR": "France",
            "TR": "Turkey",
            "AE": "UAE",
            "RU": "Russia",
            "IN": "India",
            "CA": "Canada",
            "AU": "Australia",
            "IT": "Italy",
            "ES": "Spain",
            "SE": "Sweden",
            "NO": "Norway",
            "FI": "Finland",
          };
          return m[g] || "";
        }

       

        function geoToRegionGroup(geo) {
          const g = String(geo || "").trim().toUpperCase();
          if (!g) return "";

          const ASIA = new Set(["CN","HK","MO","TW","JP","KR","SG","TH","VN","MY","ID","PH","IN","PK","BD","LK","NP","KH","LA","MM","BN"]);
          const EUROPE = new Set(["DE","NL","FR","GB","UK","IT","ES","PT","BE","LU","CH","AT","CZ","PL","SK","HU","RO","BG","GR","SE","NO","DK","FI","EE","LV","LT","IE","IS","SI","HR","RS","BA","ME","MK","AL","MD","UA"]);
          const AMERICA = new Set(["US","CA","MX","BR","AR","CL","CO","PE","VE","UY","BO","EC","PA","CR","GT","HN","SV","NI","DO","CU","PR"]);
          const CIS = new Set(["RU","BY","KZ","UZ","KG","TJ","TM","AZ","AM","GE"]);
          const MIDEAST = new Set(["TR","AE","SA","QA","KW","OM","BH","IL","JO","LB","SY","IQ","IR","YE","PS"]);
          const OCEANIA = new Set(["AU","NZ"]);
          const AFRICA = new Set(["ZA","EG","MA","DZ","TN","NG","KE","ET","GH","UG","TZ","CM","SN"]);

          if (ASIA.has(g)) return "Asia";
          if (EUROPE.has(g)) return "Europe";
          if (AMERICA.has(g)) return "America";
          if (CIS.has(g)) return "CIS";
          if (MIDEAST.has(g)) return "MiddleEast";
          if (OCEANIA.has(g)) return "Oceania";
          if (AFRICA.has(g)) return "Africa";
          return "";
        }

        function extractLinkMeta(link) {

          const out = {
            type: "",
            host: "",
            port: "",
            nameFromLink: "",
            geo: "",
          };
          const s = String(link || "").trim();
          if (!s) return out;

          const m = s.match(/^([a-z0-9+.-]+):\/\//i);
          if (m) out.type = String(m[1] || "").toLowerCase();

          // VMess base64 json
          if (out.type === "vmess") {
            try {
              const b64 = s.slice(8);
              const pad = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
              const raw = atob(pad.replace(/-/g, "+").replace(/_/g, "/"));
              const j = JSON.parse(raw);
              if (j && j.add) out.host = String(j.add);
              if (j && j.port) out.port = String(j.port);
              if (j && j.ps) out.nameFromLink = String(j.ps);
            } catch (e) {}
            out.geo = guessGeoFromText(out.nameFromLink || out.host);
            return out;
          }

          // Generic URL parsing for custom schemes
          try {
            const u = new URL(s);
            out.host = String(u.hostname || "");
            out.port = String(u.port || "");
            const h = String(u.hash || "").replace(/^#/, "");
            if (h) out.nameFromLink = safeDecodeURIComponent(h);
          } catch (e) {
            // ignore
          }

          out.geo = guessGeoFromText(out.nameFromLink || out.host);
          return out;
        }

        function applyTemplate(tpl, meta) {
          const t = String(tpl || "").trim();
          if (!t) return "";
          const map = {
            name: String(meta.name || ""),
            type: String(meta.type || ""),
            host: String(meta.host || ""),
            port: String(meta.port || ""),
            geo: String(meta.geo || ""),
            flag: String(meta.flag || ""),
            region: String(meta.region || ""),
            region_group: String(meta.region_group || ""),
            group: String(meta.group || ""),
            groups: String(meta.groups || ""),
            tags: String(meta.tags || ""),
            index: String(meta.index || ""),
          };
          return t.replace(/\{(name|type|host|port|geo|flag|region|region_group|group|groups|tags|index)\}/g, (_, k) => map[k] || "").trim();
        }

        function guessNameFromLink(link) {
          const meta = extractLinkMeta(link);
          return meta.nameFromLink || "";
        }

        function parseImportLine(line) {
          const raw = normalizeImportedLine(line);
          if (!raw) return null;
          if (raw.startsWith("#")) return null;

          // Support formats:
          // 1) link
          // 2) name|link
          // 3) name|link|groups
          // 4) name|link|groups|icon|priority
          // 5) groups|link
          // 6) name|groups|link
          // 7) name - link
          let name = "";
          let groups = "";
          let link = "";
          let icon = "";
          let priority = null;
          let tags = "";

          const consumeAux = (token) => {
            const t = String(token || "").trim();
            if (!t) return null;

            const pr = parsePriorityToken(t);
            if (pr !== null && priority === null) {
              priority = pr;
              return { kind: 'priority', value: pr };
            }

            if (looksLikeIconToken(t) && !icon) {
              icon = stripIconPrefix(t);
              return { kind: 'icon', value: icon };
            }

            // tags: tag:work / t=work / @work
            const tg = parseTagsToken(t);
            if (tg && !tags) {
              tags = tg;
              return { kind: 'tags', value: tags };
            }
            if (!tags && t.startsWith("@")) {
              const rest = t.slice(1).trim();
              // '@HK' can be forced groups token; treat as tag only for non-geo words
              if (rest && !(rest.includes(",") || rest.includes(";")) && !/^[A-Z0-9]{2,5}$/.test(rest)) {
                tags = rest;
                return { kind: 'tags', value: tags };
              }
            }

            return null;
          };

          if (raw.includes("|")) {
            const partsRaw = raw.split("|").map(s => String(s || "").trim());
            const parts = partsRaw.filter(p => String(p || "").trim() !== "");

            let linkIdx = parts.findIndex(p => isProxyUriToken(p));
            if (linkIdx < 0) linkIdx = parts.findIndex(p => isHttpUrlToken(p));

            if (linkIdx >= 0) {
              link = parts[linkIdx];

              const leftRaw = parts.slice(0, linkIdx).map(s => s.trim()).filter(Boolean);
              const rightRaw = parts.slice(linkIdx + 1).map(s => s.trim()).filter(Boolean);

              const left = [];
              leftRaw.forEach((t) => {
                if (!consumeAux(t)) left.push(t)
              });

              const right = [];
              rightRaw.forEach((t) => {
                if (!consumeAux(t)) right.push(t)
              });

              // Parse left side into name/groups by token heuristics.
              const nameParts = [];
              const groupParts = [];

              if (left.length === 1) {
                const token = left[0];
                if (looksLikeForcedGroupsToken(token)) groupParts.push(token);
                else nameParts.push(token);
              } else if (left.length === 2) {
                const a = left[0];
                const b = left[1];
                const aIsForcedGroup = looksLikeForcedGroupsToken(a);
                const bIsForcedGroup = looksLikeForcedGroupsToken(b);
                if (aIsForcedGroup && !bIsForcedGroup) {
                  groupParts.push(a);
                  nameParts.push(b);
                } else if (!aIsForcedGroup && bIsForcedGroup) {
                  nameParts.push(a);
                  groupParts.push(b);
                } else {
                  // ambiguous tokens like HK|vless://... are safer as names, not groups
                  nameParts.push(a, b);
                }
              } else if (left.length > 2) {
                left.forEach((t) => {
                  if (looksLikeForcedGroupsToken(t)) groupParts.push(t);
                  else nameParts.push(t);
                });
              }

              name = nameParts.join(" ").trim();
              groups = groupParts.join(",").trim();

              // Right side tokens are treated as groups by default.
              if (right.length) {
                const r = right.join("|").trim();
                groups = (groups ? (groups + "," + r) : r);
              }

              // Cleanup group string: remove @ prefix used as tag
              groups = String(groups || "")
                .split(/[,;]+/)
                .map(x => String(x || "").trim().replace(/^@/, ""))
                .filter(Boolean)
                .join(",");

            } else {
              // No scheme part, fallback to raw
              link = raw;
            }

          } else {
            const m = raw.match(/(vless|trojan|vmess|ss|hysteria2|hy2|https?):\/\//i);
            if (m && typeof m.index === 'number' && m.index > 0) {
              name = raw.slice(0, m.index).trim().replace(/[\-–—:]+\s*$/, "").trim();
              link = raw.slice(m.index).trim();
            } else {
              link = raw;
            }
          }

          link = (link || "").trim();
          if (!link) return null;

          const isHttpUrl = /^https?:\/\//i.test(link);

          // Do not treat pure image URLs as subscriptions
          if (isHttpUrl && looksLikeIconToken(link)) {
            return null;
          }

          if (!name) name = guessNameFromLink(link);

          if (isHttpUrl) {
            return { type: 'subscription', url: link, name };
          }

          // Proxy link
          return {
            type: 'proxy',
            kind: 'auto',
            name: name || "",
            groups: groups || "",
            icon: icon || "",
            priority: priority,
            tags: tags || "",
            data: link,
          };
        }

        function buildImportedProxy(parsed, idx, opts) {
          const link = String(parsed.data || "").trim();
          const meta = extractLinkMeta(link);
          const rawName = String(parsed.name || "").trim();
          const derivedName = meta.nameFromLink || guessNameFromLink(link) || "";
          const baseName = rawName || derivedName || (meta.host ? (meta.host + (meta.port ? (":" + meta.port) : "")) : "");

          let groupsList = parseGroupList(parsed.groups);

          const geo = meta.geo || (opts.autoGeo ? guessGeoFromText(baseName || meta.host) : "");
          const flag = geoToFlag(geo);
          const region = geoToRegionName(geo);
          const region_group = geoToRegionGroup(geo);
          const tags = String(parsed.tags || "").trim();


          if (!groupsList.length) {
            const tplGroups = String(opts.groupsTemplate || "").trim();
            if (tplGroups) {
              const rendered = applyTemplate(tplGroups, {
                name: baseName,
                type: meta.type,
                host: meta.host,
                port: meta.port,
                geo,
                flag,
                region,
                region_group,
                group: "",
                groups: "",
                tags,
                index: idx,
              });
              groupsList = parseGroupList(rendered);
            }
          }

          if (!groupsList.length && opts.autoGeo && geo) {
            groupsList = [geo];
          }

          if (opts.autoRegionGroup && region_group) {
            if (!groupsList.includes(region_group)) {
              const geoPos = geo ? groupsList.findIndex(g => String(g || '').trim().toUpperCase() === geo) : -1;
              if (geoPos >= 0) groupsList.splice(geoPos + 1, 0, region_group);
              else groupsList.push(region_group);
            }
          }

          const groupFirst = groupsList.length ? groupsList[0] : "";
          const nameTemplate = String(opts.nameTemplate || "{name}").trim() || "{name}";
          const finalName = applyTemplate(nameTemplate, {
            name: baseName,
            type: meta.type,
            host: meta.host,
            port: meta.port,
            geo,
            flag,
            region,
            region_group,
            group: groupFirst,
            groups: groupsList.join(","),
            tags,
            index: idx,
          }) || baseName;

          let pr = parsed.priority;
          if (typeof pr === 'string') pr = parsePriorityToken(pr);
          if (typeof pr !== 'number' || Number.isNaN(pr)) pr = null;

          return {
            kind: 'auto',
            name: finalName,
            groups: groupsList.join(', '),
            icon: String(parsed.icon || "").trim(),
            priority: pr,
            tags: tags,
            data: link,
          };
        }

        function clearAllProxies() {
          try {
            proxyControllers.length = 0;
            while (proxiesList.firstChild) proxiesList.removeChild(proxiesList.firstChild);
          } catch (e) {}
        }

        function addSubscriptionsToUI(urls, dedup = true) {
          if (!urls || !urls.length) return 0;
          const existing = getExistingSubscriptionUrls();
          const seen = new Set(existing.map(u => String(u).trim()));
          let added = 0;

          urls.forEach((u) => {
            const url = String(u || "").trim();
            if (!url) return;
            if (dedup && seen.has(url)) return;
            seen.add(url);

            // If the list contains a single empty row, fill it first.
            const inputs = Array.from(subscriptionsList.querySelectorAll("input[type='text']"));
            const empty = inputs.find(i => !(i.value || "").trim());
            if (empty) {
              empty.value = url;
            } else {
              subscriptionsList.appendChild(createSubscriptionRow(url));
            }
            added += 1;
          });

          return added;
        }

        function doBulkImport() {
          if (!bulkImportTextarea) return;
          const text = String(bulkImportTextarea.value || "");
          const opts = getBulkImportOptions();
          const clearExisting = opts.clearExisting;
          const toSubs = opts.toSubs;
          const dedup = opts.dedup;
          const nameTemplate = opts.nameTemplate;
          const groupsTemplate = opts.groupsTemplate;
          const autoGeo = opts.autoGeo;
          const autoRegionGroup = opts.autoRegionGroup;

          const lines = text.replace(/\r\n/g, "\n").split("\n");
          const subs = [];
          const proxies = [];
          const unknown = [];

          const existingSubs = new Set(getExistingSubscriptionUrls().map(s => String(s).trim()));
          const existingLinks = new Set(getExistingProxyLinks().map(s => String(s).trim()));
          const localSeen = new Set();

          let proxyIdx = 0;
          lines.forEach((line) => {
            const parsed = parseImportLine(line);
            if (!parsed) return;

            if (parsed.type === 'subscription') {
              const key = String(parsed.url).trim();
              if (dedup && (existingSubs.has(key) || localSeen.has(key))) return;
              localSeen.add(key);
              subs.push(key);
              return;
            }
            if (parsed.type === 'proxy') {
              const key = String(parsed.data).trim();
              if (dedup && (existingLinks.has(key) || localSeen.has(key))) return;
              localSeen.add(key);
              proxyIdx += 1;
              proxies.push(buildImportedProxy(parsed, proxyIdx, { nameTemplate, groupsTemplate, autoGeo, autoRegionGroup }));
              return;
            }

            unknown.push(String(line || "").trim());
          });

          if (!subs.length && !proxies.length) {
            setStatus("Не нашёл валидных строк для импорта.", "err");
            try { toast("Не нашёл валидных строк для импорта.", 'error'); } catch (e) {}
            return;
          }

          if (clearExisting) {
            clearAllProxies();
          }

          let addedSubs = 0;
          if (toSubs && subs.length) {
            addedSubs = addSubscriptionsToUI(subs, dedup);
          }

          let addedProxies = 0;
          proxies.forEach((p) => {
            createProxyCard({
              kind: p.kind,
              name: p.name || "",
              groups: p.groups || "",
              icon: p.icon || "",
              priority: (p.priority !== null && p.priority !== undefined) ? p.priority : "",
              tags: p.tags || "",
              data: p.data,
            });
            addedProxies += 1;
          });

          // Clear textarea for convenience
          try { bulkImportTextarea.value = ""; } catch (e) {}
          hideBulkImportModal();

          const msg = `Импортировано: узлов ${addedProxies}` + (toSubs ? `, подписок ${addedSubs}` : "") + ".";
          const finalMsg = unknown.length ? (msg + ` Не распознано строк: ${unknown.length}.`) : msg;
          setStatus(finalMsg, "ok");
          try { toast(finalMsg, unknown.length ? 'info' : 'success'); } catch (e) {}

          // Autopreview
          schedulePreview(200);
        }
      
        // ----- collect state -----


        function applyTemplatesToExistingProxies() {
          const opts = getBulkImportOptions();
          const nameTemplate = String(opts.nameTemplate || "{name}").trim() || "{name}";
          const groupsTemplate = String(opts.groupsTemplate || "").trim();
          const autoGeo = !!opts.autoGeo;
          const autoRegionGroup = !!opts.autoRegionGroup;
          const overwriteName = !!opts.overwriteName;
          const overwriteGroups = !!opts.overwriteGroups;

          let changedNodes = 0;
          let changedFields = 0;

          try {
            proxyControllers.forEach((c, i) => {
              const inputs = c && c._inputs;
              if (!inputs) return;

              const kind = String(inputs.typeSelect && inputs.typeSelect.value || "").toLowerCase();
              if (kind === "wireguard" || kind === "yaml" || kind === "provider") return;

              const link = String(inputs.dataArea && inputs.dataArea.value || "").trim();
              if (!link) return;
              if (/^https?:\/\//i.test(link)) return; // likely subscription pasted into proxy field

              const meta = extractLinkMeta(link);
              const existingName = String(inputs.nameInput && inputs.nameInput.value || "").trim();
              const existingGroupsStr = String(inputs.groupsInput && inputs.groupsInput.value || "").trim();

              const derivedName = meta.nameFromLink || guessNameFromLink(link) || "";
              const baseName = existingName || derivedName || (meta.host ? (meta.host + (meta.port ? (":" + meta.port) : "")) : "");

              let groupsList = parseGroupList(existingGroupsStr);
              if (overwriteGroups) groupsList = [];

              const geo = meta.geo || (autoGeo ? guessGeoFromText(baseName || meta.host) : "");
              const flag = geoToFlag(geo);
              const region = geoToRegionName(geo);
              const region_group = geoToRegionGroup(geo);
              const tags = String((inputs.tagsInput && inputs.tagsInput.value) || "").trim();


              if (!groupsList.length) {
                if (groupsTemplate) {
                  const rendered = applyTemplate(groupsTemplate, {
                    name: baseName,
                    type: meta.type,
                    host: meta.host,
                    port: meta.port,
                    geo,
                    flag,
                    region,
                    region_group,
                    group: "",
                    groups: "",
                    tags,
                    index: i + 1,
                  });
                  groupsList = parseGroupList(rendered);
                }
              }

              if (!groupsList.length && autoGeo && geo) {
                groupsList = [geo];
              }

              if (autoRegionGroup && region_group) {
                if (!groupsList.includes(region_group)) {
                  const geoPos = geo ? groupsList.findIndex(g => String(g || '').trim().toUpperCase() === geo) : -1;
                  if (geoPos >= 0) groupsList.splice(geoPos + 1, 0, region_group);
                  else groupsList.push(region_group);
                }
              }

              const groupFirst = groupsList.length ? groupsList[0] : "";
              const newName = applyTemplate(nameTemplate, {
                name: baseName,
                type: meta.type,
                host: meta.host,
                port: meta.port,
                geo,
                flag,
                region,
                region_group,
                group: groupFirst,
                groups: groupsList.join(","),
                tags,
                index: i + 1,
              }) || baseName;

              const newGroupsStr = groupsList.join(", ");

              let nodeChanged = false;

              if ((overwriteName || !existingName) && newName && newName !== existingName) {
                inputs.nameInput.value = newName;
                changedFields += 1;
                nodeChanged = true;
              }

              if ((overwriteGroups || !existingGroupsStr) && newGroupsStr !== existingGroupsStr) {
                inputs.groupsInput.value = newGroupsStr;
                changedFields += 1;
                nodeChanged = true;
              }

              if (nodeChanged) changedNodes += 1;
            });
          } catch (e) {
            console.error(e);
          }

          const msg = changedNodes
            ? `Шаблоны применены к ${changedNodes} узлам (изменено полей: ${changedFields}).`
            : "Нечего применять: все узлы уже заполнены.";

          setStatus(msg, changedNodes ? "ok" : null);
          try { toast(msg, changedNodes ? 'success' : 'info'); } catch (e) {}
          schedulePreview(200);
        }
        function collectState() {
          const profile = profileSelect.value || "router_custom";
      
          const subscriptions = Array.from(
            subscriptionsList.querySelectorAll("input[type='text']")
          )
            .map(i => i.value.trim())
            .filter(Boolean);
      
          const defaultGroups = (defaultGroupsInput.value || "")
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);
      
          const enabledRuleGroups = Array.from(
            document.querySelectorAll(".rule-group-checkbox")
          )
            .filter(cb => cb.checked)
            .map(cb => cb.value);
      
          const rawItems = proxyControllers
            .map(c => c.getState())
            .filter(Boolean);

          // Поддержка "подписки как узла": если в списке узлов добавили
          // provider/auto или просто вставили https://... в обычную ссылку,
          // то это считается подпиской (proxy-provider), а не одиночным прокси.
          const providerUrlsFromNodes = [];
          const proxies = [];
          const LINK_KINDS = ["auto", "vless", "trojan", "vmess", "ss", "hysteria2"];

          rawItems.forEach((it) => {
            const kind = String(it.kind || "").toLowerCase();
            const link = String(it.link || "").trim();
            const isHttpUrl = /^https?:\/\//i.test(link);

            if (kind === "provider") {
              if (link) providerUrlsFromNodes.push(link);
              return;
            }
            if (kind === "auto" && isHttpUrl) {
              providerUrlsFromNodes.push(link);
              return;
            }
            if (LINK_KINDS.includes(kind) && isHttpUrl) {
              providerUrlsFromNodes.push(link);
              return;
            }
            proxies.push(it);
          });
      
          // Объединяем подписки из секции "Подписки" и из списка узлов.
          const mergedSubscriptions = subscriptions.concat(providerUrlsFromNodes);
          // Убираем дубли, сохраняя порядок.
          const uniqSubscriptions = [];
          const seen = new Set();
          mergedSubscriptions.forEach((u) => {
            const k = String(u || "").trim();
            if (!k) return;
            if (seen.has(k)) return;
            seen.add(k);
            uniqSubscriptions.push(k);
          });

          const state = { profile, subscriptions: uniqSubscriptions, proxies };
          if (defaultGroups.length) state.defaultGroups = defaultGroups;
          if (enabledRuleGroups.length) state.enabledRuleGroups = enabledRuleGroups;
          return state;
        }
      
        // ----- generate demo preview on client -----
        function generatePreviewDemo(manual = false) {
          const state = collectState();
          const payload = { state };
          if (!_active) {
            const msg = "Editor not initialised.";
            setStatus(msg, "err");
            if (manual) {
              showMihomoResultModal({
                kind: 'error',
                kicker: 'Mihomo / preview',
                title: 'Предпросмотр недоступен',
                subtitle: 'Редактор ещё не инициализирован — дождитесь полной загрузки страницы.',
                leadTitle: 'Редактор не готов',
                leadDesc: msg,
                summary: msg,
                errors: [msg],
                source: 'Браузер',
                action: 'Предпросмотр',
              });
              try { toast(msg, 'error'); } catch (e) {}
            }
            return;
          }
      
          updateStateSummary(state);
          const validation = validateState(state, "preview");
          const localWarnings = uniqueStrings(validation.warnings || []);
          const localErrors = uniqueStrings(validation.errors || []);
          if (!validation.valid && localErrors.length) {
            const msg = localErrors.join(" ");
            setStatus(msg, "err");
            if (manual) {
              showMihomoResultModal({
                kind: 'error',
                kicker: 'Mihomo / preview',
                title: 'Невозможно собрать предпросмотр',
                subtitle: 'Сначала исправьте ошибки в исходных данных слева, затем запустите генерацию снова.',
                leadTitle: 'Проверка формы не пройдена',
                leadDesc: msg,
                summary: 'Генератор не отправлял запрос на сервер, потому что нашёл ошибки в форме.',
                errors: localErrors,
                warnings: localWarnings,
                source: 'Клиентская валидация',
                action: 'Предпросмотр',
              });
              try { toast(msg, 'error'); } catch (e) {}
            }
            return;
          }
          if (localWarnings.length) {
            setStatus(localWarnings.join(" • "), "warn");
            if (manual) try { toast(localWarnings.join(" • "), 'info'); } catch (e) {}
          } else {
            setStatus("Генерирую предпросмотр на сервере...", "ok");
          }
      
          fetch("/api/mihomo/preview", {
            method: "POST",
            headers: {
              "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
          })
            .then(resp => resp.json().catch(() => ({})).then(data => ({ ok: resp.ok, status: resp.status, data })))
            .then(({ ok, status, data }) => {
              if (!ok || !data || data.ok === false) {
                const msg = (data && (data.error || data.message)) || "Не удалось сгенерировать предпросмотр.";
                setStatus(msg, "err");
                if (manual) {
                  showMihomoResultModal({
                    kind: 'error',
                    kicker: 'Mihomo / preview',
                    title: 'Сервер не смог собрать предпросмотр',
                    subtitle: 'Конфиг не был собран. Проверьте входные данные и ответ сервера ниже.',
                    leadTitle: 'Ошибка генерации предпросмотра',
                    leadDesc: msg,
                    summary: msg,
                    errors: uniqueStrings([data && data.error, data && data.message].filter(Boolean)),
                    log: String((data && (data.log || data.details)) || ''),
                    source: 'API /api/mihomo/preview',
                    action: 'Предпросмотр',
                  });
                  try { toast(msg, 'error'); } catch (e) {}
                }
                return;
              }
              const cfg = data.content || data.config || "";
              if (!cfg.trim()) {
                const msg = "Сервер вернул пустой конфиг для предпросмотра.";
                setStatus(msg, "err");
                if (manual) {
                  showMihomoResultModal({
                    kind: 'error',
                    kicker: 'Mihomo / preview',
                    title: 'Предпросмотр получился пустым',
                    subtitle: 'Сервер ответил без содержимого config.yaml, поэтому редактор не был обновлён.',
                    leadTitle: 'Пустой ответ сервера',
                    leadDesc: msg,
                    summary: msg,
                    errors: [msg],
                    source: 'API /api/mihomo/preview',
                    action: 'Предпросмотр',
                  });
                  try { toast(msg, 'error'); } catch (e) {}
                }
                return;
              }
              setEditorText(cfg);

              const serverWarnings = uniqueStrings(Array.isArray(data.warnings) ? data.warnings : []);
              const dg = (state && Array.isArray(state.defaultGroups)) ? state.defaultGroups : [];
              const dgCheck = validateDefaultGroupsAgainstConfig(dg, cfg);
              const combinedWarnings = uniqueStrings(localWarnings.concat(serverWarnings));
              if (dgCheck.unknown && dgCheck.unknown.length) {
                combinedWarnings.push(
                  "Неизвестные группы по умолчанию: " +
                  dgCheck.unknown.join(", ") +
                  ". Убедитесь, что такие proxy-groups существуют в шаблоне."
                );
              }

              if (combinedWarnings.length) {
                const warnMsg = combinedWarnings.join(" • ");
                setStatus(warnMsg, "warn");
                if (manual) {
                  showMihomoResultModal({
                    kind: 'warning',
                    kicker: 'Mihomo / preview',
                    title: 'Предпросмотр собран с предупреждениями',
                    subtitle: 'YAML уже обновлён в редакторе, но перед применением лучше проверить замечания ниже.',
                    leadTitle: 'Предпросмотр готов, но есть нюансы',
                    leadDesc: firstMeaningfulLine(cfg) || 'Сервер собрал config.yaml и передал его в редактор.',
                    summary: 'Сервер успешно сгенерировал config.yaml для просмотра без сохранения и перезапуска.',
                    warnings: combinedWarnings,
                    source: 'API /api/mihomo/preview',
                    action: 'Предпросмотр',
                  });
                  try { toast('Предпросмотр обновлён с предупреждениями.', 'info'); } catch (e) {}
                }
              } else {
                setStatus("Предпросмотр сгенерирован на сервере без сохранения и перезапуска.", "ok");
                if (manual) try { toast("Предпросмотр обновлён.", 'success'); } catch (e) {}
              }
            })
            .catch(err => {
              console.error("preview error", err);
              const msg = "Ошибка генерации предпросмотра: " + err;
              setStatus(msg, "err");
              if (manual) {
                showMihomoResultModal({
                  kind: 'error',
                  kicker: 'Mihomo / preview',
                  title: 'Предпросмотр прервался из-за ошибки сети',
                  subtitle: 'Браузер не смог получить ответ сервера генератора.',
                  leadTitle: 'Ошибка соединения',
                  leadDesc: msg,
                  summary: msg,
                  errors: [String(err || 'network error')],
                  source: 'Браузер / fetch',
                  action: 'Предпросмотр',
                });
                try { toast(msg, 'error'); } catch (e) {}
              }
            });
        }
        // ----- download config -----
        function downloadConfig() {
          const text = getEditorText();
          if (!text.trim()) {
            setStatus("Нечего сохранять – редактор пуст.", "err");
            try { toast("Нечего сохранять – редактор пуст.", 'error'); } catch (e) {}
            return;
          }
          const blob = new Blob([text], { type: "text/yaml" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "config.yaml";
          document.body.appendChild(a);
          a.click();
          setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          }, 0);
          setStatus("config.yaml скачан на компьютер.", "ok");
          try { toast("config.yaml скачан на компьютер.", 'success'); } catch (e) {}
        }
      
        
        // ----- premium result modal (preview / validate / apply) -----
        function extractLineColFromText(text) {
          const raw = String(text || "");
          if (!raw) return null;
          const re = /(line|строка)[^0-9]*(\d+)[^0-9]+(column|col|столбец)?[^0-9]*(\d+)?/i;
          const m = raw.match(re);
          if (!m) return null;
          const line = parseInt(m[2], 10);
          const column = m[4] ? parseInt(m[4], 10) : 1;
          if (!Number.isFinite(line) || line <= 0) return null;
          return { line, column: Number.isFinite(column) && column > 0 ? column : 1 };
        }

        function firstMeaningfulLine(text) {
          return (String(text || "").split("\n").find((line) => String(line || "").trim()) || "").trim();
        }

        function renderResultItems(items, tone) {
          const arr = uniqueStrings(items || []);
          if (!arr.length) return "";
          const toneClass = tone === 'error' ? 'mihomo-result-item--error' : (tone === 'warning' ? 'mihomo-result-item--warning' : '');
          return arr.map((item, index) => {
            return '<div class="mihomo-result-item ' + toneClass + '">' +
              '<span class="mihomo-result-item-index">' + (index + 1) + '</span>' +
              '<span>' + escapeHtml(item) + '</span>' +
            '</div>';
          }).join('');
        }

        function setResultSectionVisible(node, visible) {
          if (!node) return;
          node.style.display = visible ? '' : 'none';
        }

        function buildResultCopyText(payload) {
          const parts = [];
          const title = String((payload && payload.title) || 'Результат операции').trim();
          if (title) parts.push(title);
          const summary = String((payload && payload.summary) || '').trim();
          if (summary) parts.push('', summary);
          const warnings = uniqueStrings(payload && payload.warnings);
          if (warnings.length) {
            parts.push('', 'Предупреждения:');
            warnings.forEach((item) => parts.push('- ' + item));
          }
          const errors = uniqueStrings(payload && payload.errors);
          if (errors.length) {
            parts.push('', 'Ошибки:');
            errors.forEach((item) => parts.push('- ' + item));
          }
          const log = String((payload && payload.log) || '').trim();
          if (log) parts.push('', 'Лог / детали:', log);
          return parts.join('\n');
        }

        function wireDismissableModal(modal, dismissSelector, hideFn) {
          if (!modal || typeof hideFn !== 'function') return;
          if (modal.dataset && modal.dataset.xkDismissWired === '1') return;

          modal.addEventListener('click', (ev) => {
            if (ev && ev.target === modal) hideFn();
          });

          try {
            const dismissers = modal.querySelectorAll(dismissSelector);
            dismissers.forEach((btn) => {
              if (!btn || (btn.dataset && btn.dataset.xkDismissWired === '1')) return;
              btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                hideFn();
              });
              if (btn.dataset) btn.dataset.xkDismissWired = '1';
            });
          } catch (e) {}

          if (modal.dataset) modal.dataset.xkDismissWired = '1';
        }

        function hideMihomoResultModal() {
          if (!mihomoResultModal) return;
          mihomoResultModal.classList.add('hidden');
          document.body.classList.remove('modal-open');
        }

        function showMihomoResultModal(options) {
          if (!mihomoResultModal) return;

          const payload = Object.assign({
            kind: 'info',
            kicker: 'Mihomo / result',
            title: 'Результат операции',
            subtitle: 'Подробности проверки, предпросмотра и применения конфигурации отображаются в одном окне.',
            leadTitle: '',
            leadDesc: '',
            summary: '',
            warnings: [],
            errors: [],
            log: '',
            source: '',
            action: '',
          }, options || {});

          const kind = (String(payload.kind || 'info').toLowerCase());
          const normalizedKind = (kind === 'success' || kind === 'warning' || kind === 'error') ? kind : 'info';
          const icons = { success: 'OK', warning: '!', error: 'ERR', info: 'MH' };
          const badges = { success: 'Готово', warning: 'Внимание', error: 'Ошибка', info: 'Инфо' };
          const lineCol = payload.lineCol || extractLineColFromText([payload.summary, payload.log, (payload.errors || []).join('\n')].join('\n'));
          const meta = [];
          if (payload.source) meta.push({ label: 'Источник', value: payload.source });
          if (payload.action) meta.push({ label: 'Операция', value: payload.action });
          if (lineCol) meta.push({ label: 'Локация', value: 'строка ' + lineCol.line + ', столбец ' + lineCol.column });

          _lastMihomoResultPayload = Object.assign({}, payload, { kind: normalizedKind, lineCol });

          try { mihomoResultModal.dataset.kind = normalizedKind; } catch (e) {}
          if (mihomoResultModalKicker) mihomoResultModalKicker.textContent = String(payload.kicker || 'Mihomo / result');
          if (mihomoResultModalTitle) mihomoResultModalTitle.textContent = String(payload.title || 'Результат операции');
          if (mihomoResultModalSubtitle) mihomoResultModalSubtitle.textContent = String(payload.subtitle || '');
          if (mihomoResultModalIcon) mihomoResultModalIcon.textContent = icons[normalizedKind] || 'MH';
          if (mihomoResultModalLeadTitle) mihomoResultModalLeadTitle.textContent = String(payload.leadTitle || payload.title || 'Результат операции');
          if (mihomoResultModalLeadDesc) mihomoResultModalLeadDesc.textContent = String(payload.leadDesc || payload.summary || payload.subtitle || '');
          if (mihomoResultModalBadge) mihomoResultModalBadge.textContent = badges[normalizedKind] || 'Инфо';

          const summaryText = String(payload.summary || '').trim();
          setResultSectionVisible(mihomoResultSummaryWrap, !!summaryText);
          if (mihomoResultSummary) mihomoResultSummary.textContent = summaryText;

          const warningHtml = renderResultItems(payload.warnings, 'warning');
          setResultSectionVisible(mihomoResultWarningsWrap, !!warningHtml);
          if (mihomoResultWarnings) mihomoResultWarnings.innerHTML = warningHtml;

          const errorHtml = renderResultItems(payload.errors, 'error');
          setResultSectionVisible(mihomoResultErrorsWrap, !!errorHtml);
          if (mihomoResultErrors) mihomoResultErrors.innerHTML = errorHtml;

          if (mihomoResultMetaWrap) {
            if (meta.length) {
              mihomoResultMetaWrap.innerHTML = meta.map((item) => (
                '<div class="mihomo-result-meta-card">' +
                  '<div class="mihomo-result-meta-label">' + escapeHtml(item.label) + '</div>' +
                  '<div class="mihomo-result-meta-value">' + escapeHtml(item.value) + '</div>' +
                '</div>'
              )).join('');
            } else {
              mihomoResultMetaWrap.innerHTML = '';
            }
            setResultSectionVisible(mihomoResultMetaWrap, meta.length > 0);
          }

          const logText = String(payload.log || '').trim();
          setResultSectionVisible(mihomoResultLogWrap, !!logText);
          if (mihomoResultModalLog) mihomoResultModalLog.innerHTML = logText ? formatLogHtml(logText) : '';

          if (mihomoResultJumpBtn) {
            const canJump = !!lineCol;
            mihomoResultJumpBtn.style.display = canJump ? '' : 'none';
            mihomoResultJumpBtn.onclick = canJump ? (() => {
              try { jumpToErrorPositionFromLog('line ' + lineCol.line + ' column ' + lineCol.column); } catch (e) {}
              hideMihomoResultModal();
            }) : null;
          }

          if (mihomoResultCopyBtn) {
            mihomoResultCopyBtn.onclick = async () => {
              const copyText = buildResultCopyText(_lastMihomoResultPayload || payload);
              try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  await navigator.clipboard.writeText(copyText);
                } else {
                  const ta = document.createElement('textarea');
                  ta.value = copyText;
                  document.body.appendChild(ta);
                  ta.select();
                  document.execCommand('copy');
                  document.body.removeChild(ta);
                }
                try { toast('Детали скопированы в буфер обмена.', 'success'); } catch (e) {}
              } catch (e) {
                try { toast('Не удалось скопировать детали.', 'error'); } catch (e2) {}
              }
            };
          }

          mihomoResultModal.classList.remove('hidden');
          document.body.classList.add('modal-open');
        }

        function showValidationModal(text) {
          const raw = text == null ? '' : String(text);
          showMihomoResultModal({
            kind: /\[exit code:\s*0\]/i.test(raw) ? 'success' : 'error',
            kicker: 'Mihomo / validate',
            title: /\[exit code:\s*0\]/i.test(raw) ? 'Проверка конфигурации пройдена' : 'Проверка конфигурации не пройдена',
            subtitle: 'Проверка выполняется через mihomo -t без сохранения и перезапуска.',
            leadTitle: 'Результат проверки config.yaml',
            leadDesc: firstMeaningfulLine(raw) || 'Mihomo вернул подробный лог проверки.',
            summary: firstMeaningfulLine(raw) || '',
            log: raw,
            source: 'mihomo -t',
            action: 'Валидация',
          });
        }

        const hideValidationModal = hideMihomoResultModal;
        window.showValidationModal = showValidationModal;
        window.hideValidationModal = hideValidationModal;
        window.hideMihomoResultModal = hideMihomoResultModal;
        wireDismissableModal(mihomoResultModal, '[data-dismiss="mihomo-result"]', hideMihomoResultModal);

        // ----- bulk import modal -----
        function showBulkImportModal() {
          const modal = bulkImportModal || document.getElementById("bulkImportModal");
          if (!modal) return;
          modal.classList.remove("hidden");
          document.body.classList.add("modal-open");
          try {
            if (bulkImportTextarea) bulkImportTextarea.focus();
          } catch (e) {}
        }

        function hideBulkImportModal() {
          const modal = bulkImportModal || document.getElementById("bulkImportModal");
          if (!modal) return;
          modal.classList.add("hidden");
          document.body.classList.remove("modal-open");
        }

        window.showBulkImportModal = showBulkImportModal;
        window.hideBulkImportModal = hideBulkImportModal;
        wireDismissableModal(bulkImportModal, '[data-dismiss="bulk-import"]', hideBulkImportModal);

        document.addEventListener('keydown', (ev) => {
          try {
            if (ev.key === 'Escape') {
              const resultModal = mihomoResultModal || document.getElementById('mihomoResultModal');
              if (resultModal && !resultModal.classList.contains('hidden')) {
                ev.preventDefault();
                hideMihomoResultModal();
                return;
              }
            }
          } catch (e) {}
          try {
            const modal = bulkImportModal || document.getElementById("bulkImportModal");
            if (!modal || modal.classList.contains('hidden')) return;
            if (ev.key === 'Escape') {
              ev.preventDefault();
              hideBulkImportModal();
              return;
            }
            if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
              ev.preventDefault();
              doBulkImport();
            }
          } catch (e) {}
        });
      
        // ----- validate via mihomo core -----
        async function validateConfigOnServer(showPopup = true, notify = false) {
          const cfg = getEditorText();
          if (!cfg.trim()) {
            const msg = "Нечего проверять – конфиг пуст.";
            setStatus(msg, "err");
            if (showPopup) {
              showMihomoResultModal({
                kind: 'error',
                kicker: 'Mihomo / validate',
                title: 'Проверка невозможна',
                subtitle: 'Перед проверкой нужно получить или вставить config.yaml в редактор.',
                leadTitle: 'Пустой редактор',
                leadDesc: msg,
                summary: msg,
                errors: [msg],
                source: 'Редактор',
                action: 'Валидация',
              });
            }
            if (notify) try { toast(msg, 'error'); } catch (e) {}
            return { ok: false, log: '', message: msg };
          }
          setStatus("Проверяю конфиг через mihomo...", "ok");
          try {
            const res = await fetch("/api/mihomo/validate_raw", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ config: cfg }),
            });
            const data = await res.json().catch(() => ({}));
            const log = data && data.log ? String(data.log) : "";
            if (typeof log === "string" && log.trim()) {
              setValidationLog(log);
              if (!res.ok || !data.ok) {
                jumpToErrorPositionFromLog(log);
              }
            }
            if (!res.ok) {
              const msg = "Ошибка проверки конфига: " + (data && (data.error || res.status));
              setStatus(msg, "err");
              if (showPopup) {
                showMihomoResultModal({
                  kind: 'error',
                  kicker: 'Mihomo / validate',
                  title: 'Сервер не смог проверить конфиг',
                  subtitle: 'Проверка через mihomo -t не завершилась успешно.',
                  leadTitle: 'Проверка остановлена',
                  leadDesc: msg,
                  summary: msg,
                  errors: [String((data && data.error) || res.status || 'Неизвестная ошибка')],
                  log,
                  source: 'API /api/mihomo/validate_raw',
                  action: 'Валидация',
                });
              }
              if (notify) try { toast(msg, 'error'); } catch (e) {}
              return { ok: false, log, message: msg };
            }
            const firstLine = firstMeaningfulLine(log);
            if (data.ok) {
              const msg = firstLine || "mihomo сообщает, что конфиг валиден (exit code 0).";
              setStatus(msg, "ok");
              if (showPopup) {
                showMihomoResultModal({
                  kind: 'success',
                  kicker: 'Mihomo / validate',
                  title: 'Проверка конфигурации пройдена',
                  subtitle: 'Mihomo принял config.yaml — ядро не нашло ошибок в синтаксисе и структуре.',
                  leadTitle: 'config.yaml валиден',
                  leadDesc: msg,
                  summary: msg,
                  log,
                  source: 'mihomo -t',
                  action: 'Валидация',
                });
              }
              if (notify) try { toast(msg, 'success'); } catch (e) {}
              return { ok: true, log, message: msg };
            } else {
              const msg = firstLine || "mihomo сообщил об ошибке при проверке конфига.";
              setStatus("В таком виде конфиг не будет работать: " + msg, "err");
              if (showPopup) {
                showMihomoResultModal({
                  kind: 'error',
                  kicker: 'Mihomo / validate',
                  title: 'Проверка конфигурации не пройдена',
                  subtitle: 'Конфиг не был сохранён и не должен применяться, пока ошибка не исправлена.',
                  leadTitle: 'Mihomo отклонил config.yaml',
                  leadDesc: msg,
                  summary: msg,
                  errors: [msg],
                  log,
                  source: 'mihomo -t',
                  action: 'Валидация',
                });
              }
              if (notify) try { toast("В таком виде конфиг не будет работать: " + msg, 'error'); } catch (e) {}
              return { ok: false, log, message: msg };
            }
          } catch (e) {
            const msg = "Ошибка сети при проверке конфига: " + e;
            setStatus(msg, "err");
            if (showPopup) {
              showMihomoResultModal({
                kind: 'error',
                kicker: 'Mihomo / validate',
                title: 'Проверка прервалась из-за ошибки сети',
                subtitle: 'Браузер не смог получить ответ от сервера проверки.',
                leadTitle: 'Сетевая ошибка',
                leadDesc: msg,
                summary: msg,
                errors: [String(e || 'network error')],
                source: 'Браузер / fetch',
                action: 'Валидация',
              });
            }
            if (notify) try { toast(msg, 'error'); } catch (e2) {}
            return { ok: false, log: '', message: msg };
          }
        }
      // ----- apply to router -----
        async function applyToRouter(notify = false) {
          const state = collectState();
          const cfg = getEditorText();
          if (!cfg.trim()) {
            const msg = "Нечего применять – конфиг пуст.";
            setStatus(msg, "err");
            showMihomoResultModal({
              kind: 'error',
              kicker: 'Mihomo / apply',
              title: 'Применение невозможно',
              subtitle: 'В редакторе нет config.yaml для сохранения и отправки на роутер.',
              leadTitle: 'Пустой редактор',
              leadDesc: msg,
              summary: msg,
              errors: [msg],
              source: 'Редактор',
              action: 'Применение',
            });
            if (notify) try { toast(msg, 'error'); } catch (e) {}
            return;
          }
      
          updateStateSummary(state);
          const validationState = validateState(state, "apply");
          const warnings = uniqueStrings(validationState.warnings || []);
          const errors = uniqueStrings(validationState.errors || []);
          const dg = (state && Array.isArray(state.defaultGroups)) ? state.defaultGroups : [];
          const dgCheck = validateDefaultGroupsAgainstConfig(dg, cfg);
          if (dgCheck.unknown && dgCheck.unknown.length) {
            warnings.push(
              "Неизвестные группы по умолчанию: " +
              dgCheck.unknown.join(", ") +
              ". Убедитесь, что такие proxy-groups существуют в шаблоне."
            );
          }
          if (!validationState.valid && errors.length) {
            const msg = errors.join(" ");
            setStatus(msg, "err");
            showMihomoResultModal({
              kind: 'error',
              kicker: 'Mihomo / apply',
              title: 'Применение остановлено ещё до отправки',
              subtitle: 'Генератор нашёл ошибки в форме или в текущем состоянии узлов и подписок.',
              leadTitle: 'Клиентская проверка не пройдена',
              leadDesc: msg,
              summary: 'Запрос на сервер не отправлялся, потому что конфигурация генератора уже на клиенте выглядит небезопасной.',
              errors,
              warnings,
              source: 'Клиентская валидация',
              action: 'Применение',
            });
            if (notify) try { toast(msg, 'error'); } catch (e) {}
            return;
          }
      
          const validation = await validateConfigOnServer(false, false);
          if (!validation.ok) {
            const msg = validation.message || statusMessage.textContent || 'Ошибка валидации конфига.';
            showMihomoResultModal({
              kind: 'error',
              kicker: 'Mihomo / apply',
              title: 'Применение остановлено: config.yaml не прошёл проверку',
              subtitle: 'Сохранение и перезапуск не запускались, потому что mihomo не принял текущий YAML.',
              leadTitle: 'Mihomo отклонил текущий config.yaml',
              leadDesc: msg,
              summary: msg,
              errors: uniqueStrings(errors.concat([msg])),
              warnings,
              log: String(validation.log || ''),
              source: 'mihomo -t',
              action: 'Применение',
            });
            if (notify) try { toast(msg, 'error'); } catch (e) {}
            return;
          }
      
          if (warnings.length) {
            setStatus(warnings.join(" • "), "warn");
            if (notify) try { toast('Конфиг будет применён, но есть предупреждения.', 'info'); } catch (e) {}
          } else {
            setStatus("Отправляю конфиг на роутер...", "ok");
            if (notify) try { toast("Отправляю конфиг на роутер...", 'info'); } catch (e) {}
          }
      
          const payload = { state, configOverride: cfg };
          let snap = null;
          const btn = applyBtn;
          try {
            try { if (btn) btn.disabled = true; } catch (e) {}

            try { snap = await refreshActiveCorePill({ silent: true }); } catch (e) { snap = null; }

            const res = await fetch("/api/mihomo/generate_apply", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
              const msg = "Ошибка при применении: " + (data.error || res.status);
              setStatus(msg, "err");
              showMihomoResultModal({
                kind: 'error',
                kicker: 'Mihomo / apply',
                title: 'Сервер не смог применить конфиг',
                subtitle: 'Конфиг не был безопасно сохранён или перезапуск не был запущен.',
                leadTitle: 'Ошибка сохранения / применения',
                leadDesc: msg,
                summary: msg,
                errors: uniqueStrings(errors.concat([String((data && data.error) || res.status || 'Неизвестная ошибка')])),
                warnings,
                log: String((data && (data.log || data.details)) || ''),
                source: 'API /api/mihomo/generate_apply',
                action: 'Применение',
              });
              if (notify) try { toast(msg, 'error'); } catch (e) {}
              return;
            }

            const serverWarnings = uniqueStrings(Array.isArray(data.warnings) ? data.warnings : []);
            const finalWarnings = uniqueStrings(warnings.concat(serverWarnings));

            const core = (data && data.core) ? String(data.core) : (snap && snap.core ? String(snap.core) : (_lastKnownCore || ''));
            if (core) _lastKnownCore = core;
            try { _setCorePill(core, true); } catch (e) {}

            if (core && core !== 'mihomo') {
              const coreWarning = 'Сейчас активно ядро ' + core + '. Конфиг Mihomo сохранён, но применится только после переключения ядра на Mihomo.';
              finalWarnings.push(coreWarning);
              if (notify) try { toast(coreWarning, true); } catch (e) {}
            }

            const jobId = (data && (data.restart_job_id || data.job_id)) ? String(data.restart_job_id || data.job_id) : '';

            if (jobId) {
              const baseMsg = 'Конфиг сохранён. Запущен перезапуск xkeen (в фоне).';
              setStatus(finalWarnings.length ? (baseMsg + "\n" + finalWarnings.join(" • ")) : baseMsg, finalWarnings.length ? 'warn' : 'ok');

              try {
                await clearSharedRestartLog();
                await appendSharedRestartLog('⏳ Запуск xkeen -restart (job ' + jobId + ')\n');
              } catch (e) {}
              try {
                appendValidationLog('');
                appendValidationLog('--- xkeen -restart (job ' + jobId + ') ---');
              } catch (e) {}

              const CJ = getMihomoCommandJobApi();
              if (CJ && typeof CJ.waitForCommandJob === 'function') {
                const result = await CJ.waitForCommandJob(jobId, {
                  maxWaitMs: 300000,
                  onChunk: (chunk) => {
                    try {
                      void appendSharedRestartLog(String(chunk || ''));
                    } catch (e) {}
                    try {
                      const clean = String(chunk || '').replace(/\r\n/g, '\n').replace(/\n+$/g, '');
                      if (clean) appendValidationLog(clean);
                    } catch (e) {}
                  }
                });

                const ok = !!(result && result.status === 'finished' && (result.exit_code === 0 || result.exit_code === null) && !result.error);
                if (ok) {
                  const summary = finalWarnings.length
                    ? 'Конфиг сохранён, xkeen успешно перезапущен, но стоит проверить предупреждения ниже.'
                    : 'Конфиг сохранён и xkeen успешно перезапущен.';
                  setStatus(finalWarnings.length ? 'xkeen перезапущен с предупреждениями.' : 'xkeen перезапущен.', finalWarnings.length ? 'warn' : 'ok');
                  showMihomoResultModal({
                    kind: finalWarnings.length ? 'warning' : 'success',
                    kicker: 'Mihomo / apply',
                    title: finalWarnings.length ? 'Конфиг применён с предупреждениями' : 'Конфиг успешно применён',
                    subtitle: jobId ? ('Перезапуск xkeen выполнялся фоновым заданием: ' + jobId + '.') : 'Конфиг сохранён и применён на роутере.',
                    leadTitle: finalWarnings.length ? 'Сохранение и перезапуск завершены, но есть замечания' : 'Сохранение и перезапуск завершены',
                    leadDesc: summary,
                    summary,
                    warnings: finalWarnings,
                    log: validationLogRaw,
                    source: 'API /api/mihomo/generate_apply',
                    action: 'Применение',
                  });
                  if (notify) try { toast(finalWarnings.length ? 'Конфиг применён с предупреждениями.' : 'xkeen перезапущен.', finalWarnings.length ? 'info' : 'success'); } catch (e) {}
                } else {
                  const errMsg = (result && result.error) ? String(result.error) : 'Перезапуск завершился с ошибкой';
                  setStatus(errMsg, 'err');
                  showMihomoResultModal({
                    kind: 'error',
                    kicker: 'Mihomo / apply',
                    title: 'Конфиг сохранён, но перезапуск завершился ошибкой',
                    subtitle: 'Файл уже записан на роутер, однако фоновый перезапуск xkeen не завершился штатно.',
                    leadTitle: 'Ошибка на этапе перезапуска',
                    leadDesc: errMsg,
                    summary: errMsg,
                    warnings: finalWarnings,
                    errors: [errMsg],
                    log: validationLogRaw,
                    source: 'Фоновый job xkeen -restart',
                    action: 'Применение',
                  });
                  try {
                    await appendSharedRestartLog('\nОшибка: ' + errMsg + '\n');
                  } catch (e) {}
                  if (notify) try { toast(errMsg, 'error'); } catch (e) {}
                }
              } else {
                if (notify) try { toast('Перезапуск запущен (job ' + jobId + ').', 'info'); } catch (e) {}
                showMihomoResultModal({
                  kind: finalWarnings.length ? 'warning' : 'success',
                  kicker: 'Mihomo / apply',
                  title: finalWarnings.length ? 'Конфиг сохранён, перезапуск запущен с предупреждениями' : 'Конфиг сохранён, перезапуск запущен',
                  subtitle: 'Роутер уже получил config.yaml, а перезапуск xkeen выполняется в фоне.',
                  leadTitle: 'Фоновое применение запущено',
                  leadDesc: 'Job ID: ' + jobId,
                  summary: 'Конфиг сохранён на роутере. Следите за логом проверки ниже, пока xkeen завершает перезапуск.',
                  warnings: finalWarnings,
                  log: validationLogRaw,
                  source: 'Фоновый job xkeen -restart',
                  action: 'Применение',
                });
              }
              return;
            }

            const baseMsg = "Конфиг отправлен на роутер, xkeen перезапускается.";
            setStatus(finalWarnings.length ? (baseMsg + "\n" + finalWarnings.join(" • ")) : baseMsg, finalWarnings.length ? 'warn' : 'ok');
            showMihomoResultModal({
              kind: finalWarnings.length ? 'warning' : 'success',
              kicker: 'Mihomo / apply',
              title: finalWarnings.length ? 'Конфиг применён с предупреждениями' : 'Конфиг успешно применён',
              subtitle: 'Сервер принял config.yaml и запустил перезапуск xkeen.',
              leadTitle: finalWarnings.length ? 'Сохранение выполнено, но есть замечания' : 'Сохранение выполнено успешно',
              leadDesc: baseMsg,
              summary: baseMsg,
              warnings: finalWarnings,
              source: 'API /api/mihomo/generate_apply',
              action: 'Применение',
            });
          } catch (e) {
            const msg = "Ошибка сети: " + e;
            setStatus(msg, "err");
            showMihomoResultModal({
              kind: 'error',
              kicker: 'Mihomo / apply',
              title: 'Применение прервалось из-за ошибки сети',
              subtitle: 'Браузер не смог дождаться ответа сервера после отправки config.yaml.',
              leadTitle: 'Сетевая ошибка',
              leadDesc: msg,
              summary: msg,
              warnings,
              errors: [String(e || 'network error')],
              source: 'Браузер / fetch',
              action: 'Применение',
            });
            if (notify) try { toast(msg, 'error'); } catch (e2) {}
          } finally {
            try { if (btn) btn.disabled = false; } catch (e) {}
          }
        }
        // ----- copy -----
        function copyConfig() {
          const text = getEditorText();
          if (!navigator.clipboard) {
            const t = document.createElement("textarea");
            t.value = text;
            document.body.appendChild(t);
            t.select();
            try {
              document.execCommand("copy");
              setStatus("Скопировано в буфер (через fallback).", "ok");
              try { toast("Скопировано в буфер.", 'success'); } catch (e) {}
            } catch (e) {
              setStatus("Не удалось скопировать.", "err");
              try { toast("Не удалось скопировать.", 'error'); } catch (e) {}
            } finally {
              document.body.removeChild(t);
            }
            return;
          }
          navigator.clipboard.writeText(text).then(
            () => { setStatus("Конфиг скопирован в буфер обмена.", "ok"); try { toast("Конфиг скопирован в буфер обмена.", 'success'); } catch (e) {} },
            () => { setStatus("Не удалось скопировать в буфер обмена.", "err"); try { toast("Не удалось скопировать в буфер обмена.", 'error'); } catch (e) {} }
          );
        }

        // ----- edit toggle -----
        function setEditable(flag, notify = false) {
          _isEditable = !!flag;

          // Apply to CodeMirror if present
          try {
            if (editor && editor.setOption) editor.setOption('readOnly', !_isEditable);
          } catch (e) {}

          if (_isEditable) {
            duringIdle(() => {
              try { enhanceEditorOptions(); } catch (e) {}
            }, 180);
          }

          // Apply to Monaco if present
          try {
            if (_monaco && _monaco.updateOptions) _monaco.updateOptions({ readOnly: !_isEditable });
          } catch (e) {}

          if (_isEditable) {
            setStatus('Режим редактирования включён.', 'ok');
            if (notify) {
              try { toast('Режим редактирования включён.', 'info'); } catch (e) {}
            }
          } else {
            setStatus('Редактирование выключено, конфиг защищён от случайных правок.', null);
            if (notify) {
              try { toast('Редактирование выключено.', 'info'); } catch (e) {}
            }
          }
        }

        // ----- init -----
        // NOTE: init() itself is called from pages/mihomo_generator.init.js on DOMContentLoaded.
        // Поэтому здесь нельзя вешать ещё один DOMContentLoaded, иначе колбэк уже не сработает.
        setStatus("Скелет загружен. Заполните поля слева и нажмите «Применить».", null);

        try {
          Promise.resolve(ensureEditorRuntime('codemirror', {
            mode: 'yaml',
            search: true,
            fullscreen: true,
            comments: true,
          }))
            .then((runtime) => {
              if (runtime && typeof runtime.ensureAssets === 'function') {
                return runtime.ensureAssets({
                  mode: 'yaml',
                  search: true,
                  fullscreen: true,
                  comments: true,
                });
              }
              return null;
            })
            .catch(() => null)
            .finally(() => {
              try { if (!editor) initEditor(); } catch (e) {}
            });
        } catch (e) {}

        try { initEditor(); } catch (e) {}
        try { setEditable(!!(editToggle && editToggle.checked), false); } catch (e) {}
        try { initEngineToggle(); } catch (e) {}
        try { addInitialSubscriptionRow(); } catch (e) {}

        duringIdle(() => {
          try { loadProfileDefaults(profileSelect && profileSelect.value); } catch (e) {}
          try { refreshActiveCorePill({ silent: true }); } catch (e) {}
        });
      
        addSubscriptionBtn.onclick = () => {
          subscriptionsList.appendChild(createSubscriptionRow(""));
        };
        addProxyBtn.onclick = () => createProxyCard();
        if (bulkImportBtn) bulkImportBtn.onclick = () => showBulkImportModal();
        if (normalizeProxiesBtn) normalizeProxiesBtn.onclick = () => applyTemplatesToExistingProxies();
        if (bulkImportApplyBtn) bulkImportApplyBtn.onclick = () => doBulkImport();
        if (bulkImportApplyExistingBtn) bulkImportApplyExistingBtn.onclick = () => applyTemplatesToExistingProxies();
        generateBtn.onclick = () => generatePreviewDemo(true);
        saveBtn.onclick = downloadConfig;
        validateBtn.onclick = () => { validateConfigOnServer(true, true); };
        applyBtn.onclick = () => applyToRouter(true);
        copyBtn.onclick = copyConfig;
        if (clearValidationLogBtn) {
          clearValidationLogBtn.onclick = () => { setValidationLog(""); try { toast("Лог проверки очищен.", 'info'); } catch (e) {} };
        }
        editToggle.addEventListener("change", () => setEditable(editToggle.checked, true));
    }

    return { init };
  })();
})();

export function getMihomoGeneratorApi() {
  try {
    if (mihomoGeneratorModuleApi && typeof mihomoGeneratorModuleApi.init === 'function') return mihomoGeneratorModuleApi;
  } catch (error) {
    return null;
  }
  return null;
}

export function initMihomoGenerator(...args) {
  const api = getMihomoGeneratorApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export const mihomoGeneratorApi = Object.freeze({
  get: getMihomoGeneratorApi,
  init: initMihomoGenerator,
});
