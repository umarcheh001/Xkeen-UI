// Lazy editor support for the pages that live outside the panel shell.
//
// The panel loads Monaco on demand through runtime/lazy_runtime.js. The
// standalone pages (backups, Mihomo generator) do not carry that runtime and
// used to import the Monaco support statically instead. An installation with
// the light editor has no such files, so a page of a module added later from
// its package could not load at all. This is the same hook the editor engine
// already asks for, limited to what a standalone page needs.

(() => {
  'use strict';

  const XK = (window.XKeen = window.XKeen || {});
  XK.runtime = XK.runtime || {};
  const existing = XK.runtime.lazy;
  if (existing && typeof existing.ensureEditorSupport === 'function') return;

  let monacoSupport = null;

  function isDeclared(capability) {
    try {
      const descriptor = XK.pageConfig && XK.pageConfig.frontendModules
        ? XK.pageConfig.frontendModules.editor
        : null;
      if (!descriptor || typeof descriptor !== 'object') return true;
      const capabilities = Array.isArray(descriptor.capabilities) ? descriptor.capabilities : [];
      return capabilities.includes(capability);
    } catch (e) {
      return false;
    }
  }

  function ensureEditorSupport(engine) {
    if (String(engine || '').trim().toLowerCase() !== 'monaco') return Promise.resolve(false);
    if (!isDeclared('monaco')) return Promise.resolve(false);
    if (!monacoSupport) {
      monacoSupport = import('../pages/panel.editor.monaco.bundle.js')
        .then((mod) => (mod && typeof mod.activate === 'function' ? mod.activate() : mod))
        .then(() => true)
        .catch((error) => {
          // A missing file (light editor) is an answer, not a crash: the page
          // stays on CodeMirror. Forget the attempt so a later one can retry.
          monacoSupport = null;
          try { console.warn('[XKeen] Monaco support is not available:', error); } catch (e) {}
          return false;
        });
    }
    return monacoSupport;
  }

  XK.runtime.lazy = Object.freeze(Object.assign({}, existing || {}, { ensureEditorSupport }));
})();
