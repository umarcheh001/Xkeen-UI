import { getXkeenEditorEngineApi } from './xkeen_runtime.js';

let xkeenTextsModuleApi = null;

(() => {
  xkeenTextsModuleApi = (() => {
    let inited = false;
    const editorState = Object.create(null);

    function getEditorEngineHelper() {
      return getXkeenEditorEngineApi();
    }

    function getEditorStateValue(stateKey) {
      const key = String(stateKey || '');
      return key ? (editorState[key] || null) : null;
    }

    function setEditorStateValue(stateKey, editor) {
      const key = String(stateKey || '');
      if (!key) return null;
      editorState[key] = editor || null;
      return editorState[key];
    }

    const CM6_SCOPE = 'xkeen-texts';

    function withCm6Scope(opts) {
      return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
    }

    function getEditorRuntime(engine, opts) {
      const helper = getEditorEngineHelper();
      if (!helper || typeof helper.getRuntime !== 'function') return null;
      try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
      return null;
    }

    async function ensureEditorRuntime(engine, opts) {
      const helper = getEditorEngineHelper();
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

    function shouldRestartAfterSave() {
      const cb = document.getElementById('global-autorestart-xkeen');
      // On xkeen.html this checkbox is absent; default restart=true so changes apply immediately.
      if (!cb) return true;
      return !!cb.checked;
    }

    async function loadText(url, textareaId, statusId, label, stateKey) {
      const ta = document.getElementById(textareaId);
      const statusEl = document.getElementById(statusId);
      if (!ta) return;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          if (statusEl) statusEl.textContent = `Не удалось загрузить ${label}.`;
          return;
        }
        const data = await res.json().catch(() => ({}));
        const text = (data && data.content) ? data.content : '';
        const len = text.length;

        const ed = getEditorStateValue(stateKey);
        if (ed && ed.setValue) ed.setValue(text);
        else ta.value = text;

        if (statusEl) statusEl.textContent = `${label} загружен (${len} байт).`;
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = `Ошибка загрузки ${label}.`;
      }
    }

        async function saveText(url, textareaId, statusId, label, stateKey) {
      const ta = document.getElementById(textareaId);
      const statusEl = document.getElementById(statusId);
      if (!ta) return;

      const ed = getEditorStateValue(stateKey);
      const content = (ed && ed.getValue) ? ed.getValue() : ta.value;

      const restart = shouldRestartAfterSave();

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, restart }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          const msg = `${label} сохранён.`;
          if (statusEl) statusEl.textContent = msg;

          // Если был рестарт — тост покажет spinner_fetch.js (единый тост "сохранено + перезапуск").
          if (!data.restarted) {
            try { toast(msg, false); } catch (e) {}
          }
        } else {
          const msg = 'Ошибка сохранения: ' + ((data && data.error) || res.status);
          if (statusEl) statusEl.textContent = msg;
          try { toast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = `Не удалось сохранить ${label}.`;
        if (statusEl) statusEl.textContent = msg;
        try { toast(msg, true); } catch (e2) {}
      }
    }

        function attachEditor(textareaId, stateKey, extraOpts) {
      const ta = document.getElementById(textareaId);
      if (!ta) return null;

      const runtime = getEditorRuntime('codemirror');
      const preferCm6 = isCm6Runtime(runtime);

      // Prevent double-init if main.js already created it, but do not reuse a cached legacy CM5 instance when scoped CM6 is active.
      if (getEditorStateValue(stateKey)) {
        const existing = getEditorStateValue(stateKey);
        if (!preferCm6 || isCm6Editor(existing)) return existing;
        try { disposeCodeMirrorEditor(existing); } catch (e) {}
        setEditorStateValue(stateKey, null);
      }

      const opts = {
        mode: 'text/plain',
        theme: 'material-darker',
        lineNumbers: true,
        styleActiveLine: true,
        showIndentGuides: true,
        matchBrackets: true,
        showTrailingSpace: true,
        lineWrapping: true,
        tabSize: 2,
        indentUnit: 2,
        indentWithTabs: false,
        // Keep rendering sane for potentially larger files (xkeen.json).
        viewportMargin: 80,
      };

      if (extraOpts && typeof extraOpts === 'object') {
        try { Object.assign(opts, extraOpts); } catch (e) {}
      }

      if (!runtime || typeof runtime.create !== 'function') return null;
      const ed = runtime.create(ta, opts);
      if (!ed) return null;
      try { ed.getWrapperElement().classList.add('xkeen-cm'); } catch (e) {}
      setEditorStateValue(stateKey, ed);
      return ed;
    }

    function wireButton(btnId, handler) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      if (btn.dataset && btn.dataset.xkeenWired === '1') return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });
      if (btn.dataset) btn.dataset.xkeenWired = '1';
    }

    function init() {
      // Only run on pages where at least one of these editors exists.
      const hasAny =
        document.getElementById('port-proxying-editor') ||
        document.getElementById('port-exclude-editor') ||
        document.getElementById('ip-exclude-editor') ||
        document.getElementById('xkeen-config-editor');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      const finishInit = () => {
        wireCardToggle();
        // Editors
        const portProxyEd = attachEditor('port-proxying-editor', 'portProxyingEditor');
        const portExcludeEd = attachEditor('port-exclude-editor', 'portExcludeEditor');
        const ipExcludeEd = attachEditor('ip-exclude-editor', 'ipExcludeEditor');
        const xkeenConfigEd = attachEditor('xkeen-config-editor', 'xkeenConfigEditor', { mode: 'application/jsonc' });

        // Save buttons
        wireButton('port-proxying-save-btn', () => saveText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor'));
        wireButton('port-exclude-save-btn', () => saveText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor'));
        wireButton('ip-exclude-save-btn', () => saveText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor'));
        wireButton('xkeen-config-save-btn', () => saveText('/api/xkeen/config', 'xkeen-config-editor', 'xkeen-config-status', 'xkeen.json', 'xkeenConfigEditor'));

        // Initial load
        loadText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor');
        loadText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor');
        loadText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor');
        loadText('/api/xkeen/config', 'xkeen-config-editor', 'xkeen-config-status', 'xkeen.json', 'xkeenConfigEditor');

        // Let theme.js sync editors.
        try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}
      };

      try {
        Promise.resolve(ensureEditorRuntime('codemirror', {
          mode: 'text/plain',
          trailingSpace: true,
        }))
          .then((runtime) => {
            if (runtime && typeof runtime.ensureAssets === 'function') {
              return runtime.ensureAssets({
                mode: 'text/plain',
                trailingSpace: true,
              });
            }
            return null;
          })
          .catch(() => null)
          .finally(finishInit);
        return;
      } catch (e) {}

      finishInit();
    }

    function ensureInited() {
      try { init(); } catch (e) {}
    }

    // Reload helpers (used by GitHub import / local import flows).
    function reloadPortProxying() {
      ensureInited();
      return loadText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor');
    }

    function reloadPortExclude() {
      ensureInited();
      return loadText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor');
    }

    function reloadIpExclude() {
      ensureInited();
      return loadText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor');
    }
    function reloadXkeenConfig() {
      ensureInited();
      return loadText('/api/xkeen/config', 'xkeen-config-editor', 'xkeen-config-status', 'xkeen.json', 'xkeenConfigEditor');
    }


    function reloadAll() {
      ensureInited();
      return Promise.all([
        reloadPortProxying(),
        reloadPortExclude(),
        reloadIpExclude(),
        reloadXkeenConfig(),
      ]);
    }

    function getToggleHeaders() {
      try {
        return Array.from(document.querySelectorAll('[data-xk-toggle="xkeen-settings"]'));
      } catch (e) {
        return [];
      }
    }

    function syncToggleHeaderState(isOpen) {
      getToggleHeaders().forEach((header) => {
        try { header.setAttribute('aria-expanded', isOpen ? 'true' : 'false'); } catch (e) {}
      });
    }

    function refreshAttachedEditors() {
      ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor', 'xkeenConfigEditor'].forEach((k) => {
        try {
          const ed = getEditorStateValue(k);
          if (ed && ed.refresh) ed.refresh();
        } catch (e) {}
      });
    }

    function wireCardToggle() {
      getToggleHeaders().forEach((header) => {
        if (!header || (header.dataset && header.dataset.xkeenToggleWired === '1')) return;
        const onToggle = (e) => {
          if (e) {
            if (e.type === 'keydown') {
              const key = String(e.key || '');
              if (key !== 'Enter' && key !== ' ') return;
            }
            e.preventDefault();
          }
          toggleCard();
        };
        header.addEventListener('click', onToggle);
        header.addEventListener('keydown', onToggle);
        if (header.dataset) header.dataset.xkeenToggleWired = '1';
      });
    }

    function toggleCard() {
      const body = document.getElementById('xkeen-body');
      const arrow = document.getElementById('xkeen-arrow');
      if (!body || !arrow) return;

      const willOpen = (body.style.display === '' || body.style.display === 'none');
      body.style.display = willOpen ? 'block' : 'none';
      arrow.textContent = willOpen ? '▲' : '▼';
      syncToggleHeaderState(willOpen);

      if (willOpen) refreshAttachedEditors();
    }


    return {
      init,
      toggleCard,
      reloadPortProxying,
      reloadPortExclude,
      reloadIpExclude,
      reloadXkeenConfig,
      reloadAll,
    };
  })();
})();

export function getXkeenTextsApi() {
  try {
    if (xkeenTextsModuleApi && typeof xkeenTextsModuleApi.init === 'function') return xkeenTextsModuleApi;
  } catch (error) {
    return null;
  }
  return null;
}

export function initXkeenTexts(...args) {
  const api = getXkeenTextsApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export function reloadAllXkeenTexts(...args) {
  const api = getXkeenTextsApi();
  if (!api || typeof api.reloadAll !== 'function') return null;
  return api.reloadAll(...args);
}

export const xkeenTextsApi = Object.freeze({
  get: getXkeenTextsApi,
  init: initXkeenTexts,
  reloadAll: reloadAllXkeenTexts,
});
