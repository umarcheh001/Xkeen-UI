(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });

  // ------------------------- Logging settings (quick toggles) -------------------------

  function _itemMap(items) {
    const m = {};
    try {
      for (const it of (items || [])) {
        const k = String(it.key || '');
        if (k) m[k] = it;
      }
    } catch (e) {}
    return m;
  }

  function syncLoggingControls(items) {
    const mp = _itemMap(items);
    const coreEn = byId('dt-log-core-enable');
    const lvl = byId('dt-log-core-level');
    const acc = byId('dt-log-access-enable');
    const ws = byId('dt-log-ws-enable');
    const rot = byId('dt-log-rotate-mb');
    const bak = byId('dt-log-rotate-backups');

    function eff(key, defVal) {
      const it = mp[key];
      if (!it) return defVal;
      const v = (it.effective === null || typeof it.effective === 'undefined') ? '' : String(it.effective);
      return v !== '' ? v : defVal;
    }

    try {
      if (coreEn) {
        const v = eff('XKEEN_LOG_CORE_ENABLE', '1').toLowerCase();
        coreEn.checked = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
      }
      if (lvl) {
        const v = eff('XKEEN_LOG_CORE_LEVEL', 'INFO').toUpperCase();
        lvl.value = ['ERROR','WARNING','INFO','DEBUG'].includes(v) ? v : 'INFO';
      }
      if (acc) {
        const v = eff('XKEEN_LOG_ACCESS_ENABLE', '0').toLowerCase();
        acc.checked = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
      }
      if (ws) {
        const v = eff('XKEEN_LOG_WS_ENABLE', '0').toLowerCase();
        ws.checked = (v === '1' || v === 'true' || v === 'yes' || v === 'on');
      }
      if (rot) {
        const v = parseInt(eff('XKEEN_LOG_ROTATE_MAX_MB', '2'), 10);
        rot.value = String((v && v > 0) ? v : 2);
      }
      if (bak) {
        const v = parseInt(eff('XKEEN_LOG_ROTATE_BACKUPS', '3'), 10);
        bak.value = String((v && v > 0) ? v : 3);
      }
    } catch (e) {}
  }

  // ------------------------- ENV -------------------------

  const ENV_HELP = {
    'XKEEN_UI_STATE_DIR': 'Каталог состояния UI (auth, devtools.env, restart.log и т.п.). По умолчанию: /opt/etc/xkeen-ui.',
    'XKEEN_UI_ENV_FILE': 'Путь к env‑файлу DevTools (по умолчанию <UI_STATE_DIR>/devtools.env). Обычно менять не нужно. Эта переменная отображается только для информации (read‑only).',
    'XKEEN_UI_SECRET_KEY': 'Секретный ключ Flask/сессий. При смене ключа текущие сессии станут недействительными. Значение не отображается.',
    'XKEEN_RESTART_LOG_FILE': 'Файл, куда пишутся сообщения/ошибки при запуске/перезапуске UI (для диагностики). По умолчанию: <UI_STATE_DIR>/restart.log.',
    'XKEEN_UI_PANEL_SECTIONS_WHITELIST': 'Whitelist видимых секций/вкладок на основной панели (/). Формат: ключи через запятую. Пусто/не задано = показывать всё. Ключи: routing,mihomo,xkeen,xray-logs,commands,files,mihomo-generator,donate. Пример: routing,mihomo,xray-logs,commands. (Секция “Files” может быть скрыта и по архитектуре/feature flags.)',
    'XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST': 'Whitelist видимых секций DevTools (/devtools). Формат: ключи через запятую. Пусто/не задано = показывать всё. Ключи: tools,logs,service,logging,ui,layout,theme,css,env. Пример: service,logging,ui,layout,theme,css,env (или просто tools,env).',
    'XKEEN_LOG_DIR': 'Каталог UI‑логов: core.log / access.log / ws.log. По умолчанию: /opt/var/log/xkeen-ui.',
    'XKEEN_LOG_CORE_ENABLE': 'Включить/выключить core.log. Значения: 1/0. При 0 core.log не пишется (полезно для экономии flash).',
    'XKEEN_LOG_CORE_LEVEL': 'Уровень логирования core.log: ERROR / WARNING / INFO / DEBUG.',
    'XKEEN_LOG_ACCESS_ENABLE': 'Включить лог HTTP‑доступа (access.log). Значения: 1/0.',
    'XKEEN_LOG_WS_ENABLE': 'Включить подробный лог WebSocket (ws.log). Значения: 1/0. Может заметно увеличить объём логов.',
    'XKEEN_LOG_ROTATE_MAX_MB': 'Максимальный размер каждого log‑файла перед ротацией, в МБ. Минимум 1.',
    'XKEEN_LOG_ROTATE_BACKUPS': 'Сколько архивных файлов логов хранить после ротации. Минимум 1.',
    'XKEEN_GITHUB_OWNER': 'Владелец GitHub‑репозитория с конфигами (owner).',
    'XKEEN_GITHUB_REPO': 'Имя GitHub‑репозитория с конфигами (repo).',
    'XKEEN_GITHUB_BRANCH': 'Ветка GitHub для импорта/обновлений (например: main).',
    'XKEEN_GITHUB_REPO_URL': 'Полный URL GitHub‑репозитория. Если задан — используется вместо owner/repo.',
    'XKEEN_CONFIG_SERVER_BASE': 'Базовый URL конфиг‑сервера (FastAPI), если используете внешний сервер конфигураций.',
    'XKEEN_PTY_MAX_BUF_CHARS': 'Лимит буфера вывода встроенного терминала (PTY), в символах.',
    'XKEEN_PTY_IDLE_TTL_SECONDS': 'Через сколько секунд простоя закрывать терминальную (PTY) сессию.',
    'XKEEN_REMOTEFM_ENABLE': 'Включить удалённый файловый менеджер (RemoteFM через lftp). Значения: 1/0. На MIPS и без lftp фича может быть недоступна.',
    'XKEEN_REMOTEFM_MAX_SESSIONS': 'Максимум одновременных RemoteFM‑сессий.',
    'XKEEN_REMOTEFM_SESSION_TTL': 'TTL RemoteFM‑сессии в секундах (авто‑закрытие по таймауту).',
    'XKEEN_REMOTEFM_MAX_UPLOAD_MB': 'Максимальный размер загрузки через файловый менеджер, в МБ.',
    'XKEEN_REMOTEFM_TMP_DIR': 'Временная директория для загрузок/стейджинга (по умолчанию /tmp).',
    'XKEEN_REMOTEFM_STATE_DIR': 'Постоянный каталог состояния RemoteFM (known_hosts, служебные файлы). Если не задан, используется /opt/var/lib/xkeen-ui/remotefs или /tmp.',
    'XKEEN_REMOTEFM_CA_FILE': 'Путь к CA bundle для проверки TLS‑сертификатов при FTPS (если включена проверка).',
    'XKEEN_REMOTEFM_KNOWN_HOSTS': 'Файл known_hosts для SFTP (проверка ключей хостов).',
    'XKEEN_LOCALFM_ROOTS': 'Разрешённые корни локального файлового менеджера. Формат: пути через двоеточие, например /opt/etc:/opt/var:/tmp.',
    'XKEEN_PROTECT_MNT_LABELS': 'Защита от удаления/переименования верхнего уровня в каталоге монтирования (обычно /tmp/mnt). Значения: 1/0.',
    'XKEEN_PROTECTED_MNT_ROOT': 'Каталог, для которого действует защита XKEEN_PROTECT_MNT_LABELS (по умолчанию /tmp/mnt).',
    'XKEEN_TRASH_DIR': 'Директория «Корзины» для локального файлового менеджера. По умолчанию: /opt/var/trash.',
    'XKEEN_TRASH_MAX_BYTES': 'Максимальный размер корзины в байтах. Если задан, имеет приоритет над XKEEN_TRASH_MAX_GB.',
    'XKEEN_TRASH_MAX_GB': 'Максимальный размер корзины в гигабайтах (используется, если XKEEN_TRASH_MAX_BYTES не задан).',
    'XKEEN_TRASH_TTL_DAYS': 'Срок хранения файлов в корзине (в днях). 0 = хранение отключено (удаление будет «жёстким»).',
    'XKEEN_TRASH_WARN_RATIO': 'Порог предупреждения заполнения корзины (0..1), например 0.9.',
    'XKEEN_TRASH_STATS_CACHE_SECONDS': 'Кэширование расчёта размера корзины, в секундах (меньше — чаще пересчёт).',
    'XKEEN_TRASH_PURGE_INTERVAL_SECONDS': 'Интервал авто‑очистки корзины, в секундах (минимум 60).',
    'XKEEN_FILEOPS_WORKERS': 'Количество воркеров (параллельность) для операций копирования/перемещения.',
    'XKEEN_FILEOPS_MAX_JOBS': 'Максимальное количество активных/хранимых задач FileOps.',
    'XKEEN_FILEOPS_JOB_TTL': 'TTL задач FileOps в секундах (сколько хранить завершённые задачи).',
    'XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT': 'Разрешить прямые remote→remote операции через lftp (без локального спула). Значения: 1/0.',
    'XKEEN_FILEOPS_FXP': 'Разрешить FXP (сервер‑сервер) копирование для FTP/FTPS через lftp. Значения: 1/0.',
    'XKEEN_FILEOPS_SPOOL_DIR': 'Каталог спула (временных файлов) для FileOps, особенно при remote→remote переносах.',
    'XKEEN_FILEOPS_SPOOL_MAX_MB': 'Лимит спула FileOps в МБ (минимум 16).',
    'XKEEN_FILEOPS_SPOOL_CLEANUP_AGE': 'Возраст спул‑файлов (в секундах) для автоматической очистки (минимум 600).',
    'XKEEN_MAX_ZIP_MB': 'Лимит использования /tmp при создании zip‑архивов, в МБ. 0/пусто — без лимита.',
    'XKEEN_MAX_ZIP_ESTIMATE_ITEMS': 'Ограничение количества элементов при оценке размера zip (защита от огромных деревьев).',
    'XKEEN_ALLOW_SHELL': 'Разрешить выполнение shell‑команд/терминал в UI. 1=включено, 0=выключено. Включайте только в доверенной сети.',
    'XKEEN_XRAY_LOG_TZ_OFFSET': 'Сдвиг временных меток в логах Xray/Mihomo (в часах). Значение — целое число, по умолчанию 3.',
  };


  

  // ENV help modal content
  const ENV_APPLY_IMMEDIATE_KEYS = new Set([
    'XKEEN_LOG_CORE_ENABLE',
    'XKEEN_LOG_CORE_LEVEL',
    'XKEEN_LOG_ACCESS_ENABLE',
    'XKEEN_LOG_WS_ENABLE',
    'XKEEN_LOG_ROTATE_MAX_MB',
    'XKEEN_LOG_ROTATE_BACKUPS',
  ]);

  // Большинство переменных читаются на старте (константы/инициализация blueprint'ов).
  // Для них изменения надёжнее применять через Restart UI.
  const ENV_RESTART_KEYS = new Set([
    'XKEEN_UI_STATE_DIR',
    'XKEEN_UI_ENV_FILE',
    'XKEEN_UI_SECRET_KEY',
    'XKEEN_UI_PANEL_SECTIONS_WHITELIST',
    'XKEEN_UI_DEVTOOLS_SECTIONS_WHITELIST',
    'XKEEN_LOG_DIR',
    'XKEEN_GITHUB_OWNER',
    'XKEEN_GITHUB_REPO',
    'XKEEN_GITHUB_BRANCH',
    'XKEEN_GITHUB_REPO_URL',
    'XKEEN_CONFIG_SERVER_BASE',
    'XKEEN_PTY_MAX_BUF_CHARS',
    'XKEEN_PTY_IDLE_TTL_SECONDS',
    'XKEEN_REMOTEFM_ENABLE',
    'XKEEN_REMOTEFM_MAX_SESSIONS',
    'XKEEN_REMOTEFM_SESSION_TTL',
    'XKEEN_REMOTEFM_MAX_UPLOAD_MB',
    'XKEEN_REMOTEFM_TMP_DIR',
    'XKEEN_REMOTEFM_STATE_DIR',
    'XKEEN_REMOTEFM_CA_FILE',
    'XKEEN_REMOTEFM_KNOWN_HOSTS',
    'XKEEN_LOCALFM_ROOTS',
    'XKEEN_PROTECT_MNT_LABELS',
    'XKEEN_PROTECTED_MNT_ROOT',
    'XKEEN_TRASH_DIR',
    'XKEEN_TRASH_MAX_BYTES',
    'XKEEN_TRASH_MAX_GB',
    'XKEEN_TRASH_TTL_DAYS',
    'XKEEN_TRASH_WARN_RATIO',
    'XKEEN_TRASH_STATS_CACHE_SECONDS',
    'XKEEN_TRASH_PURGE_INTERVAL_SECONDS',
    'XKEEN_FILEOPS_WORKERS',
    'XKEEN_FILEOPS_MAX_JOBS',
    'XKEEN_FILEOPS_JOB_TTL',
    'XKEEN_FILEOPS_REMOTE2REMOTE_DIRECT',
    'XKEEN_FILEOPS_FXP',
    'XKEEN_FILEOPS_SPOOL_DIR',
    'XKEEN_FILEOPS_SPOOL_MAX_MB',
    'XKEEN_FILEOPS_SPOOL_CLEANUP_AGE',
    'XKEEN_MAX_ZIP_MB',
    'XKEEN_MAX_ZIP_ESTIMATE_ITEMS',
    'XKEEN_ALLOW_SHELL',
    'XKEEN_XRAY_LOG_TZ_OFFSET',
    'XKEEN_RESTART_LOG_FILE',
  ]);

  let _envSnapshot = { items: [], envFile: '' };

  function _envRestartHint(key) {
    const k = String(key || '');
    // Keep it short to fit into the help table on small screens.
    if (ENV_APPLY_IMMEDIATE_KEYS.has(k)) return 'нет (сразу)';
    if (ENV_RESTART_KEYS.has(k)) return 'да';
    return 'зависит';
  }

  function _setEnvSnapshot(items, envFile) {
    try { _envSnapshot.items = Array.isArray(items) ? items : []; } catch (e) { _envSnapshot.items = []; }
    try { _envSnapshot.envFile = envFile ? String(envFile) : ''; } catch (e) { _envSnapshot.envFile = ''; }
  }

  function _escapeHtml(s) {
    const str = String(s == null ? '' : s);
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _basename(p) {
    const s = String(p == null ? '' : p);
    if (!s) return '';
    // Support both Unix and Windows separators.
    const parts = s.split(/[/\\]+/);
    return parts[parts.length - 1] || s;
  }

  function _buildEnvHelpHtml() {
    const envFile = _envSnapshot && _envSnapshot.envFile ? String(_envSnapshot.envFile) : '';
    const keys = Object.keys(ENV_HELP || {}).slice().sort();

    const parts = [];
    parts.push('<div style="line-height:1.55;">');

    parts.push('<p style="margin-top:0;"><strong>ENV (whitelist)</strong> — это список разрешённых переменных окружения, которые можно безопасно менять из UI. Значения сохраняются в env‑файл <code>devtools.env</code> и (частично) применяются сразу.</p>');

    parts.push('<h3 style="margin:12px 0 6px 0;">Колонки</h3>');
    parts.push('<ul style="margin-top:0;">');
    parts.push('<li><strong>Current</strong> — эффективное значение (то, что UI использует сейчас), включая дефолты.</li>');
    parts.push('<li><strong>Value</strong> — значение, которое будет записано в env‑файл (если переменная не задана — UI использует дефолт).</li>');
    parts.push('</ul>');

    parts.push('<h3 style="margin:12px 0 6px 0;">Кнопки Save / Unset</h3>');
    parts.push('<ul style="margin-top:0;">');
    parts.push('<li><strong>Save</strong> — записывает значение в env‑файл (devtools.env) и выставляет его в окружение текущего процесса. Для части настроек нужен <strong>Restart UI</strong>, см. ниже.</li>');
    parts.push('<li><strong>Unset</strong> — удаляет переменную из env‑файла и из окружения процесса. После этого UI вернётся к встроенному значению по умолчанию (или к значению, которое задаёт ваш init‑скрипт/система).</li>');
    parts.push('</ul>');

    parts.push('<h3 style="margin:12px 0 6px 0;">Когда нужен Restart UI</h3>');
    parts.push('<p style="margin-top:0;">Правило простое: если переменная влияет на <em>инициализацию</em> (регистрацию маршрутов, включение фич, пути каталогов, лимиты/TTL, безопасность, секреты), то изменения надёжно применяются только после <strong>Restart UI</strong>. Некоторые параметры логирования применяются сразу.</p>');

    parts.push('<div class="small" style="opacity:0.9; margin-bottom:6px;">Точно применяются без рестарта:</div>');
    parts.push('<ul style="margin-top:0;">');
    parts.push('<li><code>XKEEN_LOG_CORE_ENABLE</code>, <code>XKEEN_LOG_CORE_ENABLE</code>, <code>XKEEN_LOG_CORE_ENABLE</code>, <code>XKEEN_LOG_CORE_LEVEL</code>, <code>XKEEN_LOG_ACCESS_ENABLE</code>, <code>XKEEN_LOG_WS_ENABLE</code>, <code>XKEEN_LOG_ROTATE_MAX_MB</code>, <code>XKEEN_LOG_ROTATE_BACKUPS</code> — DevTools пытается обновить логирование сразу.</li>');
    parts.push('</ul>');

    parts.push('<div class="small" style="opacity:0.9; margin-bottom:6px;">Рекомендуется делать Restart UI после изменений (самое частое):</div>');
    parts.push('<ul style="margin-top:0;">');
    parts.push('<li>UI/сессии: <code>XKEEN_UI_STATE_DIR</code>, <code>XKEEN_UI_SECRET_KEY</code>, <code>XKEEN_UI_ENV_FILE</code>.</li>');
    parts.push('<li>Включение/инициализация фич: <code>XKEEN_REMOTEFM_*</code>, <code>XKEEN_PTY_*</code>, <code>XKEEN_ALLOW_SHELL</code>.</li>');
    parts.push('<li>Пути/каталоги: <code>XKEEN_LOG_DIR</code>, <code>XKEEN_TRASH_DIR</code>, <code>XKEEN_FILEOPS_SPOOL_DIR</code> и т.п.</li>');
    parts.push('<li>GitHub/Config‑server: <code>XKEEN_GITHUB_*</code>, <code>XKEEN_CONFIG_SERVER_BASE</code>.</li>');
    parts.push('</ul>');

    parts.push('<h3 style="margin:12px 0 6px 0;">Как вернуть всё по умолчанию</h3>');
    parts.push('<ul style="margin-top:0;">');
    parts.push('<li>Для одной переменной: нажмите <strong>Unset</strong> — UI вернётся к дефолту.</li>');
    parts.push('<li>Для полного сброса: удалите все заданные значения (Unset для нужных строк) или удалите файл <code>devtools.env</code> целиком (через SSH/файловый менеджер). Затем сделайте <strong>Restart UI</strong>.</li>');
    parts.push('<li>Если меняли <code>XKEEN_UI_SECRET_KEY</code>: Unset вернёт использование ключа из <code>&lt;UI_STATE_DIR&gt;/secret.key</code>. Чтобы сгенерировать новый ключ «как с нуля» — удалите файл <code>secret.key</code> (через SSH) и перезапустите UI.</li>');
    parts.push('</ul>');

    parts.push('<h3 style="margin:12px 0 6px 0;">Список переменных (whitelist)</h3>');
    parts.push('<div class="small" style="opacity:0.85; margin-bottom:8px;">В таблице ниже: назначение и подсказка по необходимости Restart UI.</div>');

    parts.push('<div class="dt-env-help-table-wrap">');
    parts.push('<table class="dt-env-help-table">');
    parts.push('<thead><tr>');
    parts.push('<th class="dt-env-help-col-key">Key</th>');
    parts.push('<th class="dt-env-help-col-desc">Описание</th>');
    parts.push('<th class="dt-env-help-col-restart">Restart UI</th>');
    parts.push('</tr></thead>');
    parts.push('<tbody>');

    for (const k of keys) {
      const desc = ENV_HELP[k] || '';
      parts.push('<tr>');
      parts.push('<td class="dt-env-help-td-key"><code>' + _escapeHtml(k) + '</code></td>');
      parts.push('<td class="dt-env-help-td-desc">' + _escapeHtml(desc) + '</td>');
      parts.push('<td class="dt-env-help-td-restart">' + _escapeHtml(_envRestartHint(k)) + '</td>');
      parts.push('</tr>');
    }

    parts.push('</tbody></table></div>');

    parts.push('<div class="small" style="opacity:0.8; margin-top:10px;">Подсказка: наведение на ключ в таблице ENV тоже показывает краткое описание (tooltip).</div>');

    parts.push('</div>');
    return parts.join('');
  }

  function _showEnvHelpModal() {
    const modal = byId('dt-env-help-modal');
    const body = byId('dt-env-help-body');
    if (!modal || !body) return;
    try { body.innerHTML = _buildEnvHelpHtml(); } catch (e) { body.textContent = 'Не удалось построить справку: ' + (e && e.message ? e.message : String(e)); }

    try { modal.classList.remove('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
    } else {
      try { document.body.classList.add('modal-open'); } catch (e) {}
    }
  }

  function _hideEnvHelpModal() {
    const modal = byId('dt-env-help-modal');
    if (!modal) return;
    try { modal.classList.add('hidden'); } catch (e) {}
    if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
      try { XKeen.ui.modal.syncBodyScrollLock(); } catch (e) {}
    } else {
      try { document.body.classList.remove('modal-open'); } catch (e) {}
    }
  }

  function _wireEnvHelp() {
    const btn = byId('dt-env-help-btn');
    const modal = byId('dt-env-help-modal');
    const btnClose = byId('dt-env-help-close-btn');
    const btnOk = byId('dt-env-help-ok-btn');

    if (btn) btn.addEventListener('click', () => _showEnvHelpModal());
    if (btnClose) btnClose.addEventListener('click', () => _hideEnvHelpModal());
    if (btnOk) btnOk.addEventListener('click', () => _hideEnvHelpModal());

    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e && e.target === modal) _hideEnvHelpModal();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (!e) return;
      if (e.key !== 'Escape' && e.key !== 'Esc') return;
      try {
        const isOpen = modal && !modal.classList.contains('hidden');
        if (isOpen) _hideEnvHelpModal();
      } catch (e2) {}
    });
  }





  function renderEnv(items, envFile) {
    const tbody = byId('dt-env-tbody');
    const envFileEl = byId('dt-env-file');
    if (envFileEl) {
      const full = envFile ? String(envFile) : '';
      const name = full ? _basename(full) : '';
      // Don't show full local paths (e.g. macOS dev environment). Keep it short.
      envFileEl.textContent = name ? ('env‑файл: ' + name) : '';
      envFileEl.title = full || '';
    }
    _setEnvSnapshot(items, envFile);
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!items || !items.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="4">(empty)</td>';
      tbody.appendChild(tr);
      return;
    }

    // Also sync quick logging controls
    syncLoggingControls(items);

    for (const it of items) {
      const tr = document.createElement('tr');
      const key = String(it.key || '');
      const cur = (it.current === null || typeof it.current === 'undefined') ? '' : String(it.current);
      const conf = (it.configured === null || typeof it.configured === 'undefined') ? '' : String(it.configured);
      const eff = (it.effective === null || typeof it.effective === 'undefined') ? '' : String(it.effective);
      const isSensitive = !!it.is_sensitive;
      const isReadonly = !!it.readonly;

      // Prefer configured value (env-file). Otherwise fall back to effective (incl. defaults), then current.
      const valuePrefill = conf !== '' ? conf : (eff !== '' ? eff : cur);

      const help = ENV_HELP[key] || ('Переменная окружения: ' + key);

      const tdKey = document.createElement('td');
      tdKey.textContent = key;
      tdKey.title = help;
      tdKey.style.whiteSpace = 'nowrap';

      const tdCur = document.createElement('td');
      // Show effective value (what UI will actually use). If empty, fall back to current.
      tdCur.textContent = eff !== '' ? eff : cur;
      tdCur.style.maxWidth = '220px';
      tdCur.style.overflow = 'hidden';
      tdCur.style.textOverflow = 'ellipsis';
      tdCur.style.minWidth = '220px';

      const tdVal = document.createElement('td');
      tdVal.style.minWidth = '260px';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'dt-env-input';
      inp.value = isSensitive ? '' : valuePrefill;
      inp.disabled = !!isReadonly;
      inp.placeholder = isReadonly ? '(read-only)' : (isSensitive ? '(секрет — вводите новое значение)' : '');
      inp.title = isReadonly ? (help + ' (read-only)') : (isSensitive ? (help + ' Значение не отображается: вводите новое и нажимайте Save.') : help);
      inp.style.width = '100%';
      inp.dataset.key = key;
      tdVal.appendChild(inp);

      const tdAct = document.createElement('td');
      tdAct.style.whiteSpace = 'nowrap';
      tdAct.style.minWidth = '140px';

      const btnSave = document.createElement('button');
      btnSave.type = 'button';
      btnSave.className = 'btn-secondary';
      btnSave.textContent = 'Save';
      btnSave.title = 'Сохранить значение в env‑файл (devtools.env) и применить в текущем процессе. Для части настроек нужен Restart UI.';
      if (isReadonly) {
        btnSave.disabled = true;
        btnSave.title = 'Read-only';
      }
      btnSave.addEventListener('click', async () => {
        const v = String(inp.value || '');
        try {
          const data = await postJSON('/api/devtools/env', { updates: { [key]: v } });
          toast('Saved: ' + key);
          renderEnv(data.items || [], data.env_file || '');
        } catch (e) {
          toast('Save failed: ' + key + ' — ' + (e && e.message ? e.message : String(e)), true);
        }
      });

      const btnUnset = document.createElement('button');
      btnUnset.type = 'button';
      btnUnset.className = 'btn-danger';
      btnUnset.textContent = 'Unset';
      btnUnset.title = 'Удалить переменную из env‑файла (devtools.env) и из окружения процесса. Для части настроек нужен Restart UI.';
      btnUnset.style.marginLeft = '6px';
      if (isReadonly) {
        btnUnset.disabled = true;
        btnUnset.title = 'Read-only';
      }
      btnUnset.addEventListener('click', async () => {
        try {
          const data = await postJSON('/api/devtools/env', { updates: { [key]: null } });
          toast('Unset: ' + key);
          renderEnv(data.items || [], data.env_file || '');
        } catch (e) {
          toast('Unset failed: ' + key + ' — ' + (e && e.message ? e.message : String(e)), true);
        }
      });

      tdAct.appendChild(btnSave);
      tdAct.appendChild(btnUnset);

      tr.appendChild(tdKey);
      tr.appendChild(tdCur);
      tr.appendChild(tdVal);
      tr.appendChild(tdAct);
      tbody.appendChild(tr);
    }
  }

  async function loadEnv() {
    try {
      const data = await getJSON('/api/devtools/env');
      renderEnv(data.items || [], data.env_file || '');
    } catch (e) {
      const tbody = byId('dt-env-tbody');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="4">Ошибка: ' + (e && e.message ? e.message : String(e)) + '</td></tr>';
      }
    }
  }

  async function saveLoggingSettings() {
    const coreEn = byId('dt-log-core-enable');
    const lvl = byId('dt-log-core-level');
    const acc = byId('dt-log-access-enable');
    const ws = byId('dt-log-ws-enable');
    const rot = byId('dt-log-rotate-mb');
    const bak = byId('dt-log-rotate-backups');

    const updates = {};
    if (coreEn) {
      try { updates.XKEEN_LOG_CORE_ENABLE = (coreEn.checked) ? '1' : '0'; } catch (e) {}
    }
    try { updates.XKEEN_LOG_CORE_LEVEL = String(lvl && lvl.value ? lvl.value : 'INFO'); } catch (e) { updates.XKEEN_LOG_CORE_LEVEL = 'INFO'; }
    // Access log toggle may be hidden in simplified UI; don't change it unless the control exists.
    if (acc) {
      try { updates.XKEEN_LOG_ACCESS_ENABLE = (acc.checked) ? '1' : '0'; } catch (e) {}
    }
    try { updates.XKEEN_LOG_WS_ENABLE = (ws && ws.checked) ? '1' : '0'; } catch (e) { updates.XKEEN_LOG_WS_ENABLE = '0'; }

    let rotMb = 2;
    let backups = 3;
    try { rotMb = parseInt(String(rot && rot.value ? rot.value : '2'), 10); } catch (e) {}
    try { backups = parseInt(String(bak && bak.value ? bak.value : '3'), 10); } catch (e) {}
    if (!rotMb || rotMb < 1) rotMb = 1;
    if (!backups || backups < 1) backups = 1;
    updates.XKEEN_LOG_ROTATE_MAX_MB = String(rotMb);
    updates.XKEEN_LOG_ROTATE_BACKUPS = String(backups);

    try {
      const data = await postJSON('/api/devtools/env', { updates });
      toast('Logging settings saved');
      renderEnv(data.items || [], data.env_file || '');

      // Refresh logs list/tail (if module is present)
      const logs = XK.features && XK.features.devtoolsLogs ? XK.features.devtoolsLogs : null;
      if (logs && typeof logs.loadLogList === 'function') await logs.loadLogList(true);
      if (logs && typeof logs.loadLogTail === 'function') await logs.loadLogTail(false);
    } catch (e) {
      toast('Save logging settings failed: ' + (e && e.message ? e.message : String(e)), true);
    }
  }

  function init() {
    // Logging quick settings
    const logSave = byId('dt-log-settings-save');
    if (logSave) logSave.addEventListener('click', saveLoggingSettings);

    // ENV help
    try { _wireEnvHelp(); } catch (e) {}

    // Initial load
    loadEnv();
  }

  XK.features.devtoolsEnv = {
    init,
    loadEnv,
    renderEnv,
    saveLoggingSettings,
    syncLoggingControls,
  };
})();
