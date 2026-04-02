(() => {
  'use strict';

  try {
    if (window.__xkMonacoRuntimeFixInstalledV2) return;
    window.__xkMonacoRuntimeFixInstalledV2 = true;
  } catch (e) {}

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  let activeEditor = null;
  let activeHost = null;
  let clickHandledAt = 0;

  const ACTION_IDS = {
    copy: ['editor.action.clipboardCopyAction'],
    cut: ['editor.action.clipboardCutAction'],
    paste: ['editor.action.clipboardPasteAction'],
  };

  function now() {
    try { return Date.now(); } catch (e) { return 0; }
  }

  function cssVar(name, fallback) {
    try {
      const value = String(getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();
      return value || fallback;
    } catch (e) {}
    return fallback;
  }

  function isRoutingHost(host) {
    try {
      if (!host) return false;
      if (host.id === 'routing-editor-monaco') return true;
      if (typeof host.closest === 'function' && host.closest('#routing-body')) return true;
    } catch (e) {}
    return false;
  }

  function setActive(editor, host) {
    try {
      if (editor) activeEditor = editor;
      if (host) activeHost = host;
    } catch (e) {}
  }

  function getActiveEditor() {
    try {
      if (activeEditor) return activeEditor;
    } catch (e) {}
    return null;
  }

  function focusEditor(editor) {
    try { if (editor && typeof editor.focus === 'function') editor.focus(); } catch (e) {}
  }

  function getSelections(editor) {
    try {
      if (editor && typeof editor.getSelections === 'function') {
        const selections = editor.getSelections();
        if (Array.isArray(selections) && selections.length) return selections;
      }
    } catch (e) {}
    try {
      if (editor && typeof editor.getSelection === 'function') {
        const selection = editor.getSelection();
        if (selection) return [selection];
      }
    } catch (e) {}
    return [];
  }

  function getSelectedText(editor) {
    try {
      const model = editor && typeof editor.getModel === 'function' ? editor.getModel() : null;
      if (!model || typeof model.getValueInRange !== 'function') return '';
      const selections = getSelections(editor);
      if (!selections.length) return '';
      const parts = selections.map((selection) => {
        try { return String(model.getValueInRange(selection) || ''); } catch (e) { return ''; }
      });
      return parts.join((typeof model.getEOL === 'function') ? model.getEOL() : '\n');
    } catch (e) {}
    return '';
  }

  function executeReplaceSelections(editor, text) {
    try {
      if (!editor || typeof editor.executeEdits !== 'function') return false;
      const selections = getSelections(editor);
      if (!selections.length) return false;
      const edits = selections.map((selection) => ({
        range: selection,
        text: String(text ?? ''),
        forceMoveMarkers: true,
      }));
      editor.executeEdits('xkeen-clipboard-fix', edits);
      return true;
    } catch (e) {}
    return false;
  }

  function storeLastClipboardText(text) {
    try {
      if (typeof text === 'string') window.__xkLastClipboardText = text;
    } catch (e) {}
  }

  function legacyCopyFallback(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text ?? '');
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = !!(document.execCommand && document.execCommand('copy'));
      document.body.removeChild(ta);
      return ok;
    } catch (e) {}
    return false;
  }

  async function clipboardWriteText(text) {
    const value = String(text ?? '');
    storeLastClipboardText(value);
    try {
      const nav = window.navigator || null;
      const clipboard = nav && nav.clipboard;
      if (clipboard && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(value);
        return true;
      }
    } catch (e) {}
    return legacyCopyFallback(value);
  }

  async function clipboardReadText() {
    try {
      const nav = window.navigator || null;
      const clipboard = nav && nav.clipboard;
      if (clipboard && typeof clipboard.readText === 'function') {
        const text = await clipboard.readText();
        if (typeof text === 'string') {
          storeLastClipboardText(text);
          return text;
        }
      }
    } catch (e) {}
    try {
      if (typeof window.__xkLastClipboardText === 'string') return window.__xkLastClipboardText;
    } catch (e) {}
    return null;
  }

  async function runClipboardAction(kind, editor) {
    const ed = editor || getActiveEditor();
    if (!ed) return false;
    focusEditor(ed);

    if (kind === 'copy') {
      const text = getSelectedText(ed);
      if (!text) return false;
      return !!(await clipboardWriteText(text));
    }

    if (kind === 'cut') {
      const text = getSelectedText(ed);
      if (!text) return false;
      const copied = await clipboardWriteText(text);
      if (copied) {
        try { executeReplaceSelections(ed, ''); } catch (e) {}
      }
      return !!copied;
    }

    if (kind === 'paste') {
      const text = await clipboardReadText();
      if (typeof text !== 'string') return false;
      return executeReplaceSelections(ed, text);
    }

    return false;
  }

  function closeMonacoMenus() {
    try {
      document.querySelectorAll('.context-view.monaco-menu-container, .context-view .action-widget, .context-view .monaco-menu').forEach((node) => {
        try { node.style.display = 'none'; } catch (e) {}
      });
      try { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window })); } catch (e) {}
    } catch (e) {}
  }

  function patchClipboardActions(editor, host) {
    if (!editor || !isRoutingHost(host) || typeof editor.getAction !== 'function') return;
    setActive(editor, host);

    Object.keys(ACTION_IDS).forEach((kind) => {
      ACTION_IDS[kind].forEach((id) => {
        let action = null;
        try { action = editor.getAction(id); } catch (e) {}
        if (!action || action.__xkClipboardPatched) return;
        const originalRun = (typeof action.run === 'function') ? action.run.bind(action) : null;
        try {
          action.run = async function patchedClipboardAction(...args) {
            try {
              setActive(editor, host);
              const ok = await runClipboardAction(kind, editor);
              if (ok) {
                try { closeMonacoMenus(); } catch (e) {}
                return;
              }
            } catch (e) {}
            if (originalRun) return originalRun(...args);
          };
          action.__xkClipboardPatched = true;
        } catch (e) {}
      });
    });
  }

  function normalizeLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function getMenuItemElement(target) {
    try {
      if (!target || typeof target.closest !== 'function') return null;
      return target.closest('.context-view .action-item, .context-view .monaco-list-row, .context-view [role="menuitem"], .context-view .action-label');
    } catch (e) {}
    return null;
  }

  function getMenuItemLabel(el) {
    if (!el) return '';
    const selectors = [
      '.action-label',
      '.action-menu-item',
      '.monaco-menu-option',
      '.label',
      '.title',
      '[role="menuitem"]',
    ];
    for (const sel of selectors) {
      try {
        const node = el.matches && el.matches(sel) ? el : (typeof el.querySelector === 'function' ? el.querySelector(sel) : null);
        const text = node ? normalizeLabel(node.textContent) : '';
        if (text) return text;
      } catch (e) {}
    }
    try { return normalizeLabel(el.textContent); } catch (e) {}
    return '';
  }

  function kindFromMenuLabel(label) {
    if (!label) return null;
    if (label === 'copy' || label.startsWith('copy ')) return 'copy';
    if (label === 'cut' || label.startsWith('cut ')) return 'cut';
    if (label === 'paste' || label.startsWith('paste ')) return 'paste';
    return null;
  }

  function styleMenuNode(node) {
    if (!node || node.__xkMenuStyled) return;
    const bg = cssVar('--xk-monaco-widget-bg', 'rgba(6, 14, 30, 0.96)');
    const fg = cssVar('--xk-monaco-widget-text', '#f8fbff');
    const border = cssVar('--xk-monaco-widget-border', 'rgba(96, 165, 250, 0.22)');
    const hover = cssVar('--xk-monaco-widget-hover', 'rgba(96, 165, 250, 0.14)');
    const shadow = cssVar('--xk-monaco-widget-shadow', 'rgba(15, 23, 42, 0.55)');

    const apply = (el, styles) => {
      if (!el || !el.style) return;
      Object.keys(styles).forEach((key) => {
        try { el.style.setProperty(key, styles[key], 'important'); } catch (e) {}
      });
    };

    apply(node, {
      'background': bg,
      'background-color': bg,
      'color': fg,
      'border': '1px solid ' + border,
      'border-radius': '12px',
      'box-shadow': '0 10px 30px ' + shadow,
      'backdrop-filter': 'none',
      '-webkit-backdrop-filter': 'none',
      'opacity': '1',
    });

    const descendants = node.querySelectorAll('.monaco-menu, .action-widget, .actionList, .monaco-list, .monaco-list-rows, .actions-container');
    descendants.forEach((el) => apply(el, {
      'background': bg,
      'background-color': bg,
      'color': fg,
      'backdrop-filter': 'none',
      '-webkit-backdrop-filter': 'none',
      'opacity': '1',
    }));

    const items = node.querySelectorAll('.action-item, .action-label, .action-menu-item, .monaco-menu-option, .monaco-list-row, .title, .label, .keybinding, .submenu-indicator, .codicon');
    items.forEach((el) => apply(el, {
      'color': fg,
      'background-color': 'transparent',
      'background': 'transparent',
    }));

    const keys = node.querySelectorAll('.monaco-keybinding-key');
    keys.forEach((el) => apply(el, {
      'background': bg,
      'background-color': bg,
      'color': fg,
      'border': '1px solid ' + border,
      'box-shadow': 'none',
    }));

    const cssText = '.context-view .action-item:hover,.context-view .action-menu-item:hover,.context-view .monaco-menu-option:hover,.context-view .monaco-list-row:hover{background:' + hover + ' !important;color:' + fg + ' !important;}';
    try {
      if (!document.getElementById('xk-monaco-menu-inline-style')) {
        const style = document.createElement('style');
        style.id = 'xk-monaco-menu-inline-style';
        style.textContent = cssText;
        document.head.appendChild(style);
      }
    } catch (e) {}

    try { node.__xkMenuStyled = true; } catch (e) {}
  }

  function patchVisibleMenus() {
    try {
      document.querySelectorAll('.context-view.monaco-menu-container, .context-view .action-widget, .context-view .monaco-menu').forEach(styleMenuNode);
    } catch (e) {}
  }

  function installMenuObserver() {
    try {
      if (window.__xkMonacoMenuObserverInstalled) return;
      window.__xkMonacoMenuObserverInstalled = true;
    } catch (e) {}

    const wire = () => patchVisibleMenus();
    try { wire(); } catch (e) {}

    try {
      const observer = new MutationObserver(() => {
        try { wire(); } catch (e) {}
      });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) {}

    const handleMenuEvent = (event) => {
      const item = getMenuItemElement(event.target);
      if (!item) return;
      const label = getMenuItemLabel(item);
      const kind = kindFromMenuLabel(label);
      if (!kind) return;
      const editor = getActiveEditor();
      if (!editor || !isRoutingHost(activeHost)) return;

      if (event.type === 'click' && now() - clickHandledAt < 500) {
        try { event.preventDefault(); } catch (e) {}
        try { event.stopPropagation(); } catch (e) {}
        try { event.stopImmediatePropagation(); } catch (e) {}
        return;
      }

      clickHandledAt = now();
      try { event.preventDefault(); } catch (e) {}
      try { event.stopPropagation(); } catch (e) {}
      try { event.stopImmediatePropagation(); } catch (e) {}

      Promise.resolve(runClipboardAction(kind, editor))
        .finally(() => {
          try { closeMonacoMenus(); } catch (e) {}
        });
    };

    try { document.addEventListener('mousedown', handleMenuEvent, true); } catch (e) {}
    try { document.addEventListener('click', handleMenuEvent, true); } catch (e) {}
  }

  function attachClipboardBridge(editor, host) {
    try {
      if (!editor || editor.__xkClipboardBridgeAttached) return;
      editor.__xkClipboardBridgeAttached = true;
    } catch (e) {
      return;
    }

    setActive(editor, host);
    patchClipboardActions(editor, host);

    const domNode = (() => {
      try { return (editor && typeof editor.getDomNode === 'function') ? editor.getDomNode() : host; } catch (e) { return host; }
    })();
    if (!domNode || typeof domNode.addEventListener !== 'function') return;

    const on = (target, type, handler, options) => {
      try { target.addEventListener(type, handler, options); } catch (e) {}
    };

    on(domNode, 'contextmenu', () => {
      setActive(editor, host);
      try { patchVisibleMenus(); } catch (e) {}
      focusEditor(editor);
    }, true);

    on(domNode, 'mousedown', () => {
      setActive(editor, host);
    }, true);

    on(domNode, 'focusin', () => {
      setActive(editor, host);
    }, true);

    on(domNode, 'copy', () => {
      try {
        const text = getSelectedText(editor);
        if (text) storeLastClipboardText(text);
      } catch (e) {}
    }, true);

    on(domNode, 'cut', () => {
      try {
        const text = getSelectedText(editor);
        if (text) storeLastClipboardText(text);
      } catch (e) {}
    }, true);

    on(domNode, 'paste', (event) => {
      try {
        if (event && event.clipboardData && typeof event.clipboardData.getData === 'function') {
          const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
          if (typeof text === 'string' && text) storeLastClipboardText(text);
        }
      } catch (e) {}
    }, true);
  }

  function patchMonacoSharedApi() {
    const api = XKeen && XKeen.ui ? XKeen.ui.monacoShared : null;
    if (!api || api.__xkRuntimeClipboardFixAppliedV2 || typeof api.createEditor !== 'function') return false;

    installMenuObserver();

    const originalCreateEditor = api.createEditor.bind(api);
    api.createEditor = async function patchedCreateEditor(host, opts) {
      const nextOpts = Object.assign({}, opts || {});
      if (isRoutingHost(host)) {
        try { delete nextOpts.disableSafariOptimizations; } catch (e) {}
      }
      const editor = await originalCreateEditor(host, nextOpts);
      if (editor && isRoutingHost(host)) {
        try {
          if (typeof editor.updateOptions === 'function') {
            editor.updateOptions({ contextmenu: true, fixedOverflowWidgets: true });
          }
        } catch (e) {}
        try { attachClipboardBridge(editor, host); } catch (e) {}
      }
      return editor;
    };

    try { api.__xkRuntimeClipboardFixAppliedV2 = true; } catch (e) {}
    return true;
  }

  if (patchMonacoSharedApi()) return;

  let tries = 0;
  const timer = window.setInterval(() => {
    tries += 1;
    if (patchMonacoSharedApi() || tries >= 120) {
      try { window.clearInterval(timer); } catch (e) {}
    }
  }, 250);
})();
