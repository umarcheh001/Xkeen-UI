// Shared CodeMirror helpers + toolbar (extracted from legacy main.js)
//
// Rationale:
// During modularization some pages/features stopped loading legacy static/main.js,
// while several editors still expect globals for toolbar + common keybindings.
// This module provides a small, page-agnostic implementation and exposes the
// same globals used across the app.

(() => {
  // --------------------
  // Common keybindings
  // --------------------
  if (typeof window.buildCmExtraKeysCommon !== 'function') {
    window.buildCmExtraKeysCommon = function buildCmExtraKeysCommon(opts) {
      const o = opts || {};
      const noFs = !!o.noFullscreen;
      const keys = {
        'Ctrl-/': 'toggleComment',
        'Cmd-/': 'toggleComment',
      };

      if (!noFs) {
        keys['F11'] = function (cm) {
          try {
            cm.setOption('fullScreen', !cm.getOption('fullScreen'));
          } catch (e) {
            // ignore
          }
        };
        keys['Esc'] = function (cm) {
          try {
            if (cm.getOption('fullScreen')) cm.setOption('fullScreen', false);
          } catch (e) {
            // ignore
          }
        };
      }

      return keys;
    };
  }

  // If toolbar already exists (e.g. legacy main.js was loaded), don't override.
  if (typeof window.xkeenAttachCmToolbar === 'function' && window.XKEEN_CM_TOOLBAR_DEFAULT) {
    return;
  }

  // --------------------
  // Key pretty-printing helpers
  // --------------------
  function xkeenPrettyKey(key) {
    // Examples:
    //  - "Shift-Ctrl-G" -> "Shift+Ctrl+G"
    //  - "Cmd-F" -> "⌘+F"
    if (!key) return '';
    const parts = String(key).split('-').filter(Boolean);
    const map = {
      Cmd: '⌘',
      Command: '⌘',
      Ctrl: 'Ctrl',
      Control: 'Ctrl',
      Shift: 'Shift',
      Alt: 'Alt',
      Option: 'Alt',
      Mod: 'Mod',
    };
    return parts.map((p) => (map[p] || p)).join('+');
  }

  function xkeenKeysForCommand(cm, commandName) {
    try {
      const extra = (cm && cm.getOption) ? (cm.getOption('extraKeys') || {}) : {};
      const keys = [];
      for (const k in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
        if (extra[k] === commandName) keys.push(k);
      }
      return keys;
    } catch (e) {
      return [];
    }
  }

  function xkeenHasCmCommand(name) {
    try {
      return !!(window.CodeMirror && CodeMirror.commands && typeof CodeMirror.commands[name] === 'function');
    } catch (e) {
      return false;
    }
  }

  function xkeenModeSupportsComment(cm) {
    try {
      if (!cm || typeof cm.getMode !== 'function') return false;
      const m = cm.getMode();
      if (!m) return false;
      // Most modes expose either lineComment or blockCommentStart/End.
      return !!(m.lineComment || m.blockCommentStart);
    } catch (e) {
      return false;
    }
  }

  function xkeenCanFullscreen(cm) {
    try {
      return !!(cm && cm.getOption && typeof cm.getOption('fullScreen') !== 'undefined');
    } catch (e) {
      return false;
    }
  }

  function xkeenDetectCmCapabilities(cm) {
    // Capabilities are based on actually loaded addons + the current mode.
    // Toolbars and help must only expose actions that will work.
    const caps = {
      find: false,
      findNext: false,
      findPrev: false,
      replace: false,
      replaceAll: false,
      comment: false,
      fullscreen: false,
    };
    try {
      caps.find = xkeenHasCmCommand('findPersistent') || xkeenHasCmCommand('find');
      caps.findNext = xkeenHasCmCommand('findNext');
      caps.findPrev = xkeenHasCmCommand('findPrev');
      caps.replace = xkeenHasCmCommand('replace');
      caps.replaceAll = xkeenHasCmCommand('replaceAll');
      caps.comment = xkeenHasCmCommand('toggleComment') && xkeenModeSupportsComment(cm);
      caps.fullscreen = xkeenCanFullscreen(cm);
    } catch (e) {}
    return caps;
  }

  function xkeenFilterToolbarItems(cm, items) {
    const caps = xkeenDetectCmCapabilities(cm);
    const out = [];

    (items || []).forEach((it) => {
      if (!it) return;

      // Always keep custom actions (no command) — we can't auto-detect them.
      if (!it.command) {
        // But hide fullscreen toggler if addon isn't present.
        if ((it.id === 'fs' || it.id === 'fullscreen') && !caps.fullscreen) return;
        out.push(it);
        return;
      }

      const cmd = String(it.command || '');

      // Map known actions to capability flags.
      if (cmd === 'findPersistent' || cmd === 'find') {
        if (!caps.find) return;

        // If findPersistent isn't available but find is, transparently swap.
        if (cmd === 'findPersistent' && !xkeenHasCmCommand('findPersistent') && xkeenHasCmCommand('find')) {
          out.push(Object.assign({}, it, { command: 'find' }));
        } else {
          out.push(it);
        }
        return;
      }
      if (cmd === 'findNext') { if (!caps.findNext) return; out.push(it); return; }
      if (cmd === 'findPrev') { if (!caps.findPrev) return; out.push(it); return; }
      if (cmd === 'replace') { if (!caps.replace) return; out.push(it); return; }
      if (cmd === 'replaceAll') { if (!caps.replaceAll) return; out.push(it); return; }
      if (cmd === 'toggleComment') { if (!caps.comment) return; out.push(it); return; }

      // Generic: keep only if the command exists.
      if (!xkeenHasCmCommand(cmd)) return;
      out.push(it);
    });

    return out;
  }

  function xkeenHintForCommand(cm, commandName, fallback) {
    try {
      const keys = xkeenKeysForCommand(cm, commandName).map(xkeenPrettyKey);
      if (keys.length) return keys.join(' / ');
    } catch (e) {}
    return fallback || '';
  }

  // --------------------
  // Help drawer (toolbar "?" button)
  // --------------------
  function xkeenEnsureCmHelpDrawer() {
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

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (drawer.classList.contains('is-open')) {
          e.preventDefault();
          close();
        }
      }
    }, { passive: false });
  }

  function xkeenHelpBlock(title, html) {
    return `
      <section class="xkeen-cm-help-section">
        <h3>${title}</h3>
        ${html}
      </section>
    `;
  }

  function xkeenBuildCmHelpHTML(cm) {
    const blocks = [];
    const readOnly = !!(cm && cm.getOption && cm.getOption('readOnly'));

    // If the toolbar is attached, use the *actual* actions shown in this editor.
    // This keeps help in sync with dynamic toolbars.
    const toolbarItems = (cm && cm._xkeenToolbarItems) ? cm._xkeenToolbarItems : null;
    const hasActionId = (id) => {
      try { return !!(toolbarItems && toolbarItems.some((it) => it && it.id === id)); } catch (e) { return false; }
    };
    const hasActionCmd = (cmd) => {
      try { return !!(toolbarItems && toolbarItems.some((it) => it && it.command === cmd)); } catch (e) { return false; }
    };
    const caps = xkeenDetectCmCapabilities(cm);

    const showFind = toolbarItems ? (hasActionId('find') || hasActionCmd('findPersistent') || hasActionCmd('find')) : caps.find;
    const showNext = toolbarItems ? (hasActionId('next') || hasActionCmd('findNext')) : caps.findNext;
    const showPrev = toolbarItems ? (hasActionId('prev') || hasActionCmd('findPrev')) : caps.findPrev;
    const showReplace = toolbarItems ? (hasActionId('replace') || hasActionCmd('replace') || hasActionCmd('replaceAll')) : (caps.replace || caps.replaceAll);
    const showComment = toolbarItems ? (hasActionId('comment') || hasActionCmd('toggleComment')) : caps.comment;
    const showFs = toolbarItems ? (hasActionId('fs') || hasActionId('fullscreen')) : caps.fullscreen;

    blocks.push(xkeenHelpBlock('Что это такое', `
      <p>Это встроенный редактор кода. Ниже — только те возможности, которые реально включены в <b>этом</b> редакторе.</p>
      ${readOnly ? '<p><b>Примечание:</b> этот редактор открыт <b>только для чтения</b>. Поиск работает, а изменения текста недоступны.</p>' : ''}
    `));

    // Search (addon/search + addon/dialog)
    if (showFind) {
      const kFind = xkeenHintForCommand(cm, 'findPersistent', 'Ctrl+F');
      const kNext = xkeenHintForCommand(cm, 'findNext', 'Ctrl+G');
      const kPrev = xkeenHintForCommand(cm, 'findPrev', 'Shift+Ctrl+G');

      blocks.push(xkeenHelpBlock('Поиск', `
        <ul>
          <li><b>Открыть поиск:</b> кнопка <b>«Поиск»</b> (лупа) или <b>${kFind}</b>.</li>
          ${showNext ? `<li><b>Следующее совпадение:</b> кнопка <b>«Следующее»</b> (стрелка вниз) или <b>${kNext}</b>.</li>` : ''}
          ${showPrev ? `<li><b>Предыдущее совпадение:</b> кнопка <b>«Предыдущее»</b> (стрелка вверх) или <b>${kPrev}</b>.</li>` : ''}
          <li>Введите текст в поле поиска и нажмите <b>Enter</b>. Закрыть панель поиска — <b>Esc</b>.</li>
        </ul>
      `));
    }

    if (showReplace) {
      const kReplace = xkeenHintForCommand(cm, 'replace', 'Ctrl+H');
      const kReplaceAll = xkeenHintForCommand(cm, 'replaceAll', 'Shift+Ctrl+H');
      blocks.push(xkeenHelpBlock('Замена', `
        ${readOnly ? '<p>Этот редактор в режиме <b>только чтение</b>, поэтому замена недоступна.</p>' : `
        <ul>
          <li><b>Открыть замену:</b> кнопка <b>«Замена»</b> (две стрелки) или <b>${kReplace}</b>.</li>
          ${kReplaceAll ? `<li><b>Заменить всё:</b> <b>${kReplaceAll}</b> (если назначено в этом редакторе).</li>` : ''}
          <li>Сначала задайте <b>что искать</b>, затем <b>на что заменить</b>. Обычно <b>Enter</b> заменяет текущее совпадение, затем можно перейти к следующему.</li>
        </ul>
        `}
      `));
    }

    // Comment addon (only when the current mode supports comment strings)
    if (showComment) {
      const kCmt = xkeenHintForCommand(cm, 'toggleComment', 'Ctrl+/');
      blocks.push(xkeenHelpBlock('Комментарии', `
        ${readOnly ? '<p>Редактирование отключено, поэтому комментирование недоступно.</p>' : `
        <ul>
          <li><b>Закомментировать/раскомментировать:</b> кнопка <b>«Коммент»</b> (облачко) или <b>${kCmt}</b>.</li>
          <li>Работает для текущей строки или для выделенного блока строк.</li>
        </ul>
        `}
      `));
    }

    // Fullscreen addon
    if (showFs) {
      blocks.push(xkeenHelpBlock('Фулскрин', `
        <ul>
          <li><b>Во весь экран:</b> кнопка <b>«Фулскрин»</b> или <b>F11</b>.</li>
          <li><b>Выйти:</b> <b>Esc</b> (или повторно F11).</li>
        </ul>
      `));
    }

    // Visual helpers (options/addons)
    try {
      if (cm && cm.getOption) {
        const v = [];
        if (cm.getOption('matchBrackets')) v.push('<li><b>Парные скобки:</b> курсор рядом со скобкой подсвечивает её пару.</li>');
        if (cm.getOption('autoCloseBrackets')) v.push('<li><b>Автозакрытие скобок/кавычек:</b> при вводе автоматически добавляется закрывающий символ.</li>');
        if (cm.getOption('styleActiveLine')) v.push('<li><b>Активная строка:</b> подсвечивается строка, где стоит курсор.</li>');
        if (cm.getOption('showIndentGuides')) v.push('<li><b>Линии отступов:</b> помогают визуально видеть уровни вложенности.</li>');
        if (cm.getOption('highlightSelectionMatches')) v.push('<li><b>Совпадения выделения:</b> выделите слово — одинаковые места подсветятся.</li>');
        if (cm.getOption('showTrailingSpace')) v.push('<li><b>Пробелы в конце строки:</b> подсвечиваются, чтобы их было легко убрать.</li>');
        if (cm.getOption('foldGutter')) v.push('<li><b>Сворачивание блоков:</b> в левом поле (gutter) появляются маркеры — кликайте, чтобы свернуть/развернуть блок.</li>');
        if (cm.getOption('lint')) v.push('<li><b>Проверка ошибок:</b> проблемы подсвечиваются/маркируются слева; наведите на маркер, чтобы увидеть подсказку.</li>');
        if (v.length) {
          blocks.push(xkeenHelpBlock('Подсказки и подсветка', `<ul>${v.join('')}</ul>`));
        }
      }
    } catch (e) {}

    blocks.push(xkeenHelpBlock('Подсказка', `
      <p>Если вы забыли горячие клавиши, наведите мышью на кнопки панели над редактором — в подсказке показываются актуальные сочетания.</p>
    `));

    return blocks.join('');
  }

  function xkeenOpenCmHelp(cm) {
    xkeenEnsureCmHelpDrawer();
    const overlay = document.getElementById('xkeen-cm-help-overlay');
    const drawer = document.getElementById('xkeen-cm-help-drawer');
    const body = document.getElementById('xkeen-cm-help-body');
    if (!overlay || !drawer || !body) return;
    body.innerHTML = xkeenBuildCmHelpHTML(cm);
    overlay.classList.add('is-open');
    drawer.classList.add('is-open');
  }

  // --------------------
  // Toolbar attach
  // --------------------
  function xkeenSyncCmToolbarReadonly(cm) {
    try {
      if (!cm || !cm.getOption) return;
      const bar = cm._xkeenToolbarEl;
      if (!bar || !bar.querySelectorAll) return;

      const ro = !!cm.getOption('readOnly');
      const buttons = bar.querySelectorAll('button.xkeen-cm-tool[data-write-only="1"]');
      (buttons || []).forEach((btn) => {
        try {
          btn.disabled = ro;
          btn.classList.toggle('is-disabled', ro);
        } catch (e) {
          // ignore
        }
      });
    } catch (e) {
      // ignore
    }
  }

  function xkeenSyncCmToolbarFullscreen(cm) {
    try {
      if (!cm || !cm.getWrapperElement) return;
      const wrapper = cm.getWrapperElement();
      const bar = cm._xkeenToolbarEl;
      if (!wrapper || !bar) return;

      const isFs = !!(cm.getOption && cm.getOption('fullScreen')) || wrapper.classList.contains('CodeMirror-fullscreen');
      bar.classList.toggle('is-fullscreen', isFs);
    } catch (e) {
      // ignore
    }
  }

  function xkeenAttachCmToolbar(cm, items, opts) {
    if (!cm || !cm.getWrapperElement) return;
    const wrapper = cm.getWrapperElement();
    if (!wrapper) return;

    const force = !!(opts && opts.force);

    // If a toolbar is already attached to this CodeMirror instance, do not
    // create another one (some pages move the toolbar into a different host),
    // unless we explicitly force a rebuild (e.g. after mode changes).
    try {
      if (!force && cm._xkeenToolbarEl && (cm._xkeenToolbarEl.isConnected || document.body.contains(cm._xkeenToolbarEl))) {
        return;
      }
      if (force && cm._xkeenToolbarEl && cm._xkeenToolbarEl.parentNode) {
        cm._xkeenToolbarEl.parentNode.removeChild(cm._xkeenToolbarEl);
      }
    } catch (e) {
      // ignore
    }

    const parent = wrapper.parentNode;

    // Stable id to attach a toolbar to a specific editor wrapper
    const cmId = (wrapper.dataset && wrapper.dataset.xkeenCmId)
      ? wrapper.dataset.xkeenCmId
      : ('xkcm_' + Math.random().toString(36).slice(2));
    try { if (wrapper.dataset) wrapper.dataset.xkeenCmId = cmId; } catch (_) {}

    // Avoid duplicates
    if (!force && parent && parent.querySelector && parent.querySelector('.xkeen-cm-toolbar[data-cm-for="' + cmId + '"]')) return;

    // Store base items so we can rebuild dynamically (e.g. when mode changes)
    const baseItems = Array.isArray(items) ? items : [];
    cm._xkeenToolbarItemsBase = baseItems;

    // Filter out actions that are not available (missing addons or unsupported mode)
    const effectiveItems = xkeenFilterToolbarItems(cm, baseItems);

    const bar = document.createElement('div');
    bar.className = 'xkeen-cm-toolbar';
    bar.setAttribute('role', 'toolbar');
    bar.dataset.cmFor = cmId;

    (effectiveItems || []).forEach((it) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xkeen-cm-tool' + ((it && (it.id === 'help' || it.isHelp)) ? ' is-help' : '');
      btn.setAttribute('aria-label', it.label || it.id || 'Action');

      // For help/debugging: keep a stable id/command on the element.
      try {
        if (it.id) btn.dataset.actionId = String(it.id);
        if (it.command) btn.dataset.command = String(it.command);
      } catch (e) {}

      // Some actions make no sense in readOnly mode (replace/comment). Keep them
      // visible for a consistent UI, but disable when editor is readOnly.
      const writeOnly = !!(it && (it.requiresWrite || it.writeOnly || it.id === 'replace' || it.id === 'comment' || it.command === 'replace' || it.command === 'toggleComment'));
      if (writeOnly) btn.dataset.writeOnly = '1';

      // SVG icon (preferred), fallback to text
      if (it.svg) btn.innerHTML = it.svg;
      else btn.textContent = it.icon || '•';

      // Tooltip: show real keybindings from extraKeys when possible
      let hint = '';
      if (it.command) {
        const keys = xkeenKeysForCommand(cm, it.command).map(xkeenPrettyKey);
        if (keys.length) hint = keys.join(' / ');
      }
      if (!hint && it.fallbackHint) hint = it.fallbackHint;

      const tip = (it.label || '') + (hint ? ` (${hint})` : '');
      if (tip.trim()) {
        // Custom tooltip via CSS ::after. Avoid native browser tooltip duplication.
        btn.dataset.tip = tip;
      }

      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Disabled actions (e.g. replace/comment in readOnly mode)
        if (btn.disabled) return;

        // NOTE: Do not steal focus from CodeMirror dialogs (find/replace)
        try {
          if (typeof it.onClick === 'function') it.onClick(cm);
          else if (it.command && cm.execCommand) cm.execCommand(it.command);
        } catch (err) {
          console.error('CM toolbar action failed', it && it.id, err);
        }

        const dialogIsOpen = wrapper.classList && wrapper.classList.contains('dialog-opened');
        if (!dialogIsOpen) {
          try { cm.focus(); } catch (_) {}
        }
        xkeenSyncCmToolbarFullscreen(cm);
      });

      bar.appendChild(btn);

      // Initial disabled state
      try {
        if (writeOnly && cm && cm.getOption && cm.getOption('readOnly')) {
          btn.disabled = true;
          btn.classList.add('is-disabled');
        }
      } catch (e) {
        // ignore
      }
    });

    // Place toolbar ABOVE the editor (outside CodeMirror), so it doesn't cover code.
    if (parent && parent.insertBefore) {
      parent.insertBefore(bar, wrapper);
    } else {
      wrapper.appendChild(bar);
    }

    cm._xkeenToolbarEl = bar;
    cm._xkeenToolbarItems = effectiveItems;

    // Sync toolbar in fullscreen mode
    try {
      if (cm && typeof cm.setOption === 'function' && !cm._xkeenSetOptionWrapped) {
        const origSetOption = cm.setOption.bind(cm);
        cm.setOption = function (opt, val) {
          origSetOption(opt, val);
          if (opt === 'fullScreen') xkeenSyncCmToolbarFullscreen(cm);
          if (opt === 'readOnly') xkeenSyncCmToolbarReadonly(cm);
          // Mode changes (e.g. in file manager) can affect which toolbar actions
          // make sense (comments, etc). Rebuild the toolbar in-place.
          if (opt === 'mode') {
            try {
              xkeenAttachCmToolbar(cm, cm._xkeenToolbarItemsBase || baseItems, { force: true });
            } catch (e) {}
          }
        };
        cm._xkeenSetOptionWrapped = true;
      }
    } catch (e) {
      // ignore
    }

    xkeenSyncCmToolbarFullscreen(cm);
    xkeenSyncCmToolbarReadonly(cm);
  }

  // --------------------
  // Icons + default toolbars
  // --------------------
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
    { id: 'help', svg: XKEEN_CM_ICONS.help, label: 'Справка', fallbackHint: '?', isHelp: true, onClick: (cm) => xkeenOpenCmHelp(cm) },
    {
      id: 'fs',
      svg: XKEEN_CM_ICONS.fullscreen,
      label: 'Фулскрин',
      fallbackHint: 'F11 / Esc',
      onClick: (cm) => {
        try {
          cm.setOption('fullScreen', !cm.getOption('fullScreen'));
        } catch (e) {
          // ignore
        }
      },
    },
  ];

  const XKEEN_CM_TOOLBAR_MINI = [
    { id: 'find', svg: XKEEN_CM_ICONS.search, label: 'Поиск', command: 'findPersistent', fallbackHint: 'Ctrl+F' },
    { id: 'help', svg: XKEEN_CM_ICONS.help, label: 'Справка', fallbackHint: '?', isHelp: true, onClick: (cm) => xkeenOpenCmHelp(cm) },
    {
      id: 'fs',
      svg: XKEEN_CM_ICONS.fullscreen,
      label: 'Фулскрин',
      fallbackHint: 'F11 / Esc',
      onClick: (cm) => {
        try {
          cm.setOption('fullScreen', !cm.getOption('fullScreen'));
        } catch (e) {
          // ignore
        }
      },
    },
  ];

  // --------------------
  // Export globals expected by feature modules
  // --------------------
  window.xkeenAttachCmToolbar = window.xkeenAttachCmToolbar || xkeenAttachCmToolbar;
  window.XKEEN_CM_ICONS = window.XKEEN_CM_ICONS || XKEEN_CM_ICONS;
  window.XKEEN_CM_TOOLBAR_DEFAULT = window.XKEEN_CM_TOOLBAR_DEFAULT || XKEEN_CM_TOOLBAR_DEFAULT;
  window.XKEEN_CM_TOOLBAR_MINI = window.XKEEN_CM_TOOLBAR_MINI || XKEEN_CM_TOOLBAR_MINI;
})();
