

function stripJsonComments(s) {
  let res = [];
  let inString = false;
  let escape = false;
  let i = 0;
  const length = s.length;

  while (i < length) {
    const ch = s[i];

    // Inside string literal
    if (inString) {
      res.push(ch);
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    // Start of string literal
    if (ch === '"') {
      inString = true;
      res.push(ch);
      i++;
      continue;
    }

    // Single-line comment //
    if (ch === '/' && i + 1 < length && s[i + 1] === '/') {
      i += 2;
      while (i < length && s[i] !== '\n') i++;
      continue;
    }

    // Single-line comment starting with #
    if (ch === '#') {
      i++;
      while (i < length && s[i] !== '\n') i++;
      continue;
    }

    // Multi-line comment /* ... */
    if (ch === '/' && i + 1 < length && s[i + 1] === '*') {
      i += 2;
      while (i + 1 < length && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    // Regular character
    res.push(ch);
    i++;
  }

  return res.join('');
}


// --------------------
// CSRF header injection for same-origin fetch()
// --------------------

const CSRF_TOKEN = (() => {
  try {
    const el = document.querySelector('meta[name="csrf-token"]');
    return (el && el.getAttribute('content')) ? el.getAttribute('content') : '';
  } catch (e) {
    return '';
  }
})();

(function patchFetchForCsrf() {
  try {
    if (!window.fetch) return;
    const origFetch = window.fetch.bind(window);
    window.fetch = function (url, options) {
      const opts = options || {};
      try {
        const method = (opts.method || 'GET').toUpperCase();
        // Ensure cookies are sent to same-origin endpoints
        if (typeof opts.credentials === 'undefined') {
          opts.credentials = 'same-origin';
        }
        // Add CSRF token for mutating requests
        if (CSRF_TOKEN && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
          const headers = new Headers(opts.headers || {});
          if (!headers.has('X-CSRF-Token')) {
            headers.set('X-CSRF-Token', CSRF_TOKEN);
          }
          opts.headers = headers;
        }
      } catch (e) {
        // ignore
      }
      return origFetch(url, opts);
    };
  } catch (e) {
    // ignore
  }
})();


// --------------------
// CodeMirror shared helpers
// --------------------

function buildCmExtraKeysCommon(opts) {
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
}



// --------------------
// CodeMirror mouse toolbar (overlay buttons with hotkey tooltips)
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

function xkeenHintForCommand(cm, commandName, fallback) {
  try {
    const keys = xkeenKeysForCommand(cm, commandName).map(xkeenPrettyKey);
    if (keys.length) return keys.join(' / ');
  } catch (e) {}
  return fallback || '';
}

// --------------------
// CodeMirror help drawer (toolbar "?" button)
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

  blocks.push(xkeenHelpBlock('Что это такое', `
    <p>Это встроенный редактор кода. Ниже — только те возможности, которые реально включены в <b>этом</b> редакторе.</p>
    ${readOnly ? '<p><b>Примечание:</b> этот редактор открыт <b>только для чтения</b>. Поиск работает, а изменения текста недоступны.</p>' : ''}
  `));

  // Search / replace (addon/search + addon/dialog)
  const hasSearch = xkeenHasCmCommand('findPersistent') || xkeenHasCmCommand('find');
  if (hasSearch) {
    const kFind = xkeenHintForCommand(cm, 'findPersistent', 'Ctrl+F');
    const kNext = xkeenHintForCommand(cm, 'findNext', 'Ctrl+G');
    const kPrev = xkeenHintForCommand(cm, 'findPrev', 'Shift+Ctrl+G');

    blocks.push(xkeenHelpBlock('Поиск', `
      <ul>
        <li><b>Открыть поиск:</b> кнопка <b>«Поиск»</b> (лупа) или <b>${kFind}</b>.</li>
        <li><b>Следующее совпадение:</b> кнопка <b>«Следующее»</b> (стрелка вниз) или <b>${kNext}</b>.</li>
        <li><b>Предыдущее совпадение:</b> кнопка <b>«Предыдущее»</b> (стрелка вверх) или <b>${kPrev}</b>.</li>
        <li>Введите текст в поле поиска и нажмите <b>Enter</b>. Закрыть панель поиска — <b>Esc</b>.</li>
      </ul>
    `));
  }

  const hasReplace = xkeenHasCmCommand('replace') || xkeenHasCmCommand('replaceAll');
  if (hasReplace) {
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

  // Comment addon
  if (xkeenHasCmCommand('toggleComment')) {
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
  const canFS = (cm && cm.getOption && typeof cm.getOption('fullScreen') !== 'undefined');
  if (canFS) {
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

function xkeenAttachCmToolbar(cm, items) {
  if (!cm || !cm.getWrapperElement) return;
  const wrapper = cm.getWrapperElement();
  if (!wrapper) return;

  const parent = wrapper.parentNode;

  // Stable id to attach a toolbar to a specific editor wrapper
  const cmId = (wrapper.dataset && wrapper.dataset.xkeenCmId) ? wrapper.dataset.xkeenCmId : ('xkcm_' + Math.random().toString(36).slice(2));
  try { if (wrapper.dataset) wrapper.dataset.xkeenCmId = cmId; } catch (_) {}

  // Avoid duplicates (toolbar now lives next to the editor, not inside it)
  if (parent && parent.querySelector && parent.querySelector('.xkeen-cm-toolbar[data-cm-for="' + cmId + '"]')) return;

  const bar = document.createElement('div');
  bar.className = 'xkeen-cm-toolbar';
  bar.setAttribute('role', 'toolbar');
  bar.dataset.cmFor = cmId;

  (items || []).forEach((it) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xkeen-cm-tool' + ((it && (it.id === 'help' || it.isHelp)) ? ' is-help' : '');
    btn.setAttribute('aria-label', it.label || it.id || 'Action');

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
      // Custom tooltip (CSS ::after). Do NOT set `title` to avoid duplicate native browser tooltip.
      btn.dataset.tip = tip;
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // IMPORTANT:
      // Some CodeMirror commands (find/replace) open a dialog via addon/dialog.
      // The dialog closes on focus-out. If we force focus back to the editor
      // right after running the command, the dialog immediately closes and it
      // looks like the button doesn't work.
      try {
        if (typeof it.onClick === 'function') it.onClick(cm);
        else if (it.command && cm.execCommand) cm.execCommand(it.command);
      } catch (err) {
        console.error('CM toolbar action failed', it.id, err);
      }
      // Keep focus where it belongs:
      // - If a dialog is open (either already open or just opened), do NOT
      //   steal focus from its input.
      // - Otherwise, return focus to the editor for convenience.
      const dialogIsOpen = wrapper.classList && wrapper.classList.contains('dialog-opened');
      // If a dialog is open, keep focus in the dialog input.
      // Otherwise, return focus to the editor for convenience.
      if (!dialogIsOpen) {
        try { cm.focus(); } catch (_) {}
      }
      xkeenSyncCmToolbarFullscreen(cm);
    });

    bar.appendChild(btn);
  });

  // Place toolbar ABOVE the editor (outside CodeMirror), so it doesn't cover code.
  if (parent && parent.insertBefore) {
    parent.insertBefore(bar, wrapper);
  } else {
    // Fallback: keep previous behavior
    wrapper.appendChild(bar);
  }

  // Keep reference for fullscreen sync
  cm._xkeenToolbarEl = bar;

  // Sync toolbar position in fullscreen mode (F11 / Esc or button)
  try {
    if (cm && typeof cm.setOption === 'function' && !cm._xkeenSetOptionWrapped) {
      const origSetOption = cm.setOption.bind(cm);
      cm.setOption = function (opt, val) {
        origSetOption(opt, val);
        if (opt === 'fullScreen') xkeenSyncCmToolbarFullscreen(cm);
      };
      cm._xkeenSetOptionWrapped = true;
    }
  } catch (e) {
    // ignore
  }

  // Initial sync
  xkeenSyncCmToolbarFullscreen(cm);
}
// Minimal inline SVG icons (no external deps)
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


let routingEditor = null;
let routingErrorMarker = null;

function setRoutingError(message, line) {
  const errorEl = document.getElementById('routing-error');
  if (errorEl) {
    errorEl.textContent = message || '';
  }

  if (!routingEditor || !routingEditor.getDoc) {
    return;
  }

  // Clear previous marker
  if (routingErrorMarker && typeof routingErrorMarker.clear === 'function') {
    routingErrorMarker.clear();
    routingErrorMarker = null;
  }

  if (typeof line !== 'number' || line < 0) {
    return;
  }

  try {
    const doc = routingEditor.getDoc();
    const lineText = doc.getLine(line) || '';
    routingErrorMarker = doc.markText(
      { line: line, ch: 0 },
      { line: line, ch: lineText.length },
      { className: 'cm-error-line' }
    );
    if (routingEditor.scrollIntoView) {
      routingEditor.scrollIntoView({ line: line, ch: 0 }, 200);
    }
  } catch (e) {
    console.error('setRoutingError failed', e);
  }
}

let mihomoEditor = null;
let mihomoActiveProfileName = null;
let portProxyingEditor = null;
let portExcludeEditor = null;
let ipExcludeEditor = null;
let jsonModalEditor = null;
let jsonModalCurrentTarget = null; // 'inbounds' или 'outbounds'



// Global capability flags reported by backend
let HAS_WS = false;

// Initialize capabilities (WebSocket support, etc.)
async function initCapabilities() {
  try {
    const resp = await fetch('/api/capabilities', { cache: 'no-store' });
    if (!resp.ok) throw new Error('http ' + resp.status);
    const data = await resp.json().catch(() => ({}));
    HAS_WS = !!data.websocket;
  } catch (e) {
    // On error we assume WS is not available and fall back to HTTP polling.
    HAS_WS = false;
  }

  // Apply capability-dependent UI (e.g., hide PTY button if WS is unavailable)
  try { terminalApplyWsCapabilityUi(); } catch (e) {}

}

// Apply capability-dependent UI (e.g., hide PTY button if WS is not supported)
function terminalApplyWsCapabilityUi() {
  // Button in "Команды" header that opens Interactive PTY shell
  const ptyBtn = document.getElementById('terminal-open-pty-btn');
  if (ptyBtn) {
    if (HAS_WS) {
      ptyBtn.style.display = '';
      ptyBtn.disabled = false;
    } else {
      // Hide to avoid confusing users on devices without gevent-websocket
      ptyBtn.style.display = 'none';
    }
  }
}

// Terminal retry controls (reserved for future auto-reconnect/backoff logic)
let terminalRetryTimer = null;
let terminalRetryIsActive = false;

function terminalStopRetry() {
  // Stops any pending auto-retry timer (if such logic is enabled).
  const hadActive = !!terminalRetryTimer || !!terminalRetryIsActive;

  terminalRetryIsActive = false;
  if (terminalRetryTimer) {
    try { clearTimeout(terminalRetryTimer); } catch (e) {}
    terminalRetryTimer = null;
  }

  // Keep the button visible; just inform the user.
  try {
    if (typeof showToast === 'function') {
      showToast(hadActive ? 'Retry stopped' : 'No retry in progress', 'info');
    }
  } catch (e) {}
}




let currentCommandFlag = null;
let currentCommandLabel = null;
let currentCommandMode = 'shell'; // 'shell' | 'xkeen' | 'pty'

let ptyWs = null;
let ptyDisposables = [];
let ptyPrevConvertEol = null;


// PTY reconnect state (per-tab via sessionStorage)
const XKEEN_PTY_SESSION_KEY = 'xkeen_pty_session_id_v1';
const XKEEN_PTY_LASTSEQ_KEY = 'xkeen_pty_last_seq_v1';
let ptySessionId = null;
let ptyLastSeq = 0;

function ptyLoadSessionState() {
  try {
    const sid = sessionStorage.getItem(XKEEN_PTY_SESSION_KEY);
    if (sid) ptySessionId = String(sid);
  } catch (e) {}
  try {
    const ls = sessionStorage.getItem(XKEEN_PTY_LASTSEQ_KEY);
    if (ls) ptyLastSeq = Math.max(0, parseInt(ls, 10) || 0);
  } catch (e) {}
}

function ptySaveSessionState() {
  try { if (ptySessionId) sessionStorage.setItem(XKEEN_PTY_SESSION_KEY, String(ptySessionId)); } catch (e) {}
  try { sessionStorage.setItem(XKEEN_PTY_LASTSEQ_KEY, String(ptyLastSeq || 0)); } catch (e) {}
}

function ptyClearSessionState() {
  ptySessionId = null;
  ptyLastSeq = 0;
  try { sessionStorage.removeItem(XKEEN_PTY_SESSION_KEY); } catch (e) {}
  try { sessionStorage.removeItem(XKEEN_PTY_LASTSEQ_KEY); } catch (e) {}
}

// Load on startup
ptyLoadSessionState();

let xkeenTerm = null;
let xkeenTermFitAddon = null;
let xkeenTermResizeObserver = null;

// XTerm addons (loaded from static/xterm)
let xkeenTermSearchAddon = null;
let xkeenTermSearchResultsDisposable = null;
let xkeenTermWebLinksAddon = null;

// Terminal search UI state
let xkeenTerminalSearchTerm = '';
let xkeenTerminalSearchResultIndex = -1;
let xkeenTerminalSearchResultCount = 0;
let xkeenTerminalSearchDebounce = null;
let xkeenTerminalSearchKeysBound = false;

const XKEEN_TERM_SEARCH_DECORATIONS = {
  matchBackground: 'rgba(255, 255, 0, 0.20)',
  matchBorder: 'rgba(255, 255, 255, 0.30)',
  matchOverviewRuler: 'rgba(255, 255, 0, 0.65)',
  activeMatchBackground: 'rgba(255, 165, 0, 0.28)',
  activeMatchBorder: 'rgba(255, 255, 255, 0.60)',
  activeMatchColorOverviewRuler: 'rgba(255, 165, 0, 0.95)',
};

// ---------------- Terminal output filters (ANSI + log highlighting) ----------------
const XKEEN_TERM_PREF_ANSI_FILTER_KEY = 'xkeen_term_ansi_filter_v1';
const XKEEN_TERM_PREF_LOG_HL_KEY = 'xkeen_term_log_hl_v1';

// If true: incoming output is stripped from ANSI escape sequences before rendering
let xkeenTerminalAnsiFilter = false;

// If true: highlight WARN/ERR words in output (works best with ANSI filter ON)
let xkeenTerminalLogHighlight = true;

function terminalLoadOutputPrefs() {
  try {
    const rawA = localStorage.getItem(XKEEN_TERM_PREF_ANSI_FILTER_KEY);
    if (rawA != null) xkeenTerminalAnsiFilter = (rawA === '1' || rawA === 'true');
  } catch (e) {}
  try {
    const rawH = localStorage.getItem(XKEEN_TERM_PREF_LOG_HL_KEY);
    if (rawH != null) xkeenTerminalLogHighlight = !(rawH === '0' || rawH === 'false');
  } catch (e) {}
}

function terminalSaveOutputPrefs() {
  try { localStorage.setItem(XKEEN_TERM_PREF_ANSI_FILTER_KEY, xkeenTerminalAnsiFilter ? '1' : '0'); } catch (e) {}
  try { localStorage.setItem(XKEEN_TERM_PREF_LOG_HL_KEY, xkeenTerminalLogHighlight ? '1' : '0'); } catch (e) {}
}

function terminalApplyOutputPrefUi() {
  const btnAnsi = document.getElementById('terminal-btn-ansi');
  const btnHl = document.getElementById('terminal-btn-loghl');

  if (btnAnsi) {
    btnAnsi.classList.toggle('is-active', !!xkeenTerminalAnsiFilter);
    btnAnsi.title = xkeenTerminalAnsiFilter ? 'ANSI filter: ON (strip ANSI from incoming output)' : 'ANSI filter: OFF (pass-through)';
  }
  if (btnHl) {
    btnHl.classList.toggle('is-active', !!xkeenTerminalLogHighlight);
    btnHl.title = xkeenTerminalLogHighlight ? 'Highlight WARN/ERR: ON' : 'Highlight WARN/ERR: OFF';
  }
}

function terminalToggleAnsiFilter() {
  xkeenTerminalAnsiFilter = !xkeenTerminalAnsiFilter;
  terminalSaveOutputPrefs();
  terminalApplyOutputPrefUi();
  try { if (typeof showToast === 'function') showToast(xkeenTerminalAnsiFilter ? 'ANSI filter: ON' : 'ANSI filter: OFF', 'info'); } catch (e) {}
}

function terminalToggleLogHighlight() {
  xkeenTerminalLogHighlight = !xkeenTerminalLogHighlight;
  terminalSaveOutputPrefs();
  terminalApplyOutputPrefUi();
  try { if (typeof showToast === 'function') showToast(xkeenTerminalLogHighlight ? 'Highlight WARN/ERR: ON' : 'Highlight WARN/ERR: OFF', 'info'); } catch (e) {}
}

// Basic ANSI stripper (CSI + OSC). For log usage it's usually enough.
function terminalStripAnsi(text) {
  if (!text) return '';
  const s = String(text);
  // OSC (ESC ] ... BEL or ESC \\)
  const noOsc = s.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
  // CSI (ESC [ ... final)
  return noOsc.replace(/\x1b\[[0-9;?]*[@-~]/g, '');
}

function terminalHighlightWarnErr(text) {
  if (!text) return '';
  const s = String(text);
  const RESET = '\x1b[0m';
  const YELLOW = '\x1b[33;1m';
  const RED = '\x1b[31;1m';

  // Keep it conservative: highlight standalone level tokens.
  return s
    .replace(/\b(WARN(?:ING)?)\b/g, `${YELLOW}$1${RESET}`)
    .replace(/\b(ERR|ERROR|FATAL|CRIT(?:ICAL)?)\b/g, `${RED}$1${RESET}`);
}

function terminalProcessOutputChunk(chunk) {
  let out = String(chunk || '');
  if (!out) return out;

  if (xkeenTerminalAnsiFilter) {
    out = terminalStripAnsi(out);
  }
  if (xkeenTerminalLogHighlight) {
    out = terminalHighlightWarnErr(out);
  }
  return out;
}

// Load persisted output prefs on startup
terminalLoadOutputPrefs();

let terminalHistory = [];
let terminalHistoryIndex = -1;
const TERMINAL_HISTORY_LIMIT = 50;

// Terminal chrome state
let xkeenTerminalIsFullscreen = false;
let xkeenTerminalGeomBeforeFullscreen = null;

// Keep a flag so toolbar buttons can know whether PTY is active
function isPtyActive() {
  return currentCommandMode === 'pty' && !!xkeenTerm;
}

// ---------------- Terminal connection status lamp + uptime ----------------
let terminalConnState = 'disconnected'; // connected|connecting|disconnected|error
let terminalUptimeStartMs = null;
let terminalUptimeTimer = null;

function terminalFormatUptime(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

function terminalUpdateUptimeUi() {
  const el = document.getElementById('terminal-uptime');
  if (!el) return;
  if (!terminalUptimeStartMs) {
    el.textContent = '00:00';
    return;
  }
  const ms = Date.now() - terminalUptimeStartMs;
  el.textContent = terminalFormatUptime(ms);
}

function terminalStopUptimeTimer() {
  if (terminalUptimeTimer) {
    try { clearInterval(terminalUptimeTimer); } catch (e) {}
    terminalUptimeTimer = null;
  }
  terminalUptimeStartMs = null;
  terminalUpdateUptimeUi();
}

function terminalStartUptimeTimer() {
  terminalUptimeStartMs = Date.now();
  terminalUpdateUptimeUi();
  if (terminalUptimeTimer) {
    try { clearInterval(terminalUptimeTimer); } catch (e) {}
  }
  terminalUptimeTimer = setInterval(terminalUpdateUptimeUi, 1000);
}

function terminalSetConnState(state, detail) {
  terminalConnState = state || 'error';

  // New lamp (preferred): uses same visuals as xkeen service lamp.
  const lamp = document.getElementById('terminal-conn-lamp');
  if (lamp) {
    const map = {
      connected: 'running',
      connecting: 'pending',
      disconnected: 'stopped',
      error: 'error',
    };
    const mapped = map[terminalConnState] || 'error';
    lamp.setAttribute('data-state', mapped);
    lamp.title = detail || ('Terminal: ' + terminalConnState);
  }

  // Backward compatibility: old badge if still present.
  const badge = document.getElementById('terminal-conn-badge');
  if (badge) {
    badge.setAttribute('data-state', terminalConnState);
    badge.textContent = (terminalConnState === 'connected') ? 'Connected'
                    : (terminalConnState === 'connecting') ? 'Connecting'
                    : (terminalConnState === 'disconnected') ? 'Disconnected'
                    : 'Error';
  }

  // Uptime: only for connected state
  if (terminalConnState === 'connected') {
    if (!terminalUptimeStartMs) terminalStartUptimeTimer();
  } else {
    terminalStopUptimeTimer();
  }
}

function loadTerminalHistory() {
  try {
    if (!window.localStorage) return;
    const raw = localStorage.getItem('xkeen_terminal_history');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      terminalHistory = parsed.slice(-TERMINAL_HISTORY_LIMIT);
      terminalHistoryIndex = terminalHistory.length;
    }
  } catch (e) {
    // ignore
  }
}

function saveTerminalHistory() {
  try {
    if (!window.localStorage) return;
    const data = terminalHistory.slice(-TERMINAL_HISTORY_LIMIT);
    localStorage.setItem('xkeen_terminal_history', JSON.stringify(data));
  } catch (e) {
    // ignore
  }
}

function pushTerminalHistory(cmd) {
  const text = (cmd || '').trim();
  if (!text) return;
  if (terminalHistory.length && terminalHistory[terminalHistory.length - 1] === text) {
    terminalHistoryIndex = terminalHistory.length;
    return;
  }
  terminalHistory.push(text);
  if (terminalHistory.length > TERMINAL_HISTORY_LIMIT) {
    terminalHistory = terminalHistory.slice(-TERMINAL_HISTORY_LIMIT);
  }
  terminalHistoryIndex = terminalHistory.length;
  saveTerminalHistory();
}

/**
 * Инициализация XTerm.js для мини-терминала XKeen.
 * Если xterm.js не загружен, возвращает null и код переходит в режим <pre>.
 */
function initXkeenTerm() {
  if (typeof Terminal === 'undefined') {
    // xterm.js не загрузился (например, нет доступа к CDN) — работаем через обычный <pre>.
    return null;
  }

  const outputEl = document.getElementById('terminal-output');
  if (!outputEl) {
    return null;
  }

  if (!xkeenTerm) {
    try {
      xkeenTerm = new Terminal({
        convertEol: true,
        cursorBlink: false,
        scrollback: 2000,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12,
      });

      if (typeof FitAddon !== 'undefined' && FitAddon && typeof FitAddon.FitAddon === 'function') {
        xkeenTermFitAddon = new FitAddon.FitAddon();
        xkeenTerm.loadAddon(xkeenTermFitAddon);
      }

      // XTerm Search addon: highlight all matches + stable next/prev
      if (typeof SearchAddon !== 'undefined' && SearchAddon && typeof SearchAddon.SearchAddon === 'function') {
        try {
          xkeenTermSearchAddon = new SearchAddon.SearchAddon({ highlightLimit: 2000 });
          xkeenTerm.loadAddon(xkeenTermSearchAddon);
          try { if (xkeenTermSearchResultsDisposable && xkeenTermSearchResultsDisposable.dispose) xkeenTermSearchResultsDisposable.dispose(); } catch (e) {}
          try {
            xkeenTermSearchResultsDisposable = xkeenTermSearchAddon.onDidChangeResults((ev) => {
              xkeenTerminalSearchResultIndex = (ev && typeof ev.resultIndex === 'number') ? ev.resultIndex : -1;
              xkeenTerminalSearchResultCount = (ev && typeof ev.resultCount === 'number') ? ev.resultCount : 0;
              try { terminalSearchUpdateCounter(); } catch (e) {}
            });
          } catch (e) {
            xkeenTermSearchResultsDisposable = null;
          }
        } catch (e) {
          xkeenTermSearchAddon = null;
          xkeenTermSearchResultsDisposable = null;
        }
      }

      // XTerm WebLinks addon: clickable URLs
      if (typeof WebLinksAddon !== 'undefined' && WebLinksAddon && typeof WebLinksAddon.WebLinksAddon === 'function') {
        try {
          xkeenTermWebLinksAddon = new WebLinksAddon.WebLinksAddon((event, uri) => {
            try {
              const w = window.open(uri, '_blank', 'noopener,noreferrer');
              if (w) {
                try { w.opener = null; } catch (e) {}
              }
            } catch (e) {
              // ignore
            }
          }, {});
          xkeenTerm.loadAddon(xkeenTermWebLinksAddon);
        } catch (e) {
          xkeenTermWebLinksAddon = null;
        }
      }

      xkeenTerm.open(outputEl);

      // Apply toolbar state (ANSI filter + log highlight)
      try { terminalApplyOutputPrefUi(); } catch (e) {}

      if (xkeenTermFitAddon && typeof xkeenTermFitAddon.fit === 'function') {
        xkeenTermFitAddon.fit();
      }

      if (typeof ResizeObserver !== 'undefined') {
        xkeenTermResizeObserver = new ResizeObserver(() => {
          if (xkeenTermFitAddon && typeof xkeenTermFitAddon.fit === 'function') {
            xkeenTermFitAddon.fit();
          }
        });
        xkeenTermResizeObserver.observe(outputEl);
      }

      xkeenTerm.writeln('XKeen терминал готов.');
    } catch (e) {
      console.error('Не удалось инициализировать xterm.js', e);
      xkeenTerm = null;
      xkeenTermFitAddon = null;
      xkeenTermResizeObserver = null;
      xkeenTermSearchAddon = null;
      xkeenTermSearchResultsDisposable = null;
      xkeenTermWebLinksAddon = null;
      return null;
    }
  } else if (xkeenTerm && typeof xkeenTerm.clear === 'function') {
    xkeenTerm.clear();
    xkeenTerm.writeln('XKeen терминал готов.');
    try { terminalApplyOutputPrefUi(); } catch (e) {}
  }

  return xkeenTerm;
}

/**
 * Безопасная запись текста в терминал XKeen (без переноса строк).
 */
function xkeenTermWrite(text) {
  if (!xkeenTerm) return;
  const t = String(text || '');
  if (!t) return;
  const out = terminalProcessOutputChunk(t);
  // xterm ожидает \r\n для переноса строки
  xkeenTerm.write(out.replace(/\n/g, '\r\n'));
}

/**
 * Запись строки с переносом.
 */
function xkeenTermWriteln(text) {
  if (!xkeenTerm) return;
  const t = String(text || '');
  const out = terminalProcessOutputChunk(t);
  xkeenTerm.write(out.replace(/\n/g, '\r\n') + '\r\n');
}

// ---------------- Terminal search (xterm-addon-search) ----------------
function terminalSearchGetEls() {
  const row = document.getElementById('terminal-search-row');
  const input = document.getElementById('terminal-search-input');
  const counter = document.getElementById('terminal-search-counter');
  return { row, input, counter };
}

function terminalIsOpen() {
  const overlay = document.getElementById('terminal-overlay');
  if (!overlay) return false;
  return overlay.style.display !== 'none' && overlay.style.display !== '';
}

function terminalSearchUpdateCounter() {
  const { counter } = terminalSearchGetEls();
  if (!counter) return;
  const total = Number(xkeenTerminalSearchResultCount || 0);
  const idx0 = Number(xkeenTerminalSearchResultIndex || -1);
  const cur = (total > 0 && idx0 >= 0) ? Math.min(total, idx0 + 1) : 0;
  counter.textContent = `${cur}/${total}`;
}

function terminalSearchClear(opts = {}) {
  const silent = !!opts.silent;
  xkeenTerminalSearchTerm = '';
  xkeenTerminalSearchResultIndex = -1;
  xkeenTerminalSearchResultCount = 0;
  try {
    const { input } = terminalSearchGetEls();
    if (input) input.value = '';
  } catch (e) {}

  try {
    if (xkeenTerm && typeof xkeenTerm.clearSelection === 'function') xkeenTerm.clearSelection();
  } catch (e) {}

  try {
    if (xkeenTermSearchAddon && typeof xkeenTermSearchAddon.clearDecorations === 'function') {
      xkeenTermSearchAddon.clearDecorations();
    }
  } catch (e) {}

  try { terminalSearchUpdateCounter(); } catch (e) {}
  if (!silent) {
    try { showToast('Поиск очищен', 'info'); } catch (e) {}
  }
}

function terminalSearchRun(direction) {
  const { input } = terminalSearchGetEls();
  const term = input ? String(input.value || '').trim() : String(xkeenTerminalSearchTerm || '').trim();
  xkeenTerminalSearchTerm = term;

  if (!term) {
    terminalSearchClear({ silent: true });
    return;
  }

  if (!xkeenTerm || !xkeenTermSearchAddon) {
    try { showToast('Поиск недоступен: xterm-addon-search не загружен', 'error'); } catch (e) {}
    return;
  }

  const opts = {
    caseSensitive: false,
    regex: false,
    wholeWord: false,
    decorations: XKEEN_TERM_SEARCH_DECORATIONS,
  };

  let ok = false;
  try {
    if (direction === 'prev') ok = xkeenTermSearchAddon.findPrevious(term, opts);
    else ok = xkeenTermSearchAddon.findNext(term, opts);
  } catch (e) {
    ok = false;
  }

  if (!ok) {
    // counter will likely be 0/0; keep it consistent
    xkeenTerminalSearchResultIndex = -1;
    xkeenTerminalSearchResultCount = 0;
    try { terminalSearchUpdateCounter(); } catch (e) {}
    try { showToast('Совпадений не найдено', 'info'); } catch (e) {}
  }

  try { if (xkeenTerm && typeof xkeenTerm.focus === 'function') xkeenTerm.focus(); } catch (e) {}
}

function terminalSearchNext() {
  terminalSearchRun('next');
}

function terminalSearchPrev() {
  terminalSearchRun('prev');
}

function terminalSearchFocus(selectAll = true) {
  const { input } = terminalSearchGetEls();
  if (!input) return;
  try {
    input.focus();
    if (selectAll) input.select();
  } catch (e) {}
}

function terminalSearchDebouncedHighlight() {
  const { input } = terminalSearchGetEls();
  if (!input) return;
  const term = String(input.value || '').trim();
  xkeenTerminalSearchTerm = term;

  if (xkeenTerminalSearchDebounce) {
    try { clearTimeout(xkeenTerminalSearchDebounce); } catch (e) {}
    xkeenTerminalSearchDebounce = null;
  }

  if (!term) {
    terminalSearchClear({ silent: true });
    return;
  }

  // Debounce to avoid heavy scanning on each keystroke
  xkeenTerminalSearchDebounce = setTimeout(() => {
    if (!xkeenTerm || !xkeenTermSearchAddon) return;
    try {
      // noScroll: keep viewport stable while typing
      xkeenTermSearchAddon.findNext(term, {
        caseSensitive: false,
        regex: false,
        wholeWord: false,
        noScroll: true,
        decorations: XKEEN_TERM_SEARCH_DECORATIONS,
      });
    } catch (e) {}
  }, 150);
}

// ---------------- Terminal toolbar helpers (PTY + clipboard + fullscreen) ----------------
function xkeenGetTerminalWindowEl() {
  const overlay = document.getElementById('terminal-overlay');
  return overlay ? overlay.querySelector('.terminal-window') : null;
}

function terminalUpdateFullscreenBtn() {
  const btn = document.getElementById('terminal-btn-fullscreen');
  if (!btn) return;
  if (xkeenTerminalIsFullscreen) {
    btn.textContent = '🗗';
    btn.title = 'Restore';
    btn.setAttribute('aria-label', 'Restore');
  } else {
    btn.textContent = '⛶';
    btn.title = 'Fullscreen';
    btn.setAttribute('aria-label', 'Fullscreen');
  }
}

function terminalSetFullscreen(on) {
  const win = xkeenGetTerminalWindowEl();
  if (!win) return;

  if (on && !xkeenTerminalIsFullscreen) {
    // remember geometry before fullscreen
    try {
      const r = win.getBoundingClientRect();
      xkeenTerminalGeomBeforeFullscreen = { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
    } catch (e) {
      xkeenTerminalGeomBeforeFullscreen = null;
    }

    xkeenTerminalIsFullscreen = true;
    win.classList.add('is-fullscreen');
    // ensure fixed positioning (CSS sets left/top/width/height)
    try {
      win.style.position = 'fixed';
    } catch (e) {}

    terminalUpdateFullscreenBtn();
    try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
    return;
  }

  if (!on && xkeenTerminalIsFullscreen) {
    xkeenTerminalIsFullscreen = false;
    win.classList.remove('is-fullscreen');

    // restore previous geometry (best-effort)
    try {
      if (xkeenTerminalGeomBeforeFullscreen) {
        xkeenApplyTerminalGeom(xkeenTerminalGeomBeforeFullscreen);
        xkeenScheduleTerminalSave();
      }
    } catch (e) {}

    terminalUpdateFullscreenBtn();
    try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
  }
}

function terminalToggleFullscreen() {
  terminalSetFullscreen(!xkeenTerminalIsFullscreen);
}

// Font size & cursor blink controls (used by toolbar buttons in panel.html)
function terminalFontInc() {
  if (!xkeenTerm) return;
  let cur = 12;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? (xkeenTerm.getOption('fontSize') || 12)
      : ((xkeenTerm.options && xkeenTerm.options.fontSize) || 12);
  } catch (e) {}
  const next = Math.min(32, cur + 1);
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('fontSize', next);
    else if (xkeenTerm.options) xkeenTerm.options.fontSize = next;
  } catch (e) {}
  try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
}

function terminalFontDec() {
  if (!xkeenTerm) return;
  let cur = 12;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? (xkeenTerm.getOption('fontSize') || 12)
      : ((xkeenTerm.options && xkeenTerm.options.fontSize) || 12);
  } catch (e) {}
  const next = Math.max(8, cur - 1);
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('fontSize', next);
    else if (xkeenTerm.options) xkeenTerm.options.fontSize = next;
  } catch (e) {}
  try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
}

function terminalToggleCursorBlink() {
  if (!xkeenTerm) return;
  let cur = false;
  try {
    cur = (typeof xkeenTerm.getOption === 'function')
      ? !!xkeenTerm.getOption('cursorBlink')
      : !!(xkeenTerm.options && xkeenTerm.options.cursorBlink);
  } catch (e) {}
  const next = !cur;
  try {
    if (typeof xkeenTerm.setOption === 'function') xkeenTerm.setOption('cursorBlink', next);
    else if (xkeenTerm.options) xkeenTerm.options.cursorBlink = next;
  } catch (e) {}
}


function xkeenPtyDisconnect(opts = {}) {
  const sendClose = (opts.sendClose !== false);
  if (sendClose) {
    // Explicit close: terminate remote PTY session and forget session_id
    try { ptyClearSessionState(); } catch (e) {}
  }
  if (ptyWs) {
    try { if (sendClose) ptyWs.send(JSON.stringify({ type: 'close' })); } catch (e) {}
    try { ptyWs.close(); } catch (e) {}
    ptyWs = null;
  }
  try { ptyDisposables.forEach(d => d && d.dispose && d.dispose()); } catch (e) {}
  ptyDisposables = [];
}

async function xkeenPtyConnect(term, opts = {}) {
  if (!term) return;
  const preserveScreen = !!opts.preserveScreen;

  // reset old connection/listeners
  xkeenPtyDisconnect({ sendClose: false });

  if (!preserveScreen) {
    try { if (typeof term.clear === 'function') term.clear(); } catch (e) {}
  }
  xkeenTermWriteln('[PTY] Подключение...');
  try { terminalSetConnState('connecting', 'PTY: подключение...'); } catch (e) {}

  // token
  let token = '';
  try {
    const r = await fetch('/api/ws-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const j = await r.json();
    if (!r.ok || !j || !j.ok) {
      throw new Error((j && j.error) ? j.error : ('HTTP ' + r.status));
    }
    token = j.token || '';
  } catch (e) {
    xkeenTermWriteln('[PTY] Ошибка получения токена: ' + (e && e.message ? e.message : String(e)));
    try { terminalSetConnState('error', 'PTY: ошибка токена'); } catch (e2) {}
    return;
  }

const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';

// session_id + last_seq enable true reconnect to the same PTY (server keeps PTY by session_id)
const qs = new URLSearchParams();
qs.set('token', token);
try {
  // Always send current terminal size so server can set PTY winsize early
  qs.set('cols', String(term && term.cols ? term.cols : 0));
  qs.set('rows', String(term && term.rows ? term.rows : 0));
} catch (e) {}

// If we already have a session_id (same tab) — ask server to reattach to it
if (ptySessionId) qs.set('session_id', String(ptySessionId));

// If we preserve screen, request only missed output; otherwise request buffered output from the beginning (best effort)
const resumeFrom = preserveScreen ? (ptyLastSeq || 0) : 0;
qs.set('last_seq', String(resumeFrom));

const url = `${proto}//${location.host}/ws/pty?${qs.toString()}`;

  try {
    ptyWs = new WebSocket(url);
  } catch (e) {
    ptyWs = null;
    xkeenTermWriteln('[PTY] WebSocket недоступен: ' + (e && e.message ? e.message : String(e)));
    try { terminalSetConnState('error', 'PTY: WebSocket недоступен'); } catch (e2) {}
    return;
  }

  const sendResize = () => {
    try {
      if (!ptyWs || ptyWs.readyState !== WebSocket.OPEN) return;
      ptyWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    } catch (e) {}
  };

  ptyWs.onopen = () => {
    xkeenTermWriteln('[PTY] Соединение установлено.');
    try { terminalSetConnState('connected', 'PTY: подключено'); } catch (e) {}
    try { if (xkeenTermFitAddon && xkeenTermFitAddon.fit) xkeenTermFitAddon.fit(); } catch (e) {}
    sendResize();
  };

  ptyWs.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (!msg) return;

    if (msg.type === 'output' && typeof msg.data === 'string') {
      // PTY output must be passed through without log/ANSI post-processing by default
      term.write(msg.data);
      // track last seen sequence number (for lossless reconnect)
      try {
        if (msg.seq != null) {
          const s = parseInt(msg.seq, 10);
          if (!isNaN(s) && s > (ptyLastSeq || 0)) {
            ptyLastSeq = s;
            ptySaveSessionState();
          }
        }
      } catch (e) {}
    } else if (msg.type === 'init') {
      // server returns session_id (store for reconnect)
      try {
        if (msg.session_id) {
          ptySessionId = String(msg.session_id);
          ptySaveSessionState();
        }
      } catch (e) {}
      if (msg.shell) xkeenTermWriteln('[PTY] Shell: ' + msg.shell);
      if (msg.reused) xkeenTermWriteln('[PTY] Reattached to existing session.');
    } else if (msg.type === 'exit') {
      xkeenTermWriteln('\r\n[PTY] Завершено (code=' + msg.code + ').');
      try { terminalSetConnState('disconnected', 'PTY: shell завершился'); } catch (e) {}
      // session ended server-side
      try { ptyClearSessionState(); } catch (e) {}
    } else if (msg.type === 'error') {
      xkeenTermWriteln('[PTY] Ошибка: ' + (msg.message || 'unknown'));
      try { terminalSetConnState('error', 'PTY: ошибка'); } catch (e) {}
    }
  };

  ptyWs.onclose = () => {
    xkeenTermWriteln('\r\n[PTY] Соединение закрыто.');
    try { terminalSetConnState('disconnected', 'PTY: соединение закрыто'); } catch (e) {}
  };

  // User input
  try {
    ptyDisposables.push(term.onData((data) => {
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        ptyWs.send(JSON.stringify({ type: 'input', data }));
      }
    }));
  } catch (e) {}

  // Resize events
  try {
    ptyDisposables.push(term.onResize(() => {
      sendResize();
    }));
  } catch (e) {}
}

