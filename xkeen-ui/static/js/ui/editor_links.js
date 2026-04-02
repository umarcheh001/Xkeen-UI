(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  function getEditorEngine() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) {}
    return null;
  }

  function getEditorActions() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorActions) ? XKeen.ui.editorActions : null; } catch (e) {}
    return null;
  }

  function toFacade(editor) {
    if (!editor) return null;
    const actions = getEditorActions();
    try {
      if (actions && typeof actions.toFacade === 'function') return actions.toFacade(editor);
    } catch (e) {}
    const engine = getEditorEngine();
    try {
      if (engine && typeof engine.toFacade === 'function') return engine.toFacade(editor);
    } catch (e) {}
    return editor;
  }

  function rawEditor(editor) {
    const target = toFacade(editor) || editor;
    try { return target.raw || target.editor || target.target || target; } catch (e) {}
    return target || null;
  }

  function setLinksEnabled(editor, enabled) {
    const next = enabled !== false;
    const target = toFacade(editor) || editor;
    const raw = rawEditor(target);

    try {
      if (target && typeof target.setLinksEnabled === 'function') return !!target.setLinksEnabled(next);
    } catch (e) {}
    try {
      if (raw && typeof raw.setLinksEnabled === 'function') return !!raw.setLinksEnabled(next);
    } catch (e) {}
    try {
      if (target && typeof target.setOption === 'function') return !!target.setOption('links', next);
    } catch (e) {}
    try {
      if (raw && typeof raw.setOption === 'function') return !!raw.setOption('links', next);
    } catch (e) {}
    return false;
  }

  function isLinksEnabled(editor) {
    const target = toFacade(editor) || editor;
    const raw = rawEditor(target);

    try {
      if (target && typeof target.getLinksEnabled === 'function') return target.getLinksEnabled() !== false;
    } catch (e) {}
    try {
      if (raw && typeof raw.getLinksEnabled === 'function') return raw.getLinksEnabled() !== false;
    } catch (e) {}
    try {
      if (target && typeof target.getOption === 'function') return target.getOption('links') !== false;
    } catch (e) {}
    try {
      if (raw && typeof raw.getOption === 'function') return raw.getOption('links') !== false;
    } catch (e) {}
    return false;
  }

  function toggleLinks(editor) {
    return setLinksEnabled(editor, !isLinksEnabled(editor));
  }

  window.xkeenCmLinksSetEnabled = function xkeenCmLinksSetEnabled(editor, enabled) {
    return setLinksEnabled(editor, enabled);
  };

  XKeen.ui.editorLinks = Object.assign({}, XKeen.ui.editorLinks || {}, {
    setEnabled: setLinksEnabled,
    isEnabled: isLinksEnabled,
    toggle: toggleLinks,
  });
})();
