// Engine-neutral editor toolbar layer.
//
// Keeps legacy XKeen globals for feature modules while exposing a neutral
// XKeen.ui.editorToolbar API backed by XKeen.ui.editorActions.

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};

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
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'Справка по редактору');

    drawer.innerHTML = `
      <div class="xkeen-cm-help-head">
        <div class="xkeen-cm-help-title">Справка по редактору</div>
        <button type="button" class="xkeen-cm-help-close" aria-label="Закрыть">✕</button>
      </div>
      <div class="xkeen-cm-help-body" id="xkeen-cm-help-body"></div>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(drawer);

    function close() {
      overlay.classList.remove('is-open');
      drawer.classList.remove('is-open');
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
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
  }

  const XKEEN_CM_ICONS = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>',
    up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>',
    replace: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
  };

  const XKEEN_CM_TOOLBAR_DEFAULT = [
    { id: 'find', svg: XKEEN_CM_ICONS.search, label: 'Поиск', command: 'findPersistent', fallbackHint: 'Ctrl+F' },
    { id: 'next', svg: XKEEN_CM_ICONS.down, label: 'Следующее', command: 'findNext', fallbackHint: 'Ctrl+G' },
    { id: 'prev', svg: XKEEN_CM_ICONS.up, label: 'Предыдущее', command: 'findPrev', fallbackHint: 'Shift+Ctrl+G' },
    { id: 'replace', svg: XKEEN_CM_ICONS.replace, label: 'Замена', command: 'replace', fallbackHint: 'Ctrl+H' },
    { id: 'comment', svg: XKEEN_CM_ICONS.comment, label: 'Коммент', command: 'toggleComment', fallbackHint: 'Ctrl+/' },
    { id: 'help', svg: XKEEN_CM_ICONS.help, label: 'Справка', fallbackHint: '?', isHelp: true, onClick: (editor) => openHelp(editor) },
    { id: 'fs', svg: XKEEN_CM_ICONS.fullscreen, label: 'Фулскрин', fallbackHint: 'F11 / Esc', onClick: (editor) => {
      const api = actions();
      if (api && typeof api.toggleFullscreen === 'function') api.toggleFullscreen(editor);
    } },
  ];

  const XKEEN_CM_TOOLBAR_MINI = [
    { id: 'find', svg: XKEEN_CM_ICONS.search, label: 'Поиск', command: 'findPersistent', fallbackHint: 'Ctrl+F' },
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
