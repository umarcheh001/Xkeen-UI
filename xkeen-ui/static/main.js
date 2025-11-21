let routingEditor = null;
let routingErrorMarker = null;
let mihomoEditor = null;
let portProxyingEditor = null;
let portExcludeEditor = null;
let ipExcludeEditor = null;

let currentCommandFlag = null;
let currentCommandLabel = null;

let xrayLogTimer = null;
let xrayLogCurrentFile = 'error';
let xrayLogLastLines = [];


function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getXrayLogLineClass(line) {
  const lower = (line || '').toLowerCase();
  if (lower.includes('error')) return 'log-line log-line-error';
  if (lower.includes('warning') || lower.includes('warn')) return 'log-line log-line-warning';
  if (lower.includes('info')) return 'log-line log-line-info';
  return 'log-line';
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
    const out = (data.output || '').trim();
    if (outputEl) {
      outputEl.textContent = out || '(нет вывода)';
    }
    appendToLog(`$ xkeen ${flag}\n`);
    if (out) appendToLog(out + '\n');
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
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  text = text.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return text;
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
      body: JSON.stringify({ content }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (statusEl) {
        statusEl.textContent = (data && data.error) || 'Не удалось сохранить config.yaml.';
      }
      return;
    }

    if (statusEl) {
      let msg = 'config.yaml сохранён.';
      if (data.restarted) {
        msg += ' XKeen перезапущен.';
      }
      statusEl.textContent = msg;
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения config.yaml.';
  }
}