function terminalSendRaw(data) {
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
    try { ptyWs.send(JSON.stringify({ type: 'input', data: String(data || '') })); } catch (e) {}
  }
}

function terminalSendCtrlC() { terminalSendRaw('\x03'); try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {} }
function terminalSendCtrlD() { terminalSendRaw('\x04'); try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {} }

async function terminalCopy() {
  // Prefer xterm selection; fallback to visible viewport; fallback to <pre> text.
  let text = '';
  try {
    if (xkeenTerm && typeof xkeenTerm.getSelection === 'function') {
      text = xkeenTerm.getSelection() || '';
    }
  } catch (e) {}

  if (!text && xkeenTerm && xkeenTerm.buffer && xkeenTerm.buffer.active) {
    try {
      const buf = xkeenTerm.buffer.active;
      const start = (typeof buf.viewportY === 'number') ? buf.viewportY : (typeof buf.baseY === 'number' ? buf.baseY : 0);
      const end = start + (xkeenTerm.rows || 0);
      const lines = [];
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        lines.push(line.translateToString(true));
      }
      text = lines.join('\n');
    } catch (e) {}
  }

  if (!text) {
    const pre = document.getElementById('terminal-output');
    if (pre) text = pre.innerText || pre.textContent || '';
  }

  text = String(text || '');
  if (!text.trim()) {
    try { showToast('Нечего копировать', 'info'); } catch (e) {}
    return;
  }

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      try { showToast('Скопировано в буфер', 'success'); } catch (e) {}
      return;
    }
  } catch (e) {
    // fall through
  }

  // Fallback for older browsers
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    try { showToast('Скопировано в буфер', 'success'); } catch (e) {}
  } catch (e) {
    try { showToast('Не удалось скопировать', 'error'); } catch (e2) {}
  }
}

async function terminalPaste() {
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      // PTY: paste into terminal (preferred)
      if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
        terminalSendRaw(text);
        try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e) {}
        return;
      }

      // Non-PTY fallback: paste into command/confirm inputs (useful on mobile)
      const cmdEl = document.getElementById('terminal-command');
      const inputEl = document.getElementById('terminal-input');
      const active = document.activeElement;
      const target = (active && (active === cmdEl || active === inputEl)) ? active : (cmdEl && cmdEl.style.display !== 'none' ? cmdEl : inputEl);
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        try {
          const start = target.selectionStart ?? target.value.length;
          const end = target.selectionEnd ?? target.value.length;
          const before = target.value.slice(0, start);
          const after = target.value.slice(end);
          target.value = before + text + after;
          const pos = start + text.length;
          target.selectionStart = target.selectionEnd = pos;
          target.focus();
          return;
        } catch (e) {
          // ignore
        }
      }

      // Last resort: show toast
      try { showToast('Нет активной сессии PTY — вставка в терминал недоступна', 'info'); } catch (e) {}
      return;
    }
  } catch (e) {
    // fall through
  }
  try { showToast('Вставка из буфера недоступна в этом браузере', 'info'); } catch (e) {}
}

function terminalClear() {
  // Clear screen without breaking the PTY session.
  try { if (xkeenTerm && typeof xkeenTerm.clear === 'function') xkeenTerm.clear(); } catch (e) {}
  try {
    const pre = document.getElementById('terminal-output');
    if (!xkeenTerm && pre) pre.textContent = '';
  } catch (e) {}

  // Ask the remote shell to clear too (keeps session alive).
  // "clear" is more explicit than Ctrl+L and works in busybox/ash and most shells.
  if (ptyWs && ptyWs.readyState === WebSocket.OPEN) {
    terminalSendRaw('clear\r');
  }
}

function terminalReconnect() {
  if (currentCommandMode !== 'pty') {
    openTerminal('', 'pty');
    return;
  }
  if (!xkeenTerm) return;
  xkeenTermWriteln('\r\n[PTY] Reconnect...');
  xkeenPtyConnect(xkeenTerm, { preserveScreen: true });
}

function terminalNewSession() {
  // Open a new browser tab and auto-open PTY terminal there.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('terminal', 'pty');
    window.open(url.toString(), '_blank');
  } catch (e) {
    // fallback: same tab
    openTerminal('', 'pty');
  }
}


let xrayLogTimer = null;
let xrayLogCurrentFile = 'error';
let xrayLogLastLines = [];
let xrayLogWs = null;
let xrayLogUseWebSocket = true;
let xrayLogWsEverOpened = false;
let xrayLogWsClosingManually = false;


function wsDebug(msg, extra) {
  try {
    fetch('/api/ws-debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msg: msg,
        extra: extra || {}
      }),
      keepalive: true
    });
  } catch (e) {
    // молча игнорируем ошибки отладчика
  }
}


// ---------- Global XKeen overlay spinner ----------
let xkeenSpinnerDepth = 0;

function showGlobalXkeenSpinner(message) {
  const overlay = document.getElementById('global-xkeen-spinner');
  if (!overlay) return;

  const textEl = document.getElementById('global-xkeen-spinner-text');
  if (textEl && message) {
    textEl.textContent = message;
  }

  xkeenSpinnerDepth += 1;
  overlay.classList.add('is-active');
}

function hideGlobalXkeenSpinner() {
  const overlay = document.getElementById('global-xkeen-spinner');
  if (!overlay) return;

  xkeenSpinnerDepth = Math.max(0, xkeenSpinnerDepth - 1);
  if (xkeenSpinnerDepth === 0) {
    overlay.classList.remove('is-active');
  }
}

