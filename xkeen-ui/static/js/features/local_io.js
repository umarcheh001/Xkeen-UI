let localIoModuleApi = null;

import { getRoutingShellApi as getRoutingShellModuleApi } from './routing_shell.js';
import { getRoutingApi } from './routing.js';
import { getXkeenUiConfigShellApi, toastXkeen } from './xkeen_runtime.js';

(() => {
  // Local import/export module (routing editor file-scoped)
  // Public API: XKeen.localIO.init()

  let _inited = false;

  function el(id) {
    return document.getElementById(id);
  }

  function getConfigShellApi() {
    return getXkeenUiConfigShellApi();
  }

  function getRoutingShellApi() {
    const api = getRoutingShellModuleApi();
    return api && typeof api.getState === 'function' ? api : null;
  }

  function bindConfigAction(btnId, handler, opts) {
    const shell = getConfigShellApi();
    if (shell && typeof shell.bindAction === 'function') {
      try {
        if (shell.bindAction('routing', btnId, handler, opts || {})) return true;
      } catch (e) {}
    }

    const btn = el(btnId);
    if (!btn) return false;
    if (btn.dataset && btn.dataset.xkLocalIoBound === '1') return true;

    btn.addEventListener('click', (event) => {
      if (event) event.preventDefault();
      handler();
    });

    if (btn.dataset) btn.dataset.xkLocalIoBound = '1';
    return true;
  }

  function setStatus(msg, isError) {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = String(msg ?? '');
    if (msg) toastXkeen(String(msg), !!isError);
  }

  function _basename(name) {
    const s = String(name ?? '');
    if (!s) return '';
    // support both unix and windows separators
    return s.split('/').pop().split('\\').pop();
  }

  function sanitizeFilename(name) {
    let s = _basename(name) || '';
    if (!s) return '';
    // Windows-forbidden chars + control chars
    s = s.replace(/[<>:\"/\\|?*\x00-\x1F]/g, '_');
    // Trim trailing dots/spaces (Windows)
    s = s.replace(/[\.\s]+$/g, '');
    // avoid empty
    if (!s) s = 'routing.json';
    return s;
  }

  function getSelectedRoutingFileName() {
    try {
      const sel = el('routing-fragment-select');
      if (sel) {
        const v = String(sel.value || '').trim();
        if (v) return v;
        const cur = String(sel.getAttribute('data-current') || '').trim();
        if (cur) return cur;
      }
    } catch (e) {}
    return 'routing.json';
  }

  function buildExportFilename() {
    const raw = getSelectedRoutingFileName();
    let fname = sanitizeFilename(raw);
    if (!/\.[A-Za-z0-9]{1,6}$/.test(fname)) fname += '.json';
    return fname;
  }

  function getEditorFacade() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.getEditorInstance === 'function') {
      try {
        return shell.getEditorInstance();
      } catch (e) {}
    }
    return null;
  }

  function getEditorText() {
    const shell = getRoutingShellApi();
    if (shell && typeof shell.getEditorText === 'function') {
      try {
        return String(shell.getEditorText() ?? '');
      } catch (e) {}
    }
    const ed = getEditorFacade();
    try {
      if (ed && typeof ed.get === 'function') return String(ed.get() ?? '');
      if (ed && typeof ed.getValue === 'function') return String(ed.getValue() ?? '');
    } catch (e) {}

    // Fallbacks
    try {
      const ta = el('routing-editor');
      if (ta) return String(ta.value ?? '');
    } catch (e2) {}

    return '';
  }

  function setEditorText(text) {
    const shell = getRoutingShellApi();
    const ed = getEditorFacade();
    const v = String(text ?? '');
    if (shell && typeof shell.setEditorText === 'function') {
      try {
        return !!shell.setEditorText(v, { reason: 'local-io' });
      } catch (e) {}
    }
    try {
      if (ed && typeof ed.set === 'function') {
        ed.set(v);
        if (typeof ed.focus === 'function') ed.focus();
        if (typeof ed.scrollTo === 'function') ed.scrollTo(0, 0);
        return true;
      }
      if (ed && typeof ed.setValue === 'function') {
        ed.setValue(v);
        if (typeof ed.focus === 'function') ed.focus();
        if (typeof ed.scrollTo === 'function') ed.scrollTo(0, 0);
        return true;
      }
    } catch (e) {}

    try {
      const ta = el('routing-editor');
      if (ta) {
        ta.value = v;
        ta.focus();
        return true;
      }
    } catch (e2) {}

    return false;
  }

  async function exportToFile() {
    const fname = buildExportFilename();
    const text = getEditorText();

    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus('Файл выгружен: ' + fname, false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка экспорта (см. консоль браузера).', true);
    }
  }

  async function importFromFile(file) {
    if (!file) {
      setStatus('Файл не выбран.', true);
      return;
    }

    // Soft size limit (keep router UI responsive)
    try {
      const maxBytes = 2 * 1024 * 1024; // 2MB
      if (file.size && file.size > maxBytes) {
        setStatus('Файл слишком большой для импорта в редактор (' + file.size + ' байт).', true);
        return;
      }
    } catch (e) {}

    const reader = new FileReader();
    reader.onerror = () => {
      setStatus('Ошибка чтения файла (см. консоль браузера).', true);
    };
    reader.onload = () => {
      try {
        const content = String(reader.result ?? '');
        let ok = false;
        const shell = getRoutingShellApi();
        if (shell && typeof shell.replaceEditorText === 'function') {
          try {
            shell.replaceEditorText(content, {
              reason: 'local-import',
              markDirty: true,
              scrollTop: true,
            });
            ok = true;
          } catch (e) {}
        }
        if (!ok) ok = setEditorText(content);
        const fname = sanitizeFilename(file.name || 'file.json');
        if (ok) {
          // Re-validate to update routing/fragment mode UI and markers.
          try {
            if (shell && typeof shell.validate === 'function') shell.validate();
            else {
              const ed = getEditorFacade();
              if (ed && typeof ed.validate === 'function') ed.validate();
              else {
                const routingApi = getRoutingApi();
                if (routingApi && typeof routingApi.validate === 'function') routingApi.validate();
              }
            }
          } catch (e) {}
          setStatus('Загружено в редактор: ' + fname + ' (не сохранено).', false);
        } else {
          setStatus('Не удалось вставить содержимое в редактор.', true);
        }
      } catch (e) {
        console.error(e);
        setStatus('Ошибка импорта (см. консоль браузера).', true);
      }
    };

    try {
      reader.readAsText(file);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка импорта (см. консоль браузера).', true);
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    const localExportBtn = el('routing-export-local-btn');
    const localImportBtn = el('routing-import-local-btn');
    const localConfigFileInput = el('local-config-file-input');

    // Export
    if (localExportBtn) bindConfigAction('routing-export-local-btn', exportToFile, { kind: 'localExport' });

    // Import
    if (localImportBtn && localConfigFileInput) {
      bindConfigAction('routing-import-local-btn', () => {
        localConfigFileInput.value = '';
        localConfigFileInput.click();
      }, { kind: 'localImport' });

      localConfigFileInput.addEventListener('change', () => {
        const file = localConfigFileInput.files && localConfigFileInput.files[0];
        if (!file) return;
        importFromFile(file);
      });
    }
  }

  localIoModuleApi = {
    init,
    exportToFile,
    importFromFile,
  };
})();

export function getLocalIoApi() {
  try {
    if (localIoModuleApi && typeof localIoModuleApi.init === 'function') return localIoModuleApi;
    return null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function callLocalIoApi(method, ...args) {
  const api = getLocalIoApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initLocalIo(...args) {
  return callLocalIoApi('init', ...args);
}

export function exportLocalConfigToFile(...args) {
  return callLocalIoApi('exportToFile', ...args);
}

export function importLocalConfigFromFile(...args) {
  return callLocalIoApi('importFromFile', ...args);
}

export function loadLocalIo() {
  return null;
}

export function onShowLocalIo() {
  return null;
}

export function disposeLocalIo(...args) {
  return callLocalIoApi('dispose', ...args);
}

export const localIoApi = Object.freeze({
  get: getLocalIoApi,
  init: initLocalIo,
  load: loadLocalIo,
  onShow: onShowLocalIo,
  exportToFile: exportLocalConfigToFile,
  importFromFile: importLocalConfigFromFile,
  dispose: disposeLocalIo,
});
