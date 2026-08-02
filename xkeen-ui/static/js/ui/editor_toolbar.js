// Engine-neutral editor toolbar layer.
//
// Keeps legacy XKeen globals for feature modules while exposing a neutral
// XKeen.ui.editorToolbar API backed by XKeen.ui.editorActions.

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

  function iconHtml(name) {
    try { return (XKeen.ui && XKeen.ui.operatorIcons) ? XKeen.ui.operatorIcons.html(name) : ''; } catch (e) {}
    return '';
  }

  function actions() {
    try { return (window.XKeen && XKeen.ui && XKeen.ui.editorActions) ? XKeen.ui.editorActions : null; } catch (e) {}
    return null;
  }

  function buildCmExtraKeysCommon(opts) {
    const api = actions();
    if (api && typeof api.buildCommonKeys === 'function') return api.buildCommonKeys(opts || {});
    return {};
  }

  function ensureHelpDrawer() {
    if (document.getElementById('xkeen-cm-help-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'xkeen-cm-help-overlay';
    overlay.className = 'xkeen-cm-help-overlay';

    const drawer = document.createElement('div');
    drawer.id = 'xkeen-cm-help-drawer';
    drawer.className = 'xkeen-cm-help-drawer';
    drawer.dataset.operatorWorkbenchSidecar = 'editor-help';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Справка по редактору');
    drawer.setAttribute('aria-hidden', 'true');

    drawer.innerHTML = `
      <div class="xkeen-cm-help-head">
        <div class="xkeen-cm-help-title">Справка по редактору</div>
        <button type="button" class="xkeen-cm-help-close" aria-label="Закрыть">${iconHtml('close')}</button>
      </div>
      <div class="xkeen-cm-help-body" id="xkeen-cm-help-body"></div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    function close() {
      const returnFocus = drawer._xkeenReturnFocus;
      overlay.classList.remove('is-open');
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('xk-editor-help-open');
      drawer._xkeenReturnFocus = null;
      try {
        if (returnFocus && document.contains(returnFocus)) returnFocus.focus();
      } catch (e) {}
    }

    overlay.addEventListener('click', close);
    drawer.querySelector('.xkeen-cm-help-close').addEventListener('click', close);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && drawer.classList.contains('is-open')) {
        event.preventDefault();
        close();
      }
    }, { passive: false });
  }

  function helpBlock(title, html) {
    return `
      <section class="xkeen-cm-help-section">
        <h3>${title}</h3>
        ${html}
      </section>
    `;
  }

  function hasAction(items, predicate) {
    try { return !!(items && items.some((item) => item && predicate(item))); } catch (e) {}
    return false;
  }

  function buildHelpHtml(editor) {
    const api = actions();
    const caps = api && typeof api.detectCapabilities === 'function'
      ? api.detectCapabilities(editor)
      : { readOnly: false };
    const toolbarItems = editor && editor._xkeenToolbarItems ? editor._xkeenToolbarItems : null;

    const hint = (command, fallback) => {
      try {
        if (api && typeof api.hintForCommand === 'function') return api.hintForCommand(editor, command, fallback || '');
      } catch (e) {}
      return fallback || '';
    };

    const showFind = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'find' || it.command === 'findPersistent' || it.command === 'find') : !!caps.find;
    const showNext = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'next' || it.command === 'findNext') : !!caps.findNext;
    const showPrev = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'prev' || it.command === 'findPrev') : !!caps.findPrev;
    const showReplace = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'replace' || it.command === 'replace' || it.command === 'replaceAll') : (!!caps.replace || !!caps.replaceAll);
    const showComment = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'comment' || it.command === 'toggleComment') : !!caps.comment;
    const showFs = toolbarItems ? hasAction(toolbarItems, (it) => it.id === 'fs' || it.id === 'fullscreen') : !!caps.fullscreen;

    const blocks = [];
    blocks.push(helpBlock('Что это такое', `
      <p>Это встроенный редактор кода. Ниже — только те возможности, которые реально включены именно в этом экземпляре редактора.</p>
      ${caps.readOnly ? '<p><b>Примечание:</b> этот редактор открыт <b>только для чтения</b>. Поиск работает, а изменения текста недоступны.</p>' : ''}
    `));

    if (showFind) {
      blocks.push(helpBlock('Поиск', `
        <ul>
          <li><b>Открыть поиск:</b> кнопка <b>«Поиск»</b> или <b>${hint('findPersistent', 'Ctrl+F')}</b>.</li>
          ${showNext ? `<li><b>Следующее совпадение:</b> кнопка <b>«Следующее»</b> или <b>${hint('findNext', 'Ctrl+G')}</b>.</li>` : ''}
          ${showPrev ? `<li><b>Предыдущее совпадение:</b> кнопка <b>«Предыдущее»</b> или <b>${hint('findPrev', 'Shift+Ctrl+G')}</b>.</li>` : ''}
          <li>Панель поиска закрывается клавишей <b>Esc</b>.</li>
        </ul>
      `));
    }

    if (showReplace && !caps.readOnly) {
      blocks.push(helpBlock('Замена', `
        <ul>
          <li><b>Открыть замену:</b> кнопка <b>«Замена»</b> или <b>${hint('replace', 'Ctrl+H')}</b>.</li>
          <li>Массовая замена поддерживается через ту же панель поиска/замены.</li>
        </ul>
      `));
    }

    if (showComment && !caps.readOnly) {
      blocks.push(helpBlock('Комментарии', `
        <ul>
          <li><b>Переключить комментарий:</b> кнопка <b>«Коммент»</b> или <b>${hint('toggleComment', 'Ctrl+/')}</b>.</li>
        </ul>
      `));
    }

    if (showFs) {
      blocks.push(helpBlock('Фулскрин', `
        <ul>
          <li><b>Переключить полноэкранный режим:</b> кнопка <b>«Фулскрин»</b> или <b>F11</b>.</li>
          <li><b>Выйти из фулскрина:</b> <b>Esc</b>.</li>
        </ul>
      `));
    }

    return blocks.join('');
  }

  function openHelp(editor) {
    ensureHelpDrawer();
    const overlay = document.getElementById('xkeen-cm-help-overlay');
    const drawer = document.getElementById('xkeen-cm-help-drawer');
    const body = document.getElementById('xkeen-cm-help-body');
    if (!overlay || !drawer || !body) return;
    body.innerHTML = buildHelpHtml(editor);
    try {
      drawer._xkeenReturnFocus = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    } catch (e) {
      drawer._xkeenReturnFocus = null;
    }
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    document.body.classList.add('xk-editor-help-open');
    try { drawer.querySelector('.xkeen-cm-help-close').focus(); } catch (e) {}
  }

  // The editor toolbar exposes HTML for legacy consumers, but every glyph
  // still originates from the shared local Operator sprite.
  const XKEEN_CM_ICONS = {
    search: iconHtml('search'),
    down: iconHtml('move-down'),
    up: iconHtml('move-up'),
    replace: iconHtml('replace'),
    quickFix: iconHtml('quick-fix'),
    comment: iconHtml('comment'),
    fullscreen: iconHtml('fullscreen'),
    help: iconHtml('help'),
    compare: iconHtml('compare'),
  };

  function openDiffForEditor(editor) {
    const api = actions();
    if (api && typeof api.openDiff === 'function') {
      try { api.openDiff(editor); return; } catch (e) {}
    }
    try {
      const scope = (editor && (editor._xkeenDiffScope
        || (editor.getWrapperElement && editor.getWrapperElement().dataset && editor.getWrapperElement().dataset.xkeenDiffScope)
        || (editor.getDomNode && editor.getDomNode().dataset && editor.getDomNode().dataset.xkeenDiffScope))) || '';
      if (scope && window.XKeen && XKeen.ui && XKeen.ui.diff && typeof XKeen.ui.diff.openForScope === 'function') {
        XKeen.ui.diff.openForScope(scope).catch(() => {});
      }
    } catch (e) {}
  }

  const XKEEN_CM_TOOLBAR_DEFAULT = [
    { id: 'find', svg: XKEEN_CM_ICONS.search, label: 'Поиск', command: 'findPersistent', fallbackHint: 'Ctrl+F' },
    { id: 'next', svg: XKEEN_CM_ICONS.down, label: 'Следующее', command: 'findNext', fallbackHint: 'Ctrl+G' },
    { id: 'prev', svg: XKEEN_CM_ICONS.up, label: 'Предыдущее', command: 'findPrev', fallbackHint: 'Shift+Ctrl+G' },
    { id: 'replace', svg: XKEEN_CM_ICONS.replace, label: 'Замена', command: 'replace', fallbackHint: 'Ctrl+H' },
    { id: 'comment', svg: XKEEN_CM_ICONS.comment, label: 'Коммент', command: 'toggleComment', fallbackHint: 'Ctrl+/' },
    { id: 'compare', svg: XKEEN_CM_ICONS.compare, label: 'Сравнить', fallbackHint: 'Diff', requiresDiffScope: true, onClick: (editor) => openDiffForEditor(editor) },
    { id: 'help', svg: XKEEN_CM_ICONS.help, label: 'Справка', fallbackHint: '?', isHelp: true, onClick: (editor) => openHelp(editor) },
    { id: 'fs', svg: XKEEN_CM_ICONS.fullscreen, label: 'Фулскрин', fallbackHint: 'F11 / Esc', onClick: (editor) => {
      const api = actions();
      if (api && typeof api.toggleFullscreen === 'function') api.toggleFullscreen(editor);
    } },
  ];

  const XKEEN_CM_TOOLBAR_MINI = [
    { id: 'find', svg: XKEEN_CM_ICONS.search, label: 'Поиск', command: 'findPersistent', fallbackHint: 'Ctrl+F' },
    { id: 'compare', svg: XKEEN_CM_ICONS.compare, label: 'Сравнить', fallbackHint: 'Diff', requiresDiffScope: true, onClick: (editor) => openDiffForEditor(editor) },
    { id: 'help', svg: XKEEN_CM_ICONS.help, label: 'Справка', fallbackHint: '?', isHelp: true, onClick: (editor) => openHelp(editor) },
    { id: 'fs', svg: XKEEN_CM_ICONS.fullscreen, label: 'Фулскрин', fallbackHint: 'F11 / Esc', onClick: (editor) => {
      const api = actions();
      if (api && typeof api.toggleFullscreen === 'function') api.toggleFullscreen(editor);
    } },
  ];

  function xkeenAttachCmToolbar(editor, items, opts) {
    const api = actions();
    if (!api || typeof api.attachToolbar !== 'function') return null;
    return api.attachToolbar(editor, items || XKEEN_CM_TOOLBAR_DEFAULT, opts || {});
  }

  XKeen.ui.editorToolbar = Object.assign({}, XKeen.ui.editorToolbar || {}, {
    buildCommonKeys: buildCmExtraKeysCommon,
    openHelp,
    attach: xkeenAttachCmToolbar,
    icons: XKEEN_CM_ICONS,
    defaultItems: XKEEN_CM_TOOLBAR_DEFAULT,
    miniItems: XKEEN_CM_TOOLBAR_MINI,
  });

  window.buildCmExtraKeysCommon = buildCmExtraKeysCommon;
  window.xkeenOpenCmHelp = openHelp;
  window.xkeenAttachCmToolbar = xkeenAttachCmToolbar;
  window.XKEEN_CM_ICONS = window.XKEEN_CM_ICONS || XKEEN_CM_ICONS;
  window.XKEEN_CM_TOOLBAR_DEFAULT = window.XKEEN_CM_TOOLBAR_DEFAULT || XKEEN_CM_TOOLBAR_DEFAULT;
  window.XKEEN_CM_TOOLBAR_MINI = window.XKEEN_CM_TOOLBAR_MINI || XKEEN_CM_TOOLBAR_MINI;
})();
