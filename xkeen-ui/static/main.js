let routingEditor = null;
let routingErrorMarker = null;
let mihomoEditor = null;
let mihomoActiveProfileName = null;
let portProxyingEditor = null;
let portExcludeEditor = null;
let ipExcludeEditor = null;
let jsonModalEditor = null;
let jsonModalCurrentTarget = null; // 'inbounds' или 'outbounds'


let currentCommandFlag = null;
let currentCommandLabel = null;

let xrayLogTimer = null;
let xrayLogCurrentFile = 'error';

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

let xrayLogLastLines = [];


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

  return '<span class="' + cls + '">' + processed + '</span>';
}



function openTerminalForFlag(flag, label) {
  const overlay = document.getElementById('terminal-overlay');
  const cmdEl = document.getElementById('terminal-command');
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');

  currentCommandFlag = flag || null;
  currentCommandLabel = label || (flag ? ('xkeen ' + flag) : 'xkeen');

  if (cmdEl) cmdEl.value = currentCommandLabel;
  if (inputEl) inputEl.value = '';
  if (outputEl) outputEl.textContent = '';

  if (overlay) {
    overlay.style.display = 'flex';
  }
}

function hideTerminal() {
  const overlay = document.getElementById('terminal-overlay');
  if (overlay) overlay.style.display = 'none';
  currentCommandFlag = null;
  currentCommandLabel = null;
}

async function sendTerminalInput() {
  const inputEl = document.getElementById('terminal-input');
  const outputEl = document.getElementById('terminal-output');
  const flag = currentCommandFlag;

  if (!flag) {
    if (outputEl) outputEl.textContent = 'Нет выбранной команды.';
    return;
  }

  let raw = inputEl ? inputEl.value : '';
  // Пустая строка — просто Enter, иначе добавляем перевод строки в конец
  const stdinValue = (raw === '' ? '\n' : raw + '\n');

  if (outputEl) {
    outputEl.textContent = 'Выполнение команды...';
  }

  try {
    const { res, data } = await runXkeenFlag(flag, stdinValue);
    if (!res.ok) {
      const msg = data.error || ('HTTP ' + res.status);
      if (outputEl) outputEl.textContent = 'Ошибка: ' + msg;
      appendToLog('Ошибка: ' + msg + '\n');
      return;
    }
    const rawOut = data.output || '';
    if (outputEl) {
      const html = ansiToHtml(rawOut || '(нет вывода)').replace(/\n/g, '<br>');
      outputEl.innerHTML = html;
    }
    appendToLog(`$ xkeen ${flag}\n`);
    if (rawOut) appendToLog(rawOut + '\n');
    if (typeof data.exit_code === 'number') {
      appendToLog(`(код завершения: ${data.exit_code})\n`);
    }
  } catch (e) {
    console.error(e);
    if (outputEl) outputEl.textContent = 'Ошибка выполнения команды.';
    appendToLog('Ошибка выполнения команды: ' + String(e) + '\n');
  }
}