// Hook fetch to show spinner for XKeen start/restart related actions
(function () {
  const origFetch = window.fetch;
  if (!origFetch) {
    return;
  }

  function parseUrl(url) {
    try {
      return new URL(url, window.location.origin);
    } catch (e) {
      return null;
    }
  }

  function bodyHasRestartFlag(body) {
    if (!body) return false;
    try {
      if (typeof body === 'string') {
        const parsed = JSON.parse(body);
        return !!parsed.restart;
      }
    } catch (e) {
      // ignore
    }
    return false;
  }

  function shouldShowSpinner(url, init) {
    if (!url) return null;

    const method = (init && init.method ? String(init.method).toUpperCase() : 'GET');
    const loc = parseUrl(url);
    const path = loc ? loc.pathname : url;
    const searchParams = loc ? loc.searchParams : null;
    const body = init && init.body;

    // Explicit start / restart endpoints
    if (path === '/api/xkeen/start' && method === 'POST') {
      return { message: 'Запуск xkeen...' };
    }
    if ((path === '/api/restart' || path === '/api/restart-xkeen') && method === 'POST') {
      return { message: 'Перезапуск xkeen...' };
    }

    // Routing save with optional restart arg (?restart=1/0/true/false)
    if (path === '/api/routing' && method === 'POST') {
      let restart = true;
      if (searchParams && searchParams.has('restart')) {
        const v = String(searchParams.get('restart') || '').trim().toLowerCase();
        restart = ['1', 'true', 'yes', 'on', 'y'].includes(v);
      }
      if (restart) {
        return { message: 'Применение routing и перезапуск xkeen...' };
      }
      return null;
    }

    // Mihomo config / inbounds / outbounds with JSON body { ..., restart: true }
    if (
      (path === '/api/mihomo-config' ||
       path === '/api/inbounds' ||
       path === '/api/outbounds') &&
      method === 'POST'
    ) {
      if (bodyHasRestartFlag(body)) {
        return { message: 'Применение настроек и перезапуск xkeen...' };
      }
      return null;
    }

    // Generator apply endpoint
    if (path === '/api/mihomo/generate_apply' && method === 'POST') {
      return { message: 'Применение профиля и перезапуск xkeen...' };
    }

    return null;
  }


  function handleXkeenRestartFromResponse(url, response) {
    if (!response || !response.headers || typeof response.clone !== 'function') return;

    const ct = response.headers.get && response.headers.get('Content-Type')
      ? String(response.headers.get('Content-Type') || '')
      : '';
    if (!ct || ct.indexOf('application/json') === -1) {
      return;
    }

    try {
      response.clone().json().then(function (data) {
        if (!data || !data.restarted) return;

        let msg = 'xkeen restarted.';
        if (typeof url === 'string' && url) {
          if (url.indexOf('/api/routing') !== -1) {
            msg = 'Routing saved. xkeen restarted.';
          } else if (url.indexOf('/api/xkeen/port-proxying') !== -1) {
            msg = 'port_proxying.lst saved. xkeen restarted.';
          } else if (url.indexOf('/api/xkeen/port-exclude') !== -1) {
            msg = 'port_exclude.lst saved. xkeen restarted.';
          } else if (url.indexOf('/api/xkeen/ip-exclude') !== -1) {
            msg = 'ip_exclude.lst saved. xkeen restarted.';
          } else if (url.indexOf('/api/mihomo-config') !== -1) {
            msg = 'config.yaml saved. xkeen restarted.';
          }
        }

        if (typeof showToast === 'function') {
          showToast(msg, false);
        }
      }).catch(function () {
        // ignore JSON parse errors
      });
    } catch (e) {
      // ignore runtime errors
    }
  }

  window.fetch = function (input, init) {
    const url = (typeof input === 'string')
      ? input
      : (input && input.url ? input.url : '');

    const spinnerConfig = shouldShowSpinner(url, init);

    if (!spinnerConfig) {
      return origFetch(input, init).then(function (res) {
        try {
          handleXkeenRestartFromResponse(url, res);
        } catch (e) {
          // ignore handler errors
        }
        return res;
      });
    }

    showGlobalXkeenSpinner(spinnerConfig.message);

    return origFetch(input, init)
      .then(function (res) {
        hideGlobalXkeenSpinner();
        try {
          handleXkeenRestartFromResponse(url, res);
        } catch (e) {
          // ignore handler errors
        }
        return res;
      })
      .catch(function (err) {
        hideGlobalXkeenSpinner();
        throw err;
      });
  };
})();


function openRoutingHelp() {
  try {
    window.location.href = '/static/routing-comments-help.html';
  } catch (e) {
    window.location.href = '/static/routing-comments-help.html';
  }
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getXrayLogLineClass(line) {
  const lower = (line || '').toLowerCase();

  if (
    lower.includes('error') ||
    lower.includes('fail') ||
    lower.includes('failed') ||
    lower.includes('fatal')
  ) {
    return 'log-line log-line-error';
  }

  if (lower.includes('warning') || lower.includes('warn')) {
    return 'log-line log-line-warning';
  }

  if (lower.includes('info')) {
    return 'log-line log-line-info';
  }

  return 'log-line';
}

function parseXrayLogLine(line) {
  if (!line || !line.trim()) {
    return '';
  }

  const cls = getXrayLogLineClass(line);
  let processed = escapeHtml(line);

  // Подсветка типичных уровней для Xray
  processed = processed
    .replace(/\[Info\]/g, '<span style="color:#3b82f6;">[Info]</span>')
    .replace(/\[Warning\]/g, '<span style="color:#f59e0b;">[Warning]</span>')
    .replace(/\[Error\]/g, '<span style="color:#ef4444;">[Error]</span>')
    .replace(/level=(info)/gi, 'level=<span style="color:#3b82f6;">$1</span>')
    .replace(/level=(warning)/gi, 'level=<span style="color:#f59e0b;">$1</span>')
    .replace(/level=(error)/gi, 'level=<span style="color:#ef4444;">$1</span>');

  // --- Направления/маршруты (в скобках) ---
  // Используем более широкие паттерны, чтобы захватывать ->, >> и другие варианты стрелок.

  processed = processed
    // tproxy -> vless-reality   /   tproxy >> vless-reality   /   любые символы между
    .replace(
      /\[(?:tproxy)[^\]]*vless-reality[^\]]*\]/gi,
      '<span class="log-route log-route-tproxy-vless">$&</span>'
    )
    // redirect -> vless-reality
    .replace(
      /\[(?:redirect)[^\]]*vless-reality[^\]]*\]/gi,
      '<span class="log-route log-route-redirect-vless">$&</span>'
    )
    // redirect -> direct
    .replace(
      /\[(?:redirect)[^\]]*direct[^\]]*\]/gi,
      '<span class="log-route log-route-redirect-direct">$&</span>'
    )
    // [reject ...]
    .replace(
      /\[(?:reject)[^\]]*\]/gi,
      '<span class="log-route log-route-reject">$&</span>'
    )
    // и просто слово reject/rejected
    .replace(
      /\breject(ed)?\b/gi,
      '<span class="log-route log-route-reject">$&</span>'
    );

  // --- IP-адреса (включая порт) ---
  processed = processed.replace(
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g,
    '<span class="log-ip">$&</span>'
  );

  // --- Домены вида something.example.com ---
  // Защита от попадания внутрь уже вставленных span-ов
  processed = processed.replace(
    /(^|[^">])((?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,})/g,
    '$1<span class="log-domain">$2</span>'
  );

  return '<span class="' + cls + '">' + processed + '</span>';
}





function openTerminal(initialCommand, mode = 'shell') {
  const overlay = document.getElementById('terminal-overlay');
  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');

  currentCommandMode = mode;

  if (mode === 'xkeen') {
    const m = (initialCommand || '').match(/^xkeen\s+(.+)$/);
    currentCommandFlag = m ? m[1].trim() : null;
    currentCommandLabel = initialCommand || (currentCommandFlag ? ('xkeen ' + currentCommandFlag) : 'xkeen');
  } else {
    currentCommandFlag = null;
    currentCommandLabel = null;
  }

  if (cmdEl) {
    cmdEl.value = initialCommand || '';
    try {
      cmdEl.focus();
      cmdEl.select();
    } catch (e) {
      // ignore
    }
  }

  if (inputEl) {
    inputEl.value = '';
  }

  // Инициализируем xterm.js (если загружен); иначе останется старый <pre>-режим.
  const term = initXkeenTerm();
  if (!term && outputEl) {
    // Фоллбек: просто очищаем вывод.
    outputEl.textContent = '';
  }

  
  // PTY mode: полноценный интерактивный shell через WebSocket (/ws/pty)
  if (mode === 'pty') {
    // Скрываем поля "команда" и "подтверждение"
    if (cmdEl) cmdEl.style.display = 'none';
    const inputRow = document.querySelector('.terminal-input-row');
    if (inputRow) inputRow.style.display = 'none';

    // Требуется xterm.js
    if (!term) {
      if (outputEl) outputEl.textContent = 'xterm.js недоступен — PTY режим невозможен.';
    } else {
      // Переводим xterm в "сырое" отображение (для escape-seq)
      try {
        if (ptyPrevConvertEol === null && typeof term.getOption === 'function') {
          ptyPrevConvertEol = term.getOption('convertEol');
        }
        if (typeof term.setOption === 'function') {
          term.setOption('convertEol', false);
        }
      } catch (e) {}

	      // Connect (or reconnect) PTY using shared helper
	      terminalUpdateFullscreenBtn();
	      xkeenPtyConnect(term, { preserveScreen: false });
    }
  } else {
    // не PTY: показываем стандартные поля
    try { terminalSetConnState('disconnected', 'Terminal: не в PTY режиме'); } catch (e) {}
    if (cmdEl) cmdEl.style.display = '';
    const inputRow = document.querySelector('.terminal-input-row');
    if (inputRow) inputRow.style.display = '';
  }

if (overlay) {
    overlay.style.display = 'flex';
  }

  // Restore terminal window geometry (size/position)
  try {
    xkeenTerminalUiOnOpen();
  } catch (e) { /* ignore */ }

  // Если есть предварительная команда (например, клик по "Команды"),
  // покажем её в терминале как подсказку.
  if (term && initialCommand) {
    xkeenTermWriteln('$ ' + initialCommand);
  }
}

function openTerminalForFlag(flag, label) {
  if (!flag) return;
  const initial = label || ('xkeen ' + flag);
  openTerminal(initial, 'xkeen');
}

function hideTerminal() {
  const overlay = document.getElementById('terminal-overlay');
  if (overlay) overlay.style.display = 'none';

  // Clear search highlights/state
  try { terminalSearchClear({ silent: true }); } catch (e) {}

  // Exit fullscreen if it was enabled
  try { terminalSetFullscreen(false); } catch (e) {}

  // cleanup PTY session if active
  xkeenPtyDisconnect({ sendClose: true });
  try { terminalSetConnState('disconnected', 'PTY: отключено'); } catch (e) {}

  // restore xterm option
  try {
    if (xkeenTerm && ptyPrevConvertEol !== null && typeof xkeenTerm.setOption === 'function') {
      xkeenTerm.setOption('convertEol', ptyPrevConvertEol);
    }
  } catch (e) {}
  ptyPrevConvertEol = null;

  // restore inputs visibility
  const cmdEl = document.getElementById('terminal-command');
  if (cmdEl) cmdEl.style.display = '';
  const inputRow = document.querySelector('.terminal-input-row');
  if (inputRow) inputRow.style.display = '';

  currentCommandFlag = null;
  currentCommandLabel = null;
  currentCommandMode = 'shell';
}



// ---------------- Terminal window chrome (resize + drag + persist) ----------------
const XKEEN_TERMINAL_GEOM_KEY = 'xkeen_terminal_geom_v1';
let xkeenTerminalChromeInited = false;
let xkeenTerminalResizeObserver = null;
let xkeenTerminalSaveTimer = null;

let xkeenTerminalDragging = false;
let xkeenTerminalDragOffsetX = 0;
let xkeenTerminalDragOffsetY = 0;
let xkeenTerminalDragWidth = 0;
let xkeenTerminalDragHeight = 0;

function xkeenGetTerminalEls() {
  const overlay = document.getElementById('terminal-overlay');
  const win = overlay ? overlay.querySelector('.terminal-window') : null;
  const header = win ? win.querySelector('.terminal-header') : null;
  return { overlay, win, header };
}

function xkeenReadTerminalGeom() {
  try {
    const raw = localStorage.getItem(XKEEN_TERMINAL_GEOM_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;

    const w = Number(j.w);
    const h = Number(j.h);
    const x = Number(j.x);
    const y = Number(j.y);

    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 200 || h < 150) return null;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { w, h, x: null, y: null };

    return { w, h, x, y };
  } catch (e) {
    return null;
  }
}

function xkeenClampTerminalPos(x, y, w, h) {
  const pad = 8;
  const maxX = Math.max(pad, window.innerWidth - w - pad);
  const maxY = Math.max(pad, window.innerHeight - h - pad);
  const clampedX = Math.min(Math.max(pad, x), maxX);
  const clampedY = Math.min(Math.max(pad, y), maxY);
  return { x: clampedX, y: clampedY };
}

function xkeenApplyTerminalGeom(geom) {
  const { win } = xkeenGetTerminalEls();
  if (!win || !geom) return;

  // Ensure fixed positioning so we can drag freely.
  win.style.position = 'fixed';

  // Size
  if (Number.isFinite(geom.w)) win.style.width = Math.round(geom.w) + 'px';
  if (Number.isFinite(geom.h)) win.style.height = Math.round(geom.h) + 'px';

  // Position
  const w = win.getBoundingClientRect().width || geom.w || 520;
  const h = win.getBoundingClientRect().height || geom.h || 360;

  let x = geom.x;
  let y = geom.y;

  // If no saved position, center
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    x = Math.round((window.innerWidth - w) / 2);
    y = Math.round((window.innerHeight - h) / 2);
  }

  const p = xkeenClampTerminalPos(x, y, w, h);
  win.style.left = Math.round(p.x) + 'px';
  win.style.top = Math.round(p.y) + 'px';
}

function xkeenSaveTerminalGeomNow() {
  if (xkeenTerminalIsFullscreen) return;
  const { win } = xkeenGetTerminalEls();
  if (!win) return;

  const rect = win.getBoundingClientRect();
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return;

  const geom = {
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    x: Math.round(rect.left),
    y: Math.round(rect.top),
  };

  try {
    localStorage.setItem(XKEEN_TERMINAL_GEOM_KEY, JSON.stringify(geom));
  } catch (e) {
    // ignore quota / privacy mode
  }
}

function xkeenScheduleTerminalSave() {
  if (xkeenTerminalSaveTimer) {
    clearTimeout(xkeenTerminalSaveTimer);
  }
  xkeenTerminalSaveTimer = setTimeout(() => {
    xkeenTerminalSaveTimer = null;
    xkeenSaveTerminalGeomNow();
  }, 150);
}

function xkeenEnsureTerminalChrome() {
  if (xkeenTerminalChromeInited) return;
  xkeenTerminalChromeInited = true;

  const { win, header } = xkeenGetTerminalEls();
  if (!win || !header) return;

  // Drag handlers
  header.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
	    if (xkeenTerminalIsFullscreen) return;
	    if (e.target && e.target.closest && e.target.closest('.terminal-toolbar')) return;

    const rect = win.getBoundingClientRect();

    // Freeze current geometry in styles
    win.style.position = 'fixed';
    win.style.left = Math.round(rect.left) + 'px';
    win.style.top = Math.round(rect.top) + 'px';
    win.style.width = Math.round(rect.width) + 'px';
    win.style.height = Math.round(rect.height) + 'px';

    xkeenTerminalDragging = true;
    xkeenTerminalDragOffsetX = e.clientX - rect.left;
    xkeenTerminalDragOffsetY = e.clientY - rect.top;
    xkeenTerminalDragWidth = rect.width;
    xkeenTerminalDragHeight = rect.height;

    document.documentElement.style.userSelect = 'none';
    document.documentElement.style.cursor = 'move';

    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!xkeenTerminalDragging) return;

    let newX = e.clientX - xkeenTerminalDragOffsetX;
    let newY = e.clientY - xkeenTerminalDragOffsetY;

    const p = xkeenClampTerminalPos(newX, newY, xkeenTerminalDragWidth, xkeenTerminalDragHeight);
    win.style.left = Math.round(p.x) + 'px';
    win.style.top = Math.round(p.y) + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!xkeenTerminalDragging) return;
    xkeenTerminalDragging = false;
    document.documentElement.style.userSelect = '';
    document.documentElement.style.cursor = '';
    xkeenScheduleTerminalSave();
  });

  // Persist resizing
  if (typeof ResizeObserver !== 'undefined') {
    xkeenTerminalResizeObserver = new ResizeObserver(() => {
	      if (xkeenTerminalIsFullscreen) return;
      // Keep the terminal inside viewport if user shrunk the window
      try {
        const r = win.getBoundingClientRect();
        const p = xkeenClampTerminalPos(r.left, r.top, r.width, r.height);
        win.style.position = 'fixed';
        win.style.left = Math.round(p.x) + 'px';
        win.style.top = Math.round(p.y) + 'px';
      } catch (e) {}

      xkeenScheduleTerminalSave();
    });
    xkeenTerminalResizeObserver.observe(win);
  }

  // If viewport size changes (rotate / resize), keep window in bounds
  window.addEventListener('resize', () => {
	    if (xkeenTerminalIsFullscreen) return;
    const r = win.getBoundingClientRect();
    const p = xkeenClampTerminalPos(r.left, r.top, r.width, r.height);
    win.style.position = 'fixed';
    win.style.left = Math.round(p.x) + 'px';
    win.style.top = Math.round(p.y) + 'px';
    xkeenScheduleTerminalSave();
  });
}

function xkeenTerminalUiOnOpen() {
  const { overlay, win } = xkeenGetTerminalEls();
  if (!overlay || !win) return;

  // Ensure handlers attached once
  xkeenEnsureTerminalChrome();

  // Apply saved geometry after the element is visible/layouted
  requestAnimationFrame(() => {
    const saved = xkeenReadTerminalGeom();
    if (saved) {
      xkeenApplyTerminalGeom(saved);
    } else {
      // Center & persist initial geometry (so next open is stable)
      const rect = win.getBoundingClientRect();
      const x = Math.round((window.innerWidth - rect.width) / 2);
      const y = Math.round((window.innerHeight - rect.height) / 2);
      xkeenApplyTerminalGeom({ w: rect.width, h: rect.height, x, y });
      xkeenScheduleTerminalSave();
    }
  });
}
function isXkeenRestartCommand(cmdText) {
  const txt = (cmdText || '').trim();

  if (currentCommandMode === 'xkeen' && currentCommandFlag === '-restart') {
    return true;
  }

  return /^xkeen\s+-restart(\s|$)/.test(txt);
}

async function sendTerminalInput() {
  if (currentCommandMode === 'pty') {
    // В PTY режиме ввод идёт напрямую в xterm (onData)
    return;
  }

  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');

  const cmdText = cmdEl ? cmdEl.value.trim() : '';
  if (!cmdText) {
    if (typeof Terminal !== 'undefined') {
      const term = initXkeenTerm();
      if (term) {
        xkeenTermWriteln('[Ошибка] Введите команду.');
        return;
      }
    }
    if (outputEl) {
      outputEl.textContent = 'Введите команду.';
    }
    return;
  }

  // Добавляем команду в локальную историю
  pushTerminalHistory(cmdText);

  // Если запрошен специальный режим перезапуска xkeen — обрабатываем отдельно.
  if (isXkeenRestartCommand(cmdText)) {
    if (typeof Terminal !== 'undefined') {
      const term = initXkeenTerm();
      if (term) {
        xkeenTermWriteln('');
        xkeenTermWriteln('[xkeen] Выполняем перезапуск (xkeen -restart)...');
      }
    } else if (outputEl) {
      outputEl.textContent = 'Отправляем xkeen -restart...';
    }

    try {
      await controlXkeen('restart');

      let logText = '';
      try {
        const logRes = await fetch('/api/restart-log');
        const logData = await logRes.json().catch(() => ({}));
        const lines = (logData && logData.lines) || [];
        if (!lines.length) {
          logText = 'Журнал пуст.';
        } else {
          logText = lines.join('');
        }
      } catch (e) {
        console.error(e);
        logText = 'Не удалось загрузить журнал перезапуска.';
      }

      if (typeof Terminal !== 'undefined') {
        const term = initXkeenTerm();
        if (term) {
          xkeenTermWriteln('');
          xkeenTermWriteln(logText || '(нет вывода)');
        }
      } else if (outputEl) {
        const html = ansiToHtml(logText || '(нет вывода)').replace(/\n/g, '<br>');
        outputEl.innerHTML = html;
        outputEl.scrollTop = outputEl.scrollHeight;
      }

      appendToLog('[terminal] xkeen -restart\n' + (logText || '(нет вывода)') + '\n');
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка при перезапуске xkeen.';
      if (typeof Terminal !== 'undefined') {
        const term = initXkeenTerm();
        if (term) {
          xkeenTermWriteln('');
          xkeenTermWriteln('[Ошибка] ' + msg);
        }
      } else if (outputEl) {
        outputEl.textContent = msg;
      }
      appendToLog('[terminal] xkeen -restart: ' + String(e) + '\n');
    }

    return;
  }

  // Обычный режим выполнения команды
  let raw = inputEl ? inputEl.value : '';
  const stdinValue = (raw === '' ? '\n' : raw + '\n');

  let buffer = '';

  let useXterm = false;
  if (typeof Terminal !== 'undefined') {
    const term = initXkeenTerm();
    if (term) {
      useXterm = true;
      xkeenTermWriteln('');
      xkeenTermWriteln('$ ' + cmdText);
    }
  }

  if (!useXterm && outputEl) {
    outputEl.textContent = 'Выполнение команды...';
  }

  try {
    const onChunk = (chunk) => {
      buffer += chunk;
      if (useXterm && xkeenTerm) {
        xkeenTermWrite(chunk);
      } else if (outputEl) {
        const html = ansiToHtml(buffer || '(нет вывода)').replace(/\n/g, '<br>');
        outputEl.innerHTML = html;
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    };

    let runner;
    if (currentCommandMode === 'xkeen' && currentCommandFlag) {
      runner = runXkeenFlag(currentCommandFlag, stdinValue, { onChunk });
    } else {
      runner = runShellCommand(cmdText, stdinValue, { onChunk });
    }

    const { res, data } = await runner;

    if (!res.ok || !data.ok) {
      const msg = (data && data.error) ? data.error : ('HTTP ' + res.status);
      if (useXterm && xkeenTerm) {
        xkeenTermWriteln('');
        xkeenTermWriteln('[Ошибка] ' + msg);
      } else if (outputEl) {
        outputEl.textContent = 'Ошибка: ' + msg;
      }
      appendToLog('Ошибка: ' + msg + '\n');
      return;
    }

    const rawOut = data.output || buffer || '';

    if (useXterm && xkeenTerm) {
      if (!buffer && rawOut) {
        xkeenTermWrite(rawOut);
      }
      xkeenTermWriteln('');
      xkeenTermWriteln('[exit_code=' + (data.exit_code != null ? data.exit_code : 0) + ']');
    } else if (outputEl) {
      const html = ansiToHtml(rawOut || '(нет вывода)').replace(/\n/g, '<br>');
      outputEl.innerHTML = html;
      outputEl.scrollTop = outputEl.scrollHeight;
    }

    appendToLog(
      '[terminal] ' +
      (currentCommandLabel || cmdText) +
      '\n' +
      (rawOut || '(нет вывода)') +
      '\n'
    );
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка: ' + String(e && e.message ? e.message : e);
    if (useXterm && xkeenTerm) {
      xkeenTermWriteln('');
      xkeenTermWriteln('[Ошибка] ' + msg);
    } else if (outputEl) {
      outputEl.textContent = msg;
    }
    appendToLog('[terminal] ' + msg + '\n');
  }
}

function validateRoutingContent() {
  if (!routingEditor) return false;
  const text = routingEditor.getValue();
  const cleaned = stripJsonComments(text);

  if (!text.trim()) {
    setRoutingError('Файл пуст. Введи корректный JSON.', null);
    return false;
  }

  try {
    JSON.parse(cleaned);
    setRoutingError('', null);
    return true;
  } catch (e) {
    let pos = null;
    const m = /position (\d+)/.exec(e.message || '');
    if (m) pos = parseInt(m[1], 10);
    let line = null;
    if (typeof pos === 'number') {
      const upTo = cleaned.slice(0, pos);
      const lines = upTo.split(/\n/);
      line = lines.length - 1;
    }
    setRoutingError('Ошибка JSON: ' + e.message, line);
    return false;
  }
}





async function loadMihomoTemplatesList() {
  const select = document.getElementById('mihomo-template-select');
  const statusEl = document.getElementById('mihomo-status');
  if (!select) return;

  try {
    const res = await fetch('/api/mihomo-templates');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось получить список шаблонов.';
      }
      return;
    }

    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }

    const templates = data.templates || [];
    if (!templates.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Нет шаблонов';
      select.appendChild(opt);
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '— выбери шаблон —';
    select.appendChild(placeholder);

    templates.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = t.name;
      select.appendChild(opt);
    });
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки списка шаблонов.';
  }
}

