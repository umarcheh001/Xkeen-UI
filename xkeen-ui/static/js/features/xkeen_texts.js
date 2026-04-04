import { getRestartLogApi } from './restart_log.js';
import { getXkeenEditorEngineApi, getXkeenPageName } from './xkeen_runtime.js';

let xkeenTextsModuleApi = null;

(() => {
  xkeenTextsModuleApi = (() => {
    const hostStates = Object.create(null);
    let currentHostKey = '';
    let editorViewStateStore = null;

    function getCurrentHostKey() {
      const page = String(getXkeenPageName() || '').trim();
      if (page) return page;
      try {
        const screen = document.body && document.body.dataset
          ? String(document.body.dataset.xkTopLevelScreen || '').trim()
          : '';
        if (screen) return screen;
      } catch (e) {}
      return 'default';
    }

    function getHostState(hostKey) {
      const key = String(hostKey || '').trim() || 'default';
      if (!hostStates[key] || typeof hostStates[key] !== 'object') {
        hostStates[key] = {
          inited: false,
          editorState: Object.create(null),
          serializedState: null,
        };
      }
      return hostStates[key];
    }

    function getActiveHostState() {
      currentHostKey = getCurrentHostKey();
      return getHostState(currentHostKey);
    }

    function getEditorEngineHelper() {
      return getXkeenEditorEngineApi();
    }

    function getEditorStateValue(stateKey) {
      const key = String(stateKey || '');
      if (!key) return null;
      const hostState = getActiveHostState();
      return hostState.editorState[key] || null;
    }

    function setEditorStateValue(stateKey, editor) {
      const key = String(stateKey || '');
      if (!key) return null;
      const hostState = getActiveHostState();
      hostState.editorState[key] = editor || null;
      return hostState.editorState[key];
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

    async function streamRestartJob(jobId, intro) {
      const api = getRestartLogApi();
      if (!api || !jobId || typeof api.streamJob !== 'function') return null;
      return api.streamJob(String(jobId), {
        clear: true,
        reveal: true,
        intro: String(intro || ''),
        maxWaitMs: 5 * 60 * 1000,
      });
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
      const requestUrl = restart
        ? (url + (url.indexOf('?') === -1 ? '?async=1' : '&async=1'))
        : url;

      try {
        const res = await fetch(requestUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, restart }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          const restartJobId = (data && (data.restart_job_id || data.job_id || data.restartJobId))
            ? String(data.restart_job_id || data.job_id || data.restartJobId)
            : '';
          const msg = `${label} сохранён.`;
          if (statusEl) {
            statusEl.textContent = (restart && restartJobId)
              ? `${label} сохранён. Перезапуск xkeen...`
              : msg;
          }

          // Если был рестарт — тост покажет spinner_fetch.js (единый тост "сохранено + перезапуск").
          if (!data.restarted && !(restart && restartJobId)) {
            try { toast(msg, false); } catch (e) {}
          }
          if (restart && restartJobId) {
            const result = await streamRestartJob(restartJobId, 'xkeen -restart (job)...\n');
            const ok = !!(result && result.ok);
            if (ok) {
              const successMsg = `${label} сохранён, xkeen перезапущен.`;
              if (statusEl) statusEl.textContent = successMsg;
              try { toast(successMsg, false); } catch (e) {}
            } else {
              const err = (result && (result.error || result.message)) ? String(result.error || result.message) : '';
              const exitCode = (result && typeof result.exit_code === 'number') ? result.exit_code : null;
              const detail = err
                ? ('Ошибка: ' + err)
                : (exitCode !== null ? ('Ошибка (exit_code=' + exitCode + ')') : '');
              const restartLog = getRestartLogApi();
              if (detail && restartLog && typeof restartLog.append === 'function') {
                try { restartLog.append('\n' + detail + '\n'); } catch (e) {}
              }
              const errorMsg = `${label} сохранён, но перезапуск xkeen завершился с ошибкой.`;
              if (statusEl) statusEl.textContent = errorMsg;
              try { toast(errorMsg, true); } catch (e2) {}
            }
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

    function hasAnyEditorElements() {
      return !!(
        document.getElementById('port-proxying-editor') ||
        document.getElementById('port-exclude-editor') ||
        document.getElementById('ip-exclude-editor') ||
        document.getElementById('xkeen-config-editor')
      );
    }

    function init() {
      // Only run on pages where at least one of these editors exists.
      if (!hasAnyEditorElements()) return;

      const hostState = getActiveHostState();
      if (hostState.inited) {
        return true;
      }

      hostState.inited = true;

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

    function isCardOpen() {
      const body = document.getElementById('xkeen-body');
      if (!body) return true;
      return body.style.display !== 'none';
    }

    function applyCardOpenState(isOpen) {
      const body = document.getElementById('xkeen-body');
      const arrow = document.getElementById('xkeen-arrow');
      if (!body || !arrow) return false;

      body.style.display = isOpen ? 'block' : 'none';
      arrow.textContent = isOpen ? '▲' : '▼';
      syncToggleHeaderState(!!isOpen);
      if (isOpen) refreshAttachedEditors();
      return true;
    }

    function refreshAttachedEditors() {
      ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor', 'xkeenConfigEditor'].forEach((k) => {
        try {
          const ed = getEditorStateValue(k);
          if (ed && ed.refresh) ed.refresh();
        } catch (e) {}
      });
    }

    function getEditorViewStateStore() {
      if (editorViewStateStore) return editorViewStateStore;
      const helper = getEditorEngineHelper();
      if (!helper || typeof helper.createViewStateStore !== 'function') return null;
      try {
        editorViewStateStore = helper.createViewStateStore({ prefix: 'xkeen.texts.viewstate.v1::' });
      } catch (e) {
        editorViewStateStore = null;
      }
      return editorViewStateStore;
    }

    function getEditorStateKeys() {
      return ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor', 'xkeenConfigEditor'];
    }

    function captureEditorViewStates() {
      const store = getEditorViewStateStore();
      const views = {};
      if (!store) return views;

      getEditorStateKeys().forEach((stateKey) => {
        try {
          const editor = getEditorStateValue(stateKey);
          if (!editor) return;
          const view = store.capture({
            key: 'memory::' + stateKey,
            engine: 'codemirror',
            editor,
          });
          if (view) views[stateKey] = view;
        } catch (e) {}
      });

      return views;
    }

    function restoreEditorViewStates(views) {
      const store = getEditorViewStateStore();
      const rawViews = views && typeof views === 'object' ? views : null;
      if (!store || !rawViews) return false;

      let restored = false;
      getEditorStateKeys().forEach((stateKey) => {
        try {
          const editor = getEditorStateValue(stateKey);
          const view = rawViews[stateKey];
          if (!editor || !view) return;
          restored = store.restore({
            key: 'memory::' + stateKey,
            engine: 'codemirror',
            editor,
            view,
          }) || restored;
        } catch (e) {}
      });

      return restored;
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
      applyCardOpenState(!isCardOpen());
    }

    function serializeState() {
      const state = {
        hostKey: getCurrentHostKey(),
        cardOpen: isCardOpen(),
        editorViews: captureEditorViewStates(),
      };

      try {
        const hostState = getActiveHostState();
        hostState.serializedState = state;
      } catch (e) {}

      return state;
    }

    function restoreState(rawState) {
      const state = rawState && typeof rawState === 'object' ? rawState : null;
      if (!state) return false;

      ensureInited();

      if (typeof state.cardOpen === 'boolean') {
        applyCardOpenState(state.cardOpen);
      }

      const restored = restoreEditorViewStates(state.editorViews);
      if (typeof state.cardOpen === 'boolean' && state.cardOpen) {
        refreshAttachedEditors();
      }
      return restored;
    }

    function activate() {
      ensureInited();
      try {
        const hostState = getActiveHostState();
        if (hostState && hostState.serializedState) {
          restoreState(hostState.serializedState);
        }
      } catch (e) {}
      refreshAttachedEditors();
      try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}
      return true;
    }

    function deactivate() {
      return serializeState();
    }

    return {
      init,
      isInitialized() {
        try {
          return !!getActiveHostState().inited;
        } catch (e) {
          return false;
        }
      },
      activate,
      deactivate,
      serializeState,
      restoreState,
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