async function newMihomoConfigFromTemplate() {
  const statusEl = document.getElementById('mihomo-status');

  const confirmed = window.confirm(
    'Заменить содержимое редактора шаблоном umarcheh001?'
  );
  if (!confirmed) return;

  if (statusEl) statusEl.textContent = 'Загрузка шаблона...';

  try {
    const res = await fetch('/api/mihomo-config/template');
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

    if (statusEl) {
      statusEl.textContent = 'Шаблон загружен в редактор. Не забудьте сохранить config.yaml.';
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
    const data = await res.json();
    if (routingEditor) {
      routingEditor.setValue(JSON.stringify(data, null, 2));
      routingEditor.scrollTo(0, 0);
    } else {
      const ta = document.getElementById('routing-editor');
      if (ta) ta.value = JSON.stringify(data, null, 2);
    }
    if (statusEl) statusEl.textContent = 'Routing загружен.';
    validateRoutingContent();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка загрузки routing.';
  }
}


async function saveRouting() {
  const statusEl = document.getElementById('routing-status');
  if (!routingEditor) return;
  const text = routingEditor.getValue();
  const cleaned = stripJsonComments(text);

  try {
    const obj = JSON.parse(cleaned);
    routingEditor.setValue(JSON.stringify(obj, null, 2));
    setRoutingError('', null);

    const res = await fetch('/api/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj)
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'Routing сохранён.';
      if (data.restarted) {
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    setRoutingError('Ошибка JSON: ' + e.message, null);
    if (statusEl) statusEl.textContent = 'Ошибка: некорректный JSON.';
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
      if (statusEl) statusEl.textContent = 'Бэкап создан: ' + data.filename;
      if (backupsStatusEl) backupsStatusEl.textContent = '';
      await loadBackups();
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка создания бэкапа.';
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
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения: ' + (data.error || 'неизвестная ошибка');
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
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'Ссылка сохранена, конфиг 04_outbounds.json обновлён.';
      if (data.restarted) {
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения outbounds.';
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
      if (statusEl) {
        const fname = data.filename || '';
        statusEl.textContent = 'Файл ' + label + ' восстановлен из авто-бэкапа ' + fname;
      }
      if (target === 'routing') {
        await loadRouting();
      } else if (target === 'inbounds') {
        await loadInboundsMode();
      } else if (target === 'outbounds') {
        await loadOutbounds();
      }
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка восстановления из авто-бэкапа: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка восстановления из авто-бэкапа.';
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
      if (statusEl) statusEl.textContent = 'Бэкап восстановлен: ' + filename;

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
      if (statusEl) statusEl.textContent = 'Ошибка восстановления: ' + (data.error || 'неизвестная ошибка');
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка восстановления бэкапа.';
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
      if (statusEl) {
        statusEl.textContent = data.error || 'Не удалось удалить бэкап.';
      }
      return;
    }

    if (statusEl) {
      statusEl.textContent = 'Бэкап удалён: ' + filename;
    }
    await loadBackups();
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка при удалении бэкапа.';
  }
}

// ---------- restart log ----------

async function loadRestartLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  try {
    const res = await fetch('/api/restart-log');
    if (!res.ok) {
      logEl.textContent = 'Не удалось загрузить журнал.';
      return;
    }
    const data = await res.json();
    const lines = data.lines || [];
    if (!lines.length) {
      logEl.textContent = 'Журнал пуст.';
    } else {
      logEl.textContent = lines.join('');
    }
  } catch (e) {
    console.error(e);
    logEl.textContent = 'Ошибка загрузки журнала.';
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

function appendToLog(text) {
  const logEl = document.getElementById('restart-log');
  if (!logEl || !text) return;
  if (logEl.textContent && !logEl.textContent.endsWith('\n')) {
    logEl.textContent += '\n';
  }
  logEl.textContent += text;
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  logEl.textContent = '';
  try {
    fetch('/api/restart-log/clear', { method: 'POST' });
  } catch (e) {
    console.error(e);
  }
}


function copyLog() {
  const logEl = document.getElementById('restart-log');
  if (!logEl) return;
  const text = logEl.textContent || '';
  if (!text) return;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => alert('Журнал скопирован в буфер обмена'),
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
    alert('Журнал скопирован в буфер обмена');
  } catch (e) {
    alert('Не удалось скопировать журнал');
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

  const lines = xrayLogLastLines || [];
  const html = lines
    .map((line) => {
      const cls = getXrayLogLineClass(line);
      return '<span class="' + cls + '">' + escapeHtml(line) + '</span>';
    })
    .join('');
  outputEl.innerHTML = html;
  outputEl.scrollTop = outputEl.scrollHeight;
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
      () => alert('Логи Xray скопированы в буфер обмена'),
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
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'port_proxying.lst сохранён.';
      if (data.restarted) {
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения port_proxying.lst: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения port_proxying.lst.';
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
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'port_exclude.lst сохранён.';
      if (data.restarted) {
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения port_exclude.lst: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения port_exclude.lst.';
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
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      let msg = 'ip_exclude.lst сохранён.';
      if (data.restarted) {
        msg += ' xkeen перезапущен.';
      }
      if (statusEl) statusEl.textContent = msg;
    } else {
      if (statusEl) statusEl.textContent = 'Ошибка сохранения ip_exclude.lst: ' + (data.error || res.status);
    }
  } catch (e) {
    console.error(e);
    if (statusEl) statusEl.textContent = 'Ошибка сохранения ip_exclude.lst.';
  }
}




document.addEventListener('DOMContentLoaded', () => {
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
  const stripBtn = document.getElementById('routing-strip-btn');
  const sortBtn = document.getElementById('routing-sort-btn');

  const inboundsSaveBtn = document.getElementById('inbounds-save-btn');
  const inboundsBackupBtn = document.getElementById('inbounds-backup-btn');
  const inboundsRestoreAutoBtn = document.getElementById('inbounds-restore-auto-btn');

  const outboundsSaveBtn = document.getElementById('outbounds-save-btn');
  const outboundsBackupBtn = document.getElementById('outbounds-backup-btn');
  const outboundsRestoreAutoBtn = document.getElementById('outbounds-restore-auto-btn');

  
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
  const mihomoTemplateLoadBtn = document.getElementById('mihomo-template-load-btn');
  const mihomoTemplateSaveFromEditorBtn = document.getElementById('mihomo-template-savefromeditor-btn');



  const portProxyingSaveBtn = document.getElementById('port-proxying-save-btn');
  const portExcludeSaveBtn = document.getElementById('port-exclude-save-btn');
  const ipExcludeSaveBtn = document.getElementById('ip-exclude-save-btn');

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
  if (stripBtn) stripBtn.addEventListener('click', (e) => {
    e.preventDefault();
    clearRoutingComments()
  });
  if (sortBtn) sortBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sortRoutingRules();
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
    alert('Xkeen перезапущен');
  });
loadPortProxying();
  loadPortExclude();
  loadIpExclude();
  refreshXrayLogStatus();

});
