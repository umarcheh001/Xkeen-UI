(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  function isFn(fn) {
    return typeof fn === 'function';
  }

  function asString(value) {
    return value == null ? '' : String(value);
  }

  function getEditorEngineHelper() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) ? XKeen.ui.editorEngine : null; } catch (e) {}
    return null;
  }

  function isFacade(value) {
    const helper = getEditorEngineHelper();
    try { return !!(helper && typeof helper.isFacade === 'function' && helper.isFacade(value)); } catch (e) {}
    return !!(value && value.__xkeenEditorFacade);
  }

  function rawEditor(target) {
    if (!target) return null;
    try {
      if (isFacade(target)) return target.raw || target.editor || target.target || null;
      return target.raw || target.editor || target.target || target;
    } catch (e) {}
    return target || null;
  }

  function inferEngine(target) {
    const raw = rawEditor(target);
    try {
      const hinted = String((target && (target.kind || target.engine)) || (raw && (raw.kind || raw.engine)) || '').toLowerCase();
      if (hinted === 'codemirror' || hinted === 'monaco') return hinted;
    } catch (e) {}
    try {
      if (raw && (isFn(raw.getWrapperElement) || raw.__xkeenCm6Bridge || isFn(raw.execCommand))) return 'codemirror';
      if (raw && (isFn(raw.getAction) || isFn(raw.getModel) || isFn(raw.onDidChangeModelContent))) return 'monaco';
    } catch (e) {}
    return 'codemirror';
  }

  function toFacade(target, opts) {
    if (!target) return null;
    if (isFacade(target)) return target;
    const helper = getEditorEngineHelper();
    const raw = rawEditor(target);
    const engine = inferEngine(target);
    try {
      if (helper) {
        if (engine === 'monaco' && typeof helper.fromMonaco === 'function') return helper.fromMonaco(raw, opts || {});
        if (engine === 'codemirror' && typeof helper.fromCodeMirror === 'function') return helper.fromCodeMirror(raw, opts || {});
      }
    } catch (e) {}
    return raw || target;
  }

  function getWrapperElement(target) {
    const raw = rawEditor(target);
    try { if (raw && isFn(raw.getWrapperElement)) return raw.getWrapperElement(); } catch (e) {}
    try { if (raw && isFn(raw.getDomNode)) return raw.getDomNode(); } catch (e) {}
    try { if (raw && raw.dom) return raw.dom; } catch (e) {}
    return raw && raw.nodeType === 1 ? raw : null;
  }

  function getParentForToolbar(target, opts) {
    const o = opts || {};
    const explicitHost = o.toolbarHost || o.parent || o.host || null;
    if (explicitHost && explicitHost.nodeType === 1) return explicitHost;
    const wrapper = getWrapperElement(target);
    try { return wrapper && wrapper.parentNode ? wrapper.parentNode : wrapper; } catch (e) {}
    return wrapper;
  }

  function getExtraKeys(target) {
    const raw = rawEditor(target);
    try {
      if (raw && isFn(raw.getOption)) {
        const extra = raw.getOption('extraKeys');
        if (extra && typeof extra === 'object') return extra;
      }
    } catch (e) {}
    try {
      if (raw && raw.options && raw.options.extraKeys && typeof raw.options.extraKeys === 'object') return raw.options.extraKeys;
    } catch (e) {}
    return {};
  }

  function prettyKey(key) {
    if (!key) return '';
    const parts = String(key).split('-').filter(Boolean);
    const map = { Cmd: '⌘', Command: '⌘', Ctrl: 'Ctrl', Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Option: 'Alt', Mod: 'Mod' };
    return parts.map((part) => map[part] || part).join('+');
  }

  function keysForCommand(target, commandName) {
    const extra = getExtraKeys(target);
    const keys = [];
    Object.keys(extra || {}).forEach((key) => {
      try { if (extra[key] === commandName) keys.push(key); } catch (e) {}
    });
    return keys;
  }

  function hintForCommand(target, commandName, fallback) {
    try {
      const keys = keysForCommand(target, commandName).map(prettyKey);
      if (keys.length) return keys.join(' / ');
    } catch (e) {}
    return fallback || '';
  }

  function isReadOnly(target) {
    const raw = rawEditor(target);
    try {
      if (raw && isFn(raw.getOption)) {
        const value = raw.getOption('readOnly');
        return value === true || value === 'nocursor';
      }
    } catch (e) {}
    try {
      if (raw && isFn(raw.getRawOptions)) {
        const value = raw.getRawOptions().readOnly;
        return value === true;
      }
    } catch (e) {}
    try {
      if (raw && isFn(raw.getOption) && inferEngine(raw) === 'monaco') {
        const value = raw.getOption(window.monaco && window.monaco.editor ? window.monaco.editor.EditorOption.readOnly : 82);
        return !!value;
      }
    } catch (e) {}
    return false;
  }

  function normalizeCommandName(name) {
    const raw = String(name || '').trim();
    if (!raw) return '';
    const key = raw.toLowerCase();
    const aliases = {
      fullscreen: 'fullscreen',
      fs: 'fullscreen',
      'togglefullscreen': 'fullscreen',
      'toggle-fullscreen': 'fullscreen',
      find: 'findPersistent',
      findpersistent: 'findPersistent',
      findnext: 'findNext',
      next: 'findNext',
      findprev: 'findPrev',
      findprevious: 'findPrev',
      prev: 'findPrev',
      previous: 'findPrev',
      replace: 'replace',
      replaceall: 'replaceAll',
      comment: 'toggleComment',
      togglecomment: 'toggleComment',
      undo: 'undo',
      redo: 'redo',
      save: 'save',
      links: 'links',
    };
    return aliases[key] || raw;
  }

  function runCodeMirrorCommand(target, name) {
    const raw = rawEditor(target);
    const command = normalizeCommandName(name);
    if (!raw || !command) return false;
    try {
      if (command === 'fullscreen') return !!toggleFullscreen(raw);
      if (command === 'save') {
        if (isFn(raw.emit)) { raw.emit('save', null); return true; }
        if (isFn(raw.onSave)) return false;
      }
      if (command === 'links') {
        if (typeof raw.setLinksEnabled === 'function') {
          raw.setLinksEnabled(!(raw.getLinksEnabled ? raw.getLinksEnabled() : true));
          return true;
        }
        if (typeof window.xkeenCmLinksSetEnabled === 'function') {
          const next = !(raw.getLinksEnabled ? raw.getLinksEnabled() : true);
          window.xkeenCmLinksSetEnabled(raw, next);
          return true;
        }
      }
      if (isFn(raw.runCommand)) return !!raw.runCommand(command);
      if (isFn(raw.execCommand)) { raw.execCommand(command); return true; }
    } catch (e) {}
    return false;
  }

  function getMonacoActionId(name) {
    const command = normalizeCommandName(name);
    const map = {
      findPersistent: 'actions.find',
      findNext: 'editor.action.nextMatchFindAction',
      findPrev: 'editor.action.previousMatchFindAction',
      replace: 'editor.action.startFindReplaceAction',
      replaceAll: 'editor.action.startFindReplaceAction',
      toggleComment: 'editor.action.commentLine',
      undo: 'undo',
      redo: 'redo',
    };
    return map[command] || '';
  }

  function runMonacoCommand(target, name) {
    const raw = rawEditor(target);
    const command = normalizeCommandName(name);
    if (!raw || !command) return false;
    try {
      if (command === 'fullscreen') return !!toggleFullscreen(raw);
      if (command === 'save') {
        try {
          const evt = new CustomEvent('xkeen-editor-save-request', { detail: { editor: raw, engine: 'monaco' } });
          document.dispatchEvent(evt);
          return true;
        } catch (e) {}
        return false;
      }
      const actionId = getMonacoActionId(command);
      if (!actionId || !isFn(raw.getAction)) return false;
      const action = raw.getAction(actionId);
      if (!action || !isFn(action.run)) return false;
      Promise.resolve(action.run()).catch(() => {});
      return true;
    } catch (e) {}
    return false;
  }

  function runAction(target, action, opts) {
    const o = opts || {};
    const item = (action && typeof action === 'object') ? action : { id: action, command: action };
    const raw = rawEditor(target);
    if (!raw) return false;
    if (typeof item.onClick === 'function') {
      try {
        item.onClick(raw, o);
        return true;
      } catch (e) {
        return false;
      }
    }
    const command = item.command || item.id || action;
    const engine = inferEngine(raw);
    if (engine === 'monaco') return runMonacoCommand(raw, command);
    return runCodeMirrorCommand(raw, command);
  }

  function detectCapabilities(target) {
    const raw = rawEditor(target);
    const engine = inferEngine(raw);
    const caps = {
      engine,
      readOnly: isReadOnly(raw),
      find: false,
      findNext: false,
      findPrev: false,
      replace: false,
      replaceAll: false,
      comment: false,
      fullscreen: true,
      links: false,
      save: false,
      undo: false,
      redo: false,
    };
    try {
      if (engine === 'monaco') {
        const hasAction = (id) => {
          try { return !!(raw && isFn(raw.getAction) && raw.getAction(id)); } catch (e) {}
          return false;
        };
        caps.find = hasAction('actions.find');
        caps.findNext = hasAction('editor.action.nextMatchFindAction');
        caps.findPrev = hasAction('editor.action.previousMatchFindAction');
        caps.replace = hasAction('editor.action.startFindReplaceAction');
        caps.replaceAll = caps.replace;
        caps.comment = hasAction('editor.action.commentLine');
        caps.undo = hasAction('undo');
        caps.redo = hasAction('redo');
        return caps;
      }
      const hasCommand = (name) => {
        try {
          if (raw && isFn(raw.hasCommand)) return !!raw.hasCommand(name);
        } catch (e) {}
        return false;
      };
      caps.find = hasCommand('findPersistent') || hasCommand('find');
      caps.findNext = hasCommand('findNext');
      caps.findPrev = hasCommand('findPrev');
      caps.replace = hasCommand('replace');
      caps.replaceAll = hasCommand('replaceAll');
      caps.comment = hasCommand('toggleComment');
      caps.undo = hasCommand('undo');
      caps.redo = hasCommand('redo');
      caps.save = hasCommand('save');
      caps.links = !!(raw && (isFn(raw.setLinksEnabled) || typeof window.xkeenCmLinksSetEnabled === 'function'));
    } catch (e) {}
    return caps;
  }

  function fullscreenState(target) {
    const raw = rawEditor(target);
    if (!raw) return null;
    raw.__xkeenFullscreenState = raw.__xkeenFullscreenState || { active: false };
    return raw.__xkeenFullscreenState;
  }

  function isFullscreen(target) {
    const raw = rawEditor(target);
    const st = fullscreenState(raw);
    if (st && st.active) return true;
    try {
      const wrapper = getWrapperElement(raw);
      return !!(wrapper && wrapper.classList && wrapper.classList.contains('is-fullscreen'));
    } catch (e) {}
    return false;
  }

  function syncToolbarFullscreen(target) {
    const raw = rawEditor(target);
    const bar = raw && raw._xkeenToolbarEl ? raw._xkeenToolbarEl : null;
    if (!bar || !bar.classList) return false;
    try { bar.classList.toggle('is-fullscreen', isFullscreen(raw)); } catch (e) {}
    return true;
  }

  function syncToolbarReadonly(target) {
    const raw = rawEditor(target);
    const bar = raw && raw._xkeenToolbarEl ? raw._xkeenToolbarEl : null;
    if (!bar) return false;
    const ro = isReadOnly(raw);
    try {
      const buttons = bar.querySelectorAll('button[data-write-only="1"]');
      buttons.forEach((btn) => {
        btn.disabled = !!ro;
        btn.classList.toggle('is-disabled', !!ro);
      });
    } catch (e) {}
    return true;
  }

  function applyFullscreenStyles(node, active, prevStyle) {
    if (!node || !node.style) return;
    if (active) {
      node.style.position = 'fixed';
      node.style.inset = '0';
      node.style.zIndex = '2140';
      node.style.width = '100vw';
      node.style.height = '100vh';
      node.style.maxWidth = '100vw';
      node.style.maxHeight = '100vh';
      node.style.margin = '0';
      node.style.borderRadius = '0';
      node.style.background = 'var(--card, var(--bg-elevated, #111))';
    } else {
      Object.keys(prevStyle || {}).forEach((key) => {
        try { node.style[key] = prevStyle[key] || ''; } catch (e) {}
      });
    }
  }

  function setFullscreen(target, flag, opts) {
    const raw = rawEditor(target);
    const wrapper = getWrapperElement(raw);
    const o = opts || {};
    if (!raw || !wrapper) return false;
    const st = fullscreenState(raw);
    const next = !!flag;
    if (!!st.active === next) {
      syncToolbarFullscreen(raw);
      return true;
    }

    if (next) {
      const parent = wrapper.parentNode;
      if (!parent) return false;
      const placeholder = document.createElement('div');
      placeholder.className = 'xkeen-editor-fs-placeholder';
      placeholder.style.display = 'none';
      parent.insertBefore(placeholder, wrapper);
      st.parent = parent;
      st.placeholder = placeholder;
      st.prevNextSibling = wrapper.nextSibling;
      st.prevBodyOverflow = document.body.style.overflow;
      st.prevWrapperClass = wrapper.className;
      st.prevStyle = {
        position: wrapper.style.position || '',
        inset: wrapper.style.inset || '',
        zIndex: wrapper.style.zIndex || '',
        width: wrapper.style.width || '',
        height: wrapper.style.height || '',
        maxWidth: wrapper.style.maxWidth || '',
        maxHeight: wrapper.style.maxHeight || '',
        margin: wrapper.style.margin || '',
        borderRadius: wrapper.style.borderRadius || '',
        background: wrapper.style.background || '',
      };
      document.body.appendChild(wrapper);
      try { wrapper.classList.add('is-fullscreen', 'CodeMirror-fullscreen'); } catch (e) {}
      applyFullscreenStyles(wrapper, true, st.prevStyle);
      try { document.body.style.overflow = 'hidden'; } catch (e) {}
      st.onKeyDown = (event) => {
        try {
          if (event && event.key === 'Escape' && isFullscreen(raw)) {
            event.preventDefault();
            setFullscreen(raw, false, o);
          }
        } catch (e) {}
      };
      try { document.addEventListener('keydown', st.onKeyDown, { capture: true }); } catch (e) {}
      st.active = true;
    } else {
      try { if (st.onKeyDown) document.removeEventListener('keydown', st.onKeyDown, { capture: true }); } catch (e) {}
      st.onKeyDown = null;
      try { wrapper.classList.remove('is-fullscreen', 'CodeMirror-fullscreen'); } catch (e) {}
      applyFullscreenStyles(wrapper, false, st.prevStyle || {});
      try {
        if (st.parent && st.placeholder && st.placeholder.parentNode === st.parent) {
          st.parent.insertBefore(wrapper, st.placeholder);
          st.placeholder.remove();
        }
      } catch (e) {}
      try { document.body.style.overflow = st.prevBodyOverflow || ''; } catch (e) {}
      st.active = false;
      st.parent = null;
      st.placeholder = null;
      st.prevStyle = null;
      st.prevBodyOverflow = null;
    }

    syncToolbarFullscreen(raw);
    try {
      if (isFn(raw.layout)) raw.layout();
      else if (isFn(raw.refresh)) raw.refresh();
    } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent('xkeen-editor-fullscreen-change', {
        detail: { editor: raw, engine: inferEngine(raw), fullScreen: !!next },
      }));
    } catch (e) {}
    return true;
  }

  function toggleFullscreen(target, opts) {
    return setFullscreen(target, !isFullscreen(target), opts);
  }

  function detachToolbar(target) {
    const raw = rawEditor(target);
    try {
      if (raw && raw._xkeenToolbarEl && raw._xkeenToolbarEl.parentNode) raw._xkeenToolbarEl.parentNode.removeChild(raw._xkeenToolbarEl);
    } catch (e) {}
    try { if (raw) raw._xkeenToolbarEl = null; } catch (e2) {}
    return true;
  }

  function filterToolbarItems(target, items) {
    const caps = detectCapabilities(target);
    const out = [];
    (items || []).forEach((item) => {
      if (!item) return;
      const id = normalizeCommandName(item.id || item.command || '');
      if (!item.command && !item.id) {
        out.push(item);
        return;
      }
      if (id === 'fullscreen') { if (caps.fullscreen) out.push(item); return; }
      if (id === 'findPersistent') { if (caps.find) out.push(item); return; }
      if (id === 'findNext') { if (caps.findNext) out.push(item); return; }
      if (id === 'findPrev') { if (caps.findPrev) out.push(item); return; }
      if (id === 'replace') { if (caps.replace) out.push(item); return; }
      if (id === 'replaceAll') { if (caps.replaceAll) out.push(item); return; }
      if (id === 'toggleComment') { if (caps.comment) out.push(item); return; }
      if (id === 'links') { if (caps.links) out.push(item); return; }
      if (id === 'undo') { if (caps.undo) out.push(item); return; }
      if (id === 'redo') { if (caps.redo) out.push(item); return; }
      out.push(item);
    });
    return out;
  }

  function attachToolbar(target, items, opts) {
    const raw = rawEditor(target);
    const wrapper = getWrapperElement(raw);
    const parent = getParentForToolbar(raw, opts);
    const o = opts || {};
    if (!raw || !wrapper || !parent) return null;

    const force = !!o.force;
    if (!force && raw._xkeenToolbarEl && (raw._xkeenToolbarEl.isConnected || document.body.contains(raw._xkeenToolbarEl))) {
      return raw._xkeenToolbarEl;
    }
    if (force) detachToolbar(raw);

    const effectiveItems = filterToolbarItems(raw, Array.isArray(items) ? items : []);
    raw._xkeenToolbarItemsBase = Array.isArray(items) ? items : [];
    raw._xkeenToolbarItems = effectiveItems;

    const bar = document.createElement('div');
    bar.className = 'xkeen-cm-toolbar';
    bar.setAttribute('role', 'toolbar');
    effectiveItems.forEach((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xkeen-cm-tool'
        + ((it && (it.id === 'help' || it.isHelp)) ? ' is-help' : '')
        + ((it && (it.id === 'help_comments' || it.isCommentsHelp)) ? ' is-comments-help' : '');
      btn.setAttribute('aria-label', it.label || it.id || 'Action');
      if (it.id) btn.dataset.actionId = String(it.id);
      if (it.command) btn.dataset.command = String(it.command);
      const writeOnly = !!(it && (it.requiresWrite || it.writeOnly || it.id === 'replace' || it.id === 'comment' || it.command === 'replace' || it.command === 'toggleComment'));
      if (writeOnly) btn.dataset.writeOnly = '1';
      if (it.svg) btn.innerHTML = it.svg;
      else btn.textContent = it.icon || '•';
      let hint = '';
      if (it.command) hint = hintForCommand(raw, it.command, it.fallbackHint || '');
      else if (it.fallbackHint) hint = it.fallbackHint;
      const tip = (it.label || '') + (hint ? ` (${hint})` : '');
      if (tip.trim()) btn.dataset.tip = tip;
      btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.disabled) return;
        runAction(raw, it, o);
        const shouldRefocus = !(it && (it.command === 'findPersistent' || it.command === 'find' || it.command === 'replace'));
        if (shouldRefocus) {
          try { if (isFn(raw.focus)) raw.focus(); } catch (e) {}
        }
        syncToolbarFullscreen(raw);
        syncToolbarReadonly(raw);
      });
      bar.appendChild(btn);
    });

    if (parent.insertBefore && wrapper.parentNode === parent) parent.insertBefore(bar, wrapper);
    else parent.appendChild(bar);

    raw._xkeenToolbarEl = bar;
    syncToolbarFullscreen(raw);
    syncToolbarReadonly(raw);

    try {
      if (raw && isFn(raw.setOption) && !raw._xkeenToolbarSetOptionWrapped) {
        const original = raw.setOption.bind(raw);
        raw.setOption = function patchedSetOption(name, value) {
          const result = original(name, value);
          const key = asString(name || '');
          if (key === 'fullScreen' || key === 'readOnly' || key === 'mode' || key === 'links') {
            if (key === 'mode') {
              try { attachToolbar(raw, raw._xkeenToolbarItemsBase || effectiveItems, { force: true }); } catch (e) {}
            } else {
              syncToolbarFullscreen(raw);
              syncToolbarReadonly(raw);
            }
          }
          return result;
        };
        raw._xkeenToolbarSetOptionWrapped = true;
      }
    } catch (e) {}

    return bar;
  }

  function buildCommonKeys(opts) {
    const o = opts || {};
    const noFullscreen = !!o.noFullscreen;
    const keys = {
      'Ctrl-/': (editor) => runAction(editor, 'toggleComment'),
      'Cmd-/': (editor) => runAction(editor, 'toggleComment'),
    };
    if (!noFullscreen) {
      keys.F11 = (editor) => runAction(editor, 'fullscreen');
      keys.Esc = (editor) => {
        if (isFullscreen(editor)) return !!setFullscreen(editor, false, o);
        return false;
      };
    }
    return keys;
  }

  const api = {
    toFacade,
    rawEditor,
    inferEngine,
    getWrapperElement,
    getExtraKeys,
    prettyKey,
    keysForCommand,
    hintForCommand,
    isReadOnly,
    detectCapabilities,
    runAction,
    attachToolbar,
    detachToolbar,
    syncToolbarFullscreen,
    syncToolbarReadonly,
    isFullscreen,
    setFullscreen,
    toggleFullscreen,
    buildCommonKeys,
  };

  XKeen.ui.editorActions = api;
})();
