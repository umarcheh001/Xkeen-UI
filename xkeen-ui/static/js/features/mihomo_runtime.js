const mihomoRuntimeFallbackState = {
  mihomoEditor: null,
};

function getWindowRef() {
  try {
    return window || null;
  } catch (e) {
    return null;
  }
}

function getWindowXKeen() {
  try {
    const win = getWindowRef();
    return win && win.XKeen ? win.XKeen : null;
  } catch (e) {
    return null;
  }
}

function ensureWindowXKeen() {
  try {
    const win = getWindowRef();
    if (!win) return null;
    win.XKeen = win.XKeen || {};
    return win.XKeen;
  } catch (e) {
    return null;
  }
}

function getMihomoStateStore(create) {
  try {
    const xk = create ? ensureWindowXKeen() : getWindowXKeen();
    if (xk) {
      if (create) xk.state = xk.state || {};
      if (xk.state) return xk.state;
    }
  } catch (e) {}
  return mihomoRuntimeFallbackState;
}

export function getMihomoUiApi() {
  try {
    const xk = getWindowXKeen();
    return xk ? (xk.ui || null) : null;
  } catch (e) {
    return null;
  }
}

export function getMihomoModalApi() {
  try {
    const ui = getMihomoUiApi();
    return ui ? (ui.modal || null) : null;
  } catch (e) {
    return null;
  }
}

export function syncMihomoModalBodyScrollLock() {
  try {
    const modalApi = getMihomoModalApi();
    if (modalApi && typeof modalApi.syncBodyScrollLock === 'function') {
      modalApi.syncBodyScrollLock();
      return true;
    }
  } catch (e) {}
  return false;
}

export function getMihomoEditorEngineApi() {
  try {
    const ui = getMihomoUiApi();
    return ui ? (ui.editorEngine || null) : null;
  } catch (e) {
    return null;
  }
}

export function getMihomoEditorActionsApi() {
  try {
    const ui = getMihomoUiApi();
    return ui ? (ui.editorActions || null) : null;
  } catch (e) {
    return null;
  }
}

export function getMihomoFormattersApi() {
  try {
    const ui = getMihomoUiApi();
    return ui ? (ui.formatters || null) : null;
  } catch (e) {
    return null;
  }
}

export function getMihomoCoreHttpApi() {
  try {
    const xk = getWindowXKeen();
    return xk && xk.core ? (xk.core.http || null) : null;
  } catch (e) {
    return null;
  }
}

export function getMihomoCommandJobApi() {
  try {
    const xk = getWindowXKeen();
    return xk && xk.util ? (xk.util.commandJob || null) : null;
  } catch (e) {
    return null;
  }
}

export function escapeMihomoHtml(value) {
  try {
    const xk = getWindowXKeen();
    if (xk && xk.util && typeof xk.util.escapeHtml === 'function') {
      return xk.util.escapeHtml(value);
    }
  } catch (e) {}
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function confirmMihomoAction(opts, fallbackText) {
  const cfg = opts || {};
  try {
    const ui = getMihomoUiApi();
    if (ui && typeof ui.confirm === 'function') return !!(await ui.confirm(cfg));
  } catch (e) {}
  try {
    const text = fallbackText || cfg.message || cfg.text || cfg.title || 'Continue?';
    return !!window.confirm(String(text));
  } catch (e2) {
    return false;
  }
}

export function getSharedMihomoEditor() {
  try {
    const state = getMihomoStateStore(false);
    return state && state.mihomoEditor ? state.mihomoEditor : null;
  } catch (e) {
    return null;
  }
}

export function setSharedMihomoEditor(editor) {
  try {
    const state = getMihomoStateStore(true);
    state.mihomoEditor = editor || null;
    return state.mihomoEditor;
  } catch (e) {
    mihomoRuntimeFallbackState.mihomoEditor = editor || null;
    return mihomoRuntimeFallbackState.mihomoEditor;
  }
}

export function clearSharedMihomoEditor(editor) {
  try {
    const state = getMihomoStateStore(true);
    if (arguments.length === 0 || state.mihomoEditor === editor) {
      state.mihomoEditor = null;
    }
  } catch (e) {
    if (arguments.length === 0 || mihomoRuntimeFallbackState.mihomoEditor === editor) {
      mihomoRuntimeFallbackState.mihomoEditor = null;
    }
  }
  return null;
}

export function refreshSharedMihomoEditor() {
  const editor = getSharedMihomoEditor();
  if (!editor) return false;
  try {
    if (typeof editor.refresh === 'function') {
      editor.refresh();
      return true;
    }
    if (typeof editor.layout === 'function') {
      editor.layout();
      return true;
    }
  } catch (e) {}
  return false;
}

export const mihomoRuntimeApi = Object.freeze({
  getUiApi: getMihomoUiApi,
  getModalApi: getMihomoModalApi,
  syncBodyScrollLock: syncMihomoModalBodyScrollLock,
  getEditorEngineApi: getMihomoEditorEngineApi,
  getEditorActionsApi: getMihomoEditorActionsApi,
  getFormattersApi: getMihomoFormattersApi,
  getCoreHttpApi: getMihomoCoreHttpApi,
  getCommandJobApi: getMihomoCommandJobApi,
  escapeHtml: escapeMihomoHtml,
  confirm: confirmMihomoAction,
  getSharedEditor: getSharedMihomoEditor,
  setSharedEditor: setSharedMihomoEditor,
  clearSharedEditor: clearSharedMihomoEditor,
  refreshSharedEditor: refreshSharedMihomoEditor,
});
