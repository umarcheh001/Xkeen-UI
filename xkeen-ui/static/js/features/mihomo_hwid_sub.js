import { getMihomoPanelApi } from './mihomo_panel.js';
import { getMihomoYamlPatchApi } from './mihomo_yaml_patch.js';
import {
  getMihomoCommandJobApi,
  getMihomoCoreHttpApi,
  getMihomoEditorEngineApi,
  refreshSharedMihomoEditor,
  syncMihomoModalBodyScrollLock,
} from './mihomo_runtime.js';
import { getXkeenFilePath } from './xkeen_runtime.js';

let mihomoHwidSubModuleApi = null;

(() => {
  'use strict';

  // Mihomo HWID subscription wizard
  // - Probe subscription with HWID headers
  // - Build proxy-provider YAML snippet
  // - Insert into config.yaml editor (proxy-providers section)
  // Legacy globals are published by features/compat/mihomo_hwid_sub.js.

  const HW = mihomoHwidSubModuleApi || {};
  mihomoHwidSubModuleApi = HW;

  const IDS = {
    btnOpen: 'mihomo-hwid-sub-btn',

    modal: 'mihomo-hwid-modal',
    btnClose: 'mihomo-hwid-close-btn',
    btnCancel: 'mihomo-hwid-cancel-btn',

    url: 'mihomo-hwid-url',
    insecure: 'mihomo-hwid-insecure',
    name: 'mihomo-hwid-name',
    preview: 'mihomo-hwid-preview',
    previewMonaco: 'mihomo-hwid-preview-monaco',
    engineSelect: 'mihomo-hwid-engine-select',

    status: 'mihomo-hwid-status',
    meta: 'mihomo-hwid-meta',
    tip: 'mihomo-hwid-tip',
    diag: 'mihomo-hwid-diag',
    diagActive: 'mihomo-hwid-diag-active',
    diagActiveNote: 'mihomo-hwid-diag-active-note',
    diagSource: 'mihomo-hwid-diag-source',
    diagSourceNote: 'mihomo-hwid-diag-source-note',
    diagRouter: 'mihomo-hwid-diag-router',
    diagRouterNote: 'mihomo-hwid-diag-router-note',
    diagDevice: 'mihomo-hwid-diag-device',
    diagDeviceNote: 'mihomo-hwid-diag-device-note',
    diagHeaders: 'mihomo-hwid-diag-headers',
    diagResponse: 'mihomo-hwid-diag-response',

    btnProbe: 'mihomo-hwid-probe-btn',
    btnInsert: 'mihomo-hwid-insert-btn',

    // Injected in MH-04
    btnApplyRestart: 'mihomo-hwid-apply-restart-btn',
    mode: 'mihomo-hwid-mode',
    template: 'mihomo-hwid-template',
  };

  let _inited = false;
  let _restartLogModulePromise = null;
  let _device = null; // device info from /api/mihomo/hwid/device
  let _lastProbe = null; // probe response
  let _busy = false;
  let _previewCm = null;
  let _previewFacade = null;
  let _previewMonaco = null;
  let _previewMonacoFacade = null;
  let _previewKind = 'codemirror';
  let _previewLastText = '';
  let _previewLayoutRaf = 0;
  let _engineUnsub = null;
  let _engineSyncing = false;

  const CM6_SCOPE = 'mihomo-hwid-preview';

  function $(id) {
    return document.getElementById(id);
  }

  function toastMsg(msg, kind) {
    // kind: 'success' | 'error' | 'warning'
    try {
      if (window.toast) window.toast(String(msg || ''), kind || 'success');
      else if (window.showToast) window.showToast(String(msg || ''), kind === 'error');
    } catch (e) {}
  }

  function toggleBlock(el, show) {
    if (!el) return;
    try { el.classList.toggle('hidden', !show); } catch (e) {}
    try { el.style.display = show ? '' : 'none'; } catch (e2) {}
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    const s = String(msg || '').trim();
    el.textContent = s;
    el.classList.toggle('error', !!isErr && !!s);
    el.classList.toggle('success', !!s && !isErr);
    toggleBlock(el, !!s);
  }

  function setMeta(msg) {
    const el = $(IDS.meta);
    if (!el) return;
    const s = String(msg || '').trim();
    el.textContent = s;
    toggleBlock(el, !!s);
  }

  function setTip(msg) {
    const el = $(IDS.tip);
    if (!el) return;
    const s = String(msg || '').trim();
    el.textContent = s;
    toggleBlock(el, !!s);
  }

  function setDiagValue(id, value, fallback) {
    const el = $(id);
    if (!el) return;
    const text = String(value == null ? '' : value).trim();
    el.textContent = text || String(fallback || '—');
  }

  function setDiagNote(id, value) {
    const el = $(id);
    if (!el) return;
    const text = String(value == null ? '' : value).trim();
    el.textContent = text;
    toggleBlock(el, !!text);
  }

  function hwidFormatLabel(kind) {
    const s = String(kind || '').trim().toLowerCase();
    if (s === 'mac12') return 'MAC-12 format';
    if (s === 'string') return 'provider string override';
    return 'not detected';
  }

  function formatHeaderBlock(headers, emptyText) {
    const h = headers && typeof headers === 'object' ? headers : null;
    if (!h) return String(emptyText || '—');
    const keys = Object.keys(h).filter((key) => String(h[key] || '').trim());
    if (!keys.length) return String(emptyText || '—');
    keys.sort((a, b) => a.localeCompare(b));
    return keys.map((key) => `${key}: ${String(h[key] || '').trim()}`).join('\n');
  }

  function formatProviderResponseBlock(result) {
    const res = result && typeof result === 'object' ? result : null;
    if (!res) return 'Появится после «Проверить».';

    const lines = [];
    const hdr = res.hwid_response_headers && typeof res.hwid_response_headers === 'object'
      ? res.hwid_response_headers
      : null;
    if (hdr) {
      const headerText = formatHeaderBlock(hdr, '');
      if (headerText) lines.push(headerText);
    }

    const limit = res.hwid_limit_info && typeof res.hwid_limit_info === 'object'
      ? res.hwid_limit_info
      : null;
    if (limit && limit.summary) lines.push(`devices: ${String(limit.summary)}`);
    else if (limit && typeof limit.used === 'number' && typeof limit.limit === 'number') {
      lines.push(`devices: ${String(limit.used)}/${String(limit.limit)}`);
    }

    const payload = res.provider_payload && typeof res.provider_payload === 'object'
      ? res.provider_payload
      : null;
    if (payload && typeof payload.node_count === 'number') {
      lines.push(`nodes: ${String(payload.node_count)}`);
    }
    if (payload && payload.hwid_placeholder_reason) {
      lines.push(`placeholder: ${String(payload.hwid_placeholder_reason)}`);
    }

    return lines.filter(Boolean).join('\n') || 'Провайдер не вернул специальных HWID-заголовков.';
  }

  function clearDiagnostics() {
    setDiagValue(IDS.diagActive, '—');
    setDiagValue(IDS.diagSource, '—');
    setDiagValue(IDS.diagRouter, '—');
    setDiagValue(IDS.diagDevice, '—');
    setDiagValue(IDS.diagHeaders, '—');
    setDiagValue(IDS.diagResponse, 'Появится после «Проверить».');
    setDiagNote(IDS.diagActiveNote, '');
    setDiagNote(IDS.diagSourceNote, '');
    setDiagNote(IDS.diagRouterNote, '');
    setDiagNote(IDS.diagDeviceNote, '');
    toggleBlock($(IDS.diag), false);
  }

  function renderDiagnostics(device, result) {
    const wrap = $(IDS.diag);
    if (!wrap || !device || typeof device !== 'object') {
      clearDiagnostics();
      return;
    }

    const hwid = String(device.hwid || '').trim();
    const source = hwidSourceLabel(device.hwid_source);
    const mac = String(device.mac || '').trim();
    const macHwid = String(device.mac_hwid || '').trim();
    const activeNote = [hwidFormatLabel(device.hwid_format)];
    if (device.hwid_matches_router_mac) activeNote.push('совпадает с router MAC');
    else if (device.override_differs_from_router) activeNote.push('override отличается от router MAC');
    else if (!hwid) activeNote.push('заголовок x-hwid будет пустым');

    const sourceNote = device.override_differs_from_router
      ? 'Сейчас используется ручной override, а не HWID, вычисленный из MAC роутера.'
      : String(device.hwid_warning || '').trim();

    let routerValue = 'MAC роутера недоступен';
    if (mac && macHwid) routerValue = `${mac} -> ${macHwid}`;
    else if (mac) routerValue = mac;
    else if (macHwid) routerValue = macHwid;
    const routerNote = macHwid
      ? 'Это router-native кандидат, который панель смогла вычислить из MAC.'
      : 'Панель не смогла получить MAC роутера и использует fallback-источник.';

    const deviceValue = [
      String(device.device_model || '').trim(),
      String(device.os_release || '').trim(),
    ].filter(Boolean).join(' • ');
    const deviceNote = [
      device.mihomo_version ? ('mihomo: ' + String(device.mihomo_version)) : '',
      device.user_agent ? ('UA: ' + String(device.user_agent)) : '',
    ].filter(Boolean).join('\n');

    setDiagValue(IDS.diagActive, hwid || 'не определён');
    setDiagNote(IDS.diagActiveNote, activeNote.filter(Boolean).join(' • '));
    setDiagValue(IDS.diagSource, source || 'не определён');
    setDiagNote(IDS.diagSourceNote, sourceNote);
    setDiagValue(IDS.diagRouter, routerValue);
    setDiagNote(IDS.diagRouterNote, routerNote);
    setDiagValue(IDS.diagDevice, deviceValue || '—');
    setDiagNote(IDS.diagDeviceNote, deviceNote);
    setDiagValue(IDS.diagHeaders, formatHeaderBlock(device.headers, 'Заголовки пока не собраны.'));
    setDiagValue(IDS.diagResponse, formatProviderResponseBlock(result));
    toggleBlock(wrap, true);
  }

  function hwidSourceLabel(source) {
    const s = String(source || '').trim();
    if (!s) return '';
    if (s === 'XKEEN_MIHOMO_HWID') return 'DevTools override';
    if (s === 'XKEEN_HWID') return 'XKEEN_HWID override';
    if (s === 'mac') return 'MAC роутера';
    if (s === 'machine_id') return 'machine-id';
    if (s === 'generated_state') return 'сгенерирован и сохранён';
    if (s === 'generated_ephemeral') return 'временный fallback';
    if (s === 'none') return '';
    return s;
  }

  function isTruthyHeader(value) {
    const s = String(value == null ? '' : value).trim().toLowerCase();
    return !!s && !['0', 'false', 'no', 'off', 'none', 'null'].includes(s);
  }

  function hwidProviderHeaderTips(headers) {
    const h = headers || {};
    const tips = [];
    if (isTruthyHeader(h['x-hwid-not-supported'])) {
      tips.push('Провайдер сообщил: HWID не поддержан или не принят этим запросом.');
    }
    if (isTruthyHeader(h['x-hwid-max-devices-reached'])) {
      tips.push('Провайдер сообщил: достигнут лимит устройств для этой подписки.');
    }
    if (isTruthyHeader(h['x-hwid-limit'])) {
      tips.push('Провайдер сообщил о срабатывании HWID-лимита устройств.');
    }
    if (!tips.length && isTruthyHeader(h['x-hwid-active'])) {
      tips.push('Провайдер подтвердил активный HWID-limit для этой подписки.');
    }
    return tips;
  }

  function hwidProviderHeaderMeta(headers) {
    const h = headers || {};
    const parts = [];
    if (isTruthyHeader(h['x-hwid-active'])) parts.push('HWID active');
    if (isTruthyHeader(h['x-hwid-not-supported'])) parts.push('HWID not supported');
    if (isTruthyHeader(h['x-hwid-max-devices-reached'])) parts.push('HWID max devices reached');
    if (isTruthyHeader(h['x-hwid-limit'])) parts.push('HWID limit');
    return parts;
  }

  function payloadSummaryTips(res) {
    const payload = res && res.provider_payload ? res.provider_payload : null;
    const regular = res && res.regular_provider_payload ? res.regular_provider_payload : null;
    const tips = [];
    if (payload && payload.hwid_placeholder_provider && String(payload.hwid_placeholder_reason || '') === 'device_limit') {
      tips.push('Провайдер сообщил: HWID-лимит устройств исчерпан.');
    } else if (payload && payload.has_nodes === false) {
      tips.push('HWID-подписка доступна, но вернула 0 узлов. Проверь привязку HWID у провайдера или попробуй обычную подписку.');
    }
    if (payload && payload.has_nodes === false && regular && regular.has_nodes === true) {
      tips.push('Без HWID эта ссылка возвращает узлы, поэтому для неё может лучше подойти обычный provider/import.');
    }
    if (res && res.provider_payload_error && res.provider_payload_error.message) {
      tips.push('URL проверен, но payload для подсчёта узлов получить не удалось: ' + String(res.provider_payload_error.message));
    }
    return tips;
  }

  function payloadSummaryMeta(res) {
    const payload = res && res.provider_payload ? res.provider_payload : null;
    if (!payload) return [];
    if (payload.has_nodes === false) return ['0 nodes'];
    if (typeof payload.node_count === 'number') return ['nodes: ' + String(payload.node_count)];
    return [];
  }

  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getEngineHelper() {
    return getMihomoEditorEngineApi();
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

  function normalizeEngine(engine) {
    return String(engine || '').toLowerCase() === 'monaco' ? 'monaco' : 'codemirror';
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
      if (_previewFacade && _previewFacade.getValue) return String(_previewFacade.getValue() || '');
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

  function createMonacoFacade(editor) {
    if (!editor) return null;
    const helper = getEngineHelper();
    try {
      if (helper && typeof helper.fromMonaco === 'function') return helper.fromMonaco(editor);
    } catch (e) {}
    return null;
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

  function layoutPreviewEditor() {
    try {
      if (_previewLayoutRaf) return;
      _previewLayoutRaf = requestAnimationFrame(() => {
        _previewLayoutRaf = 0;
        try {
          if (_previewCm) {
            if (typeof _previewCm.setSize === 'function') _previewCm.setSize(null, '100%');
            if (typeof _previewCm.refresh === 'function') _previewCm.refresh();
            else if (typeof _previewCm.layout === 'function') _previewCm.layout();
          }
        } catch (e1) {}
        try {
          if (_previewFacade && typeof _previewFacade.layout === 'function') _previewFacade.layout();
        } catch (e2) {}
        try {
          if (_previewMonacoFacade && typeof _previewMonacoFacade.layout === 'function') _previewMonacoFacade.layout();
          else if (_previewMonaco && typeof _previewMonaco.layout === 'function') _previewMonaco.layout();
        } catch (e3) {}
      });
    } catch (e) {
      try { if (_previewCm && typeof _previewCm.refresh === 'function') _previewCm.refresh(); } catch (e2) {}
      try { if (_previewMonaco && typeof _previewMonaco.layout === 'function') _previewMonaco.layout(); } catch (e3) {}
    }
  }

  async function ensureCodeMirrorPreviewEditor() {
    const ta = $(IDS.preview);
    if (!ta) return null;

    if (_previewCm) {
      try {
        if (_previewCm.setOption) _previewCm.setOption('theme', cmThemeFromPage());
      } catch (e) {}
      layoutPreviewEditor();
      return _previewCm;
    }

    let runtime = null;
    try {
      runtime = await ensureEditorRuntime('codemirror', { mode: 'yaml' });
      if (runtime && typeof runtime.ensureAssets === 'function') {
        await runtime.ensureAssets({ mode: 'yaml' });
      }
    } catch (e) {
      runtime = getEditorRuntime('codemirror', { mode: 'yaml' });
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
      const w = _previewCm && typeof _previewCm.getWrapperElement === 'function'
        ? _previewCm.getWrapperElement()
        : null;
      if (w) w.classList.add('xkeen-cm', 'xk-hw-preview-cm');
      if (_previewCm && typeof _previewCm.setSize === 'function') _previewCm.setSize(null, '100%');
      else if (w) w.style.height = '100%';
    } catch (e) {}

    _previewFacade = createCodeMirrorFacade(_previewCm);
    setPreview(_previewLastText);
    layoutPreviewEditor();
    return _previewCm;
  }

  async function activatePreviewEngine(engine) {
    const next = normalizeEngine(engine);
    const ta = $(IDS.preview);
    const host = $(IDS.previewMonaco);
    const value = previewTextFallback();

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        setEngineSelectValue('codemirror');
        return activatePreviewEngine('codemirror');
      }

      const w = cmWrapper(_previewCm);
      if (w) hideNode(w);
      if (ta) hideNode(ta);
      showNode(host);

      if (!_previewMonaco) {
        const ed = await runtime.create(host, {
          language: 'yaml',
          value: value,
          readOnly: true,
          tabSize: 2,
          insertSpaces: true,
          wordWrap: 'on',
          minimap: { enabled: false },
        });
        if (!ed) {
          hideNode(host);
          setEngineSelectValue('codemirror');
          return activatePreviewEngine('codemirror');
        }
        _previewMonaco = ed;
        _previewMonacoFacade = createMonacoFacade(ed);
        try { if (runtime.layoutOnVisible) runtime.layoutOnVisible(ed, host); } catch (e) {}
      } else if (_previewMonacoFacade && _previewMonacoFacade.setValue) {
        _previewMonacoFacade.setValue(value);
      } else if (_previewMonaco && typeof _previewMonaco.setValue === 'function') {
        _previewMonaco.setValue(value);
      }

      _previewKind = 'monaco';
      setEngineSelectValue('monaco');
      try { if (_previewMonacoFacade && _previewMonacoFacade.scrollTo) _previewMonacoFacade.scrollTo(0, 0); } catch (e2) {}
      layoutPreviewEditor();
      return 'monaco';
    }

    if (host) hideNode(host);
    try { disposePreviewMonaco(); } catch (e) {}

    const cm = await ensureCodeMirrorPreviewEditor();
    const w = cmWrapper(cm);
    if (cm) {
      if (w) showNode(w);
      if (ta) hideNode(ta);
    } else if (ta) {
      showNode(ta);
    }

    if (cm && cm.setOption) {
      try { cm.setOption('theme', cmThemeFromPage()); } catch (e) {}
    }
    setPreview(value);
    _previewKind = 'codemirror';
    setEngineSelectValue('codemirror');
    layoutPreviewEditor();
    return 'codemirror';
  }

  async function ensurePreviewEditor() {
    const engine = await resolvePreferredEngine();
    return activatePreviewEngine(engine);
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

  function schedulePreviewEditor() {
    try {
      Promise.resolve(ensurePreviewEditor()).catch(() => null);
    } catch (e) {}
  }

  function bindPreviewLayoutHooks() {
    const modal = $(IDS.modal);
    if (!modal || (modal.dataset && modal.dataset.xkHwPreviewLayoutBound === '1')) return;
    try {
      const content = modal.querySelector ? modal.querySelector('.modal-content') : null;
      if (content && typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => {
          if (modalOpen()) layoutPreviewEditor();
        });
        ro.observe(content);
      }
    } catch (e) {}
    try {
      window.addEventListener('resize', () => {
        if (modalOpen()) layoutPreviewEditor();
      });
    } catch (e2) {}
    try {
      document.addEventListener('xkeen-theme-change', () => {
        try { if (_previewCm && _previewCm.setOption) _previewCm.setOption('theme', cmThemeFromPage()); } catch (e3) {}
        if (modalOpen()) layoutPreviewEditor();
      });
    } catch (e4) {}
    if (modal.dataset) modal.dataset.xkHwPreviewLayoutBound = '1';
  }

  function setPreview(text) {
    const v = String(text || '');
    _previewLastText = v;
    try {
      if (_previewKind === 'monaco' && _previewMonacoFacade && typeof _previewMonacoFacade.setValue === 'function') {
        _previewMonacoFacade.setValue(v);
        try { _previewMonacoFacade.scrollTo(0, 0); } catch (e1) {}
        return;
      }
      if (_previewKind === 'monaco' && _previewMonacoFacade && typeof _previewMonacoFacade.set === 'function') {
        _previewMonacoFacade.set(v);
        try { _previewMonacoFacade.scrollTo(0, 0); } catch (e2) {}
        return;
      }
      if (_previewKind === 'monaco' && _previewMonaco && typeof _previewMonaco.setValue === 'function') {
        _previewMonaco.setValue(v);
        try {
          if (typeof _previewMonaco.setScrollPosition === 'function') _previewMonaco.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
        } catch (e3) {}
        return;
      }
      if (_previewFacade && typeof _previewFacade.setValue === 'function') {
        _previewFacade.setValue(v);
        try { _previewFacade.scrollTo(0, 0); } catch (e4) {}
        return;
      }
      if (_previewFacade && typeof _previewFacade.set === 'function') {
        _previewFacade.set(v);
        try { _previewFacade.scrollTo(0, 0); } catch (e5) {}
        return;
      }
    } catch (e) {}
    try {
      if (_previewCm && typeof _previewCm.setValue === 'function') {
        _previewCm.setValue(v);
        try { _previewCm.scrollTo(0, 0); } catch (e6) {}
        return;
      }
    } catch (e7) {}
    const ta = $(IDS.preview);
    if (!ta) return;
    try { ta.value = v; } catch (e) {}
  }

  function setInsertEnabled(on) {
    const b = $(IDS.btnInsert);
    if (!b) return;
    b.disabled = !on;
  }

  function setApplyEnabled(on) {
    const b = $(IDS.btnApplyRestart);
    if (!b) return;
    b.disabled = !on;
  }

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

  async function waitForRestartJob(jobId, onChunk) {
    const CJ = getMihomoCommandJobApi();
    if (CJ && typeof CJ.waitForCommandJob === 'function') {
      return CJ.waitForCommandJob(String(jobId), {
        maxWaitMs: 5 * 60 * 1000,
        onChunk: (chunk) => {
          if (typeof onChunk === 'function') {
            try { onChunk(chunk); } catch (e) {}
          }
        }
      });
    }

    let result = null;
    let lastLen = 0;
    while (true) {
      const pr = await fetch(`/api/run-command/${encodeURIComponent(String(jobId))}`);
      const pj = await pr.json().catch(() => ({}));
      const out = (pj && typeof pj.output === 'string') ? pj.output : '';
      if (out.length > lastLen) {
        const chunk = out.slice(lastLen);
        lastLen = out.length;
        if (chunk && typeof onChunk === 'function') {
          try { onChunk(chunk); } catch (e) {}
        }
      }
      if (!pr.ok || pj.ok === false || pj.status === 'finished' || pj.status === 'error') {
        result = pj;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return result;
  }

  function modalOpen() {
    const m = $(IDS.modal);
    return !!(m && !m.classList.contains('hidden'));
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
      _lastProbe = null;
      _device = null;
      setStatus('', false);
      setMeta('');
      setTip('');
      clearDiagnostics();
      setPreview('');
      setInsertEnabled(false);
      setApplyEnabled(false);

      // Lazy fetch device info (for headers + UX hint)
      try { fetchDeviceInfo(); } catch (e3) {}

      // Load templates list lazily (only used for replace_all)
      try { ensureTemplatesLoaded(); } catch (e4) {}

      try {
        const inp = $(IDS.url);
        if (inp) inp.focus();
      } catch (e4) {}

      try {
        bindPreviewLayoutHooks();
        schedulePreviewEditor();
      } catch (e5) {}
    }
  }

  function wireButton(id, fn) {
    const el = $(id);
    if (!el) return;
    if (el.dataset && el.dataset.xkWired === '1') return;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      try { fn(e); } catch (err) { console.error(err); }
    });
    if (el.dataset) el.dataset.xkWired = '1';
  }

  function getHttp() {
    return getMihomoCoreHttpApi();
  }

  async function postJSONAllowError(url, body) {
    const http = getHttp();
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      cache: 'no-store',
    };

    let opts = init;
    try {
      if (http && typeof http.withCSRF === 'function') {
        opts = http.withCSRF(init, 'POST');
      }
    } catch (e) {}

    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, ok: res.ok, data };
  }

  async function fetchDeviceInfo() {
    if (_device) return _device;
    const http = getHttp();
    if (!http || typeof http.fetchJSON !== 'function') return null;
    try {
      const data = await http.fetchJSON('/api/mihomo/hwid/device');
      _device = data || null;
      renderDiagnostics(_device, _lastProbe);
      // Non-intrusive summary
      try {
        const hwid = data && data.hwid ? String(data.hwid) : '';
        const source = hwidSourceLabel(data && data.hwid_source);
        const model = data && data.device_model ? String(data.device_model) : '';
        if (hwid || source || model) {
          setMeta([
            hwid ? ('HWID: ' + hwid) : '',
            source ? ('источник: ' + source) : '',
            model ? ('устройство: ' + model) : '',
          ].filter(Boolean).join(' • '));
        }
      } catch (e2) {}
      return _device;
    } catch (e) {
      // do not block the flow
      _device = null;
      clearDiagnostics();
      return null;
    }
  }

  function yamlQuote(v) {
    const s = String(v == null ? '' : v);
    // Always quote to avoid YAML edge-cases.
    return '"' + s.replace(/\\/g, '\\\\').replace(/\"/g, '\\"').replace(/\n/g, '\\n') + '"';
  }

  function sanitizeProviderName(name) {
    let s = String(name || '').trim();
    if (!s) return '';
    s = s.replace(/\s+/g, '_');
    s = s.replace(/[^A-Za-z0-9._-]+/g, '_');
    s = s.replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
    return s.slice(0, 64);
  }

  function buildProviderAdapterUrl(url, insecure) {
    const raw = String(url || '').trim();
    let port = '';
    try {
      port = String(window.location && window.location.port ? window.location.port : '').trim();
      if (!port) port = (window.location && window.location.protocol === 'https:') ? '443' : '80';
    } catch (e) {
      port = '8088';
    }
    const params = new URLSearchParams();
    params.set('url', raw);
    params.set('insecure', insecure ? '1' : '0');
    return `http://127.0.0.1:${port}/mihomo/hwid/provider.yaml?${params.toString()}`;
  }

  function buildProviderSnippet(name, url, headers, opts) {
    const nm = sanitizeProviderName(name);
    const h = headers || {};
    const options = opts || {};
    const providerUrl = String(options.providerUrl || url || '').trim();

    const lines = [];
    lines.push(`  ${nm}:`);
    lines.push(`    type: http`);
    lines.push(`    url: ${yamlQuote(providerUrl)}`);
    lines.push(`    interval: 43200`);
    lines.push(`    path: ${yamlQuote(`./proxy_providers/${nm}.yaml`)}`);
    lines.push(`    health-check:`);
    lines.push(`      enable: true`);
    lines.push(`      url: "https://www.gstatic.com/generate_204"`);
    lines.push(`      interval: 300`);
    lines.push(`      expected-status: 204`);

    const headerLines = [];
    const pushH = (k, v) => {
      const vv = String(v == null ? '' : v).trim();
      if (!vv) return;
      // Mihomo docs use list-of-strings for header values.
      headerLines.push(`      ${k}:`);
      headerLines.push(`      - ${yamlQuote(vv)}`);
    };

    pushH('User-Agent', h['User-Agent'] || h['user-agent']);
    pushH('x-hwid', h['x-hwid']);

    if (headerLines.length) {
      lines.push(`    header:`);
      lines.push(...headerLines);
    }

    lines.push(`    override:`);
    lines.push(`      udp: true`);
    lines.push(`      tfo: true`);

    return lines.join('\n') + '\n';
  }

  function getEditorText() {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.getEditorText === 'function') {
        return api.getEditorText();
      }
    } catch (e2) {}
    const ta = document.getElementById('mihomo-editor');
    return ta ? String(ta.value || '') : '';
  }

  function setEditorText(text) {
    try {
      const api = getMihomoPanelApi();
      if (api && typeof api.setEditorText === 'function') return api.setEditorText(text);
    } catch (e) {}
    const ta = document.getElementById('mihomo-editor');
    if (ta) ta.value = String(text || '');
  }

  function refreshEditor() {
    refreshSharedMihomoEditor();
  }

  function updatePreviewFromState() {
    const urlEl = $(IDS.url);
    const nameEl = $(IDS.name);
    const url = urlEl ? String(urlEl.value || '').trim() : '';
    const name = sanitizeProviderName(nameEl ? nameEl.value : '');
    if (!url || !name) {
      setPreview('');
      setInsertEnabled(false);
      setApplyEnabled(false);
      return;
    }
    const insecureEl = $(IDS.insecure);
    const adapterUrl = buildProviderAdapterUrl(url, !!(insecureEl && insecureEl.checked));
    setPreview(buildProviderSnippet(name, url, {}, { providerUrl: adapterUrl }));
    if (_lastProbe && _lastProbe.ok) {
      setInsertEnabled(true);
      setApplyEnabled(true);
    }
  }

  async function reloadEditorFromServer() {
    const http = getHttp();
    if (!http || typeof http.fetchJSON !== 'function') return;
    try {
      const data = await http.fetchJSON('/api/mihomo-config');
      if (data && data.ok && typeof data.content === 'string') {
        setEditorText(String(data.content || ''));
        refreshEditor();
      }
    } catch (e) {}
  }

  async function doProbe() {
    if (_busy) return;
    const urlEl = $(IDS.url);
    const insecureEl = $(IDS.insecure);
    const nameEl = $(IDS.name);

    const url = urlEl ? String(urlEl.value || '').trim() : '';
    const insecure = !!(insecureEl && insecureEl.checked);

    if (!url) {
      setStatus('Введите URL подписки.', true);
      return;
    }

    _busy = true;
    setInsertEnabled(false);
    setApplyEnabled(false);
    setTip('');
    setStatus('Проверяем подписку…', false);

    try {
      const dev = await fetchDeviceInfo();
      const r = await postJSONAllowError('/api/mihomo/hwid/probe', { url, insecure: insecure });
      const res = r && r.data ? r.data : null;
      _lastProbe = res || null;
      renderDiagnostics(dev, _lastProbe);

      if (!r.ok || !res || !res.ok) {
        const errObj = (res && res.error) ? res.error : null;
        const msg = (errObj && errObj.message) ? String(errObj.message) : (res && res.error ? String(res.error) : 'Не удалось проверить подписку.');
        const hint = (errObj && errObj.hint) ? String(errObj.hint) : '';
        setStatus(msg, true);
        if (hint) setMeta(hint);
        try {
          const providerTips = hwidProviderHeaderTips(res && res.hwid_response_headers);
          if (providerTips.length) setTip(providerTips.join(' '));
        } catch (e3) {}
        return;
      }

      const p = res.profile || {};
      const probe = res.probe || {};
      const title = p.profile_title ? String(p.profile_title) : '';
      const suggested = p.suggested_name ? String(p.suggested_name) : '';

      // Auto-fill name when empty (or when previously autogen)
      try {
        const cur = nameEl ? String(nameEl.value || '').trim() : '';
        if (!cur || cur === suggested) {
          if (nameEl && suggested) nameEl.value = suggested;
        }
      } catch (e1) {}

      const nm = sanitizeProviderName(nameEl ? nameEl.value : suggested);
      if (!nm) {
        setStatus('Не удалось подобрать имя provider — укажи вручную.', true);
        return;
      }

      const headers = (res.headers_used) || (dev && dev.headers) || {};
      try {
        const tips = [];
        const hwid = String((headers && headers['x-hwid']) || '').trim();
        const hwidWarning = dev && dev.hwid_warning ? String(dev.hwid_warning) : '';
        if (!hwid) {
          tips.push('HWID не определён: provider будет без x-hwid. Если провайдер ожидает уже привязанный HWID, открой DevTools → ENV, найди через поиск HWID, заполни XKEEN_MIHOMO_HWID и снова нажми «Проверить».');
        } else if (hwidWarning) {
          tips.push(hwidWarning);
        }
        tips.push(...hwidProviderHeaderTips(res.hwid_response_headers));
        tips.push(...payloadSummaryTips(res));
        if (res.no_headers_ok === true) {
          tips.push('Сервер отвечает и без HWID-заголовков, но это не доказывает, что подписка обычная. Для premium/HWID лучше оставить header.');
        }
        setTip(tips.join(' '));
      } catch (e0) {
        setTip('');
      }
      const adapterUrl = buildProviderAdapterUrl(url, insecure);
      const snippet = buildProviderSnippet(nm, url, {}, { providerUrl: adapterUrl });
      setPreview(snippet);

      // Meta line
      const parts = [];
      if (title) parts.push('profile-title: ' + title);
      if (probe.http_status) parts.push('HTTP ' + probe.http_status);
      if (probe.method) parts.push(probe.method);
      if (typeof probe.timing_ms === 'number') parts.push(probe.timing_ms + 'ms');
      if (probe.resolved_url && String(probe.resolved_url) !== url) parts.push('→ ' + String(probe.resolved_url));
      parts.push(...hwidProviderHeaderMeta(res.hwid_response_headers));
      parts.push(...payloadSummaryMeta(res));
      if (parts.length) setMeta(parts.join(' • '));
      renderDiagnostics(dev, res);

      // Warnings
      try {
        const warns = Array.isArray(res.warnings) ? res.warnings : [];
        if (warns.length) {
          const w = warns[0];
          if (w && w.hint) toastMsg(String(w.hint), 'warning');
        }
      } catch (e2) {}

      setStatus('OK — можно вставлять в config.yaml', false);
      setInsertEnabled(true);
      setApplyEnabled(true);
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      _busy = false;
    }
  }

  function ensureModeUi() {
    const modeEl = $(IDS.mode);
    const wrapT = document.getElementById(IDS.template + '-wrap');
    if (!modeEl || !wrapT) return;
    if (!modeEl.dataset || modeEl.dataset.xkWired !== '1') {
      const sync = () => {
        const v = String(modeEl.value || 'add');
        toggleBlock(wrapT, v === 'replace_all');
      };
      modeEl.addEventListener('change', sync);
      sync();
      if (modeEl.dataset) modeEl.dataset.xkWired = '1';
    }
  }

  async function ensureTemplatesLoaded() {
    const sel = $(IDS.template);
    if (!sel || sel.dataset && sel.dataset.xkLoaded === '1') return;
    const http = getHttp();
    if (!http || typeof http.fetchJSON !== 'function') return;
    try {
      const data = await http.fetchJSON('/api/mihomo-templates');
      const list = (data && Array.isArray(data.templates)) ? data.templates : [];
      sel.innerHTML = '';
      const opt0 = document.createElement('option');
      opt0.value = '';
      opt0.textContent = '(шаблон по умолчанию)';
      sel.appendChild(opt0);
      list.forEach((it) => {
        const name = it && it.name ? String(it.name) : '';
        if (!name) return;
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        sel.appendChild(o);
      });
      if (sel.dataset) sel.dataset.xkLoaded = '1';
    } catch (e) {
      // ignore
    }
  }

  function ensureApplyRestartButton() {
    const btn = $(IDS.btnApplyRestart);
    if (!btn) return;
    btn.disabled = true;
  }

  async function doApplyRestart() {
    if (_busy) return;
    const urlEl = $(IDS.url);
    const insecureEl = $(IDS.insecure);
    const nameEl = $(IDS.name);

    const url = urlEl ? String(urlEl.value || '').trim() : '';
    const insecure = !!(insecureEl && insecureEl.checked);
    const name = nameEl ? String(nameEl.value || '').trim() : '';

    if (!url) {
      setStatus('Введите URL подписки.', true);
      return;
    }

    const modeEl = $(IDS.mode);
    const mode = modeEl ? String(modeEl.value || 'add') : 'add';
    const tmplEl = $(IDS.template);
    const template_name = (tmplEl && mode === 'replace_all') ? String(tmplEl.value || '').trim() : '';

    _busy = true;
    setStatus('Применяем и ставим рестарт в очередь…', false);
    setInsertEnabled(false);
    setApplyEnabled(false);

    try {
      await fetchDeviceInfo();
      const r = await postJSONAllowError('/api/mihomo/hwid/apply', {
        url,
        insecure,
        mode,
        name,
        template_name,
        restart: true,
      });
      const res = r && r.data ? r.data : null;

      if (!r.ok || !res || !res.ok) {
        // Two possible shapes: {error:...} or {stage:'probe', probe:{...}}
        let errObj = (res && res.error) ? res.error : null;
        if (!errObj && res && res.stage === 'probe' && res.probe && res.probe.error) errObj = res.probe.error;
        const msg = (errObj && errObj.message) ? String(errObj.message) : (res && res.error ? String(res.error) : 'Не удалось применить изменения.');
        const hint = (errObj && errObj.hint) ? String(errObj.hint) : '';
        setStatus(msg, true);
        if (hint) setMeta(hint);
        return;
      }

      const nm = res.provider_name ? String(res.provider_name) : '';
      const job = res.restart_job_id ? String(res.restart_job_id) : '';

      await reloadEditorFromServer();
      showModal(false);

      if (job) {
        try {
          await clearSharedRestartLog();
          await appendSharedRestartLog('⏳ Запуск xkeen -restart (job ' + job + ')\n');
        } catch (e) {}

        const result = await waitForRestartJob(job, (chunk) => {
          try { void appendSharedRestartLog(String(chunk || '')); } catch (e) {}
        });

        const ok = !!(result && result.ok);
        if (ok) {
          toastMsg(`Применено ✅ ${nm ? '(' + nm + ') ' : ''}xkeen перезапущен.`, 'success');
        } else {
          const errMsg = (result && (result.error || result.message))
            ? String(result.error || result.message)
            : 'Перезапуск завершился с ошибкой';
          try { await appendSharedRestartLog('\nОшибка: ' + errMsg + '\n'); } catch (e) {}
          toastMsg(errMsg, 'error');
        }
      } else {
        toastMsg(`Применено ✅ ${nm ? '(' + nm + ')' : ''}`, 'success');
      }
    } catch (e) {
      setStatus(String(e && e.message ? e.message : e), true);
    } finally {
      _busy = false;
    }
  }

  function nameAlreadyExists(yamlText, name) {
    const nm = sanitizeProviderName(name);
    if (!nm) return false;
    const esc = (s) => String(s || '').replace(/[.*+?^${}()|[\[\]\\]/g, '\\$&');
    const re = new RegExp('^\\s{2}' + esc(nm) + '\\s*:', 'm');
    return re.test(String(yamlText || ''));
  }

  function doInsert() {
    const nameEl = $(IDS.name);
    const urlEl = $(IDS.url);

    const name = sanitizeProviderName(nameEl ? nameEl.value : '');
    const url = urlEl ? String(urlEl.value || '').trim() : '';

    if (!name) {
      setStatus('Укажи имя provider.', true);
      return;
    }
    if (!url) {
      setStatus('Укажи URL подписки.', true);
      return;
    }

    const existing = getEditorText();
    if (nameAlreadyExists(existing, name)) {
      setStatus(`Provider '${name}' уже есть в конфиге. Выбери другое имя.`, true);
      return;
    }

    const insecureEl = $(IDS.insecure);
    const adapterUrl = buildProviderAdapterUrl(url, !!(insecureEl && insecureEl.checked));
    const snippet = buildProviderSnippet(name, url, {}, { providerUrl: adapterUrl });

    const patch = getMihomoYamlPatchApi();
    if (!patch || typeof patch.insertIntoSection !== 'function') {
      setStatus('mihomoYamlPatch недоступен — обнови страницу.', true);
      return;
    }

    const next = patch.insertIntoSection(existing, 'proxy-providers', snippet, { avoidDuplicates: true });
    setEditorText(next);
    refreshEditor();

    showModal(false);
    toastMsg('Добавлено в proxy-providers ✅', 'success');

    try {
      if (typeof window.updateLastActivity === 'function') {
        const fp = getXkeenFilePath('mihomo', '/opt/etc/mihomo/config.yaml');
        window.updateLastActivity('modified', 'mihomo', fp);
      }
    } catch (e) {}
  }

  HW.init = function init() {
    const openBtn = $(IDS.btnOpen);
    const modal = $(IDS.modal);
    if (!openBtn || !modal) return;

    if (_inited || (modal.dataset && modal.dataset.xkMihomoHwidInited === '1')) return;
    _inited = true;
    if (modal.dataset) modal.dataset.xkMihomoHwidInited = '1';

    wireButton(IDS.btnOpen, () => showModal(true));
    wireButton(IDS.btnClose, () => showModal(false));
    wireButton(IDS.btnCancel, () => showModal(false));

    wireButton(IDS.btnProbe, () => doProbe());
    wireButton(IDS.btnInsert, () => doInsert());

    // MH-04: injected UI
    try {
      ensureModeUi();
      ensureApplyRestartButton();
      wireButton(IDS.btnApplyRestart, () => doApplyRestart());
    } catch (e) {}

    try {
      const bindLivePreview = (el, opts) => {
        if (!el || (el.dataset && el.dataset.xkHwPreview === '1')) return;
        const onMutate = () => {
          if (opts && opts.invalidateProbe) {
            _lastProbe = null;
            setInsertEnabled(false);
            setApplyEnabled(false);
          }
          updatePreviewFromState();
        };
        el.addEventListener('input', onMutate);
        el.addEventListener('change', onMutate);
        if (el.dataset) el.dataset.xkHwPreview = '1';
      };
      bindLivePreview($(IDS.name));
      bindLivePreview($(IDS.url), { invalidateProbe: true });
      bindLivePreview($(IDS.insecure), { invalidateProbe: true });
    } catch (e) {}

    try {
      const sel = $(IDS.engineSelect);
      if (sel && (!sel.dataset || sel.dataset.xkWired !== '1')) {
        sel.addEventListener('change', async () => {
          const ee = getEngineHelper();
          try { if (ee && typeof ee.set === 'function') await ee.set(sel.value); } catch (e) {}
          scheduleEngineSync();
        });
        if (sel.dataset) sel.dataset.xkWired = '1';
      }
      if (!_engineUnsub) {
        const ee = getEngineHelper();
        if (ee && typeof ee.onChange === 'function') {
          _engineUnsub = ee.onChange((d) => {
            try { setEngineSelectValue(d && d.engine ? d.engine : 'codemirror'); } catch (e) {}
            if (modalOpen()) scheduleEngineSync();
          });
        }
      }
      scheduleEngineSync();
    } catch (e) {}

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

    // Ctrl+Enter = probe, Ctrl+Shift+Enter = insert
    const urlEl = $(IDS.url);
    if (urlEl && (!urlEl.dataset || urlEl.dataset.xkKeys !== '1')) {
      urlEl.addEventListener('keydown', (e) => {
        try {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (e.shiftKey) doInsert();
            else doProbe();
          }
        } catch (err) {}
      });
      if (urlEl.dataset) urlEl.dataset.xkKeys = '1';
    }
  };

  // Auto-init (safe, no API calls until user opens/probes)
  try { setTimeout(() => { try { HW.init(); } catch (e) {} }, 0); } catch (e) {}
})();
export function getMihomoHwidSubApi() {
  try {
    if (mihomoHwidSubModuleApi && typeof mihomoHwidSubModuleApi.init === 'function') return mihomoHwidSubModuleApi;
  }
  catch (error) {}
  return null;
}

export function initMihomoHwidSub(...args) {
  const api = getMihomoHwidSubApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export const mihomoHwidSubApi = Object.freeze({
  get: getMihomoHwidSubApi,
  init: initMihomoHwidSub,
});