async function loadSelectedMihomoTemplateToEditor() {
  const select = document.getElementById('mihomo-template-select');
  const statusEl = document.getElementById('mihomo-status');
  if (!select || !select.value) {
    if (statusEl) statusEl.textContent = 'Не выбран шаблон.';
    return;
  }

  try {
    const res = await fetch('/api/mihomo-template?name=' + encodeURIComponent(select.value));
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось загрузить шаблон.';
      }
      return;
    }

    const content = data.content || '';
    const len = (content && content.length) || 0;
    console.log('mihomo config length', len);
    if (mihomoEditor) {
      mihomoEditor.setValue(content);
      mihomoEditor.scrollTo(0, 0);
    } else {
      const ta = document.getElementById('mihomo-editor');
      if (ta) ta.value = content;
    }

    if (statusEl) statusEl.textContent = 'Шаблон загружен в редактор. Не забудьте сохранить config.yaml, если нужно применить.';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки шаблона.';
  }
}

async function saveEditorAsMihomoTemplate() {
  const statusEl = document.getElementById('mihomo-status');
  const select = document.getElementById('mihomo-template-select');

  let defaultName = '';
  if (select && select.value) {
    defaultName = select.value;
  } else {
    defaultName = 'custom.yaml';
  }

  const name = window.prompt('Имя шаблона (без пути):', defaultName);
  if (!name) return;

  const ta = document.getElementById('mihomo-editor');
  const content = mihomoEditor
    ? mihomoEditor.getValue()
    : (ta ? ta.value : '');

  try {
    const res = await fetch('/api/mihomo-template', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось сохранить шаблон.';
      }
      return;
    }

    if (statusEl) statusEl.textContent = 'Шаблон сохранён: ' + data.name;
    await loadMihomoTemplatesList();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения шаблона.';
  }
}
async function loadMihomoConfig() {
  const statusEl = document.getElementById('mihomo-status');
  if (statusEl) statusEl.textContent = 'Загрузка config.yaml...';

  try {
    const res = await fetch('/api/mihomo-config');
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось загрузить config.yaml.';
      }
      return;
    }
    updateLastActivity('loaded', 'config.yaml');

    const content = data.content || '';
    const len = (content && content.length) || 0;
    console.log('mihomo config length', len);
    if (mihomoEditor) {
      mihomoEditor.setValue(content);
      mihomoEditor.scrollTo(0, 0);
    } else {
      const ta = document.getElementById('mihomo-editor');
      if (ta) ta.value = content;
    }

    if (statusEl) statusEl.textContent = 'config.yaml загружен (' + len + ' байт).';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки config.yaml.';
  }
}

async function saveMihomoConfig() {
  const statusEl = document.getElementById('mihomo-status');
  const ta = document.getElementById('mihomo-editor');
  const content = mihomoEditor
    ? mihomoEditor.getValue()
    : (ta ? ta.value : '');

  try {
    const res = await fetch('/api/mihomo-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, restart: shouldAutoRestartAfterSave() }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Failed to save config.yaml.';
      }
      return;
    }

    if (statusEl) {
      let msg = 'config.yaml saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      statusEl.textContent = msg;
    }
    updateLastActivity('saved', 'config.yaml');
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения config.yaml.';
  }
}

async function newMihomoConfigFromTemplate() {
  const statusEl = document.getElementById('mihomo-status');

  if (statusEl) statusEl.textContent = 'Получение списка шаблонов...';

  try {
    const listRes = await fetch('/api/mihomo-templates');
    const listData = await listRes.json();
    if (!listRes.ok || !listData.ok) {
      if (statusEl) {
        statusEl.textContent = (listData && listData.error) || 'Не удалось получить список шаблонов.';
      }
      return;
    }

    const templates = Array.isArray(listData.templates) ? listData.templates : [];
    if (!templates.length) {
      if (statusEl) statusEl.textContent = 'Шаблоны не найдены.';
      return;
    }

    let chosenTemplate = null;

    if (templates.length === 1) {
      const only = templates[0];
      const confirmedSingle = window.confirm(
        'Заменить содержимое редактора шаблоном ' + (only.name || 'template') + '?'
      );
      if (!confirmedSingle) {
        if (statusEl) statusEl.textContent = 'Загрузка шаблона отменена.';
        return;
      }
      chosenTemplate = only.name;
    } else {
      const listText = templates
        .map((t, idx) => (idx + 1) + ') ' + (t.name || 'template-' + (idx + 1)))
        .join('\n');

      const input = window.prompt(
        'Выберите номер шаблона для загрузки в редактор (текущее содержимое будет ЗАМЕНЕНО):\n\n' +
        listText +
        '\n\nВведите номер шаблона:'
      );
      if (!input) {
        if (statusEl) statusEl.textContent = 'Загрузка шаблона отменена.';
        return;
      }
      const num = parseInt(input, 10);
      if (!Number.isFinite(num) || num < 1 || num > templates.length) {
        if (statusEl) statusEl.textContent = 'Некорректный номер шаблона.';
        return;
      }
      const tpl = templates[num - 1];
      const confirmReplace = window.confirm(
        'Заменить содержимое редактора шаблоном ' + (tpl.name || 'template') + '?'
      );
      if (!confirmReplace) {
        if (statusEl) statusEl.textContent = 'Загрузка шаблона отменена.';
        return;
      }
      chosenTemplate = tpl.name;
    }

    if (!chosenTemplate) {
      if (statusEl) statusEl.textContent = 'Шаблон не выбран.';
      return;
    }

    if (statusEl) statusEl.textContent = 'Загрузка шаблона...';

    const res = await fetch('/api/mihomo-template?name=' + encodeURIComponent(chosenTemplate));
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось загрузить шаблон.';
      }
      return;
    }

    const content = data.content || '';
    const len = (content && content.length) || 0;
    console.log('mihomo config template length', len);
    if (mihomoEditor) {
      mihomoEditor.setValue(content);
      mihomoEditor.scrollTo(0, 0);
    } else {
      const ta = document.getElementById('mihomo-editor');
      if (ta) ta.value = content;
    }

    if (statusEl) {
      statusEl.textContent = 'Шаблон ' + chosenTemplate + ' загружен в редактор. Не забудьте сохранить config.yaml.';
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки шаблона.';
  }
}
async function loadRouting() {
  const statusEl = document.getElementById('routing-status');
  try {
    const res = await fetch('/api/routing');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить routing.';
      return;
    }
    const text = await res.text();
    if (routingEditor) {
      routingEditor.setValue(text);
      routingEditor.scrollTo(0, 0);
    } else {
      const ta = document.getElementById('routing-editor');
      if (ta) ta.value = text;
    }
    routingSavedContent = text;
    routingIsDirty = false;
    const saveBtn = document.getElementById('routing-save-btn');
    if (saveBtn) saveBtn.classList.remove('dirty');
    if (statusEl) statusEl.textContent = 'Routing загружен.';
    updateLastActivity('loaded', 'routing');
    validateRoutingContent();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки routing.';
  }
}


async function saveRouting() {
  const statusEl = document.getElementById('routing-status');
  if (!routingEditor) return;
  const rawText = routingEditor.getValue();
  const cleaned = stripJsonComments(rawText);

  // Validate JSON (comments are allowed and stripped before parsing)
  try {
    JSON.parse(cleaned);
    setRoutingError('', null);
  } catch (e) {
    console.error(e);
    setRoutingError('Ошибка JSON: ' + e.message, null);
    if (statusEl) statusEl.textContent = 'Ошибка: некорректный JSON.';
    if (typeof showToast === 'function') {
      showToast('Ошибка: некорректный JSON.', true);
    }
    return;
  }

  const restart = shouldAutoRestartAfterSave();

  try {
    const res = await fetch('/api/routing?restart=' + (restart ? '1' : '0'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: rawText
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      routingSavedContent = rawText;
      routingIsDirty = false;
      const saveBtn = document.getElementById('routing-save-btn');
      if (saveBtn) saveBtn.classList.remove('dirty');

      let msg = 'Routing saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
      updateLastActivity('saved', 'routing');
    } else {
      const msg = 'Save error: ' + ((data && data.error) || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = msg;
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
    }
  } catch (e) {
    console.error(e);
    setRoutingError('Ошибка JSON: ' + e.message, null);
    if (statusEl) statusEl.textContent = 'Ошибка при сохранении routing.';
    if (typeof showToast === 'function') {
      showToast('Ошибка при сохранении routing.', true);
    }
  }
}


function openGithubExportModal() {
  const modal = document.getElementById('github-export-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
}

function closeGithubExportModal() {
  const modal = document.getElementById('github-export-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}


function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' toast-error' : '');
  const icon = document.createElement('div');
  icon.className = 'toast-icon';
  icon.textContent = isError ? '⚠️' : '✅';
  const text = document.createElement('div');
  text.className = 'toast-message';
  text.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(text);
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(4px)';
    setTimeout(() => {
      toast.remove();
    }, 200);
  }, 3200);
}

function updateLastActivity(kind, targetLabel) {
  const badge = document.getElementById('last-load');
  if (!badge) return;

  const now = new Date();
  const t = now.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  let text;
  if (kind === 'loaded') {
    text = 'Загружено ' + (targetLabel || '') + ' в ' + t;
  } else if (kind === 'saved') {
    text = 'Сохранено ' + (targetLabel || '') + ' в ' + t;
  } else {
    text = (targetLabel || 'Состояние') + ': ' + t;
  }

  badge.textContent = text.trim();
  badge.className = 'last-load-badge last-load-' + (kind || 'info');
}

// ---------- Local file import/export ----------

async function exportUserConfigsToFile() {
  const statusEl = document.getElementById('routing-status');
  if (statusEl) statusEl.textContent = 'Экспорт локальной конфигурации в файл...';

  try {
    const res = await fetch('/api/local/export-configs', {
      method: 'GET',
    });

    if (!res.ok) {
      const errText = 'Ошибка экспорта: ' + (res.statusText || ('HTTP ' + res.status));
      if (statusEl) statusEl.textContent = errText;
      showToast(errText, true);
      return;
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date();
    const fname = 'xkeen-config-' +
      ts.getFullYear().toString() +
      String(ts.getMonth() + 1).padStart(2, '0') +
      String(ts.getDate()).padStart(2, '0') + '-' +
      String(ts.getHours()).padStart(2, '0') +
      String(ts.getMinutes()).padStart(2, '0') +
      String(ts.getSeconds()).padStart(2, '0') +
      '.json';

    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    const okMsg = 'Конфигурация выгружена в файл ' + fname;
    if (statusEl) statusEl.textContent = okMsg;
    showToast(okMsg, false);
  } catch (e) {
    console.error(e);
    const errMsg = 'Ошибка экспорта (см. консоль браузера).';
    if (statusEl) statusEl.textContent = errMsg;
    showToast(errMsg, true);
  }
}

async function importUserConfigsFromFile(file) {
  const statusEl = document.getElementById('routing-status');
  if (statusEl) statusEl.textContent = 'Загрузка конфигурации из файла...';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/local/import-configs', {
      method: 'POST',
      body: formData,
    });
    const data = await res.json();

    if (res.ok && data && data.ok) {
      const msg = 'Конфигурация загружена из файла. Не забудьте перезапустить xkeen после проверки.';
      if (statusEl) statusEl.textContent = msg;
      showToast(msg, false);

      try {
        await loadRouting();
        await loadInboundsMode();
        await loadPortProxying();
        await loadPortExclude();
        await loadIpExclude();
      } catch (e) {
        console.error(e);
      }
    } else {
      const errMsg = 'Ошибка импорта: ' + ((data && data.error) || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = errMsg;
      showToast(errMsg, true);
    }
  } catch (e) {
    console.error(e);
    const errMsg = 'Ошибка импорта (см. консоль браузера).';
    if (statusEl) statusEl.textContent = errMsg;
    showToast(errMsg, true);
  }
}

// ---------- GitHub / config-server integration ----------