function stripJsonComments(text) {
  let result = '';
  let inString = false;
  let stringChar = null; // '"' or '\''
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let prevChar = '';
  const length = text.length;

  for (let i = 0; i < length; i++) {
    const char = text[i];
    const nextChar = i + 1 < length ? text[i + 1] : '';

    // already inside a single-line comment
    if (inSingleLineComment) {
      if (char === '\n') {
        inSingleLineComment = false;
        result += char; // keep newline
      }
      continue;
    }

    // already inside a multi-line comment
    if (inMultiLineComment) {
      if (char === '*' && nextChar === '/') {
        inMultiLineComment = false;
        i++; // skip '/'
      }
      continue;
    }

    // inside string literal
    if (inString) {
      result += char;
      if (char === stringChar && prevChar !== '\\') {
        inString = false;
        stringChar = null;
      }
      prevChar = char;
      continue;
    }

    // not in string/comment — check for comment start
    if (char === '/' && nextChar === '/') {
      inSingleLineComment = true;
      i++; // skip second '/'
      continue;
    }
    // '#' — однострочный комментарий (вся строка до конца)
    if (char === '#') {
      inSingleLineComment = true;
      // символ '#' не добавляем в результат
      continue;
    }
    if (char === '/' && nextChar === '*') {
      inMultiLineComment = true;
      i++; // skip '*'
      continue;
    }

    // start of string
    if (char === '"' || char === '\'') {
      inString = true;
      stringChar = char;
      result += char;
      prevChar = char;
      continue;
    }

    // normal character
    result += char;
    prevChar = char;
  }

  return result;
}
function setRoutingError(msg, line) {
  const errEl = document.getElementById('routing-error');
  const saveBtn = document.getElementById('routing-save-btn');

  if (routingErrorMarker && routingEditor) {
    routingEditor.removeLineClass(routingErrorMarker, 'background', 'cm-error-line');
    routingErrorMarker = null;
  }

  if (!errEl) return;

  if (msg) {
    errEl.textContent = msg;
    if (saveBtn) saveBtn.disabled = true;
    if (routingEditor && typeof line === 'number' && line >= 0) {
      const handle = routingEditor.getLineHandle(line);
      routingEditor.addLineClass(handle, 'background', 'cm-error-line');
      routingErrorMarker = handle;
    }
  } else {
    errEl.textContent = '';
    if (saveBtn) saveBtn.disabled = false;
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
      showToast(msg, !ok);
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


async function runXkeenFlag(flag, stdinValue) {
  const body = { flag };
  if (typeof stdinValue === 'string') {
    body.stdin = stdinValue;
  }
  const res = await fetch('/api/run-command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function runInstantXkeenFlag(flag, label) {
  appendToLog(`$ xkeen ${flag}\n`);
  try {
    const { res, data } = await runXkeenFlag(flag, '\n');
    if (!res.ok) {
      const msg = data.error || ('HTTP ' + res.status);
      appendToLog('Ошибка: ' + msg + '\n');
      if (typeof showToast === 'function') {
        showToast(msg, true);
      }
      return;
    }
    const out = (data.output || '').trim();
    if (out) {
      appendToLog(out + '\n');
    } else {
      appendToLog('(нет вывода)\n');
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
  // Escape HTML special chars
  let escaped = text
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

async function fetchXrayLogsOnce() {
  const outputEl = document.getElementById('xray-log-output');
  if (!outputEl) return;

  const statusEl = document.getElementById('xray-log-status');

  const file = xrayLogCurrentFile || 'error';

  try {
    const res = await fetch(`/api/xray-logs?file=${encodeURIComponent(file)}&max_lines=800`);
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
  if (xrayLogTimer) return;
  fetchXrayLogsOnce();
  xrayLogTimer = setInterval(fetchXrayLogsOnce, 2000);
}

function stopXrayLogAuto() {
  if (xrayLogTimer) {
    clearInterval(xrayLogTimer);
    xrayLogTimer = null;
  }
}

function xrayLogsView() {
  // Одноразовая подгрузка логов из файлов
  fetchXrayLogsOnce();
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
  fetchXrayLogsOnce();
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

      // Для -start / -stop / -restart выполняем команду сразу,
      // без подтверждения и без мини-терминала – вывод идёт прямо в журнал.
      if (flag === '-start' || flag === '-stop' || flag === '-restart') {
        // не даём запускать команду повторно в течение короткого времени
        if (el.classList.contains('loading')) return;
        el.classList.add('loading');
        try {
          runInstantXkeenFlag(flag, label);
        } finally {
          // через несколько секунд снимаем блокировку и спиннер даже если сервер не ответил
          setTimeout(() => {
            el.classList.remove('loading');
          }, 7000);
        }
        return;
      }

      if (!confirm(`Выполнить команду: ${label}?`)) return;
      openTerminalForFlag(flag, label);
    });
  });
}


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
    const text = (data && data.text)
      ? data.text
      : (cfg ? JSON.stringify(cfg, null, 2) : '{}');

    textarea.value = text || '';

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


  const routingTextarea = document.getElementById('routing-editor');
  if (routingTextarea && window.CodeMirror) {
    routingEditor = CodeMirror.fromTextArea(routingTextarea, {
      mode: { name: 'javascript', json: true },
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      gutters: ['CodeMirror-lint-markers'],
      lint: true,
      // Render all lines to avoid internal virtual scrolling glitches
      viewportMargin: Infinity,
    });
    // Slightly smaller minimum height for compact screens
    if (routingEditor.getWrapperElement) {
      routingEditor.getWrapperElement().classList.add('xkeen-cm');
    }
    routingEditor.on('change', () => {
      validateRoutingContent();
    });
  }


  const portProxyingTextarea = document.getElementById('port-proxying-editor');
  const portExcludeTextarea = document.getElementById('port-exclude-editor');
  const ipExcludeTextarea = document.getElementById('ip-exclude-editor');

  if (portProxyingTextarea && window.CodeMirror) {
    portProxyingEditor = CodeMirror.fromTextArea(portProxyingTextarea, {
      mode: 'shell',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
    });
    portProxyingEditor.getWrapperElement().classList.add('xkeen-cm');
  }
  if (portExcludeTextarea && window.CodeMirror) {
    portExcludeEditor = CodeMirror.fromTextArea(portExcludeTextarea, {
      mode: 'shell',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
    });
    portExcludeEditor.getWrapperElement().classList.add('xkeen-cm');
  }
  if (ipExcludeTextarea && window.CodeMirror) {
    ipExcludeEditor = CodeMirror.fromTextArea(ipExcludeTextarea, {
      mode: 'shell',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      viewportMargin: Infinity,
    });
    ipExcludeEditor.getWrapperElement().classList.add('xkeen-cm');
  }


  const mihomoTextarea = document.getElementById('mihomo-editor');
  if (mihomoTextarea && window.CodeMirror) {
    mihomoEditor = CodeMirror.fromTextArea(mihomoTextarea, {
      mode: 'yaml',
      theme: 'material-darker',
      lineNumbers: true,
      lineWrapping: true,
      // Render all lines and rely on outer scroll to avoid broken scrollbars
      viewportMargin: Infinity,
    });
    if (mihomoEditor.getWrapperElement) {
      mihomoEditor.getWrapperElement().classList.add('xkeen-cm');
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
