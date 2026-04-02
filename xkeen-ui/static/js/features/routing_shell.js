let routingShellModuleApi = null;

(() => {
  'use strict';

  const shell = routingShellModuleApi || {};
  routingShellModuleApi = shell;
  const state = shell.state = shell.state || {};
  state.layers = state.layers || {};

  function hasOwn(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  function syncCompat() {
    try { window.routingSavedContent = String(state.savedContent ?? ''); } catch (e) {}
    try { window.routingIsDirty = !!state.dirty; } catch (e) {}
  }

  function getTextarea() {
    try {
      return document.getElementById('routing-editor') || document.getElementById('routing-textarea');
    } catch (e) {}
    return null;
  }

  function resolveEditor(preferRaw) {
    if (preferRaw) return state.editor || state.facade || null;
    return state.facade || state.editor || null;
  }

  function fallbackGetText() {
    const editor = resolveEditor(false);
    try {
      if (editor && typeof editor.get === 'function') return String(editor.get() ?? '');
      if (editor && typeof editor.getValue === 'function') return String(editor.getValue() ?? '');
    } catch (e) {}
    const ta = getTextarea();
    return ta ? String(ta.value ?? '') : '';
  }

  function fallbackSetText(text) {
    const value = String(text ?? '');
    const editor = resolveEditor(false);
    try {
      if (editor && typeof editor.set === 'function') {
        editor.set(value);
        return true;
      }
      if (editor && typeof editor.setValue === 'function') {
        editor.setValue(value);
        return true;
      }
    } catch (e) {}
    const ta = getTextarea();
    if (!ta) return false;
    try {
      ta.value = value;
      return true;
    } catch (e2) {}
    return false;
  }

  function isDirtyText(current, saved) {
    const cur = String(current ?? '');
    const sv = String(saved ?? '');
    if (sv.length) return cur !== sv;
    return cur.trim().length > 0;
  }

  shell.getState = function () {
    return state;
  };

  shell.registerLayers = function (layers) {
    const next = layers && typeof layers === 'object' ? layers : {};
    if (hasOwn(next, 'gui')) state.layers.gui = next.gui || null;
    if (hasOwn(next, 'raw')) state.layers.raw = next.raw || null;
    if (hasOwn(next, 'orchestration')) state.layers.orchestration = next.orchestration || null;
    syncCompat();
    return state.layers;
  };

  shell.getLayer = function (name) {
    return state.layers ? state.layers[String(name || '')] || null : null;
  };

  shell.bindEditor = function (binding) {
    const next = binding && typeof binding === 'object' ? binding : {};
    if (hasOwn(next, 'engine')) state.engine = String(next.engine || 'codemirror');
    if (hasOwn(next, 'editor')) state.editor = next.editor || null;
    if (hasOwn(next, 'facade')) state.facade = next.facade || null;
    if (hasOwn(next, 'getText')) state.getText = (typeof next.getText === 'function') ? next.getText : null;
    if (hasOwn(next, 'setText')) state.setText = (typeof next.setText === 'function') ? next.setText : null;
    if (hasOwn(next, 'replaceText')) state.replaceText = (typeof next.replaceText === 'function') ? next.replaceText : null;
    if (hasOwn(next, 'validate')) state.validate = (typeof next.validate === 'function') ? next.validate : null;
    if (hasOwn(next, 'saveViewState')) state.saveViewState = (typeof next.saveViewState === 'function') ? next.saveViewState : null;
    if (hasOwn(next, 'loadViewState')) state.loadViewState = (typeof next.loadViewState === 'function') ? next.loadViewState : null;
    if (hasOwn(next, 'restoreViewState')) state.restoreViewState = (typeof next.restoreViewState === 'function') ? next.restoreViewState : null;
    syncCompat();
    return state;
  };

  shell.getEditorInstance = function (opts) {
    return resolveEditor(!!(opts && opts.preferRaw));
  };

  shell.getEditorFacade = function () {
    return state.facade || null;
  };

  shell.getEditorText = function () {
    try {
      if (typeof state.getText === 'function') return String(state.getText() ?? '');
    } catch (e) {}
    return fallbackGetText();
  };

  shell.setEditorText = function (text, opts) {
    const value = String(text ?? '');
    try {
      if (typeof state.setText === 'function') return state.setText(value, opts || {});
    } catch (e) {}
    return fallbackSetText(value);
  };

  shell.replaceEditorText = function (text, opts) {
    const value = String(text ?? '');
    const options = opts || {};
    try {
      if (typeof state.replaceText === 'function') return state.replaceText(value, options);
    } catch (e) {}
    const ok = shell.setEditorText(value, options);
    if (options.markDirty === true) shell.setDirty(true);
    else if (options.markDirty === false) {
      shell.setSavedContent(value);
      shell.setDirty(false);
    }
    return ok;
  };

  shell.validate = function () {
    try {
      if (typeof state.validate === 'function') return state.validate();
    } catch (e) {}
    const editor = resolveEditor(false);
    try {
      if (editor && typeof editor.validate === 'function') return editor.validate();
    } catch (e2) {}
    return null;
  };

  shell.saveViewState = function (opts) {
    try {
      if (typeof state.saveViewState === 'function') return state.saveViewState(opts || {});
    } catch (e) {}
    return null;
  };

  shell.loadViewState = function (key) {
    try {
      if (typeof state.loadViewState === 'function') return state.loadViewState(key);
    } catch (e) {}
    return null;
  };

  shell.restoreViewState = function (view) {
    try {
      if (typeof state.restoreViewState === 'function') return !!state.restoreViewState(view);
    } catch (e) {}
    return false;
  };

  shell.setSavedContent = function (text) {
    state.savedContent = String(text ?? '');
    syncCompat();
    return state.savedContent;
  };

  shell.getSavedContent = function () {
    return String(state.savedContent ?? '');
  };

  shell.setDirty = function (dirty) {
    state.dirty = !!dirty;
    syncCompat();
    return state.dirty;
  };

  shell.isDirty = function () {
    return !!state.dirty;
  };

  shell.hasUnsavedChanges = function (currentText) {
    const current = (typeof currentText === 'string') ? currentText : shell.getEditorText();
    return isDirtyText(current, shell.getSavedContent());
  };

  shell.syncCompat = syncCompat;

  if (!hasOwn(state, 'savedContent')) {
    try {
      state.savedContent = (typeof window.routingSavedContent === 'string') ? window.routingSavedContent : '';
    } catch (e) {
      state.savedContent = '';
    }
  }
  if (!hasOwn(state, 'dirty')) {
    try {
      state.dirty = !!window.routingIsDirty;
    } catch (e) {
      state.dirty = false;
    }
  }
  if (!hasOwn(state, 'engine')) state.engine = 'codemirror';
  if (!hasOwn(state, 'editor')) {
    state.editor = null;
  }
  if (!hasOwn(state, 'facade')) {
    state.facade = null;
  }

  syncCompat();
})();


export function getRoutingShellApi() {
  try {
    return routingShellModuleApi && typeof routingShellModuleApi.getState === 'function'
      ? routingShellModuleApi
      : null;
  } catch (error) {}
  return null;
}

export const routingShellApi = Object.freeze({
  get: getRoutingShellApi,
});