async function exportUserConfigsToGithub() {
  const statusEl = document.getElementById('routing-status');
  const tagInput = document.getElementById('github-export-tag-input');
  const descInput = document.getElementById('github-export-desc-input');

  const tag = tagInput ? tagInput.value.trim() : '';
  const desc = descInput ? descInput.value.trim() : '';

  const payload = {
    title: 'XKeen config ' + new Date().toLocaleString(),
    description: desc,
    tags: tag ? [tag] : [],
  };

  if (statusEl) statusEl.textContent = 'Выгрузка конфигураций на сервер...';

  try {
    const res = await fetch('/api/github/export-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const id = data.id || (data.server_response && data.server_response.id);
      const okMsg = 'Конфигурация выгружена. ID: ' + (id || 'неизвестно');
      if (statusEl) statusEl.textContent = okMsg;
      showToast(okMsg, false);

      if (tagInput) tagInput.value = '';
      if (descInput) descInput.value = '';
      closeGithubExportModal();
    } else {
      const errMsg = 'Ошибка выгрузки: ' + ((data && data.error) || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = errMsg;
      showToast(errMsg, true);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка выгрузки (см. консоль браузера).';
  }
}

async function loadGithubConfigsCatalog() {
  const listEl = document.getElementById('github-catalog-list');
  if (!listEl) return;

  listEl.textContent = 'Загрузка...';

  try {
    const res = await fetch('/api/github/configs');
    const data = await res.json();
    if (!res.ok || !data.ok) {
      listEl.textContent =
        'Ошибка загрузки каталога: ' + ((data && data.error) || 'неизвестная ошибка');
      return;
    }

    const items = data.items || [];
    if (!items.length) {
      listEl.textContent = 'Конфигураций пока нет.';
      return;
    }

    const container = document.createElement('div');
    container.className = 'github-config-list';

    items
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .forEach((item) => {
        const row = document.createElement('div');
        row.className = 'github-config-row';

        const title = document.createElement('div');
        title.className = 'github-config-title';
        title.textContent = item.title || item.id;

        const meta = document.createElement('div');
        meta.className = 'github-config-meta';
        const dt = item.created_at ? new Date(item.created_at * 1000) : null;
        const tags = (item.tags || []).join(', ');
        meta.textContent =
          (dt ? dt.toLocaleString() : '') + (tags ? ' • ' + tags : '');

        const btn = document.createElement('button');
        btn.textContent = 'Загрузить';
        btn.addEventListener('click', () => {
          importUserConfigById(item.id);
        });

        row.appendChild(title);
        row.appendChild(meta);
        row.appendChild(btn);
        container.appendChild(row);
      });

    listEl.innerHTML = '';
    listEl.appendChild(container);
  } catch (e) {
    console.error(e);
    listEl.textContent = 'Ошибка загрузки каталога (см. консоль).';
  }
}

async function importUserConfigById(cfgId) {
  const statusEl = document.getElementById('routing-status');
  if (statusEl) statusEl.textContent = 'Загрузка конфигурации ' + cfgId + '...';

  try {
    const res = await fetch('/api/github/import-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cfg_id: cfgId }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const msg = 'Конфигурация ' + (data.cfg_id || cfgId) + ' загружена. Не забудьте перезапустить xkeen после проверки.';
      if (statusEl) statusEl.textContent = msg;
      showToast(msg, false);

      await loadRouting();
      await loadInboundsMode();
      await loadPortProxying();
      await loadPortExclude();
      await loadIpExclude();
    } else {
      const errMsg = 'Ошибка загрузки: ' + ((data && data.error) || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = errMsg;
      showToast(errMsg, true);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки (см. консоль).';
  }
}

function openGithubCatalogModal() {
  const modal = document.getElementById('github-catalog-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  loadGithubConfigsCatalog();
}

function closeGithubCatalogModal() {
  const modal = document.getElementById('github-catalog-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

function openGithubRepository() {
  const url = window.XKEEN_GITHUB_REPO_URL;
  if (url) {
    window.open(url, '_blank');
  } else {
    showToast('URL репозитария не настроен на сервере (XKEEN_GITHUB_REPO_URL).', true);
  }
}


function autoFormatRouting() {
  const statusEl = document.getElementById('routing-status');
  if (!routingEditor) return;
  const text = routingEditor.getValue();
  const cleaned = stripJsonComments(text);
  try {
    const obj = JSON.parse(cleaned);
    routingEditor.setValue(JSON.stringify(obj, null, 2));
    routingEditor.scrollTo(0, 0);
    setRoutingError('', null);
    if (statusEl) statusEl.textContent = 'JSON отформатирован.';
  } catch (e) {
    console.error(e);
    setRoutingError('Ошибка JSON: ' + e.message, null);
    if (statusEl) statusEl.textContent = 'Не удалось отформатировать: некорректный JSON.';
  }
}

function clearRoutingComments() {
  const statusEl = document.getElementById('routing-status');
  if (!routingEditor) return;
  const text = routingEditor.getValue();
  const cleaned = stripJsonComments(text);
  routingEditor.setValue(cleaned);
  validateRoutingContent();
  if (statusEl) statusEl.textContent = 'Комментарии удалены.';
}

function sortRoutingRules() {
  const statusEl = document.getElementById('routing-status');
  if (!routingEditor) return;

  const text = routingEditor.getValue();
  const cleaned = stripJsonComments(text);
  try {
    const obj = JSON.parse(cleaned);
    if (!obj.routing || !Array.isArray(obj.routing.rules)) {
      if (statusEl) statusEl.textContent = 'Не найден массив routing.rules для сортировки.';
      return;
    }
    const rules = obj.routing.rules.slice();
    rules.sort((a, b) => {
      const oa = (a.outboundTag || a.outbound || '').toString();
      const ob = (b.outboundTag || b.outbound || '').toString();
      if (oa < ob) return -1;
      if (oa > ob) return 1;
      const ta = (a.type || '').toString();
      const tb = (b.type || '').toString();
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      return 0;
    });
    obj.routing.rules = rules;
    routingEditor.setValue(JSON.stringify(obj, null, 2));
    setRoutingError('', null);
    if (statusEl) statusEl.textContent = 'Правила routing.rules упорядочены.';
  } catch (e) {
    console.error(e);
    setRoutingError('Ошибка JSON: ' + e.message, null);
    if (statusEl) statusEl.textContent = 'Не удалось упорядочить правила: некорректный JSON.';
  }
}

async function createBackup() {
  const statusEl = document.getElementById('routing-status');
  const backupsStatusEl = document.getElementById('backups-status');
  try {
    const res = await fetch('/api/backup', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      const msg = 'Бэкап создан: ' + data.filename;
      if (statusEl) statusEl.textContent = msg;
      if (backupsStatusEl) backupsStatusEl.textContent = '';
      if (typeof showToast === 'function') {
        showToast(msg, false);
      }
      await loadBackups();
    } else {
      const msg = 'Ошибка создания бэкапа: ' + (data.error || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = msg;
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
    }
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка создания бэкапа.';
    if (statusEl) statusEl.textContent = msg;
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}

async function restartXkeen() {
  const statusEl = document.getElementById('routing-status');
  try {
    const res = await fetch('/api/restart', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (statusEl) statusEl.textContent = 'xkeen перезапущен.';
    } else {
      if (statusEl) statusEl.textContent = 'Не удалось перезапустить xkeen.';
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка при перезапуске xkeen.';
  } finally {
    loadRestartLog();
  }
}

function shouldAutoRestartAfterSave() {
  const cb = document.getElementById('global-autorestart-xkeen');
  return !!(cb && cb.checked);
}
function controlXkeen(action) {
  const statusEl = document.getElementById('routing-status');
  const map = {
    start: '/api/xkeen/start',
    stop: '/api/xkeen/stop',
    restart: '/api/restart'
  };
  const url = map[action];
  if (!url) return;

  if (statusEl) statusEl.textContent = 'xkeen: ' + action + '...';

  return fetch(url, { method: 'POST' })
    .then(res => res.json().catch(() => ({})))
    .then(data => {
      const ok = !data || data.ok !== false;
      try { refreshXkeenServiceStatus(); } catch (e) {}
      const base = action === 'start'
        ? 'xkeen started.'
        : action === 'stop'
        ? 'xkeen stopped.'
        : 'xkeen restarted.';
      const err = action === 'start'
        ? 'Failed to start xkeen.'
        : action === 'stop'
        ? 'Failed to stop xkeen.'
        : 'Failed to restart xkeen.';
      const msg = ok ? base : err;
      if (statusEl) statusEl.textContent = msg;
      // For restart we rely on the global "restarted" handler to show success toast
      // to avoid duplicate notifications. However, if restart fails, we still want
      // a visible error message.
      if (!ok || action !== 'restart') {
        showToast(msg, !ok);
      }
      if (action === 'restart') {
        try { loadRestartLog(); } catch (e) {}
      }
    })
    .catch(e => {
      console.error(e);
      const msg = 'xkeen control error.';
      if (statusEl) statusEl.textContent = msg;
      showToast(msg, true);
      try { refreshXkeenServiceStatus(); } catch (e2) {}
    });
}


// ---------- inbounds ----------


async function loadInboundsMode() {
  const statusEl = document.getElementById('inbounds-status');
  try {
    const res = await fetch('/api/inbounds');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить inbounds.';
      return;
    }
    const data = await res.json();
    const mode = data.mode;
    if (mode === 'mixed' || mode === 'tproxy' || mode === 'redirect') {
      const radio = document.querySelector('input[name="inbounds_mode"][value="' + mode + '"]');
      if (radio) radio.checked = true;
    }
    if (statusEl) {
      if (mode === 'custom') {
        statusEl.textContent = 'Обнаружен пользовательский конфиг (не совпадает с пресетами).';
      } else if (mode) {
        statusEl.textContent = 'Текущий режим: ' + mode;
      } else {
        statusEl.textContent = 'Режим не определён (файл отсутствует или повреждён).';
      }
    }
    updateLastActivity('loaded', 'inbounds');
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки inbounds.';
  }
}

async function saveInboundsMode() {
  const statusEl = document.getElementById('inbounds-status');
  const selected = document.querySelector('input[name="inbounds_mode"]:checked');
  const toggle = document.getElementById('inbounds-autorestart');

  if (!selected) {
    if (statusEl) statusEl.textContent = 'Выбери режим перед сохранением.';
    return;
  }

  const mode = selected.value;
  const restart = toggle ? !!toggle.checked : false;

  try {
    const res = await fetch('/api/inbounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, restart })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'Режим сохранён: ' + data.mode + '.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
      updateLastActivity('saved', 'inbounds');
    } else {
      if (statusEl) statusEl.textContent = 'Save error: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения режима inbounds.';
  } finally {
    loadRestartLog();
  }
}

// ---------- outbounds ----------

async function loadOutbounds() {
  const statusEl = document.getElementById('outbounds-status');
  const input = document.getElementById('outbounds-url');
  if (!input) return;

  try {
    const res = await fetch('/api/outbounds');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить outbounds.';
      return;
    }
    const data = await res.json();
    if (data.url) {
      input.value = data.url;
      if (statusEl) statusEl.textContent = 'Текущая ссылка загружена.';
    } else {
    updateLastActivity('loaded', 'outbounds');
      if (statusEl) statusEl.textContent = 'Файл outbounds отсутствует или не содержит VLESS-конфиг.';
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки outbounds.';
  }
}


async function saveOutbounds() {
  const statusEl = document.getElementById('outbounds-status');
  const input = document.getElementById('outbounds-url');
  if (!input) return;

  const url = input.value.trim();
  if (!url) {
    if (statusEl) statusEl.textContent = 'Введи VLESS ссылку.';
    return;
  }

  try {
    const res = await fetch('/api/outbounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, restart: shouldAutoRestartAfterSave() })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'Outbounds saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
      updateLastActivity('saved', 'outbounds');
    } else {
      if (statusEl) statusEl.textContent = 'Save error: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Failed to save outbounds.';
  }
}



async function createInboundsBackup() {
  const statusEl = document.getElementById('inbounds-status');
  const backupsStatusEl = document.getElementById('backups-status');
  try {
    const res = await fetch('/api/backup-inbounds', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (statusEl) statusEl.textContent = 'Бэкап 03_inbounds.json создан: ' + data.filename;
      if (backupsStatusEl) backupsStatusEl.textContent = '';
      await loadBackups();
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа 03_inbounds.json: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа 03_inbounds.json.';
  }
}

async function createOutboundsBackup() {
  const statusEl = document.getElementById('outbounds-status');
  const backupsStatusEl = document.getElementById('backups-status');
  try {
    const res = await fetch('/api/backup-outbounds', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (statusEl) statusEl.textContent = 'Бэкап 04_outbounds.json создан: ' + data.filename;
      if (backupsStatusEl) backupsStatusEl.textContent = '';
      await loadBackups();
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа 04_outbounds.json: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа 04_outbounds.json.';
  }
}

async function restoreFromAutoBackup(target) {
  let statusEl = null;
  let label = '05_routing.json';

  if (target === 'inbounds') {
    statusEl = document.getElementById('inbounds-status');
    label = '03_inbounds.json';
  } else if (target === 'outbounds') {
    statusEl = document.getElementById('outbounds-status');
    label = '04_outbounds.json';
  } else {
    statusEl = document.getElementById('routing-status');
    label = '05_routing.json';
  }

  if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;

  try {
    const res = await fetch('/api/restore-auto', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const fname = data.filename || '';
      if (statusEl) {
        statusEl.textContent = 'Файл ' + label + ' восстановлен из авто-бэкапа ' + fname;
      }
      if (typeof showToast === 'function') {
        showToast('Файл ' + label + ' восстановлен из авто-бэкапа ' + fname, false);
      }
      if (target === 'routing') {
        await loadRouting();
      } else if (target === 'inbounds') {
        await loadInboundsMode();
      } else if (target === 'outbounds') {
        await loadOutbounds();
      }
    } else {
      const msg = 'Ошибка восстановления из авто-бэкапа: ' + (data.error || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = msg;
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
    }
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка восстановления из авто-бэкапа.';
    if (statusEl) statusEl.textContent = msg;
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}

// ---------- backups list ----------

async function loadBackups() {
  const tableBody = document.querySelector('#backups-table tbody');
  const statusEl = document.getElementById('backups-status');
  if (!tableBody) return;

  tableBody.innerHTML = '';

  try {
    const res = await fetch('/api/backups');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить список бэкапов.';
      return;
    }
    const backups = await res.json();

    if (!backups.length) {
      const tr = document.createElement('tr');
      tr.classList.add('backups-empty-row');
      const td = document.createElement('td');
      td.colSpan = 4;
      td.textContent = 'Бэкапов пока нет.';
      tr.appendChild(td);
      tableBody.appendChild(tr);
      return;
    }

    backups.forEach(b => {
      const tr = document.createElement('tr');

      const nameTd = document.createElement('td');
      nameTd.textContent = b.name;
      tr.appendChild(nameTd);

      const sizeTd = document.createElement('td');
      sizeTd.textContent = b.size + ' B';
      tr.appendChild(sizeTd);

      const mtimeTd = document.createElement('td');
      mtimeTd.textContent = b.mtime;
      tr.appendChild(mtimeTd);

      const actionTd = document.createElement('td');
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'backup-actions';

      const restoreBtn = document.createElement('button');
      restoreBtn.type = 'button';
      restoreBtn.className = 'backup-icon-btn';
      restoreBtn.title = 'Восстановить бэкап';
      restoreBtn.innerHTML = '<img src="/static/icons/restore.svg" alt="Восстановить" class="backup-icon">';
      restoreBtn.addEventListener('click', () => restoreBackup(b.name));

      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'backup-icon-btn backup-delete-btn';
      deleteBtn.title = 'Удалить бэкап';
      deleteBtn.innerHTML = '<img src="/static/icons/trash.svg" alt="Удалить" class="backup-icon">';
      deleteBtn.addEventListener('click', () => deleteBackup(b.name));

      actionsDiv.appendChild(restoreBtn);
      actionsDiv.appendChild(deleteBtn);

      actionTd.appendChild(actionsDiv);
      tr.appendChild(actionTd);

      tableBody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки списка бэкапов.';
  }
}

async function restoreBackup(filename) {
  const statusEl = document.getElementById('backups-status');
  const routingStatusEl = document.getElementById('routing-status');
  const inboundsStatusEl = document.getElementById('inbounds-status');
  const outboundsStatusEl = document.getElementById('outbounds-status');

  let target = 'routing';
  let label = '05_routing.json';
  if (filename.startsWith('03_inbounds-')) {
    target = 'inbounds';
    label = '03_inbounds.json';
  } else if (filename.startsWith('04_outbounds-')) {
    target = 'outbounds';
    label = '04_outbounds.json';
  }

  if (!confirm('Восстановить бэкап ' + filename + ' в ' + label + '?')) return;

  try {
    const res = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      const msg = 'Бэкап восстановлен: ' + filename;
      if (statusEl) statusEl.textContent = msg;
      if (typeof showToast === 'function') {
        showToast(msg, false);
      }

      if (target === 'routing') {
        if (routingStatusEl) routingStatusEl.textContent = 'Routing восстановлён из бэкапа ' + filename;
        await loadRouting();
      } else if (target === 'inbounds') {
        if (inboundsStatusEl) inboundsStatusEl.textContent = '03_inbounds.json восстановлён из бэкапа ' + filename;
        await loadInboundsMode();
      } else if (target === 'outbounds') {
        if (outboundsStatusEl) outboundsStatusEl.textContent = '04_outbounds.json восстановлён из бэкапа ' + filename;
        await loadOutbounds();
      }
    } else {
      const msg = 'Ошибка восстановления: ' + (data.error || 'неизвестная ошибка');
      if (statusEl) statusEl.textContent = msg;
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
    }
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка восстановления бэкапа.';
    if (statusEl) statusEl.textContent = msg;
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}

async function deleteBackup(filename) {
  const statusEl = document.getElementById('backups-status');

  if (!confirm('Удалить бэкап ' + filename + '? Это действие необратимо.')) {
    return;
  }

  try {
    const res = await fetch('/api/delete-backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename })
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      const msg = data.error || 'Не удалось удалить бэкап.';
      if (statusEl) {
        statusEl.textContent = msg;
      }
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
      return;
    }

    const msg = 'Бэкап удалён: ' + filename;
    if (statusEl) {
      statusEl.textContent = msg;
    }
    if (typeof showToast === 'function') {
      showToast(msg, false);
    }
    await loadBackups();
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка при удалении бэкапа.';
    if (statusEl) statusEl.textContent = msg;
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}

// ---------- restart log ----------

async function loadRestartLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  try {
    const res = await fetch('/api/restart-log');
    if (!res.ok) {
      const msg = 'Не удалось загрузить журнал.';
      logEl.dataset.rawText = msg;
      renderLogFromRaw(msg);
      return;
    }
    const data = await res.json();
    const lines = data.lines || [];
    let text;
    if (!lines.length) {
      text = 'Журнал пуст.';
    } else {
      text = lines.join('');
    }
    logEl.dataset.rawText = text;
    renderLogFromRaw(text);
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка загрузки журнала.';
    logEl.dataset.rawText = msg;
    renderLogFromRaw(msg);
  }
}


async function runShellCommand(cmd, stdinValue, options = {}) {
  const body = { cmd };
  if (typeof stdinValue === 'string') {
    body.stdin = stdinValue;
  }

  const createRes = await fetch('/api/run-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const createData = await createRes.json().catch(() => ({}));

  if (!createRes.ok || createData.ok === false) {
    return { res: createRes, data: createData };
  }

  const jobId = createData.job_id;
  if (!jobId) {
    return {
      res: createRes,
      data: { ok: false, error: 'no job_id returned from /api/run-command' }
    };
  }

  const finalData = await waitForCommandJob(jobId, options || {});
  return { res: createRes, data: finalData };
}
async function runXkeenFlag(flag, stdinValue, options = {}) {
  const body = { flag };
  if (typeof stdinValue === 'string') {
    body.stdin = stdinValue;
  }

  // Шаг 1: создаём задачу на бэкенде
  const createRes = await fetch('/api/run-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const createData = await createRes.json().catch(() => ({}));

  if (!createRes.ok || createData.ok === false) {
    return { res: createRes, data: createData };
  }

  const jobId = createData.job_id;
  if (!jobId) {
    // на всякий случай
    return {
      res: createRes,
      data: {
        ok: false,
        error: 'no job_id returned from /api/run-command'
      }
    };
  }

  // Шаг 2: ждём завершения задачи, опрашивая /api/run-command/<job_id>
  const finalData = await waitForCommandJob(jobId, options || {});
  return { res: createRes, data: finalData };
}
async function waitForCommandJob(jobId, options = {}) {
  const start = Date.now();
  const MAX_WAIT_MS = 300 * 1000; // 5 минут максимального ожидания на стороне клиента

  const onChunk = (options && typeof options.onChunk === 'function') ? options.onChunk : null;

  let accOutput = '';
  let wsResult = null;

  // Попытка сначала использовать WebSocket, если он доступен
  if (HAS_WS && typeof WebSocket !== 'undefined') {
    const proto = (location.protocol === 'https:') ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/command-status?job_id=${encodeURIComponent(jobId)}`;

    try {
      wsResult = await new Promise((resolve) => {
        let resolved = false;
        let ws = null;

        const finishWith = (result) => {
          if (resolved) return;
          resolved = true;
          try {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close();
            }
          } catch (e) {
            // ignore
          }
          resolve(result);
        };

        const timeoutId = setTimeout(() => {
          finishWith({
            ok: false,
            status: 'error',
            error: 'Client-side timeout while waiting for command result (WS)',
            job_id: jobId,
            output: accOutput
          });
        }, MAX_WAIT_MS);

        try {
          ws = new WebSocket(url);
        } catch (e) {
          clearTimeout(timeoutId);
          // Если не удалось создать WebSocket — вернём null и перейдём к HTTP-поллингу
          return finishWith(null);
        }

        ws.onmessage = (event) => {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch (e) {
            return;
          }

          if (msg.type === 'chunk') {
            if (typeof msg.data === 'string') {
              const chunk = msg.data;
              accOutput += chunk;
              if (onChunk) {
                try {
                  onChunk(chunk, { via: 'ws', jobId });
                } catch (e) {
                  console.error('onChunk handler (ws) failed:', e);
                }
              }
            }
          } else if (msg.type === 'done') {
            clearTimeout(timeoutId);
            const status = msg.status || 'finished';
            const exitCode = (typeof msg.exit_code === 'number') ? msg.exit_code : null;
            const error = msg.error || null;
            finishWith({
              ok: status === 'finished' && exitCode === 0 && !error,
              status,
              exit_code: exitCode,
              output: accOutput,
              job_id: jobId,
              error
            });
          } else if (msg.type === 'error') {
            clearTimeout(timeoutId);
            finishWith({
              ok: false,
              status: 'error',
              error: msg.message || 'WebSocket command error',
              job_id: jobId,
              output: accOutput
            });
          }
        };

        ws.onerror = () => {
          clearTimeout(timeoutId);
          // вернём null, чтобы ниже перейти на HTTP-поллинг
          finishWith(null);
        };

        ws.onclose = () => {
          clearTimeout(timeoutId);
          // если ещё не успели вернуть результат, тоже падаем на HTTP-поллинг
          finishWith(wsResult);
        };
      });

      if (wsResult) {
        return wsResult;
      }
      // Если wsResult === null — продолжаем ниже через HTTP-поллинг
    } catch (e) {
      console.error('waitForCommandJob WS error:', e);
      // Падаем обратно на HTTP-поллинг
    }
  }

  // HTTP-поллинг: /api/run-command/<job_id>
  let lastLen = 0;

  while (true) {
    const res = await fetch(`/api/run-command/${encodeURIComponent(jobId)}`);
    const data = await res.json().catch(() => ({}));

    if (!res.ok || data.ok === false) {
      if (!data.error) {
        data.error = 'HTTP ' + res.status;
      }
      // в HTTP-ветке гарантируем возврат накопленного вывода
      if (accOutput && typeof data.output !== 'string') {
        data.output = accOutput;
      }
      return data;
    }

    const output = (typeof data.output === 'string') ? data.output : '';
    if (output.length > lastLen) {
      const chunk = output.slice(lastLen);
      lastLen = output.length;
      if (chunk) {
        accOutput += chunk;
        if (onChunk) {
          try {
            onChunk(chunk, { via: 'http', jobId });
          } catch (e) {
            console.error('onChunk handler (http) failed:', e);
          }
        }
      }
    }

    const status = data.status;
    if (status === 'finished' || status === 'error') {
      const finalData = Object.assign({}, data);
      // всегда возвращаем финальный вывод из accOutput, если он есть
      if (accOutput) {
        finalData.output = accOutput;
      }
      return finalData;
    }

    if (Date.now() - start > MAX_WAIT_MS) {
      return {
        ok: false,
        status: 'error',
        error: 'Client-side timeout while waiting for command result',
        job_id: jobId,
        output: accOutput
      };
    }

    // ждём чуть-чуть перед следующим опросом
    await new Promise(r => setTimeout(r, 1000));
  }
}
async function runInstantXkeenFlag(flag, label) {
  appendToLog(`$ xkeen ${flag}\n`);

  // Буфер для случая, если нужно будет показать вывод после завершения
  let liveBuffer = '';

  try {
    const { res, data } = await runXkeenFlag(flag, '\n', {
      onChunk(chunk) {
        liveBuffer += chunk;
        // Показываем стриминговый вывод сразу в лог
        appendToLog(chunk);
      }
    });

    if (!res.ok) {
      const msg = data.error || ('HTTP ' + res.status);
      appendToLog('Ошибка: ' + msg + '\n');
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
      return;
    }

    // Если стриминга не было (onChunk не вызывался), показываем финальный вывод как раньше
    if (!liveBuffer) {
      const out = (data.output || '').trim();
      if (out) {
        appendToLog(out + '\n');
      } else {
        appendToLog('(нет вывода)\n');
      }
    } else {
      // Стриминг уже напечатал весь текст, просто завершим переносом строки, если нужно
      if (!liveBuffer.endsWith('\n')) {
        appendToLog('\n');
      }
    }

    if (typeof data.exit_code === 'number') {
      appendToLog('(код завершения: ' + data.exit_code + ')\n');
    }
  } catch (e) {
    console.error(e);
    const msg = 'Ошибка выполнения команды: ' + String(e);
    appendToLog(msg + '\n');
    if (typeof showToast === 'function') {
      showToast(msg, true);
    }
  }
}
function ansiToHtml(text) {
  if (!text) return '';
  // Remove non-color ANSI control sequences (leave only SGR ...m, e.g. colors)
  const stripped = String(text).replace(/\x1b\[[0-9;?]*[@-~]/g, function (seq) {
    var finalChar = seq.charAt(seq.length - 1);
    return finalChar === 'm' ? seq : '';
  });

  // Escape HTML special chars
  let escaped = stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const ansiRegex = /\x1b\[([0-9;]+)m/g;
  const ANSI_COLOR_MAP = {
    30: '#000000', // black
    31: '#ff5555', // red
    32: '#50fa7b', // green
    33: '#f1fa8c', // yellow
    34: '#bd93f9', // blue
    35: '#ff79c6', // magenta
    36: '#8be9fd', // cyan
    37: '#f8f8f2', // white / light gray
    90: '#4c566a', // bright black
    91: '#ff6e6e',
    92: '#69ff94',
    93: '#ffffa5',
    94: '#d6acff',
    95: '#ff92df',
    96: '#a4ffff',
    97: '#ffffff'
  };
  let result = '';
  let lastIndex = 0;
  let openSpan = false;
  let currentStyle = '';

  function closeSpan() {
    if (openSpan) {
      result += '</span>';
      openSpan = false;
    }
  }

  let match;
  while ((match = ansiRegex.exec(escaped)) !== null) {
    if (match.index > lastIndex) {
      result += escaped.slice(lastIndex, match.index);
    }
    lastIndex = ansiRegex.lastIndex;

    const codes = match[1].split(';').map(function (c) { return parseInt(c, 10) || 0; });
    let style = currentStyle;
    let reset = false;

    codes.forEach(function (code) {
      if (code === 0) {
        style = '';
        reset = true;
      } else if (code === 1) {
        style = style.replace(/font-weight:[^;]+;?/g, '') + 'font-weight:bold;';
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        const color = ANSI_COLOR_MAP[code];
        if (color) {
          style = style.replace(/color:[^;]+;?/g, '') + 'color:' + color + ';';
        }
      }
    });

    if (reset || style !== currentStyle) {
      closeSpan();
      currentStyle = style;
      if (style) {
        result += '<span style="' + style + '">';
        openSpan = true;
      }
    }
  }

  if (lastIndex < escaped.length) {
    result += escaped.slice(lastIndex);
  }
  closeSpan();

  return result;
}

function renderLogFromRaw(rawText) {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;

  const text = rawText || '';
  const lines = text.split(/\r?\n/);

  const html = lines
    .map((line) => {
      const cls = getXrayLogLineClass(line);
      const inner = ansiToHtml(line || '');
      return '<span class="' + cls + '">' + inner + '</span>';
    })
    .join('<br>');

  logEl.innerHTML = html;
  logEl.scrollTop = logEl.scrollHeight;
}

function appendToLog(text) {
  const logEl = document.getElementById('restart-log');
  if (!logEl || !text) return;
  const current = logEl.dataset.rawText || '';
  let raw = current;
  if (raw && !raw.endsWith('\n')) {
    raw += '\n';
  }
  raw += text;
  logEl.dataset.rawText = raw;
  renderLogFromRaw(raw);
}

function clearLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  logEl.dataset.rawText = '';
  logEl.innerHTML = '';
  try {
    fetch('/api/restart-log/clear', { method: 'POST' });
  } catch (e) {
    console.error(e);
  }
}


function copyLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  const text = logEl.dataset.rawText || '';
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Журнал скопирован в буфер обмена', false),
      () => fallbackCopyText(text)
    );
  } else {
    fallbackCopyText(text);
  }
}

function fallbackCopyText(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast('Журнал скопирован в буфер обмена', false);
  } catch (e) {
    showToast('Не удалось скопировать журнал', true);
  }
  document.body.removeChild(ta);
}


function setXrayLogLampState(state, level) {
  const lamp = document.getElementById('xray-log-lamp');
  if (!lamp) return;

  lamp.dataset.state = state;

  if (state === 'on') {
    lamp.title = level
      ? `Логи включены (loglevel=${level})`
      : 'Логи включены';
    lamp.classList.add('pulse');
    setTimeout(() => lamp.classList.remove('pulse'), 300);
  } else if (state === 'off') {
    lamp.title = 'Логи отключены (loglevel=none)';
    lamp.classList.remove('pulse');
  } else if (state === 'error') {
    lamp.title = 'Не удалось получить статус логов Xray';
    lamp.classList.remove('pulse');
  } else {
    lamp.title = 'Статус логов Xray неизвестен';
    lamp.classList.remove('pulse');
  }
}

async function refreshXrayLogStatus() {
  try {
    const res = await fetch('/api/xray-logs/status');
    if (!res.ok) throw new Error('status http error');
    const data = await res.json().catch(() => ({}));
    const level = String(data.loglevel || 'none').toLowerCase();
    const state = level === 'none' ? 'off' : 'on';
    setXrayLogLampState(state, level);
  } catch (e) {
    console.error('xray log status error', e);
    setXrayLogLampState('error');
  }
}


// ---------- Xkeen service status (header lamp) ----------

function setXkeenServiceStatus(state, core) {
  const lamp = document.getElementById('xkeen-service-lamp');
  const textEl = document.getElementById('xkeen-service-text');
  const coreEl = document.getElementById('xkeen-core-text');

  if (!lamp || !textEl || !coreEl) return;

  lamp.dataset.state = state;

  let text;
  switch (state) {
    case 'running':
      text = 'Сервис запущен';
      break;
    case 'stopped':
      text = 'Сервис остановлен';
      break;
    case 'pending':
      text = 'Проверка статуса...';
      break;
    case 'error':
      text = 'Ошибка статуса';
      break;
    default:
      text = 'Статус неизвестен';
  }

  textEl.textContent = text;

  if (core && state === 'running') {
    const label = core === 'mihomo' ? 'mihomo' : 'xray';
    coreEl.textContent = `Ядро: ${label}`;
    coreEl.dataset.core = label;
    coreEl.classList.add('has-core');
    lamp.title = `${text} (ядро: ${label})`;
  } else {
    coreEl.textContent = '';
    coreEl.dataset.core = '';
    coreEl.classList.remove('has-core');
    lamp.title = text;
  }
}

async function refreshXkeenServiceStatus() {
  const lamp = document.getElementById('xkeen-service-lamp');
  if (!lamp) return;

  // Показать промежуточное состояние
  setXkeenServiceStatus('pending');

  try {
    const res = await fetch('/api/xkeen/status');
    if (!res.ok) throw new Error('status http error: ' + res.status);
    const data = await res.json().catch(() => ({}));

    const running = !!data.running;
    const core = data.core || null;

    setXkeenServiceStatus(running ? 'running' : 'stopped', core);
  } catch (e) {
    console.error('xkeen status error', e);
    setXkeenServiceStatus('error');
  }
}


// ---------- Xkeen core selection (modal) ----------

let xkeenCoreModalLoading = false;

function openXkeenCoreModal() {
  const modal = document.getElementById('core-modal');
  const statusEl = document.getElementById('core-modal-status');
  const confirmBtn = document.getElementById('core-modal-confirm-btn');
  const coreButtons = document.querySelectorAll('#core-modal .core-option');

  if (!modal || !statusEl || !confirmBtn || !coreButtons.length) return;

  modal.classList.remove('hidden');
  statusEl.textContent = 'Загрузка списка ядер...';
  confirmBtn.disabled = true;

  coreButtons.forEach(btn => {
    btn.disabled = true;
    btn.classList.remove('active');
    btn.style.display = 'inline-block';
  });

  xkeenCoreModalLoading = true;

  fetch('/api/xkeen/core')
    .then(res => res.json().catch(() => ({})))
    .then(data => {
      xkeenCoreModalLoading = false;

      const ok = data && data.ok !== false;
      if (!ok) {
        statusEl.textContent = data && data.error
          ? `Ошибка: ${data.error}`
          : 'Не удалось получить список ядер';
        return;
      }

      const cores = Array.isArray(data.cores) ? data.cores : [];
      const current = data.currentCore || null;

      if (cores.length < 2) {
        statusEl.textContent = cores.length
          ? 'Доступно только одно ядро — переключение не требуется'
          : 'Не найдено ни одного ядра';
        confirmBtn.disabled = true;
        coreButtons.forEach(btn => { btn.disabled = true; });
        return;
      }

      statusEl.textContent = 'Выберите ядро XKeen:';

      coreButtons.forEach(btn => {
        const value = btn.getAttribute('data-core');
        if (!value || !cores.includes(value)) {
          btn.style.display = 'none';
          return;
        }
        btn.disabled = false;
        if (value === current) {
          btn.classList.add('active');
        }
      });

      confirmBtn.disabled = false;
    })
    .catch(err => {
      console.error('core list error', err);
      xkeenCoreModalLoading = false;
      statusEl.textContent = 'Ошибка загрузки списка ядер';
      confirmBtn.disabled = true;
    });
}

function closeXkeenCoreModal() {
  const modal = document.getElementById('core-modal');
  if (!modal) return;
  modal.classList.add('hidden');
}

async function confirmXkeenCoreChange() {
  if (xkeenCoreModalLoading) return;

  const statusEl = document.getElementById('core-modal-status');
  const confirmBtn = document.getElementById('core-modal-confirm-btn');
  const coreButtons = document.querySelectorAll('#core-modal .core-option');

  if (!statusEl || !confirmBtn || !coreButtons.length) return;

  let selectedCore = null;
  coreButtons.forEach(btn => {
    if (btn.classList.contains('active') && !btn.disabled && btn.style.display !== 'none') {
      selectedCore = btn.getAttribute('data-core');
    }
  });

  if (!selectedCore) {
    statusEl.textContent = 'Пожалуйста, выберите ядро';
    return;
  }

  statusEl.textContent = `Смена ядра на ${selectedCore}...`;
  confirmBtn.disabled = true;
  coreButtons.forEach(btn => { btn.disabled = true; });

  try {
    const res = await fetch('/api/xkeen/core', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ core: selectedCore })
    });
    const data = await res.json().catch(() => ({}));
    const ok = data && data.ok !== false;

    if (!ok) {
      statusEl.textContent = data && data.error
        ? `Ошибка: ${data.error}`
        : 'Не удалось сменить ядро';
      confirmBtn.disabled = false;
      coreButtons.forEach(btn => { btn.disabled = false; });
      showToast('Не удалось сменить ядро', true);
      return;
    }

    showToast(`Ядро изменено на ${selectedCore}`, false);
    closeXkeenCoreModal();
    try { refreshXkeenServiceStatus(); } catch (e) {}
  } catch (err) {
    console.error('core change error', err);
    statusEl.textContent = 'Ошибка при смене ядра';
    confirmBtn.disabled = false;
    coreButtons.forEach(btn => { btn.disabled = false; });
    showToast('Не удалось сменить ядро (ошибка сети)', true);
  }
}



// ---------- Xray live logs ----------

async function fetchXrayLogsOnce(source = 'manual') {
  const outputEl = document.getElementById('xray-log-output');
  if (!outputEl) return;

  const statusEl = document.getElementById('xray-log-status');

  const file = xrayLogCurrentFile || 'error';

  try {
    const res = await fetch(`/api/xray-logs?file=${encodeURIComponent(file)}&max_lines=800&source=${encodeURIComponent(source)}`);
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить логи Xray.';
      return;
    }
    const data = await res.json();
    xrayLogLastLines = data.lines || [];
    applyXrayLogFilterToOutput();
    if (statusEl) statusEl.textContent = '';
    refreshXrayLogStatus();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка чтения логов Xray.';
  }
}


function xrayLogConnectWs() {
  if (!HAS_WS || !('WebSocket' in window)) {
    xrayLogUseWebSocket = false;
    return;
  }

  // Если уже есть живой или подключающийся WebSocket — ничего не делаем
  if (
    xrayLogWs &&
    (xrayLogWs.readyState === WebSocket.OPEN ||
      xrayLogWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  const statusEl = document.getElementById('xray-log-status');
  const file = xrayLogCurrentFile || 'error';

  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const url =
    proto + '//' + host + '/ws/xray-logs?file=' + encodeURIComponent(file);

  wsDebug('WS: connecting', { url: url, file: file });

  try {
    // при новой попытке подключения сбрасываем флаги
    xrayLogWsClosingManually = false;
    xrayLogWsEverOpened = false;
    xrayLogWs = new WebSocket(url);
  } catch (e) {
    console.error('Failed to create WebSocket for logs', e);
    xrayLogUseWebSocket = false;
    if (statusEl) {
      statusEl.textContent = 'Не удалось создать WebSocket, использую HTTP.';
    }
    // HTTP-поллинг при необходимости включит startXrayLogAuto()
    return;
  }

  xrayLogWs.onopen = function () {
    wsDebug('WS: open', { file: file });
    xrayLogWsEverOpened = true;

    // Как только WebSocket успешно подключился, выключаем HTTP-polling,
    // чтобы логи шли только по одному каналу.
    if (xrayLogTimer) {
      clearInterval(xrayLogTimer);
      xrayLogTimer = null;
    }

    if (statusEl) statusEl.textContent = 'WebSocket для логов подключён.';
  };

  xrayLogWs.onmessage = function (event) {
    let data = null;
    try {
      data = JSON.parse(event.data);
    } catch (e) {
      console.warn('Invalid WebSocket payload for xray logs', e);
      return;
    }

    // Новый протокол: { type: "init", lines: [...] } и { type: "line", line: "..." }
    if (data && data.type === 'init' && Array.isArray(data.lines)) {
      xrayLogLastLines = data.lines;
    } else if (data && data.type === 'line' && typeof data.line === 'string') {
      xrayLogLastLines.push(data.line);
      if (xrayLogLastLines.length > 800) {
        xrayLogLastLines = xrayLogLastLines.slice(-800);
      }
    } else if (Array.isArray(data.lines)) {
      // Backward compatibility with старым протоколом без поля type
      xrayLogLastLines = data.lines;
    } else if (data.line) {
      xrayLogLastLines.push(data.line);
      if (xrayLogLastLines.length > 800) {
        xrayLogLastLines = xrayLogLastLines.slice(-800);
      }
    }

    applyXrayLogFilterToOutput();
  };

  xrayLogWs.onclose = function () {
    const viewEl = document.getElementById('view-xray-logs');
    const isVisible = viewEl && viewEl.style.display !== 'none';

    wsDebug('WS: close', {
      file: file,
      manual: xrayLogWsClosingManually,
      everOpened: xrayLogWsEverOpened,
    });

    xrayLogWs = null;

    // Если мы сами закрыли сокет (смена вкладки/файла или стоп) —
    // ничего не делаем и не включаем HTTP.
    if (xrayLogWsClosingManually || !isVisible) {
      if (statusEl) statusEl.textContent = 'WebSocket для логов закрыт.';
      return;
    }

    // Если соединение так и не открылось — считаем, что WebSocket недоступен
    // и переключаемся на HTTP.
    if (!xrayLogWsEverOpened) {
      xrayLogUseWebSocket = false;
      if (statusEl) {
        statusEl.textContent = 'WebSocket недоступен, использую HTTP.';
      }
      if (!xrayLogTimer) {
        fetchXrayLogsOnce('fallback_ws');
        xrayLogTimer = setInterval(fetchXrayLogsOnce, 2000);
      }
      return;
    }

    // Был рабочий WebSocket, который отвалился сам по себе —
    // пробуем переподключиться, но НЕ включаем HTTP, чтобы не было дублей.
    if (statusEl) {
      statusEl.textContent =
        'WebSocket для логов разорван, пытаюсь переподключиться...';
    }

    setTimeout(function () {
      const stillVisibleEl = document.getElementById('view-xray-logs');
      const stillVisible =
        stillVisibleEl && stillVisibleEl.style.display !== 'none';

      if (!xrayLogWs && xrayLogUseWebSocket && stillVisible) {
        xrayLogConnectWs();
      }
    }, 1000);
  };

  xrayLogWs.onerror = function () {
    wsDebug('WS: error', { file: file });
    console.warn('WebSocket error in xray logs');
    // Здесь не включаем HTTP: окончательное решение принимает onclose.
  };
}


function applyXrayLogFilterToOutput() {
  const outputEl = document.getElementById('xray-log-output');
  if (!outputEl) return;

  const filterEl = document.getElementById('xray-log-filter');
  const rawFilter = (filterEl && filterEl.value || '').trim().toLowerCase();

  // Разбиваем фильтр на слова, применяем AND-логику:
  // "error xray" -> строки, содержащие и "error", и "xray"
  const terms = rawFilter
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const sourceLines = xrayLogLastLines || [];
  const filtered = terms.length
    ? sourceLines.filter((line) => {
        const lower = (line || '').toLowerCase();
        return terms.every((t) => lower.includes(t));
      })
    : sourceLines;

  const wasAtBottom =
    outputEl.scrollTop + outputEl.clientHeight >= outputEl.scrollHeight - 5;

  const html = filtered
    .map((line) => parseXrayLogLine(line))
    .join('\n');

  outputEl.innerHTML = html;

  if (wasAtBottom) {
    outputEl.scrollTop = outputEl.scrollHeight;
  }
}


function xrayLogApplyFilter() {
  applyXrayLogFilterToOutput();
}

function startXrayLogAuto() {
  const outputEl = document.getElementById('xray-log-output');
  if (!outputEl) return;

  // Если уже есть живой или подключающийся WebSocket — просто ничего не делаем
  if (
    xrayLogUseWebSocket &&
    xrayLogWs &&
    (xrayLogWs.readyState === WebSocket.OPEN ||
      xrayLogWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  // Пробуем WebSocket
  if (HAS_WS && xrayLogUseWebSocket && 'WebSocket' in window) {
    // Перед попыткой WebSocket гарантированно выключаем HTTP-polling,
    // чтобы не было одновременной работы двух механизмов.
    if (xrayLogTimer) {
      clearInterval(xrayLogTimer);
      xrayLogTimer = null;
    }
    xrayLogConnectWs();
    return;
  }

  // Фоллбек: старый добрый HTTP-polling (только если WebSocket недоступен)
  if (xrayLogTimer) return;
  fetchXrayLogsOnce('manual');
  xrayLogTimer = setInterval(fetchXrayLogsOnce, 2000);
}


function stopXrayLogAuto() {
  if (xrayLogTimer) {
    clearInterval(xrayLogTimer);
    xrayLogTimer = null;
  }

  if (xrayLogWs) {
    // помечаем, что закрытие сокета инициировано нами,
    // чтобы onclose не включал HTTP-фоллбек
    xrayLogWsClosingManually = true;
    try {
      xrayLogWs.close();
    } catch (e) {
      // ignore
    }
    xrayLogWs = null;
  }
}

function xrayLogsView() {
  // Одноразовая подгрузка логов из файлов
  fetchXrayLogsOnce('manual');
}

function xrayLogsClearScreen() {
  // Очищаем только окно вывода, файлы не трогаем
  const outputEl = document.getElementById('xray-log-output');
  if (outputEl) {
    outputEl.innerHTML = '';
  }
  xrayLogLastLines = [];
}

function xrayLogChangeFile() {
  const selectEl = document.getElementById('xray-log-file');
  if (selectEl) {
    xrayLogCurrentFile = selectEl.value || 'error';
  }

  // очищаем текущий буфер и перерисовываем окно
  xrayLogLastLines = [];
  applyXrayLogFilterToOutput();

  // если используем WebSocket — пересоздаём соединение с новым file=...
  if (HAS_WS && xrayLogUseWebSocket && 'WebSocket' in window) {
    // Перед переключением файла через WebSocket выключаем HTTP-polling,
    // чтобы не было параллельного чтения по HTTP.
    if (xrayLogTimer) {
      clearInterval(xrayLogTimer);
      xrayLogTimer = null;
    }

    if (xrayLogWs) {
      // закрываем текущий сокет по инициативе клиента,
      // чтобы onclose не запускал HTTP-фоллбек
      xrayLogWsClosingManually = true;
      try {
        xrayLogWs.close();
      } catch (e) {
        // ignore
      }
      xrayLogWs = null;
    }
    xrayLogConnectWs();
    return;
  }

  // иначе остаётся HTTP
  fetchXrayLogsOnce('manual');
}

async function xrayLogsEnable() {
  const statusEl = document.getElementById('xray-log-status');
  try {
    const res = await fetch('/api/xray-logs/enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loglevel: 'warning' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error();
    if (statusEl) {
      statusEl.textContent = 'Логи включены (loglevel=' + (data.loglevel || 'warning') + '). Xray перезапущен.';
    }
    setXrayLogLampState('on', data.loglevel || 'warning');
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Не удалось включить логи.';
  }
}

async function xrayLogsDisable() {
  // Сразу останавливаем автообновление, чтобы сохранить последний снимок логов
  stopXrayLogAuto();
  const statusEl = document.getElementById('xray-log-status');
  try {
    const res = await fetch('/api/xray-logs/disable', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error();
    if (statusEl) {
      statusEl.textContent = 'Логи остановлены (loglevel=none). Xray перезапущен.';
    }
    setXrayLogLampState('off', 'none');
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Не удалось остановить логи.';
  }
}

async function xrayLogsClear() {
  const statusEl = document.getElementById('xray-log-status');
  try {
    const file = xrayLogCurrentFile || 'error';
    const res = await fetch('/api/xray-logs/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file }),
    });
    if (!res.ok) throw new Error();
    xrayLogLastLines = [];
    applyXrayLogFilterToOutput();
    if (statusEl) statusEl.textContent = 'Логфайлы очищены.';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Не удалось очистить логфайлы.';
  }
}

function xrayLogsCopy() {
  const outputEl = document.getElementById('xray-log-output');
  if (!outputEl) return;
  const text = outputEl.textContent || '';
  if (!text) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => showToast('Логи Xray скопированы в буфер обмена', false),
      () => fallbackCopyText(text)
    );
  } else {
    fallbackCopyText(text);
  }
}


function toggleCommands() {
  const body = document.getElementById('commands-body');
  const arrow = document.getElementById('commands-arrow');
  if (!body || !arrow) return;
  const hidden = body.style.display === '' || body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  arrow.textContent = hidden ? '▲' : '▼';
}


function showView(name) {
  const sections = {
    routing: document.getElementById('view-routing'),
    mihomo: document.getElementById('view-mihomo'),
    xkeen: document.getElementById('view-xkeen'),
    'xray-logs': document.getElementById('view-xray-logs'),
    commands: document.getElementById('view-commands'),
  };

  Object.entries(sections).forEach(([key, el]) => {
    if (!el) return;
    el.style.display = key === name ? 'block' : 'none';
  });

  const buttons = document.querySelectorAll('.top-tab-btn');
  buttons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  if (name === 'mihomo' && typeof mihomoEditor !== 'undefined' && mihomoEditor && mihomoEditor.refresh) {
    mihomoEditor.refresh();
  }
  if (name === 'xkeen') {
    if (typeof portProxyingEditor !== 'undefined' && portProxyingEditor && portProxyingEditor.refresh) {
      portProxyingEditor.refresh();
    }
    if (typeof portExcludeEditor !== 'undefined' && portExcludeEditor && portExcludeEditor.refresh) {
      portExcludeEditor.refresh();
    }
    if (typeof ipExcludeEditor !== 'undefined' && ipExcludeEditor && ipExcludeEditor.refresh) {
      ipExcludeEditor.refresh();
    }
  }

  if (name === 'xray-logs') {
    startXrayLogAuto();
    refreshXrayLogStatus();
  } else {
    stopXrayLogAuto();
  }
}

function toggleRoutingCard() {
  const body = document.getElementById('routing-body');
  const arrow = document.getElementById('routing-arrow');
  if (!body || !arrow) return;

  // If body is currently hidden (display: none), we are about to open it
  const willOpen = body.style.display === 'none';
  body.style.display = willOpen ? 'block' : 'none';
  arrow.textContent = willOpen ? '▲' : '▼';

  // After expanding, force CodeMirror to recompute dimensions
  if (willOpen && typeof routingEditor !== 'undefined' && routingEditor && routingEditor.refresh) {
    routingEditor.refresh();
  }
}

function toggleMihomoCard() {
  const body = document.getElementById('mihomo-body');
  const arrow = document.getElementById('mihomo-arrow');
  if (!body || !arrow) return;

  const willOpen = body.style.display === 'none';
  body.style.display = willOpen ? 'block' : 'none';
  arrow.textContent = willOpen ? '▲' : '▼';

  if (willOpen && typeof mihomoEditor !== 'undefined' && mihomoEditor && mihomoEditor.refresh) {
    mihomoEditor.refresh();
  }
}





function toggleInboundsCard() {
  const body = document.getElementById('inbounds-body');
  const arrow = document.getElementById('inbounds-arrow');
  if (!body || !arrow) return;

  const willOpen = body.style.display === 'none';
  body.style.display = willOpen ? 'block' : 'none';
  arrow.textContent = willOpen ? '▲' : '▼';

  try {
    if (window.localStorage) {
      localStorage.setItem('xkeen_inbounds_open', willOpen ? '1' : '0');
    }
  } catch (e) {
    // ignore
  }
}

function toggleOutboundsCard() {
  const body = document.getElementById('outbounds-body');
  const arrow = document.getElementById('outbounds-arrow');
  if (!body || !arrow) return;

  const willOpen = body.style.display === 'none';
  body.style.display = willOpen ? 'block' : 'none';
  arrow.textContent = willOpen ? '▲' : '▼';

  try {
    if (window.localStorage) {
      localStorage.setItem('xkeen_outbounds_open', willOpen ? '1' : '0');
    }
  } catch (e) {
    // ignore
  }
}

function toggleXkeenSettings() {
  const body = document.getElementById('xkeen-body');
  const arrow = document.getElementById('xkeen-arrow');
  if (!body || !arrow) return;
  const hidden = body.style.display === '' || body.style.display === 'none';
  body.style.display = hidden ? 'block' : 'none';
  arrow.textContent = hidden ? '▲' : '▼';
  if (!hidden) {
    if (typeof portProxyingEditor !== 'undefined' && portProxyingEditor && portProxyingEditor.refresh) {
      portProxyingEditor.refresh();
    }
    if (typeof portExcludeEditor !== 'undefined' && portExcludeEditor && portExcludeEditor.refresh) {
      portExcludeEditor.refresh();
    }
    if (typeof ipExcludeEditor !== 'undefined' && ipExcludeEditor && ipExcludeEditor.refresh) {
      ipExcludeEditor.refresh();
    }
  }
}
function initCommandClicks() {
  const items = document.querySelectorAll('.command-item');
  if (!items.length) return;
  items.forEach((el) => {
    el.addEventListener('click', () => {
      const flag = el.getAttribute('data-flag');
      const label = el.getAttribute('data-label') || ('xkeen ' + flag);
      if (!flag) return;
      // Любая команда из списка "Команды" теперь используется как подсказка:
      // просто открываем терминал XKeen с предзаполненной строкой.
      openTerminalForFlag(flag, label);
    });
  });
}

// ---------- ini


// ---------- init ----------


// ---------- xkeen text configs (port/ip exclude) ----------


async function loadPortProxying() {
  const ta = document.getElementById('port-proxying-editor');
  const statusEl = document.getElementById('port-proxying-status');
  if (!ta) return;
  try {
    const res = await fetch('/api/xkeen/port-proxying');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить port_proxying.lst.';
      return;
    }
    const data = await res.json();
    const text = data.content || '';
    const len = (text && text.length) || 0;
    console.log('loadPortProxying length', len);
    if (portProxyingEditor) {
      portProxyingEditor.setValue(text);
    } else {
      ta.value = text;
    }
    if (statusEl) statusEl.textContent = 'port_proxying.lst загружен (' + len + ' байт).';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки port_proxying.lst.';
  }
}



async function savePortProxying() {
  const ta = document.getElementById('port-proxying-editor');
  const statusEl = document.getElementById('port-proxying-status');
  if (!ta) return;
  const content = portProxyingEditor ? portProxyingEditor.getValue() : ta.value;
  try {
    const res = await fetch('/api/xkeen/port-proxying', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, restart: shouldAutoRestartAfterSave() }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'port_proxying.lst saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Save error: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Failed to save port_proxying.lst.';
  }
}




async function loadPortExclude() {
  const ta = document.getElementById('port-exclude-editor');
  const statusEl = document.getElementById('port-exclude-status');
  if (!ta) return;
  try {
    const res = await fetch('/api/xkeen/port-exclude');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить port_exclude.lst.';
      return;
    }
    const data = await res.json();
    const text = data.content || '';
    const len = (text && text.length) || 0;
    console.log('loadPortExclude length', len);
    if (portExcludeEditor) {
      portExcludeEditor.setValue(text);
    } else {
      ta.value = text;
    }
    if (statusEl) statusEl.textContent = 'port_exclude.lst загружен (' + len + ' байт).';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки port_exclude.lst.';
  }
}



async function savePortExclude() {
  const ta = document.getElementById('port-exclude-editor');
  const statusEl = document.getElementById('port-exclude-status');
  if (!ta) return;
  const content = portExcludeEditor ? portExcludeEditor.getValue() : ta.value;
  try {
    const res = await fetch('/api/xkeen/port-exclude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, restart: shouldAutoRestartAfterSave() }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'port_exclude.lst saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Save error: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Failed to save port_exclude.lst.';
  }
}




async function loadIpExclude() {
  const ta = document.getElementById('ip-exclude-editor');
  const statusEl = document.getElementById('ip-exclude-status');
  if (!ta) return;
  try {
    const res = await fetch('/api/xkeen/ip-exclude');
    if (!res.ok) {
      if (statusEl) statusEl.textContent = 'Не удалось загрузить ip_exclude.lst.';
      return;
    }
    const data = await res.json();
    const text = data.content || '';
    const len = (text && text.length) || 0;
    console.log('loadIpExclude length', len);
    if (ipExcludeEditor) {
      ipExcludeEditor.setValue(text);
    } else {
      ta.value = text;
    }
    if (statusEl) statusEl.textContent = 'ip_exclude.lst загружен (' + len + ' байт).';
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки ip_exclude.lst.';
  }
}



async function saveIpExclude() {
  const ta = document.getElementById('ip-exclude-editor');
  const statusEl = document.getElementById('ip-exclude-status');
  if (!ta) return;
  const content = ipExcludeEditor ? ipExcludeEditor.getValue() : ta.value;
  try {
    const res = await fetch('/api/xkeen/ip-exclude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, restart: shouldAutoRestartAfterSave() }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'ip_exclude.lst saved.';
      if (data.restarted) {
        msg += ' xkeen restarted.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Save error: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Failed to save ip_exclude.lst.';
  }
}





async function openJsonEditor(target) {
  const modal = document.getElementById('json-editor-modal');
  const titleEl = document.getElementById('json-editor-title');
  const fileLabelEl = document.getElementById('json-editor-file-label');
  const errorEl = document.getElementById('json-editor-error');
  const textarea = document.getElementById('json-editor-textarea');

  if (!modal || !textarea) return;

  jsonModalCurrentTarget = target;
  if (errorEl) errorEl.textContent = '';

  let url;
  let title;
  let fileLabel;

  if (target === 'inbounds') {
    url = '/api/inbounds';
    title = 'Редактор 03_inbounds.json';
    fileLabel = 'Файл: 03_inbounds.json';
  } else if (target === 'outbounds') {
    url = '/api/outbounds';
    title = 'Редактор 04_outbounds.json';
    fileLabel = 'Файл: 04_outbounds.json';
  } else {
    return;
  }

  if (titleEl) titleEl.textContent = title;
  if (fileLabelEl) fileLabelEl.textContent = fileLabel;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (errorEl) errorEl.textContent = 'Не удалось загрузить конфиг.';
      return;
    }
    const data = await res.json();
    const cfg = data && data.config ? data.config : null;
    const finalText = (data && data.text)
      ? data.text
      : (cfg ? JSON.stringify(cfg, null, 2) : '{}');

    if (window.CodeMirror) {
      if (!jsonModalEditor) {
        jsonModalEditor = CodeMirror.fromTextArea(textarea, {
          mode: { name: 'javascript', json: true },
          theme: (document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'material-darker'),
          lineNumbers: true,
          styleActiveLine: true,
          showIndentGuides: true,
          matchBrackets: true,
          showTrailingSpace: true,
          rulers: [{ column: 120 }],
          lineWrapping: true,
          gutters: ['CodeMirror-lint-markers'],
          lint: true,
          tabSize: 2,
          indentUnit: 2,
          indentWithTabs: false,
          extraKeys: Object.assign({}, buildCmExtraKeysCommon({ noFullscreen: true }), {
            'Ctrl-F': 'findPersistent',
            'Cmd-F': 'findPersistent',
            'Ctrl-G': 'findNext',
            'Cmd-G': 'findNext',
            'Shift-Ctrl-G': 'findPrev',
            'Shift-Cmd-G': 'findPrev',
            'Ctrl-H': 'replace',
            'Shift-Ctrl-H': 'replaceAll',
          }),
          viewportMargin: Infinity,
        });

        if (jsonModalEditor.getWrapperElement) {
          jsonModalEditor.getWrapperElement().classList.add('xkeen-cm');
        }
      }

      jsonModalEditor.setValue(finalText || '');
      setTimeout(() => jsonModalEditor.refresh(), 0);
      jsonModalEditor.focus();
    } else {
      textarea.value = finalText || '';
    }

    modal.classList.remove('hidden');
  } catch (e) {
    console.error(e);
    if (errorEl) errorEl.textContent = 'Ошибка загрузки конфига.';
  }
}

function closeJsonEditor() {
  const modal = document.getElementById('json-editor-modal');
  const errorEl = document.getElementById('json-editor-error');
  if (modal) modal.classList.add('hidden');
  if (errorEl) errorEl.textContent = '';
  jsonModalCurrentTarget = null;
}

async function saveJsonEditor() {
  const modal = document.getElementById('json-editor-modal');
  const errorEl = document.getElementById('json-editor-error');
  const textarea = document.getElementById('json-editor-textarea');

  if (!jsonModalCurrentTarget) return;

  const target = jsonModalCurrentTarget;
  let text;

  if (jsonModalEditor) {
    text = jsonModalEditor.getValue();
  } else if (textarea) {
    text = textarea.value || '';
  } else {
    return;
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (e) {
    if (errorEl) errorEl.textContent = 'Ошибка парсинга JSON: ' + e.message;
    return;
  }

  const url = target === 'inbounds' ? '/api/inbounds' : '/api/outbounds';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config,
        restart: shouldAutoRestartAfterSave(),
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (errorEl) {
        errorEl.textContent =
          'Ошибка сохранения: ' + ((data && data.error) || 'неизвестная ошибка');
      }
      return;
    }

    if (modal) modal.classList.add('hidden');
    jsonModalCurrentTarget = null;
    if (errorEl) errorEl.textContent = '';

    try {
      if (target === 'inbounds') {
        loadInboundsMode();
      } else {
        loadOutbounds();
      }
    } catch (e) {
      console.error(e);
    }

    showToast(
      target === 'inbounds'
        ? '03_inbounds.json сохранён.'
        : '04_outbounds.json сохранён.'
    );
  } catch (e) {
    console.error(e);
    if (errorEl) errorEl.textContent = 'Ошибка сохранения.';
  } finally {
    loadRestartLog();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Initialize backend-reported capabilities (WebSocket support, etc.)
  initCapabilities();
  const xkeenStartBtn = document.getElementById('xkeen-start-btn');
  const xkeenStopBtn = document.getElementById('xkeen-stop-btn');
  const xkeenRestartBtn = document.getElementById('xkeen-restart-btn');

  if (xkeenStartBtn) xkeenStartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    controlXkeen('start');
  });
  if (xkeenStopBtn) xkeenStopBtn.addEventListener('click', (e) => {
    e.preventDefault();
    controlXkeen('stop');
  });
  if (xkeenRestartBtn) xkeenRestartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (xkeenRestartBtn.disabled) return;
    xkeenRestartBtn.disabled = true;
    xkeenRestartBtn.classList.add('loading');
    const p = controlXkeen('restart');
    if (p && typeof p.finally === 'function') {
      p.finally(() => {
        xkeenRestartBtn.disabled = false;
        xkeenRestartBtn.classList.remove('loading');
      });
    } else {
      // safety fallback
      setTimeout(() => {
        xkeenRestartBtn.disabled = false;
        xkeenRestartBtn.classList.remove('loading');
      }, 2500);
    }
  });

  // Управление выбором ядра (modal)
  const coreTextEl = document.getElementById('xkeen-core-text');
  const coreModal = document.getElementById('core-modal');
  const coreModalCloseBtn = document.getElementById('core-modal-close-btn');
  const coreModalCancelBtn = document.getElementById('core-modal-cancel-btn');
  const coreModalConfirmBtn = document.getElementById('core-modal-confirm-btn');
  const coreOptionButtons = document.querySelectorAll('#core-modal .core-option');

  if (coreTextEl) {
    coreTextEl.addEventListener('click', (e) => {
      e.preventDefault();
      openXkeenCoreModal();
    });
  }
  if (coreModalCloseBtn) {
    coreModalCloseBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeXkeenCoreModal();
    });
  }
  if (coreModalCancelBtn) {
    coreModalCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      closeXkeenCoreModal();
    });
  }
  if (coreModalConfirmBtn) {
    coreModalConfirmBtn.addEventListener('click', (e) => {
      e.preventDefault();
      confirmXkeenCoreChange();
    });
  }
  if (coreOptionButtons && coreOptionButtons.length) {
    coreOptionButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        if (btn.disabled) return;
        coreOptionButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }


  const globalAutorestartCb = document.getElementById('global-autorestart-xkeen');
  if (globalAutorestartCb) {
    try {
      if (window.localStorage) {
        const stored = localStorage.getItem('xkeen_global_autorestart');
        if (stored === '1') globalAutorestartCb.checked = true;
        else if (stored === '0') globalAutorestartCb.checked = false;
      }
    } catch (e) {
      // ignore localStorage errors
    }

    globalAutorestartCb.addEventListener('change', () => {
      try {
        if (!window.localStorage) return;
        localStorage.setItem('xkeen_global_autorestart', globalAutorestartCb.checked ? '1' : '0');
      } catch (e) {
        // ignore
      }
    });
  }

  const cmExtraKeysCommon = buildCmExtraKeysCommon();


  const routingTextarea = document.getElementById('routing-editor');
  if (routingTextarea && window.CodeMirror) {
    routingEditor = CodeMirror.fromTextArea(routingTextarea, {
      mode: { name: 'javascript', json: true },
      theme: 'material-darker',
      lineNumbers: true,
      styleActiveLine: true,
          showIndentGuides: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      highlightSelectionMatches: true,
      showTrailingSpace: true,
      rulers: [{ column: 120 }],
      lineWrapping: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter', 'CodeMirror-lint-markers'],
      lint: true,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: Object.assign({}, cmExtraKeysCommon, {
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      }),
      // Render all lines to avoid internal virtual scrolling glitches
      viewportMargin: Infinity,
    });
    // Slightly smaller minimum height for compact screens
    if (routingEditor.getWrapperElement) {
      routingEditor.getWrapperElement().classList.add('xkeen-cm');
      xkeenAttachCmToolbar(routingEditor, XKEEN_CM_TOOLBAR_DEFAULT);
    }
    routingEditor.on('change', () => {
      validateRoutingContent();
    });
  }


  const portProxyingTextarea = document.getElementById('port-proxying-editor');
  const portExcludeTextarea = document.getElementById('port-exclude-editor');
  const ipExcludeTextarea = document.getElementById('ip-exclude-editor');

  // XKeen ports/exclusions are simple list editors.
  // Keep CodeMirror config minimal here to avoid requiring extra addons
  // (fold/search/closebrackets/highlightSelectionMatches, etc.).
  const xkeenBasicEditorOpts = {
    mode: 'shell',
    theme: 'material-darker',
    lineNumbers: true,
    styleActiveLine: true,
    showIndentGuides: true,
    matchBrackets: true,
    showTrailingSpace: true,
    lineWrapping: true,
    tabSize: 2,
    indentUnit: 2,
    indentWithTabs: false,
    extraKeys: buildCmExtraKeysCommon({ noFullscreen: true }),
    // Render all lines to avoid internal virtual scrolling glitches
    viewportMargin: Infinity,
  };

  if (portProxyingTextarea && window.CodeMirror) {
    portProxyingEditor = CodeMirror.fromTextArea(portProxyingTextarea, { ...xkeenBasicEditorOpts });
    portProxyingEditor.getWrapperElement().classList.add('xkeen-cm');
  }
  if (portExcludeTextarea && window.CodeMirror) {
    portExcludeEditor = CodeMirror.fromTextArea(portExcludeTextarea, { ...xkeenBasicEditorOpts });
    portExcludeEditor.getWrapperElement().classList.add('xkeen-cm');
  }
  if (ipExcludeTextarea && window.CodeMirror) {
    ipExcludeEditor = CodeMirror.fromTextArea(ipExcludeTextarea, { ...xkeenBasicEditorOpts });
    ipExcludeEditor.getWrapperElement().classList.add('xkeen-cm');
  }


  const mihomoTextarea = document.getElementById('mihomo-editor');
  if (mihomoTextarea && window.CodeMirror) {
    mihomoEditor = CodeMirror.fromTextArea(mihomoTextarea, {
      mode: 'yaml',
      theme: 'material-darker',
      lineNumbers: true,
      styleActiveLine: true,
          showIndentGuides: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      highlightSelectionMatches: true,
      showTrailingSpace: true,
      rulers: [{ column: 100 }],
      lineWrapping: true,
      foldGutter: true,
      gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      extraKeys: Object.assign({}, cmExtraKeysCommon, {
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-G': 'findNext',
        'Cmd-G': 'findNext',
        'Shift-Ctrl-G': 'findPrev',
        'Shift-Cmd-G': 'findPrev',
        'Ctrl-H': 'replace',
        'Shift-Ctrl-H': 'replaceAll',
      }),
      // Render all lines and rely on outer scroll to avoid broken scrollbars
      viewportMargin: Infinity,
    });
    if (mihomoEditor.getWrapperElement) {
      mihomoEditor.getWrapperElement().classList.add('xkeen-cm');
      xkeenAttachCmToolbar(mihomoEditor, XKEEN_CM_TOOLBAR_DEFAULT);
    }
  }

  const saveBtn = document.getElementById('routing-save-btn');
  const backupBtn = document.getElementById('routing-backup-btn');
  const routingRestoreAutoBtn = document.getElementById('routing-restore-auto-btn');
  const restartBtn = document.getElementById('routing-restart-btn');
  const fmtBtn = document.getElementById('routing-format-btn');
  const githubExportBtn = document.getElementById('github-export-btn');
  const githubOpenCatalogBtn = document.getElementById('github-open-catalog-btn');
  const localExportBtn = document.getElementById('routing-export-local-btn');
  const localImportBtn = document.getElementById('routing-import-local-btn');
  const localConfigFileInput = document.getElementById('local-config-file-input');
  const routingHelpLine = document.getElementById('routing-help-line');


const inboundsSaveBtn = document.getElementById('inbounds-save-btn');
  const inboundsBackupBtn = document.getElementById('inbounds-backup-btn');
  const inboundsRestoreAutoBtn = document.getElementById('inbounds-restore-auto-btn');
  const inboundsOpenEditorBtn = document.getElementById('inbounds-open-editor-btn');

  const outboundsSaveBtn = document.getElementById('outbounds-save-btn');
  const outboundsBackupBtn = document.getElementById('outbounds-backup-btn');
  const outboundsRestoreAutoBtn = document.getElementById('outbounds-restore-auto-btn');
  const outboundsOpenEditorBtn = document.getElementById('outbounds-open-editor-btn');

  const jsonEditorCloseBtn = document.getElementById('json-editor-close-btn');
  const jsonEditorCancelBtn = document.getElementById('json-editor-cancel-btn');
  const jsonEditorSaveBtn = document.getElementById('json-editor-save-btn');

  const inboundsBody = document.getElementById('inbounds-body');
  const inboundsArrow = document.getElementById('inbounds-arrow');
  const outboundsBody = document.getElementById('outbounds-body');
  const outboundsArrow = document.getElementById('outbounds-arrow');

  // Инициализация состояния сворачиваемых блоков inbounds/outbounds с учётом localStorage
  if (inboundsBody && inboundsArrow) {
    let inbOpen = false;
    try {
      if (window.localStorage) {
        const stored = localStorage.getItem('xkeen_inbounds_open');
        if (stored === '1') inbOpen = true;
        else if (stored === '0') inbOpen = false;
      }
    } catch (e) {
      // ignore
    }
    inboundsBody.style.display = inbOpen ? 'block' : 'none';
    inboundsArrow.textContent = inbOpen ? '▲' : '▼';
  }

  if (outboundsBody && outboundsArrow) {
    let outOpen = false;
    try {
      if (window.localStorage) {
        const stored = localStorage.getItem('xkeen_outbounds_open');
        if (stored === '1') outOpen = true;
        else if (stored === '0') outOpen = false;
      }
    } catch (e) {
      // ignore
    }
    outboundsBody.style.display = outOpen ? 'block' : 'none';
    outboundsArrow.textContent = outOpen ? '▲' : '▼';
  }

const mihomoLoadBtn = document.getElementById('mihomo-load-btn');
  const mihomoSaveBtn = document.getElementById('mihomo-save-btn');
  const mihomoTemplateBtn = document.getElementById('mihomo-template-btn');
  const mihomoRestartBtn = document.getElementById('mihomo-restart-btn');
  const mihomoConfiguratorBtn = document.getElementById('mihomo-configurator-btn');
  const mihomoTemplatesRefreshBtn = document.getElementById('mihomo-templates-refresh-btn');
  const mihomoProfilesLink = document.getElementById('mihomo-profiles-link');
  const mihomoTemplateLoadBtn = document.getElementById('mihomo-template-load-btn');
  const mihomoTemplateSaveFromEditorBtn = document.getElementById('mihomo-template-savefromeditor-btn');



  const portProxyingSaveBtn = document.getElementById('port-proxying-save-btn');
  const portExcludeSaveBtn = document.getElementById('port-exclude-save-btn');
  const ipExcludeSaveBtn = document.getElementById('ip-exclude-save-btn');

  if (routingHelpLine) routingHelpLine.addEventListener('click', (e) => {
    e.preventDefault();
    openRoutingHelp();
  });

  if (saveBtn) saveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (validateRoutingContent()) {
      saveRouting();
    }
  });
  if (backupBtn) backupBtn.addEventListener('click', (e) => {
    e.preventDefault();
    createBackup();
  });
  if (routingRestoreAutoBtn) routingRestoreAutoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restoreFromAutoBackup('routing');
  });
  if (restartBtn) restartBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restartXkeen();
  });
  if (fmtBtn) fmtBtn.addEventListener('click', (e) => {
    e.preventDefault();
    autoFormatRouting();
  });

  if (localExportBtn) localExportBtn.addEventListener('click', (e) => {
    e.preventDefault();
    exportUserConfigsToFile();
  });

  if (localImportBtn && localConfigFileInput) {
    localImportBtn.addEventListener('click', (e) => {
      e.preventDefault();
      localConfigFileInput.value = '';
      localConfigFileInput.click();
    });

    localConfigFileInput.addEventListener('change', () => {
      const file = localConfigFileInput.files && localConfigFileInput.files[0];
      if (!file) return;
      importUserConfigsFromFile(file);
    });
  }


if (githubExportBtn) githubExportBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openGithubExportModal();
  });

  if (githubOpenCatalogBtn) githubOpenCatalogBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openGithubCatalogModal();
  });

  const githubCatalogCloseBtn = document.getElementById('github-catalog-close-btn');
  if (githubCatalogCloseBtn) githubCatalogCloseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeGithubCatalogModal();
  });


  const githubCatalogCloseBtnHeader = document.getElementById('github-catalog-close-btn-header');
  if (githubCatalogCloseBtnHeader) githubCatalogCloseBtnHeader.addEventListener('click', (e) => {
    e.preventDefault();
    closeGithubCatalogModal();
  });

  const githubExportCancelBtnHeader = document.getElementById('github-export-cancel-btn-header');
  if (githubExportCancelBtnHeader) githubExportCancelBtnHeader.addEventListener('click', (e) => {
    e.preventDefault();
    closeGithubExportModal();
  });
  const githubExportConfirmBtn = document.getElementById('github-export-confirm-btn');
  if (githubExportConfirmBtn) githubExportConfirmBtn.addEventListener('click', (e) => {
    e.preventDefault();
    exportUserConfigsToGithub();
  });

  const githubExportCancelBtn = document.getElementById('github-export-cancel-btn');
  if (githubExportCancelBtn) githubExportCancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeGithubExportModal();
  });
  if (inboundsSaveBtn) inboundsSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveInboundsMode();
  });
  if (inboundsBackupBtn) inboundsBackupBtn.addEventListener('click', (e) => {
    e.preventDefault();
    createInboundsBackup();
  });
  if (inboundsRestoreAutoBtn) inboundsRestoreAutoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restoreFromAutoBackup('inbounds');
  });
  if (inboundsOpenEditorBtn) inboundsOpenEditorBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openJsonEditor('inbounds');
  });

  if (outboundsSaveBtn) outboundsSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveOutbounds();
  });
  if (outboundsBackupBtn) outboundsBackupBtn.addEventListener('click', (e) => {
    e.preventDefault();
    createOutboundsBackup();
  });
  if (outboundsRestoreAutoBtn) outboundsRestoreAutoBtn.addEventListener('click', (e) => {
    e.preventDefault();
    restoreFromAutoBackup('outbounds');
  });
  if (outboundsOpenEditorBtn) outboundsOpenEditorBtn.addEventListener('click', (e) => {
    e.preventDefault();
    openJsonEditor('outbounds');
  });

  if (jsonEditorCloseBtn) jsonEditorCloseBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeJsonEditor();
  });
  if (jsonEditorCancelBtn) jsonEditorCancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    closeJsonEditor();
  });
  if (jsonEditorSaveBtn) jsonEditorSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveJsonEditor();
  });

  if (mihomoSaveBtn) mihomoSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveMihomoConfig();
  });
  if (mihomoTemplateBtn) mihomoTemplateBtn.addEventListener('click', (e) => {
    e.preventDefault();
    newMihomoConfigFromTemplate();
  });
  if (mihomoConfiguratorBtn) mihomoConfiguratorBtn.addEventListener('click', (e) => {
    e.preventDefault();
    const url = mihomoConfiguratorBtn.dataset.configuratorUrl || '/static/mihomo-configurator.html';
    window.open(url, '_blank');
  });
  if (mihomoProfilesLink && mihomoConfiguratorBtn) mihomoProfilesLink.addEventListener('click', (e) => {
    e.preventDefault();
    const baseUrl = mihomoConfiguratorBtn.dataset.configuratorUrl || '/static/mihomo-configurator.html';
    const url = baseUrl + '#profiles';
    window.open(url, '_blank');
  });

  if (mihomoTemplatesRefreshBtn) mihomoTemplatesRefreshBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loadMihomoTemplatesList();
  });
  if (mihomoTemplateLoadBtn) mihomoTemplateLoadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loadSelectedMihomoTemplateToEditor();
  });
  if (mihomoTemplateSaveFromEditorBtn) mihomoTemplateSaveFromEditorBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveEditorAsMihomoTemplate();
  });


  if (portProxyingSaveBtn) portProxyingSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    savePortProxying();
  });
  if (portExcludeSaveBtn) portExcludeSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    savePortExclude();
  });
  if (ipExcludeSaveBtn) ipExcludeSaveBtn.addEventListener('click', (e) => {
    e.preventDefault();
    saveIpExclude();
  });


    loadRouting();
  loadInboundsMode();
  loadOutbounds();
  loadBackups();
  loadRestartLog();
  initCommandClicks();

  const terminalInput = document.getElementById('terminal-input');
  if (terminalInput) {
    terminalInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        sendTerminalInput();
      }
    });
  }

  loadMihomoConfig();
  loadMihomoTemplatesList();

  if (mihomoRestartBtn) mihomoRestartBtn.addEventListener('click', async (e)=>{
    e.preventDefault();
    await fetch('/api/restart-xkeen',{method:'POST'});
  });

  loadPortProxying();
  loadPortExclude();
  loadIpExclude();
  refreshXrayLogStatus();

  // Статус сервиса xkeen в шапке
  refreshXkeenServiceStatus();
  setInterval(() => {
    refreshXkeenServiceStatus();
  }, 15000);
});



document.addEventListener('DOMContentLoaded', () => {
  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const historyBtn = document.getElementById('terminal-history-btn');
  const searchEl = document.getElementById('terminal-search-input');

  // Загрузка сохранённой истории команд
  try {
    loadTerminalHistory();
  } catch (e) {
    // ignore
  }

  if (cmdEl) {
    cmdEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        // Отправляем команду так же, как по кнопке "Отправить"
        void sendTerminalInput();
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        hideTerminal();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        // Очистка терминала (Ctrl+L)
        if (typeof Terminal !== 'undefined') {
          const term = initXkeenTerm();
          if (term && typeof term.clear === 'function') {
            term.clear();
          }
        }
        const out = document.getElementById('terminal-output');
        if (out && !out.querySelector('.xterm')) {
          out.textContent = '';
        }
        return;
      }

      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        if (!terminalHistory.length) return;
        e.preventDefault();

        if (e.key === 'ArrowUp') {
          if (terminalHistoryIndex <= 0) {
            terminalHistoryIndex = 0;
          } else {
            terminalHistoryIndex -= 1;
          }
        } else {
          // ArrowDown
          if (terminalHistoryIndex < 0) {
            return;
          } else if (terminalHistoryIndex >= terminalHistory.length - 1) {
            terminalHistoryIndex = terminalHistory.length;
            cmdEl.value = '';
            return;
          } else {
            terminalHistoryIndex += 1;
          }
        }

        if (terminalHistoryIndex >= 0 && terminalHistoryIndex < terminalHistory.length) {
          cmdEl.value = terminalHistory[terminalHistoryIndex];
          const len = cmdEl.value.length;
          try {
            cmdEl.setSelectionRange(len, len);
          } catch (e2) {
            // ignore
          }
        }
      }
    });
  }

  // Terminal search UI (xterm-addon-search)
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      try { terminalSearchDebouncedHighlight(); } catch (e) {}
    });
    searchEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) terminalSearchPrev();
        else terminalSearchNext();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        terminalSearchClear({ silent: true });
        try { xkeenTerm && xkeenTerm.focus && xkeenTerm.focus(); } catch (e2) {}
        return;
      }
    });
  }

  // Global search hotkeys while terminal is open
  if (!xkeenTerminalSearchKeysBound) {
    xkeenTerminalSearchKeysBound = true;
    document.addEventListener('keydown', (e) => {
      try {
        if (!terminalIsOpen()) return;
        // Ctrl+F / Cmd+F
        if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
          e.preventDefault();
          terminalSearchFocus(true);
          try { terminalSearchDebouncedHighlight(); } catch (e2) {}
          return;
        }
        // F3 / Shift+F3
        if (e.key === 'F3') {
          e.preventDefault();
          if (e.shiftKey) terminalSearchPrev();
          else terminalSearchNext();
          return;
        }
      } catch (e2) {
        // ignore
      }
    }, true);
  }

  if (historyBtn) {
    historyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!terminalHistory.length) {
        alert('История команд пуста.');
        return;
      }
      const lines = terminalHistory.slice().reverse().join('\n');
      alert(lines);
    });
  }
});


// ---------- Mihomo generator: VLESS/WireGuard → proxy, proxy-groups, profiles & backups ----------

function getMihomoEditorText() {
  if (typeof mihomoEditor !== 'undefined' && mihomoEditor) {
    return mihomoEditor.getValue();
  }
  const ta = document.getElementById('mihomo-editor');
  return ta ? ta.value : '';
}

function setMihomoEditorText(text) {
  if (typeof mihomoEditor !== 'undefined' && mihomoEditor) {
    mihomoEditor.setValue(text || '');
    mihomoEditor.scrollTo(0, 0);
  } else {
    const ta = document.getElementById('mihomo-editor');
    if (ta) ta.value = text || '';
  }
}

function setMihomoStatus(msg, isError) {
  const el = document.getElementById('mihomo-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = isError ? '#f87171' : '#9ca3af';
}



function mihomoFormatLogHtml(text) {
  if (!text) return "";
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  return lines.map((line) => {
    const safe = escapeHtml(line);
    let cls = "log-line";
    if (/fatal|panic/i.test(line)) cls += " log-fatal";
    else if (/error|\berr\b|err\[/i.test(line)) cls += " log-error";
    else if (/warn/i.test(line)) cls += " log-warn";
    else if (/info/i.test(line)) cls += " log-info";
    else if (/debug/i.test(line)) cls += " log-debug";
    return '<div class="' + cls + '">' + (safe || "&nbsp;") + "</div>";
  }).join("");
}

function showMihomoValidationModal(text) {
  const modal = document.getElementById('mihomo-validation-modal');
  const body = document.getElementById('mihomo-validation-modal-body');
  if (!modal || !body) return;

  const raw = text == null ? '' : String(text);
  body.innerHTML = mihomoFormatLogHtml(raw);

  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function hideMihomoValidationModal() {
  const modal = document.getElementById('mihomo-validation-modal');
  if (!modal) return;

  modal.classList.add('hidden');
  document.body.classList.remove('modal-open');
}

window.hideMihomoValidationModal = hideMihomoValidationModal;

async function validateMihomoConfigFromEditor() {
  const ta = document.getElementById('mihomo-editor');
  const content = (typeof mihomoEditor !== 'undefined' && mihomoEditor)
    ? mihomoEditor.getValue()
    : (ta ? ta.value : '');
  if (!content || !content.trim()) {
    setMihomoStatus('config.yaml пустой, проверять нечего.', true);
    return;
  }

  setMihomoStatus('Проверяю конфиг через mihomo...', false);

  try {
    const res = await fetch('/api/mihomo/validate_raw', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: content }),
    });
    const data = await res.json();
    const log = data && data.log ? data.log : '';
    if (typeof log === 'string' && log.trim()) {
      showMihomoValidationModal(log);
    }

    if (!res.ok) {
      setMihomoStatus('Ошибка проверки конфига: ' + (data && (data.error || res.status)), true);
      return;
    }

    const firstLine = (log.split('\n').find((l) => l.trim()) || '').trim();
    if (data.ok) {
      const msg = firstLine || 'mihomo сообщает, что конфиг валиден (exit code 0).';
      setMihomoStatus(msg, false);
    } else {
      const msg = firstLine || 'mihomo сообщил об ошибке при проверке конфига.';
      setMihomoStatus('В таком виде конфиг не будет работать: ' + msg, true);
    }
  } catch (e) {
    setMihomoStatus('Ошибка сети при проверке конфига: ' + e, true);
  }
}

async function saveMihomoAndRestart() {
  const ta = document.getElementById('mihomo-editor');
  const content = (typeof mihomoEditor !== 'undefined' && mihomoEditor)
    ? mihomoEditor.getValue()
    : (ta ? ta.value : '');
  if (!content.trim()) {
    setMihomoStatus('config.yaml пустой, сохранять нечего.', true);
    return;
  }
  setMihomoStatus('Сохранение config.yaml и перезапуск mihomo...');
  try {
    const res = await fetch('/api/mihomo-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, restart: true }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setMihomoStatus((data && data.error) || 'Ошибка сохранения config.yaml.', true);
      return;
    }
    let msg = 'config.yaml сохранён.';
    if (data.restarted) {
      msg += ' xkeen перезапущен.';
    }
    setMihomoStatus(msg, false);
  } catch (e) {
    console.error(e);
    setMihomoStatus('Ошибка сохранения config.yaml.', true);
  }
}


function updateMihomoBackupsFilterUI() {
  const label = document.getElementById('mihomo-backups-active-profile-label');
  const checkbox = document.getElementById('mihomo-backups-active-only');
  if (!label || !checkbox) return;
  if (mihomoActiveProfileName) {
    label.textContent = 'Активный профиль: ' + mihomoActiveProfileName;
    checkbox.disabled = false;
  } else {
    label.textContent = 'Активный профиль не выбран';
    checkbox.disabled = true;
  }
}

function getMihomoBackupsFilterProfile() {
  const checkbox = document.getElementById('mihomo-backups-active-only');
  if (!checkbox || !checkbox.checked) return null;
  if (!mihomoActiveProfileName) return null;
  return mihomoActiveProfileName;
}

function formatMihomoBackupDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  try {
    return d.toLocaleString();
  } catch (e) {
    return value;
  }
}

function parseMihomoBackupFilename(filename) {
  // Ожидаем: <base>_YYYYMMDD_HHMMSS.yaml
  const m = filename && filename.match(/^(.+?)_(\d{8})_(\d{6})\.yaml$/);
  if (!m) {
    return { profile: null, created: null };
  }

  const base = m[1];
  const profile = base.endsWith('.yaml') ? base : base + '.yaml';

  let created = null;
  try {
    const year = Number(m[2].slice(0, 4));
    const month = Number(m[2].slice(4, 6)) - 1; // 0–11
    const day = Number(m[2].slice(6, 8));
    const hours = Number(m[3].slice(0, 2));
    const minutes = Number(m[3].slice(2, 4));
    const seconds = Number(m[3].slice(4, 6));
    const d = new Date(year, month, day, hours, minutes, seconds);
    if (!Number.isNaN(d.getTime())) {
      created = d;
    }
  } catch (e) {
    created = null;
  }

  return { profile, created };
}

async function mihomoLoadProfiles() {
  const tbody = document.getElementById('mihomo-profiles-list');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="3">Загрузка...</td></tr>';

  try {
    const res = await fetch('/api/mihomo/profiles');
    const data = await res.json();
    if (!Array.isArray(data)) {
      tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    mihomoActiveProfileName = null;
    data.forEach((p) => {
      const tr = document.createElement('tr');
      tr.dataset.name = p.name;
      if (p.is_active) {
        mihomoActiveProfileName = p.name;
      }
      tr.innerHTML = [
        '<td>' + p.name + '</td>',
        '<td>' + (p.is_active ? 'да' : '') + '</td>',
        '<td>' +
          '<button data-action="load" title="В редактор">📥</button> ' +
          '<button data-action="activate">✅ Активировать</button> ' +
          '<button data-action="delete">🗑️ Удалить</button>' +
        '</td>',
      ].join('');
      tbody.appendChild(tr);
    });
    updateMihomoBackupsFilterUI();
  } catch (e) {
    console.error(e);
    tbody.innerHTML = '<tr><td colspan="3">Ошибка загрузки профилей</td></tr>';
  }
}

async function mihomoLoadBackups() {
  const tbody = document.getElementById('mihomo-backups-list');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4">Загрузка...</td></tr>';

  try {
    let url = '/api/mihomo/backups';
    const profile = getMihomoBackupsFilterProfile();
    if (profile) {
      url += '?profile=' + encodeURIComponent(profile);
    }
    const res = await fetch(url);
    const data = await res.json();
    if (!Array.isArray(data)) {
      tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    data.forEach((b) => {
      const tr = document.createElement('tr');
      tr.dataset.filename = b.filename;

      const created = formatMihomoBackupDate(b.created_at);

      const isOwnProfile =
        !mihomoActiveProfileName ||
        !b.profile ||
        mihomoActiveProfileName === b.profile;

      const restoreAttrs = isOwnProfile
        ? ' title="Восстановить"'
        : ' disabled title="Восстановить: активный профиль (' + mihomoActiveProfileName +
          ') не совпадает с профилем бэкапа (' + b.profile + ')"';

      tr.innerHTML = [
        '<td>' +
          '<div class="backup-filename-marquee" title="' + b.filename + '">' +
            '<span class="backup-filename-marquee-inner">' + b.filename + '</span>' +
          '</div>' +
        '</td>',
        '<td>' + (b.profile || '') + '</td>',
        '<td>' + created + '</td>',
        '<td>' +
          '<button data-action="preview" title="В редактор">👁️</button> ' +
          '<button data-action="restore"' + restoreAttrs + '>⏪</button> ' +
          '<button data-action="delete" title="Удалить бэкап">🗑️</button>' +
        '</td>',
      ].join('');
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
    tbody.innerHTML = '<tr><td colspan="4">Ошибка загрузки бэкапов</td></tr>';
  }
}

async function mihomoCreateProfileFromEditor() {
  const nameInput = document.getElementById('mihomo-new-profile-name');
  const name = (nameInput && nameInput.value || '').trim();
  const cfg = getMihomoEditorText().trim();

  if (!name || !cfg) {
    setMihomoStatus('Имя профиля и config.yaml не должны быть пустыми.', true);
    return;
  }

  try {
    const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: cfg,
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      setMihomoStatus(data.error || 'Ошибка создания профиля.', true);
      return;
    }
    setMihomoStatus('Профиль ' + name + ' создан.', false);
    mihomoLoadProfiles();
  } catch (e) {
    console.error(e);
    setMihomoStatus('Ошибка создания профиля.', true);
  }
}

function attachMihomoProfilesHandlers() {
  const tbody = document.getElementById('mihomo-profiles-list');
  if (!tbody) return;
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    const name = tr && tr.dataset.name;
    const action = btn.dataset.action;
    if (!name || !action) return;

    if (action === 'load') {
      try {
        const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name));
        const text = await res.text();
        if (!res.ok) {
          setMihomoStatus('Ошибка загрузки профиля ' + name, true);
          return;
        }
        setMihomoEditorText(text);
        setMihomoStatus('Профиль ' + name + ' загружен в редактор.', false);
      } catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка загрузки профиля.', true);
      }
    } else if (action === 'activate') {
      try {
        const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name) + '/activate', {
  method: 'POST',
});
const data = await res.json();
if (!res.ok || data.error) {
  setMihomoStatus(data.error || 'Ошибка активации профиля.', true);
  return;
}
let msg = 'Профиль ' + name + ' активирован.';
if (data.restarted) {
  msg += ' xkeen перезапущен.';
}
setMihomoStatus(msg, false);
mihomoLoadProfiles();
} catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка активации профиля.', true);
      }
    } else if (action === 'delete') {
      if (!window.confirm('Удалить профиль ' + name + '?')) return;
      try {
        const res = await fetch('/api/mihomo/profiles/' + encodeURIComponent(name), {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMihomoStatus(data.error || 'Ошибка удаления профиля.', true);
          return;
        }
        setMihomoStatus('Профиль ' + name + ' удалён.', false);
        mihomoLoadProfiles();
      } catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка удаления профиля.', true);
      }
    }
  });
}

function attachMihomoBackupsHandlers() {
  const tbody = document.getElementById('mihomo-backups-list');
  if (!tbody) return;
  tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    const tr = btn.closest('tr');
    const filename = tr && tr.dataset.filename;
    const action = btn.dataset.action;
    if (!filename || !action) return;

    if (action === 'preview') {
      try {
        const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename));
        const text = await res.text();
        if (!res.ok) {
          setMihomoStatus('Ошибка загрузки бэкапа ' + filename, true);
          return;
        }
        setMihomoEditorText(text);

        const info = parseMihomoBackupFilename(filename);
        let msg = 'Бэкап';

        if (info.profile) {
          msg += ' профиля ' + info.profile;
        } else {
          msg += ' ' + filename;
        }

        if (info.created instanceof Date && !Number.isNaN(info.created.getTime())) {
          try {
            msg += ' от ' + info.created.toLocaleString();
          } catch (e) {
            // игнорируем, если браузер что-то не умеет
          }
        }

        msg += ' загружен в редактор (не применён).';

        setMihomoStatus(msg, false);
      } catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка загрузки бэкапа.', true);
      }
    } else if (action === 'restore') {
      if (!window.confirm('Восстановить конфиг из бэкапа ' + filename + '?')) return;
      try {
        const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename) + '/restore', {
          method: 'POST',
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          setMihomoStatus(data.error || 'Ошибка восстановления бэкапа.', true);
          return;
        }
        let msg = 'Бэкап ' + filename + ' восстановлен.';
        if (data.restarted) {
          msg += ' xkeen перезапущен.';
        } else {
          msg += ' Загрузите config.yaml ещё раз.';
        }
        setMihomoStatus(msg, false);
      } catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка восстановления бэкапа.', true);
      }
    } else if (action === 'delete') {
      if (!window.confirm('Удалить бэкап ' + filename + '? Это действие необратимо.')) return;
      try {
        const res = await fetch('/api/mihomo/backups/' + encodeURIComponent(filename), {
          method: 'DELETE',
        });
        let data = null;
        try {
          data = await res.json();
        } catch (e) {
          data = null;
        }
        if (!res.ok || (data && data.error)) {
          const msg = (data && data.error) || 'Ошибка удаления бэкапа.';
          setMihomoStatus(msg, true);
          return;
        }
        setMihomoStatus('Бэкап ' + filename + ' удалён.', false);
        // Обновим таблицу бэкапов
        mihomoLoadBackups();
      } catch (err) {
        console.error(err);
        setMihomoStatus('Ошибка удаления бэкапа.', true);
      }
    }
  });
}


async function mihomoCleanBackups() {
  const limitInput = document.getElementById('mihomo-backups-clean-limit');
  const raw = (limitInput && limitInput.value) || '5';
  let limit = parseInt(raw, 10);

  if (Number.isNaN(limit) || limit < 0) {
    setMihomoStatus('Лимит должен быть целым числом ≥ 0.', true);
    return;
  }

  const profile = getMihomoBackupsFilterProfile();

  if (!window.confirm(
    'Очистить бэкапы' +
      (profile ? ' для профиля ' + profile : ' для всех профилей') +
      ', оставив не более ' + limit + ' шт.?'
  )) {
    return;
  }

  try {
    const res = await fetch('/api/mihomo/backups/clean', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, profile }),
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      setMihomoStatus(data.error || 'Ошибка очистки бэкапов.', true);
      return;
    }

    const remaining = (data.remaining && data.remaining.length) || 0;
    let msg = 'Очистка бэкапов выполнена. Осталось ' + remaining + ' файлов.';
    if (profile) {
      msg += ' Профиль: ' + profile + '.';
    }
    setMihomoStatus(msg, false);

    mihomoLoadBackups();
  } catch (e) {
    console.error(e);
    setMihomoStatus('Ошибка очистки бэкапов.', true);
  }
}

function initMihomoGeneratorUI() {
  const loadBtn = document.getElementById('mihomo-load-btn');
  const saveRestartBtn = document.getElementById('mihomo-save-restart-btn');
  const validateBtn = document.getElementById('mihomo-validate-btn');
  const profilesHeader = document.getElementById('mihomo-profiles-link');
  const profilesPanel = document.getElementById('mihomo-profiles-panel');
  const profilesArrow = document.getElementById('mihomo-profiles-arrow');
  const refreshProfilesBtn = document.getElementById('mihomo-refresh-profiles-btn');
  const refreshBackupsBtn = document.getElementById('mihomo-refresh-backups-btn');
  const saveProfileBtn = document.getElementById('mihomo-save-profile-btn');
  const backupsFilterCheckbox = document.getElementById('mihomo-backups-active-only');
  const backupsCleanBtn = document.getElementById('mihomo-backups-clean-btn');

  if (loadBtn) {
    loadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      loadMihomoConfig();
    });
  }

  if (saveRestartBtn) {
    saveRestartBtn.addEventListener('click', (e) => {
      e.preventDefault();
      saveMihomoAndRestart();
    });
  }

  if (validateBtn) {
    validateBtn.addEventListener('click', (e) => {
      e.preventDefault();
      validateMihomoConfigFromEditor();
    });
  }

  if (profilesHeader && profilesPanel) {
    profilesHeader.addEventListener('click', async (e) => {
      e.preventDefault();
      const visible = profilesPanel.style.display !== 'none';
      profilesPanel.style.display = visible ? 'none' : 'block';
      if (profilesArrow) {
        profilesArrow.textContent = visible ? '▼' : '▲';
      }
      if (!visible) {
        await mihomoLoadProfiles();
        await mihomoLoadBackups();
      }
    });
  }

  if (refreshProfilesBtn) {
    refreshProfilesBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mihomoLoadProfiles();
    });
  }

  if (refreshBackupsBtn) {
    refreshBackupsBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mihomoLoadBackups();
    });
  }

  
  if (backupsCleanBtn) {
    backupsCleanBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mihomoCleanBackups();
    });
  }

  if (backupsFilterCheckbox) {
    backupsFilterCheckbox.addEventListener('change', () => {
      mihomoLoadBackups();
    });
  }

  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', (e) => {
      e.preventDefault();
      mihomoCreateProfileFromEditor();
    });
  }

  attachMihomoProfilesHandlers();
  attachMihomoBackupsHandlers();
}
window.addEventListener('DOMContentLoaded', initMihomoGeneratorUI);


document.addEventListener('DOMContentLoaded', () => {
  const filterEl = document.getElementById('xray-log-filter');
  const clearBtn = document.getElementById('xray-log-filter-clear');

  if (filterEl) {
    filterEl.addEventListener('input', () => {
      applyXrayLogFilterToOutput();
    });

    filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        filterEl.blur();
      }
    });
  }

  if (clearBtn && filterEl) {
    clearBtn.addEventListener('click', () => {
      filterEl.value = '';
      applyXrayLogFilterToOutput();
      filterEl.focus();
    });
  }
});

// === Theme toggle ===
(function () {
  const THEME_KEY = 'xkeen-theme';

  function applyTheme(theme) {
    const html = document.documentElement;
    const next = theme === 'light' ? 'light' : 'dark';

    html.setAttribute('data-theme', next);

    // Sync CodeMirror theme with panel theme (light -> default, dark -> material-darker)
    const cmTheme = next === 'light' ? 'default' : 'material-darker';
    const editors = [
      routingEditor,
      portProxyingEditor,
      portExcludeEditor,
      ipExcludeEditor,
      mihomoEditor,
      jsonModalEditor,
    ];

    // Allow pages (e.g. Mihomo generator) to register extra editors
    try {
      if (window.__xkeenEditors && Array.isArray(window.__xkeenEditors)) {
        window.__xkeenEditors.forEach((cm) => editors.push(cm));
      }
    } catch (e) {}

    // De-dup & apply
    try {
      const uniq = Array.from(new Set(editors.filter(Boolean)));
      uniq.forEach((cm) => {
        if (!cm || !cm.setOption) return;
        try {
          cm.setOption('theme', cmTheme);
          if (cm.refresh) cm.refresh();
        } catch (e) {
          // ignore CodeMirror errors
        }
      });
    } catch (e) {}

    // Notify other scripts about theme changes
    try {
      document.dispatchEvent(new CustomEvent('xkeen-theme-change', { detail: { theme: next, cmTheme } }));
    } catch (e) {}


    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    btn.dataset.theme = next;

    const isLight = next === 'light';
    const icon = isLight ? '☾' : '☀';
    const label = isLight ? 'Тёмная тема' : 'Светлая тема';

    btn.innerHTML = `
      <span class="theme-toggle-icon">${icon}</span>
      <span class="theme-toggle-text">${label}</span>
    `;
  }

  function getInitialTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch (e) {
      // localStorage might be unavailable; ignore
    }

    if (window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function initThemeToggle() {
    let current = getInitialTheme();
    applyTheme(current);

    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      current = current === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_KEY, current);
      } catch (e) {}
      applyTheme(current);
    });
  }

  document.addEventListener('DOMContentLoaded', initThemeToggle);
})();

// Auto-open terminal from URL query (used by "New session" button)
document.addEventListener('DOMContentLoaded', () => {
  try {
    const url = new URL(window.location.href);
    const mode = String(url.searchParams.get('terminal') || '').toLowerCase();
    if (mode !== 'pty' && mode !== 'shell') return;

    // Let the rest of the UI initialize first.
    setTimeout(() => {
      try { openTerminal('', mode); } catch (e) {}
    }, 50);
  } catch (e) {
    // ignore
  }
});
