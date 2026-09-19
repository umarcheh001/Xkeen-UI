import { getUpdateNotifierApi } from '../update_notifier.js';
import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from '../devtools_namespace.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const XK = window.XKeen;
  const DT = getDevtoolsNamespace();

  const SH = getDevtoolsSharedApi() || {};
  let _inited = false;
  const toast = SH.toast || function (m, isErr) { try { console[(isErr ? 'error' : 'log')](m); } catch (e) {} };
  // Kind-aware toast helper: supports boolean (legacy) and 'info'|'success'|'error'.
  const toastKind = function (msg, kind) {
    try {
      if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind);
      if (XK && XK.ui && typeof XK.ui.showToast === 'function') return XK.ui.showToast(String(msg || ''), kind);
    } catch (e) {}
    const k = String(kind || '').toLowerCase();
    const isErr = (kind === true) || (k === 'error' || k === 'danger' || k === 'fail' || k === 'failed');
    return toast(String(msg || ''), isErr);
  };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, {
      cache: 'no-store',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b || {}),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });
  const confirmAction = SH.confirmAction || (async (opts) => {
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') return !!(await XKeen.ui.confirm(opts || {}));
    return !!window.confirm(String((opts && opts.message) || 'Продолжить?'));
  });


  // Cross-tab reload broadcast key (handled by update_notifier.js on other tabs).
  const LS_FORCE_RELOAD = 'xk_ui_force_reload_ts';

  function _reloadWithCacheBust() {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set('_', String(Date.now()));
      window.location.replace(u.toString());
    } catch (e) {
      try { window.location.reload(); } catch (e2) {}
    }
  }

  // Shared with update_notifier.js
  const LS_NOTIFY_ENABLED = 'xk_update_notify_enabled';
  const LS_NOTIFY_INTERVAL_H = 'xk_update_notify_interval_h';

  function _clampNotifyHours(v) {
    const n = Number(v);
    if (n === 1 || n === 6 || n === 24) return n;
    return 6;
  }

  function _readNotifySettings() {
    // Prefer feature API (it also applies defaults).
    try {
      const n = getUpdateNotifierApi();
      if (n && typeof n.getSettings === 'function') return n.getSettings();
    } catch (e) {}

    // Fallback: read localStorage directly.
    let enabled = true;
    let hours = 6;
    try {
      const rawE = String(window.localStorage.getItem(LS_NOTIFY_ENABLED) || '').trim();
      if (rawE === '0') enabled = false;
      if (rawE === '1') enabled = true;
    } catch (e) {}
    try {
      const rawH = String(window.localStorage.getItem(LS_NOTIFY_INTERVAL_H) || '').trim();
      if (rawH) hours = _clampNotifyHours(rawH);
    } catch (e) {}
    return { enabled, intervalHours: hours, intervalMs: hours * 60 * 60 * 1000 };
  }

  function _applyNotifySettings(s) {
    // Prefer feature API (so it immediately re-schedules polling).
    try {
      const n = getUpdateNotifierApi();
      if (n && typeof n.setSettings === 'function') return n.setSettings(s);
      if (n && typeof n.applySettings === 'function') return n.applySettings();
    } catch (e) {}

    // Fallback: store to localStorage only.
    try {
      if (typeof s.enabled === 'boolean') window.localStorage.setItem(LS_NOTIFY_ENABLED, s.enabled ? '1' : '0');
    } catch (e) {}
    try {
      if (s.intervalHours != null) window.localStorage.setItem(LS_NOTIFY_INTERVAL_H, String(_clampNotifyHours(s.intervalHours)));
    } catch (e) {}
    return _readNotifySettings();
  }

  function _fmtIso(iso) {
    try {
      const s = String(iso || '').trim();
      if (!s) return '';
      const d = new Date(s);
      if (String(d) === 'Invalid Date') return s;
      return d.toLocaleString('ru-RU');
    } catch (e) {
      return String(iso || '');
    }
  }

  function _fmtAgeSec(sec) {
    try {
      const v = Math.max(0, Number(sec || 0));
      if (v < 60) return Math.floor(v) + ' с';
      if (v < 3600) return Math.floor(v / 60) + ' мин';
      if (v < 86400) return Math.floor(v / 3600) + ' ч';
      return Math.floor(v / 86400) + ' дн';
    } catch (e) {
      return '';
    }
  }
  function _setText(id, text) {
    const el = byId(id);
    if (!el) return;
    try { el.textContent = String(text || ''); } catch (e) {}
  }

  function _setClass(id, className) {
    const el = byId(id);
    if (!el) return;
    try { el.className = String(className || ''); } catch (e) {}
  }

  function _setStatus(msg, cls) {
    const el = byId('dt-update-status');
    if (!el) return;
    try {
      el.textContent = String(msg || '—');
      const base = 'status';
      const c = String(cls || '').trim();
      el.className = c ? (base + ' ' + c) : base;
    } catch (e) {}
  }

  function _setSubStatus(msg) {
    const el = byId('dt-update-substatus');
    if (!el) return;
    try { el.textContent = String(msg || ''); } catch (e) {}
  }

  // Хвост update.log в карточке больше не показываем: полный лог живёт во вкладке
  // Logs, здесь остаётся только вердикт — были ли во время обновлений ошибки.
  // Скрипт обновления помечает проблемные строки префиксом «[!]».
  const UPDATE_LOG_ALERT_RE = /\[!\]/;

  const UPDATE_LOG_VERDICTS = {
    empty: { text: 'Обновления ещё не запускались', link: false },
    clean: { text: 'Во время обновлений ошибок не обнаружено', link: false },
    warn: { text: 'Во время обновлений были предупреждения', link: true },
    failed: { text: 'Во время обновлений обнаружены ошибки', link: true },
  };

  function _classifyUpdateLog(lines, stateVal, err) {
    if (stateVal === 'failed' || err) return 'failed';
    if (!lines || !lines.length) return 'empty';
    try {
      for (let i = 0; i < lines.length; i += 1) {
        if (UPDATE_LOG_ALERT_RE.test(String(lines[i] || ''))) return 'warn';
      }
    } catch (e) {}
    return 'clean';
  }

  function _renderLog(lines, stateVal, err) {
    const box = byId('dt-update-log-verdict');
    const textEl = byId('dt-update-log-verdict-text');
    const linkEl = byId('dt-update-log-open');
    if (!box || !textEl) return;

    const verdict = _classifyUpdateLog(lines, stateVal, err);
    const spec = UPDATE_LOG_VERDICTS[verdict] || UPDATE_LOG_VERDICTS.empty;
    try {
      box.setAttribute('data-verdict', verdict);
      textEl.textContent = spec.text;
      if (linkEl) linkEl.style.display = spec.link ? '' : 'none';
    } catch (e) {}
  }


  const STEP_LABELS = {
    spawn: 'Запуск…',
    init: 'Подготовка…',
    backup: 'Создание бэкапа…',
    check_latest: 'Проверка GitHub…',
    download: 'Скачивание…',
    verify: 'Проверка checksum…',
    extract: 'Распаковка…',
    install: 'Установка…',
    restart: 'Перезапуск UI…',
    rollback_select: 'Откат: выбор бэкапа…',
    rollback_stop: 'Откат: остановка UI…',
    rollback_restore: 'Откат: восстановление…',
  };

  // Названия шагов без многоточия — для строки расшифровки под статусом.
  const STEP_NAMES = {
    spawn: 'запуск',
    init: 'подготовка',
    backup: 'резервная копия',
    check_latest: 'проверка GitHub',
    download: 'скачивание',
    verify: 'проверка контрольной суммы',
    extract: 'распаковка',
    install: 'установка',
    restart: 'перезапуск панели',
    lock: 'блокировка',
    done: 'готово',
    rollback_select: 'откат: выбор копии',
    rollback_stop: 'откат: остановка панели',
    rollback_restore: 'откат: восстановление',
  };

  // Скрипт обновления пишет шаг, сообщение и код ошибки по-английски. Показываем
  // их по-русски; незнакомый текст оставляем как есть, чтобы ничего не потерять.
  const UPDATE_TEXTS = {
    'starting': 'запуск',
    'update completed': 'обновление завершено',
    'rollback completed': 'откат завершён',
    'creating backup': 'создаём резервную копию',
    'selecting backup': 'выбираем резервную копию',
    'stopping ui service': 'останавливаем панель',
    'restoring backup': 'восстанавливаем из резервной копии',
    'restarting ui service': 'перезапускаем панель',
    'fetching latest info': 'запрашиваем данные о последней версии',
    'fetching latest release info': 'запрашиваем данные о последнем релизе',
    'downloading release asset': 'скачиваем архив обновления',
    'verifying sha256': 'проверяем контрольную сумму',
    'extracting archive': 'распаковываем архив',
    'running install.sh': 'запускаем установщик install.sh',
    'lock already exists': 'обновление уже выполняется',
    'backup not found': 'резервная копия не найдена',
    'backup failed': 'не удалось создать резервную копию',
    'backup_tar_unsupported': 'tar на роутере не поддерживает --exclude',
    'failed to move current dir': 'не удалось убрать текущую папку панели',
    'move failed': 'не удалось убрать текущую папку панели',
    'extract failed': 'не удалось распаковать архив',
    'unsafe archive': 'архив не прошёл проверку безопасности',
    'failed to fetch latest commit': 'не удалось получить последний коммит',
    'failed to fetch latest release': 'не удалось получить последний релиз',
    'release asset not found': 'в релизе нет нужного архива',
    'checksum required but missing': 'нет файла контрольных сумм',
    'checksum missing': 'нет файла контрольных сумм',
    'checksum entry missing': 'в контрольных суммах нет записи для архива',
    'checksum has no entry for asset': 'в контрольных суммах нет записи для архива',
    'checksum download failed': 'не удалось скачать контрольные суммы',
    'checksum verify failed': 'не удалось проверить контрольную сумму',
    'sha256 mismatch': 'контрольная сумма не совпала',
    'install.sh not found': 'установщик install.sh не найден',
    'install.sh failed': 'установщик install.sh завершился с ошибкой',
    'spawn_failed': 'не удалось запустить процесс обновления',
  };

  function _ruText(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const known = UPDATE_TEXTS[raw.toLowerCase()];
    return known || raw;
  }

  function _ruStep(step) {
    const raw = String(step || '').trim();
    if (!raw) return '';
    return STEP_NAMES[raw] || raw;
  }

  const STEP_PCT = {
    spawn: 3,
    init: 8,
    backup: 18,
    check_latest: 30,
    download: 55,
    verify: 62,
    extract: 78,
    install: 90,
    restart: 96,
    rollback_select: 15,
    rollback_stop: 35,
    rollback_restore: 80,
  };

  function _setProgress(visible, pct, indeterminate, text) {
    const wrap = byId('dt-update-progress-wrap');
    const bar = byId('dt-update-progress-bar');
    const box = byId('dt-update-progress');
    const tx = byId('dt-update-progress-text');
    if (!wrap || !bar || !box) return;
    try { wrap.style.display = visible ? '' : 'none'; } catch (e) {}
    if (!visible) return;

    const p = Math.max(0, Math.min(100, Math.round(Number(pct || 0))));
    try { box.setAttribute('aria-valuenow', String(p)); } catch (e) {}

    try {
      if (indeterminate) box.classList.add('indeterminate');
      else box.classList.remove('indeterminate');
    } catch (e) {}

    try {
      if (!indeterminate) bar.style.width = String(p) + '%';
      else bar.style.width = '0%';
    } catch (e) {}

    try { if (tx) tx.textContent = String(text || ''); } catch (e) {}
  }


  function _fmtBytes(n) {
    try {
      const v = Number(n || 0);
      if (!isFinite(v) || v <= 0) return '';
      const mib = v / (1024 * 1024);
      if (mib < 1) return Math.round(v) + ' B';
      if (mib < 1024) return (Math.round(mib * 10) / 10) + ' MiB';
      const gib = mib / 1024;
      return (Math.round(gib * 10) / 10) + ' GiB';
    } catch (e) { return ''; }
  }

  function _clearEl(el) {
    if (!el) return;
    try {
      while (el.firstChild) el.removeChild(el.firstChild);
    } catch (e) {}
  }

  function _prettyUrlReason(reason) {
    const r = String(reason || '');
    if (!r || r === 'ok') return '';
    if (r === 'empty' || r === 'missing') return 'URL отсутствует';
    if (r === 'parse_failed') return 'не удалось разобрать URL';
    if (r === 'http_not_allowed') return 'HTTP запрещён (только HTTPS)';
    if (r === 'no_host') return 'в URL нет host';
    if (r.startsWith('bad_scheme:')) return 'недопустимая схема: ' + r.split(':').slice(1).join(':');
    if (r.startsWith('host_not_allowed:')) return 'хост не в allow-list: ' + r.split(':').slice(1).join(':');
    return r;
  }

  function _scrollToUpdateSecurityBox() {
    const box = byId('dt-update-security');
    if (!box) return;
    try {
      if (box.style && box.style.display === 'none') return;
    } catch (e) {}
    try {
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch (e) {
      try { box.scrollIntoView(); } catch (e2) {}
    }
  }

  function _setRunBlockedState(btn, blocked, kind, message) {
    if (!btn) return;
    try {
      if (btn.dataset) {
        delete btn.dataset.blocked;
        delete btn.dataset.blockedKind;
        delete btn.dataset.blockedMessage;
      }
    } catch (e) {}
    if (!blocked) return;
    try {
      if (btn.dataset) {
        btn.dataset.blocked = '1';
        if (kind) btn.dataset.blockedKind = String(kind);
        if (message) btn.dataset.blockedMessage = String(message);
      }
    } catch (e) {}
  }

  function _showBlockedUpdateReason(btnRun) {
    try {
      if (!(btnRun && btnRun.dataset && btnRun.dataset.blocked === '1')) return false;
      const blockKind = btnRun.dataset.blockedKind ? String(btnRun.dataset.blockedKind) : '';
      const blockedSummary = btnRun.dataset.blockedMessage
        ? String(btnRun.dataset.blockedMessage)
        : (blockKind === 'policy'
          ? 'Автообновление остановлено политикой безопасности.'
          : 'Панель не смогла проверить обновление.');
      toastKind(blockedSummary + ' Подробности показаны в карточке обновления.', 'error');
      _scrollToUpdateSecurityBox();
      return true;
    } catch (e) {
      return false;
    }
  }

  function _buildClientSideCheckFailureData(error) {
    const info = (state.lastInfo && typeof state.lastInfo === 'object') ? state.lastInfo : {};
    const settings = (info.settings && typeof info.settings === 'object') ? info.settings : {};
    const build = (info.build && typeof info.build === 'object') ? info.build : {};
    const message = error && error.message ? String(error.message) : String(error || 'check_failed');
    return {
      ok: false,
      error: 'check_failed',
      repo: settings.repo ? String(settings.repo) : (build.repo ? String(build.repo) : ''),
      channel: settings.channel ? String(settings.channel) : (build.channel ? String(build.channel) : ''),
      branch: settings.branch ? String(settings.branch) : '',
      current: build,
      latest: null,
      update_available: false,
      stale: false,
      meta: message ? { message } : {},
      security: (info.security && typeof info.security === 'object') ? info.security : null,
    };
  }

  function _extractHostFromUrl(url) {
    try {
      return String(new URL(String(url || ''), window.location.href).host || '').trim();
    } catch (e) {
      return '';
    }
  }

  function _summarizeSecurityBlock(sec) {
    const warnings = Array.isArray(sec && sec.warnings) ? sec.warnings.map((w) => String(w)) : [];
    const dl = (sec && sec.download && typeof sec.download === 'object') ? sec.download : null;
    const checksum = (sec && sec.checksum && typeof sec.checksum === 'object') ? sec.checksum : null;

    for (const w of warnings) {
      if (w.startsWith('download_url_blocked:')) {
        const reason = w.slice('download_url_blocked:'.length);
        const host = _extractHostFromUrl(dl && dl.url);
        if (reason === 'http_not_allowed') return 'Автообновление остановлено: URL архива использует HTTP, а политика разрешает только HTTPS.';
        if (reason.startsWith('host_not_allowed:')) return 'Автообновление остановлено: хост загрузки' + (host ? (' ' + host) : '') + ' не разрешён политикой обновления.';
        if (reason === 'missing' || reason === 'empty') return 'Автообновление остановлено: панель не получила корректный URL архива обновления.';
        return 'Автообновление остановлено: URL архива не проходит текущую политику безопасности.';
      }
      if (w.startsWith('checksum_url_blocked:')) {
        const reason = w.slice('checksum_url_blocked:'.length);
        const host = _extractHostFromUrl(checksum && checksum.url);
        if (reason === 'http_not_allowed') return 'Автообновление остановлено: checksum доступен только по HTTP, а политика требует HTTPS.';
        if (reason.startsWith('host_not_allowed:')) return 'Автообновление остановлено: хост checksum' + (host ? (' ' + host) : '') + ' не разрешён политикой обновления.';
        return 'Автообновление остановлено: URL checksum не проходит текущую политику безопасности.';
      }
      if (w === 'checksum_required_missing') {
        return 'Автообновление остановлено: политика требует checksum, но для релиза он не найден.';
      }
    }

    return 'Автообновление остановлено политикой безопасности. Подробности показаны в карточке обновления.';
  }

  function _summarizeCheckFailure(data) {
    const hint = data && data.hint ? String(data.hint) : '';
    if (hint) return hint;
    const err = data && data.error ? String(data.error) : 'check_failed';
    const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
    const low = _checkFailureSearchText(data);

    if (meta && meta.reason === 'no_releases') {
      return 'Панель не нашла опубликованный release для self-update. Подробности показаны в карточке обновления.';
    }
    if (err === 'timeout' || low.indexOf('timeout') >= 0 || low.indexOf('timed out') >= 0) {
      return 'Панель не дождалась ответа от GitHub. Возможно, GitHub недоступен с роутера или соединение режется по пути.';
    }
    if (
      low.indexOf('temporary failure') >= 0 ||
      low.indexOf('name or service not known') >= 0 ||
      low.indexOf('getaddrinfo') >= 0 ||
      low.indexOf('failed to resolve') >= 0 ||
      low.indexOf('could not resolve') >= 0 ||
      low.indexOf('nodename nor servname') >= 0
    ) {
      return 'Панель не смогла разрешить адрес GitHub по DNS. Часто это означает сетевую блокировку или проблему DNS на роутере.';
    }
    if (
      low.indexOf('403') >= 0 ||
      low.indexOf('forbidden') >= 0 ||
      low.indexOf('429') >= 0 ||
      low.indexOf('rate limit') >= 0
    ) {
      return 'GitHub отклонил запрос или ограничил доступ. Подробности показаны в карточке обновления.';
    }
    if (
      low.indexOf('ssl') >= 0 ||
      low.indexOf('tls') >= 0 ||
      low.indexOf('certificate') >= 0
    ) {
      return 'Панель не смогла пройти TLS/SSL-проверку при обращении к GitHub.';
    }
    return 'Панель не смогла проверить обновление через GitHub. Часто это означает, что GitHub или release asset URLs недоступны с роутера.';
  }

  function _safeJson(value, maxLen) {
    let out = '';
    try {
      out = JSON.stringify(value, null, 2);
    } catch (e) {
      try { out = String(value || ''); } catch (e2) { out = ''; }
    }
    const limit = Math.max(200, Number(maxLen || 1600));
    if (out.length > limit) out = out.slice(0, limit - 1) + '…';
    return out;
  }

  function _checkFailureSearchText(data) {
    const err = data && data.error ? String(data.error) : 'check_failed';
    const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
    const hint = data && data.hint ? String(data.hint) : '';
    return (err + ' ' + hint + ' ' + _safeJson(meta, 2400)).toLowerCase();
  }

  function _classifyCheckFailure(data) {
    const err = data && data.error ? String(data.error) : 'check_failed';
    const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : {};
    const low = _checkFailureSearchText(data);

    if (meta && meta.reason === 'no_releases') return 'no_releases';
    if (err === 'timeout' || low.indexOf('timeout') >= 0 || low.indexOf('timed out') >= 0) return 'timeout';
    if (
      low.indexOf('temporary failure') >= 0 ||
      low.indexOf('name or service not known') >= 0 ||
      low.indexOf('getaddrinfo') >= 0 ||
      low.indexOf('failed to resolve') >= 0 ||
      low.indexOf('could not resolve') >= 0 ||
      low.indexOf('nodename nor servname') >= 0
    ) return 'dns';
    if (
      low.indexOf('network is unreachable') >= 0 ||
      low.indexOf('failed to connect') >= 0 ||
      low.indexOf('connection refused') >= 0 ||
      low.indexOf('connection reset') >= 0 ||
      low.indexOf('no route to host') >= 0
    ) return 'connect';
    if (
      low.indexOf('403') >= 0 ||
      low.indexOf('forbidden') >= 0 ||
      low.indexOf('429') >= 0 ||
      low.indexOf('rate limit') >= 0
    ) return 'limited';
    if (
      low.indexOf('ssl') >= 0 ||
      low.indexOf('tls') >= 0 ||
      low.indexOf('certificate') >= 0
    ) return 'tls';
    return 'generic';
  }

  function _buildCheckFailureView(data) {
    const kind = _classifyCheckFailure(data || {});
    if (kind === 'no_releases') {
      return {
        title: '⚠️ Release не найден',
        lines: [
          'Для выбранного канала нет опубликованного release или нужного install-архива.',
          'Проверь repo/channel и наличие xkeen-ui-routing.tar.gz в GitHub Releases.',
        ],
      };
    }
    if (kind === 'timeout') {
      return {
        title: '⚠️ GitHub не ответил',
        lines: [
          'Проверка latest дошла до таймаута. Установка не начиналась.',
          'Повтори позже или проверь доступ роутера к GitHub/release assets.',
        ],
      };
    }
    if (kind === 'dns') {
      return {
        title: '⚠️ Роутер не видит GitHub',
        lines: [
          'DNS не смог разрешить адрес GitHub. Обновление не запускалось.',
          'Проверь DNS/интернет на роутере; при блокировке разреши GitHub hosts или используй рабочий маршрут.',
        ],
      };
    }
    if (kind === 'connect') {
      return {
        title: '⚠️ Нет соединения с GitHub',
        lines: [
          'Адрес найден, но соединение не установилось. Обновление не запускалось.',
          'Проверь блокировки, firewall и маршрут до GitHub с самого роутера.',
        ],
      };
    }
    if (kind === 'limited') {
      return {
        title: '⚠️ GitHub отклонил запрос',
        lines: [
          'GitHub вернул отказ или rate limit. Установка не начиналась.',
          'Повтори позже; если автопроверка включена часто, увеличь интервал.',
        ],
      };
    }
    if (kind === 'tls') {
      return {
        title: '⚠️ TLS-проверка не прошла',
        lines: [
          'Панель не смогла установить безопасное HTTPS-соединение с GitHub.',
          'Проверь время на роутере, сертификаты и сетевой перехват HTTPS.',
        ],
      };
    }
    return {
      title: '⚠️ Не удалось проверить обновление',
      lines: [
        'Панель не получила latest с GitHub. Обновление не запускалось.',
        'Чаще всего причина в недоступности GitHub/API/assets с роутера.',
      ],
    };
  }

  function _appendAlertDetails(parent, title, detailLines) {
    const lines = Array.isArray(detailLines) ? detailLines.filter(Boolean) : [];
    if (!parent || !lines.length) return;
    const details = document.createElement('details');
    details.className = 'dt-alert-details';
    const summary = document.createElement('summary');
    summary.textContent = title || 'Технические детали';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.className = 'dt-alert-details-pre';
    pre.textContent = lines.join('\n');
    details.appendChild(pre);
    parent.appendChild(details);
  }

  function _collectCheckFailureDetails(data, sec) {
    const out = [];
    const err = data && data.error ? String(data.error) : '';
    const repo = data && data.repo ? String(data.repo) : '';
    const channel = data && data.channel ? String(data.channel) : '';
    const branch = data && data.branch ? String(data.branch) : '';
    const meta = (data && data.meta && typeof data.meta === 'object') ? data.meta : null;
    if (err) out.push('Ошибка: ' + err);
    if (repo || channel || branch) out.push('Источник: ' + [repo, channel, branch].filter(Boolean).join(' · '));
    if (meta) out.push('Meta: ' + _safeJson(meta, 1400));
    if (sec && typeof sec === 'object') {
      const st = (sec.settings && typeof sec.settings === 'object') ? sec.settings : null;
      if (st) out.push('Policy: ' + _safeJson(st, 900));
    }
    return out;
  }

  function _collectSecurityDetails(sec) {
    const out = [];
    if (!sec || typeof sec !== 'object') return out;
    try {
      const warnings = Array.isArray(sec.warnings) ? sec.warnings.map((w) => String(w)) : [];
      if (warnings.length) out.push('Warnings: ' + warnings.join(' · '));
      if (sec.download) out.push('Download: ' + _safeJson(sec.download, 700));
      if (sec.checksum) out.push('Checksum: ' + _safeJson(sec.checksum, 700));
      if (sec.settings) out.push('Policy: ' + _safeJson(sec.settings, 900));
    } catch (e) {}
    return out;
  }

  function _renderSecurity(sec, opts) {
    const box = byId('dt-update-security');
    if (!box) return;

    _clearEl(box);

    const options = (opts && typeof opts === 'object') ? opts : {};
    const checkError = !!options.checkError;
    const checkData = (options.data && typeof options.data === 'object') ? options.data : {};

    if ((!sec || typeof sec !== 'object') && !checkError) {
      try { box.style.display = 'none'; } catch (e) {}
      try { box.className = 'dt-alert'; } catch (e) {}
      return;
    }

    const warnings = Array.isArray(sec && sec.warnings) ? sec.warnings.map((w) => String(w)) : [];
    const willBlock = !!(sec && sec.will_block_run);

    // Derive severity from warnings.
    let sev = 'warn';
    if (checkError || willBlock) sev = 'bad';
    if (warnings.some((w) => w.indexOf('blocked') >= 0 || w.indexOf('required_missing') >= 0 || w === 'checksum_required_missing')) sev = 'bad';

    // If nothing to show — hide.
    if (!checkError && !willBlock && (!warnings || !warnings.length)) {
      try { box.style.display = 'none'; } catch (e) {}
      try { box.className = 'dt-alert'; } catch (e) {}
      return;
    }

    try { box.style.display = ''; } catch (e) {}
    try { box.className = 'dt-alert ' + sev; } catch (e) {}

    const title = document.createElement('strong');
    const checkFailureView = checkError ? _buildCheckFailureView(checkData) : null;
    if (checkError) title.textContent = checkFailureView.title;
    else if (willBlock) title.textContent = '⚠️ Обновление остановлено политикой';
    else title.textContent = '⚠️ Предупреждения безопасности';
    box.appendChild(title);

    const linesWrap = document.createElement('div');
    linesWrap.className = 'dt-alert-lines';

    function addLine(text, opacity) {
      const d = document.createElement('div');
      d.textContent = String(text || '');
      if (opacity !== undefined && opacity !== null) d.style.opacity = String(opacity);
      linesWrap.appendChild(d);
    }

    if (checkError) {
      const viewLines = (checkFailureView && Array.isArray(checkFailureView.lines)) ? checkFailureView.lines : [];
      for (const line of viewLines) addLine(line);
    } else {
      if (willBlock) {
        addLine('Панель нашла обновление, но не будет запускать скачивание с текущими настройками безопасности.');
      }
      for (const w of warnings) {
        if (w === 'checksum_required_missing') {
          addLine('Для релиза не найден sha-файл, а политика требует checksum.');
          continue;
        }
        if (w.startsWith('download_url_blocked:')) {
          const reason = w.slice('download_url_blocked:'.length);
          const host = _extractHostFromUrl(sec && sec.download && sec.download.url);
          addLine('URL архива не разрешён: ' + _prettyUrlReason(reason) + (host ? (' · ' + host) : '') + '.');
          continue;
        }
        if (w.startsWith('checksum_url_blocked:')) {
          const reason = w.slice('checksum_url_blocked:'.length);
          const host = _extractHostFromUrl(sec && sec.checksum && sec.checksum.url);
          addLine('URL checksum не разрешён: ' + _prettyUrlReason(reason) + (host ? (' · ' + host) : '') + '.');
          continue;
        }
        addLine(w);
      }
      if (willBlock) addLine('Проверь allow-list/SHA-настройки или верни штатные GitHub URLs.', 0.9);
    }

    box.appendChild(linesWrap);
    if (checkError) {
      _appendAlertDetails(box, 'Технические детали', _collectCheckFailureDetails(checkData, sec));
    } else {
      _appendAlertDetails(box, 'Policy / URL детали', _collectSecurityDetails(sec));
    }
  }

  function _isBackupTarUnsupported(data) {
    try {
      return !!(data && String(data.error || '') === 'backup_tar_unsupported');
    } catch (e) {
      return false;
    }
  }

  function _backupTarUnsupportedHint(data) {
    const hint = data && data.hint ? String(data.hint) : '';
    if (hint) return hint;
    return 'Бэкап перед обновлением не может быть создан: текущий tar не поддерживает --exclude. Установите полноценный tar командой opkg update && opkg install tar или запустите обновление без бэкапа.';
  }

  function _renderBackupTarUnsupported(data) {
    const box = byId('dt-update-security');
    if (!box) return;
    _clearEl(box);
    try { box.style.display = ''; } catch (e) {}
    try { box.className = 'dt-alert bad'; } catch (e) {}

    const title = document.createElement('strong');
    title.textContent = '⚠️ Бэкап перед обновлением не создан';
    box.appendChild(title);

    const lines = document.createElement('div');
    lines.className = 'dt-alert-lines';

    const addLine = (text) => {
      const d = document.createElement('div');
      d.textContent = String(text || '');
      lines.appendChild(d);
    };

    addLine('На роутере найден tar без поддержки --exclude, обычно это BusyBox tar. Такой бэкап updater не запускает, чтобы не оставить пользователя с ложным rollback.');
    addLine('Надёжный вариант: установить полноценный tar и повторить обновление.');

    const cmd = document.createElement('code');
    cmd.textContent = String((data && data.install_command) || 'opkg update && opkg install tar');
    const cmdLine = document.createElement('div');
    cmdLine.appendChild(document.createTextNode('Команда: '));
    cmdLine.appendChild(cmd);
    lines.appendChild(cmdLine);

    addLine('Альтернатива: подтвердить запуск без бэкапа. В этом режиме rollback на предыдущую версию будет недоступен.');
    box.appendChild(lines);
  }

  const state = {
    pollTimer: null,
    lastCheck: null,
    lastInfo: null,
    lastStatus: null,
    lastRunState: null,
    lastRunOp: null,
  };

  function _setButtonsDisabled(disabled) {
    const btnCheck = byId('dt-update-check');
    const btnRun = byId('dt-update-run');
    const btnRollback = byId('dt-update-rollback');
    const btnRefresh = byId('dt-update-refresh');
    try { if (btnCheck) btnCheck.disabled = !!disabled; } catch (e) {}
    try { if (btnRun) btnRun.disabled = !!disabled; } catch (e) {}
    try { if (btnRollback) btnRollback.disabled = !!disabled; } catch (e) {}
    try { if (btnRefresh) btnRefresh.disabled = false; } catch (e) {}
  }

  // Track consecutive polling failures during update to detect service restart.
  let _pollFailCount = 0;
  let _waitingForRestart = false;

  function _startPolling() {
    if (state.pollTimer) return;
    _pollFailCount = 0;
    _waitingForRestart = false;
    state.pollTimer = setInterval(() => {
      loadStatus(true).catch(() => {});
    }, 1500);
  }

  function _stopPolling() {
    if (!state.pollTimer) return;
    try { clearInterval(state.pollTimer); } catch (e) {}
    state.pollTimer = null;
    _pollFailCount = 0;
    _waitingForRestart = false;
  }

  // Полный хэш (40 символов) не влезал в строку «Текущая версия:» и рвал её надвое.
  // Короткого префикса хватает, чтобы сверить сборку, а версии в других местах панели
  // печатаются так же.
  function _shortCommit(commit) {
    const raw = String(commit || '').trim();
    if (!/^[0-9a-f]{13,}$/i.test(raw)) return raw;
    return raw.slice(0, 12);
  }

  function _renderInfo(data) {
    const build = (data && data.build && typeof data.build === 'object') ? data.build : {};
    const settings = (data && data.settings && typeof data.settings === 'object') ? data.settings : {};

    const repo = (settings && settings.repo) ? String(settings.repo) : ((build && build.repo) ? String(build.repo) : '—');
    const channel = (settings && settings.channel) ? String(settings.channel) : ((build && build.channel) ? String(build.channel) : 'stable');
    const branch = (settings && settings.branch) ? String(settings.branch) : '';

    const version = (build && build.version) ? String(build.version) : '—';
    const commit = (build && build.commit) ? String(build.commit) : '';
    const builtUtc = (build && build.built_utc) ? String(build.built_utc) : '';

    _setText('dt-update-repo', repo);
    _setText('dt-update-channel', channel);
    _setText('dt-update-branch', branch || '—');
    _setText('dt-update-current-version', version);
    _setText('dt-update-current-commit', commit ? ('(' + _shortCommit(commit) + ')') : '');
    _setText('dt-update-current-built', builtUtc ? ('Сборка: ' + _fmtIso(builtUtc)) : '');


    // Cosmetic classes
    try {
      _setClass('dt-update-repo', 'dt-badge dt-badge-info');
      const chl = String(channel || '').toLowerCase();
      let chCls = 'dt-badge dt-badge-muted';
      if (chl === 'stable') chCls = 'dt-badge dt-badge-ok';
      else if (chl === 'main') chCls = 'dt-badge dt-badge-warn';
      _setClass('dt-update-channel', chCls);
      _setClass('dt-update-branch', 'dt-badge dt-badge-muted');
      _setClass('dt-update-current-version', 'dt-value dt-value-neutral');
      _setClass('dt-update-latest-version', 'dt-value dt-value-neutral');
      _setClass('dt-update-verdict', 'dt-pill dt-pill-muted');
    } catch (e) {}

    const caps = (data && data.capabilities && typeof data.capabilities === 'object') ? data.capabilities : {};
    const miss = [];
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'curl') && !caps.curl) miss.push('curl');
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'tar') && !caps.tar) miss.push('tar');
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'sha256sum') && !caps.sha256sum) {
      // sha256sum optional; don't treat as fatal.
    }

    if (miss.length) {
      _setSubStatus('Внимание: отсутствуют зависимости: ' + miss.join(', '));
    } else if (caps && caps.tar === true && caps.tar_exclude === false) {
      _setSubStatus('Внимание: текущий tar не поддерживает --exclude. Для бэкапа обновления нужен: opkg update && opkg install tar');
    }
  }

  function _renderCheck(data) {
    const latest = (data && data.latest && typeof data.latest === 'object') ? data.latest : null;
    const stale = !!(data && data.stale);

    const ok = !!(data && data.ok);
    const updateAvail = !!(data && data.update_available);

    _renderSecurity((data && data.security) ? data.security : null, (!latest || !ok) ? { checkError: true, data } : null);

    // Defaults
    _setClass('dt-update-current-version', 'dt-value dt-value-neutral');
    _setClass('dt-update-latest-version', 'dt-value dt-value-neutral');
    _setClass('dt-update-verdict', 'dt-pill dt-pill-muted');

    const btnRun = byId('dt-update-run');
    if (btnRun) {
      try { delete btnRun.dataset.uptodate; } catch (e) {}
      _setRunBlockedState(btnRun, false);
      try { btnRun.disabled = false; } catch (e) {}
    }

    if (!latest || !ok) {
      const blockedSummary = _summarizeCheckFailure(data || {});
      _setText('dt-update-latest-kind', '—');
      _setText('dt-update-latest-version', '—');
      _setText('dt-update-latest-date', '');
      _setText('dt-update-verdict', '⚠️ Не удалось получить информацию о последней версии');
      _setClass('dt-update-verdict', 'dt-pill dt-pill-bad');
      // Плашка статуса принадлежит операции обновления: результат проверки версии
      // живёт в пилюле рядом с «Latest», иначе одно затирает другое.
      _setText('dt-update-latest-hint', blockedSummary);
      if (btnRun) {
        _setRunBlockedState(btnRun, true, 'check_failed', blockedSummary);
        try { btnRun.title = blockedSummary; } catch (e) {}
      }
      return;
    }

    const kind = latest.kind ? String(latest.kind) : 'stable';
    _setText('dt-update-latest-kind', kind);

    let verLabel = '—';
    let dateLabel = '';
    if (kind === 'main') {
      const br = latest.branch ? String(latest.branch) : 'main';
      const shortSha = latest.short_sha ? String(latest.short_sha) : (latest.sha ? String(latest.sha).slice(0, 7) : '');
      verLabel = br + '@' + (shortSha || '—');
      const ca = latest.committed_at ? String(latest.committed_at) : '';
      dateLabel = ca ? ('(' + _fmtIso(ca) + ')') : '';
    } else {
      const tag = latest.tag ? String(latest.tag) : '—';
      verLabel = tag;
      const pub = latest.published_at ? String(latest.published_at) : '';
      dateLabel = pub ? ('(' + _fmtIso(pub) + ')') : '';
    }

    _setText('dt-update-latest-version', verLabel);
    _setText('dt-update-latest-date', dateLabel);

    const hintParts = [];
    if (stale) hintParts.push('данные из кэша');

    // Asset hint (stable only)
    if (kind !== 'main') {
      try {
        const assets = Array.isArray(latest.assets) ? latest.assets : [];
        const wanted = ['xkeen-ui-routing.tar.gz', 'xkeen-ui.tar.gz'];
        const haveAsset = assets.some((a) => {
          const name = a && a.name ? String(a.name) : '';
          return wanted.indexOf(name) >= 0;
        });
        if (!haveAsset) hintParts.push('в релизе нет xkeen-ui-routing.tar.gz / xkeen-ui.tar.gz');
      } catch (e) {}
    }

    // Policy block: if security says will_block_run, show as error verdict and disable Update.
    const willBlock = !!(data && data.security && data.security.will_block_run);
    if (willBlock) {
      const blockedSummary = _summarizeSecurityBlock(data && data.security);
      _setText('dt-update-verdict', '⛔ Обновление заблокировано политикой безопасности');
      _setClass('dt-update-verdict', 'dt-pill dt-pill-bad');
      _setClass('dt-update-latest-version', 'dt-value dt-value-neutral');
      hintParts.push(blockedSummary);
      if (btnRun) {
        _setRunBlockedState(btnRun, true, 'policy', blockedSummary);
        try { btnRun.disabled = false; } catch (e) {}
        try { btnRun.title = blockedSummary; } catch (e) {}
      }
    } else if (updateAvail) {
      _setText('dt-update-verdict', '⬆️ Доступно обновление: ' + verLabel);
      _setClass('dt-update-verdict', 'dt-pill dt-pill-warn');
      _setClass('dt-update-latest-version', 'dt-value dt-value-warn');
      _setClass('dt-update-current-version', 'dt-value dt-value-neutral');
    } else {
      _setText('dt-update-verdict', '✅ У вас актуальная версия');
      _setClass('dt-update-verdict', 'dt-pill dt-pill-ok');
      _setClass('dt-update-latest-version', 'dt-value dt-value-ok');
      _setClass('dt-update-current-version', 'dt-value dt-value-ok');
      if (btnRun) {
        try { btnRun.dataset.uptodate = '1'; } catch (e) {}
        try { btnRun.title = 'Версия актуальна. Можно нажать Update, чтобы переустановить поверх (с подтверждением).'; } catch (e) {}
      }
    }

    _setText('dt-update-latest-hint', hintParts.join(' · '));
  }

  function _renderStatus(data) {
    const st = (data && data.status && typeof data.status === 'object') ? data.status : {};
    const lock = (data && data.lock && typeof data.lock === 'object') ? data.lock : {};

    const stateVal = st && st.state ? String(st.state) : 'idle';
    const step = st && st.step ? String(st.step) : '';
    const err = st && st.error ? String(st.error) : '';
    const op = st && st.op ? String(st.op) : '';

    // Progress bar (step-based by default; real byte progress when runner provides bytes_done/bytes_total)
    if (stateVal === 'running') {
      let label = STEP_LABELS[step] || (step ? ('Шаг: ' + step) : 'Выполняется…');
      let pct = (step && Object.prototype.hasOwnProperty.call(STEP_PCT, step)) ? STEP_PCT[step] : 0;
      let ind = (step === 'download' || step === 'verify' || step === 'extract');

      const prog = (st && st.progress && typeof st.progress === 'object') ? st.progress : null;
      try {
        const phase = prog && prog.phase ? String(prog.phase) : '';
        const isDl = (step === 'download') || (phase === 'download');
        const isVerify = (step === 'verify') || (phase === 'verify');
        const isExtract = (step === 'extract') || (phase === 'extract');

        if (prog && (isDl || isVerify || isExtract)) {
          const bd = Number(prog.bytes_done || 0);
          const bt = Number(prog.bytes_total || 0);
          const fd = Number(prog.files_done || 0);
          const ft = Number(prog.files_total || 0);

          const hasBytes = (bt > 0 && bd >= 0);
          const hasFiles = (ft > 0 && fd >= 0);

          if (hasBytes || (isExtract && hasFiles)) {
            if (hasBytes) pct = Math.max(0, Math.min(100, (bd / bt) * 100));
            else pct = Math.max(0, Math.min(100, (fd / ft) * 100));

            ind = false;

            const pInt = Math.round(pct);
            const doneS = _fmtBytes(bd);
            const totalS = _fmtBytes(bt);

            if (isDl) label = (STEP_LABELS['download'] || 'Скачивание…') + ' ' + pInt + '%';
            else if (isVerify) label = (STEP_LABELS['verify'] || 'Проверка checksum…') + ' ' + pInt + '%';
            else if (isExtract) label = (STEP_LABELS['extract'] || 'Распаковка…') + ' ' + pInt + '%';

            const extra = [];
            if (isExtract && hasFiles) extra.push(String(fd) + ' / ' + String(ft) + ' файлов');
            if (hasBytes && doneS && totalS) extra.push(doneS + ' / ' + totalS);
            if (isVerify && !hasBytes && bd > 0 && doneS) extra.push('проверено ' + doneS);

            if (extra.length) label += ' (' + extra.join(' · ') + ')';

            const sp = Number(prog.speed_bps || 0);
            if (sp > 0) {
              const spS = _fmtBytes(sp);
              if (spS) label += ' · ' + spS + '/s';
            }
            const eta = Number(prog.eta_sec || 0);
            if (eta > 0 && eta < 86400) label += ' · осталось ' + _fmtAgeSec(eta);
          } else {
            // totals unknown — keep indeterminate bar
            ind = true;
            if (isVerify) {
              const doneS = _fmtBytes(bd);
              if (doneS) label = (STEP_LABELS['verify'] || 'Проверка checksum…') + ' (проверено ' + doneS + ')';
            }
            if (isExtract && fd > 0) {
              label = (STEP_LABELS['extract'] || 'Распаковка…') + ' (' + String(fd) + ' файлов)';
            }
          }
        }
      } catch (e) {}

      _setProgress(true, pct, ind, label);
    } else {
      _setProgress(false, 0, false, '');
    }

    // Status headline
    if (stateVal === 'running') {
      _setStatus((op === 'rollback' ? 'Откат выполняется' : 'Обновление выполняется') + (step ? (': ' + step) : ''), 'warn');
    } else if (stateVal === 'done') {
      _setStatus(op === 'rollback' ? 'Откат завершён' : 'Обновление завершено', 'ok');
    } else if (stateVal === 'failed') {
      _setStatus(op === 'rollback' ? 'Ошибка отката' : 'Ошибка обновления', 'bad');
    } else {
      _setStatus('Ожидание', '');
    }

    const parts = [];
    const errRu = _ruText(err);
    if (step && stateVal !== 'running') parts.push('Шаг: ' + _ruStep(step));
    if (errRu) parts.push('Ошибка: ' + errRu);

    try {
      if (lock && lock.exists) {
        const pid = lock.pid ? String(lock.pid) : '?';
        const age = (lock.age_sec !== null && lock.age_sec !== undefined) ? _fmtAgeSec(lock.age_sec) : '';
        parts.push('Блокировка: процесс ' + pid + (age ? (', держится ' + age) : ''));
      }
    } catch (e) {}

    // backups info (for rollback)
    try {
      const bks = (data && Array.isArray(data.backups)) ? data.backups : [];
      if (bks && bks.length) parts.push('Резервных копий: ' + bks.length);
    } catch (e) {}

    // runner pid if known
    try {
      const pid = st && st.pid ? String(st.pid) : '';
      if (pid) parts.push('Процесс обновления: ' + pid);
      // Сообщение панели часто пересказывает ту же ошибку — второй раз не пишем.
      const msg = _ruText(st && st.message);
      if (msg && msg.toLowerCase() !== errRu.toLowerCase()) parts.push(msg);
    } catch (e) {}

    _setSubStatus(parts.join(' · '));

    const logTail = (data && Array.isArray(data.log_tail)) ? data.log_tail : [];
    _renderLog(logTail, stateVal, err);
    state.lastRunState = stateVal;

    // Rollback button visibility (only when backups exist)
    try {
      const btnRb = byId('dt-update-rollback');
      const bks = (data && Array.isArray(data.backups)) ? data.backups : [];
      const hasBk = !!(data && (data.has_backup || (bks && bks.length)));
      if (btnRb) {
        btnRb.style.display = hasBk ? '' : 'none';
        if (hasBk && bks && bks.length) btnRb.textContent = 'Откатить (' + bks.length + ')';
        else btnRb.textContent = 'Откатить';
        btnRb.disabled = (stateVal === 'running');
      }
    } catch (e) {}

    // Polling toggle
    if (stateVal === 'running') {
      _startPolling();
      _setButtonsDisabled(true);
    } else {
      _stopPolling();
      _setButtonsDisabled(false);
    }

    // Toasts on finish (works across reloads via localStorage)
    try {
      const fin = Number(st && st.finished_ts ? st.finished_ts : 0);
      if (fin && (stateVal === 'done' || stateVal === 'failed')) {
        const key = 'xk_dt_update_last_toast_ts';
        let last = 0;
        try { last = Number(window.localStorage.getItem(key) || 0); } catch (e) { last = 0; }
        if (!last || fin > last) {
          if (stateVal === 'done') {
            toastKind(op === 'rollback' ? 'Откат завершён' : 'Обновление завершено', 'success');

            // Important UX: clear the global "update available" badge immediately after update,
            // and refresh open tabs to pick up new assets without manual Ctrl+F5.
            if (op !== 'rollback') {
              try {
                const n = getUpdateNotifierApi();
                if (n && typeof n.resetCache === 'function') n.resetCache();
              } catch (e) {}
              try { window.localStorage.setItem(LS_FORCE_RELOAD, String(Date.now())); } catch (e) {}
              // Refresh this DevTools tab too (storage event doesn't fire in the same tab).
              try { setTimeout(() => _reloadWithCacheBust(), 700); } catch (e) {}
            }
          } else {
            const e2 = err || (st && st.message ? String(st.message) : 'failed');
            toastKind((op === 'rollback' ? 'Ошибка отката: ' : 'Ошибка обновления: ') + e2, 'error');
          }
          try { window.localStorage.setItem(key, String(fin)); } catch (e) {}
        }
      }
    } catch (e) {}
  }

  async function loadInfo() {
    try {
      const data = await getJSON('/api/devtools/update/info');
      state.lastInfo = data;
      _renderInfo(data);
    } catch (e) {
      _setStatus('Ошибка: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  async function checkLatest(forceRefresh, silentToast, silentStatus) {
    try {
      if (!silentStatus) {
        _setText('dt-update-verdict', 'Проверяем GitHub…');
        _setClass('dt-update-verdict', 'dt-pill dt-pill-muted');
      }
      const data = await postJSON('/api/devtools/update/check', {
        force_refresh: !!forceRefresh,
        wait_seconds: 2.5,
      });
      state.lastCheck = data;
      if (data && data.ok) {
        _renderCheck(data);
      } else {
        _renderCheck(data || {});
      }
    } catch (e) {
      const failureData = _buildClientSideCheckFailureData(e);
      state.lastCheck = failureData;
      _renderCheck(failureData);
      if (!silentToast) toastKind(_summarizeCheckFailure(failureData), 'error');
    }
  }

  async function loadStatus(isSilent) {
    try {
      const tail = 200;
      const data = await getJSON('/api/devtools/update/status?tail=' + tail);
      _pollFailCount = 0;
      // If we were waiting for restart and backend is back, auto-reload.
      if (_waitingForRestart) {
        _waitingForRestart = false;
        _stopPolling();
        const st = (data && data.status && typeof data.status === 'object') ? data.status : {};
        const stateVal = st.state ? String(st.state) : '';
        if (stateVal === 'done') {
          _setStatus('Обновление завершено, перезагрузка…', 'ok');
          _setProgress(false, 0, false, '');
          try { window.localStorage.setItem(LS_FORCE_RELOAD, String(Date.now())); } catch (e) {}
          setTimeout(() => _reloadWithCacheBust(), 500);
          return;
        }
      }
      state.lastStatus = data;
      _renderStatus(data);
    } catch (e) {
      // During an active update, network errors likely mean the service is restarting.
      const lastSt = state.lastStatus && state.lastStatus.status;
      const lastState = lastSt && lastSt.state ? String(lastSt.state) : '';
      const lastStep = lastSt && lastSt.step ? String(lastSt.step) : '';
      if (lastState === 'running' && state.pollTimer) {
        _pollFailCount++;
        // After a few failures (especially at "restart" step), show a waiting message.
        if (_pollFailCount >= 2 || lastStep === 'restart') {
          _waitingForRestart = true;
          _setStatus('Панель перезапускается, ожидание…', 'warn');
          _setProgress(true, 95, true, 'Перезапуск сервиса…');
        }
      } else if (!isSilent) {
        _setStatus('Не удалось получить статус: ' + (e && e.message ? e.message : String(e)), 'bad');
      }
    }
  }

  async function runRollback() {
    try {
      const ok = await confirmAction({
        title: 'Откатить панель?',
        message: 'Откатить панель на предыдущую версию из бэкапа?',
        okText: 'Откатить',
        cancelText: 'Отменить',
        danger: true,
      });
      if (!ok) return;

      _setStatus('Запускаем откат…', 'warn');
      const data = await postJSON('/api/devtools/update/rollback', {});
      if (data && data.ok) {
        if (data.started) {
          toastKind('Откат запущен', 'info');
          _setButtonsDisabled(true);
          setTimeout(() => loadStatus(true).catch(() => {}), 400);
          _startPolling();
        } else if (data.reason === 'locked') {
          toastKind('Операция уже выполняется', 'info');
          _renderStatus({ status: data.status, lock: data.lock, log_tail: [] });
          _startPolling();
        } else {
          toastKind('Откат не запущен', 'error');
        }
      } else {
        const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'rollback_failed';
        _setStatus('Не удалось запустить откат: ' + _ruText(err), 'bad');
      }
    } catch (e) {
      _setStatus('Ошибка отката: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  async function runUpdate() {
    try {
      const btnRun = byId('dt-update-run');
      if (_showBlockedUpdateReason(btnRun)) return;

      let ok = true;
      try {
        const upToDate = !!(btnRun && btnRun.dataset && btnRun.dataset.uptodate === '1');
        if (upToDate) {
          ok = await confirmAction({
            title: 'Переустановить поверх?',
            message: 'У вас актуальная версия. Переустановить поверх ещё раз?',
            okText: 'Переустановить',
            cancelText: 'Отменить',
            danger: false,
          });
        }
      } catch (e) { ok = true; }
      if (!ok) return;
      // "По красоте": если есть результат /check (или быстро получим его),
      // передаём в /run (asset_url/tag/sha_url), чтобы runner не делал сетевой check_latest.
      let chk = state.lastCheck;
      if (!(chk && chk.ok && chk.latest)) {
        try {
          await checkLatest(false, true, true);
          chk = state.lastCheck;
        } catch (e) {
          // ignore; will fallback to runner's own check_latest
        }
        if (_showBlockedUpdateReason(btnRun)) return;
      }

      const resolved = {};
      try {
        const ch = (chk && chk.channel) ? String(chk.channel).toLowerCase() : '';
        if (ch) resolved.channel = ch;
        if (chk && chk.branch) resolved.branch = String(chk.branch);
        const latest = (chk && chk.latest && typeof chk.latest === 'object') ? chk.latest : null;
        if (latest) {
          if (ch === 'stable') {
            resolved.tag = latest.tag ? String(latest.tag) : '';
            const asset = (latest.asset && typeof latest.asset === 'object') ? latest.asset : {};
            if (asset.name) resolved.asset_name = String(asset.name);
            if (asset.download_url) resolved.asset_url = String(asset.download_url);
            const sha = (latest.sha256_asset && typeof latest.sha256_asset === 'object') ? latest.sha256_asset : {};
            if (sha.download_url) resolved.sha_url = String(sha.download_url);
            if (sha.kind) resolved.sha_kind = String(sha.kind);
          } else if (ch === 'main') {
            // main channel: we already know the tarball_url from /check
            resolved.tag = latest.tag ? String(latest.tag) : '';
            if (latest.tarball_url) resolved.asset_url = String(latest.tarball_url);
          }
        }
      } catch (e) {}

      const payload = (resolved && resolved.asset_url) ? { resolved } : {};

      _setStatus('Запускаем обновление…', 'warn');
      let data = await postJSON('/api/devtools/update/run', payload);
      if (!(data && data.ok) && _isBackupTarUnsupported(data)) {
        _renderBackupTarUnsupported(data);
        _setStatus(_backupTarUnsupportedHint(data), 'bad');
        const skipBackup = await confirmAction({
          title: 'Обновить без бэкапа?',
          message: 'Бэкап не создан, потому что текущий tar не поддерживает --exclude. Можно установить tar командой opkg update && opkg install tar и повторить обновление, либо продолжить без бэкапа. Без бэкапа rollback на предыдущую версию будет недоступен.',
          okText: 'Без бэкапа',
          cancelText: 'Отменить',
          danger: true,
        });
        if (!skipBackup) return;

        const noBackupPayload = Object.assign({}, payload || {}, { skip_backup: true });
        _setStatus('Запускаем обновление без резервной копии…', 'warn');
        data = await postJSON('/api/devtools/update/run', noBackupPayload);
      }
      if (data && data.ok) {
        if (data.started) {
          toastKind('Обновление запущено', 'info');
          _setButtonsDisabled(true);
          setTimeout(() => loadStatus(true).catch(() => {}), 400);
          _startPolling();
        } else if (data.reason === 'locked') {
          toastKind('Обновление уже выполняется', 'info');
          _renderStatus({ status: data.status, lock: data.lock, log_tail: [] });
          _startPolling();
        } else {
          toastKind('Обновление не запущено', 'error');
        }
      } else {
        const err = data && (data.hint || data.error) ? String(data.hint || data.error) : 'run_failed';
        _setStatus('Не удалось запустить обновление: ' + _ruText(err), 'bad');
      }
    } catch (e) {
      _setStatus('Ошибка запуска: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  function openLogsTab() {
    try {
      const logs = DT.devtoolsLogs || null;
      if (logs && typeof logs.openLog === 'function') {
        logs.openLog('update').catch(() => {});
        return;
      }
    } catch (e) {}

    try {
      // Prefer feature API if present.
      if (DT.devtools && typeof DT.devtools.setActiveTab === 'function') {
        DT.devtools.setActiveTab('logs');
        return;
      }
    } catch (e) {}

    try {
      const btn = byId('dt-tab-btn-logs');
      if (btn) btn.click();
    } catch (e) {}
  }

  function _renderNotifyHint(s) {
    const elHint = byId('dt-update-autocheck-hint');
    const elEnable = byId('dt-update-autocheck-enable');
    const elInterval = byId('dt-update-autocheck-interval');
    if (!elEnable || !elInterval) return;

    const enabled = !!(s && s.enabled);
    const hours = s && s.intervalHours ? Number(s.intervalHours) : 6;

    try { elEnable.checked = enabled; } catch (e) {}
    try { elInterval.value = String(_clampNotifyHours(hours)); } catch (e) {}
    try { elInterval.disabled = !enabled; } catch (e) {}

    if (elHint) {
      const msg = enabled
        ? ('Автопроверка включена: каждые ' + String(_clampNotifyHours(hours)) + 'ч (пока вкладка открыта).')
        : 'Автопроверка выключена (уведомления не будут показываться автоматически).';
      try { elHint.textContent = msg; } catch (e) {}
    }
  }

  function _initAutoCheckControls() {
    const elEnable = byId('dt-update-autocheck-enable');
    const elInterval = byId('dt-update-autocheck-interval');
    if (!elEnable || !elInterval) return;

    // Initial render
    _renderNotifyHint(_readNotifySettings());

    // Wire change handlers
    elEnable.addEventListener('change', () => {
      const enabled = !!elEnable.checked;
      const hours = _clampNotifyHours(elInterval.value);
      const s = _applyNotifySettings({ enabled, intervalHours: hours });
      _renderNotifyHint(s);
      toastKind(enabled ? 'Автопроверка обновлений включена' : 'Автопроверка обновлений выключена', 'success');
    });

    elInterval.addEventListener('change', () => {
      const enabled = !!elEnable.checked;
      const hours = _clampNotifyHours(elInterval.value);
      const s = _applyNotifySettings({ enabled, intervalHours: hours });
      _renderNotifyHint(s);
      toastKind('Интервал автопроверки: ' + String(_clampNotifyHours(hours)) + 'ч', 'success');
    });

    // Keep UI in sync if settings change from another tab.
    try {
      window.addEventListener('storage', (ev) => {
        const k = ev && ev.key ? String(ev.key) : '';
        if (k === LS_NOTIFY_ENABLED || k === LS_NOTIFY_INTERVAL_H) {
          _renderNotifyHint(_readNotifySettings());
        }
      });
    } catch (e) {}
  }

  function init() {
    if (_inited) return;
    _inited = true;

    const btnCheck = byId('dt-update-check');
    const btnRun = byId('dt-update-run');
    const btnRollback = byId('dt-update-rollback');
    const btnRefresh = byId('dt-update-refresh');
    const btnOpenLogs = byId('dt-update-open-logs');
    const btnVerdictLog = byId('dt-update-log-open');

    if (btnCheck) btnCheck.addEventListener('click', () => checkLatest(true, false, false));
    if (btnRun) btnRun.addEventListener('click', () => runUpdate());
    if (btnRollback) btnRollback.addEventListener('click', () => runRollback());
    if (btnRefresh) btnRefresh.addEventListener('click', () => loadStatus(false));
    if (btnOpenLogs) btnOpenLogs.addEventListener('click', openLogsTab);
    if (btnVerdictLog) btnVerdictLog.addEventListener('click', openLogsTab);

    // Auto-check settings UI (shared with global header notifier)
    try { _initAutoCheckControls(); } catch (e) {}

    // Initial paint
    loadInfo().catch(() => {});
    loadStatus(true).catch(() => {});
    // UX: populate "Latest" on load (silently; no temporary "Checking…" status).
    try { setTimeout(() => checkLatest(false, true, true).catch(() => {}), 250); } catch (e) {}
  }

  function activate() {
    if (!_inited) return false;
    try {
      if (!state.lastInfo) loadInfo().catch(() => {});
      loadStatus(true).catch(() => {});
    } catch (e) {}
    return true;
  }

  function deactivate() {
    _stopPolling();
    return true;
  }

  setDevtoolsNamespaceApi('devtoolsUpdate', {
    init,
    activate,
    deactivate,
    loadInfo,
    checkLatest,
    loadStatus,
    runUpdate,
    runRollback,
  });
})();
