(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
  const toast = SH.toast || function (m, isErr) { try { console[(isErr ? 'error' : 'log')](m); } catch (e) {} };
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
      if (v < 60) return Math.floor(v) + 's';
      if (v < 3600) return Math.floor(v / 60) + 'm';
      if (v < 86400) return Math.floor(v / 3600) + 'h';
      return Math.floor(v / 86400) + 'd';
    } catch (e) {
      return '';
    }
  }

  function _setText(id, text) {
    const el = byId(id);
    if (!el) return;
    try { el.textContent = String(text || ''); } catch (e) {}
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

  function _renderLog(lines) {
    const pre = byId('dt-update-log');
    if (!pre) return;
    try {
      if (!lines || !lines.length) {
        pre.textContent = '';
        return;
      }
      // Backend returns lines with keepends; join as-is.
      pre.textContent = lines.join('');
    } catch (e) {
      try { pre.textContent = ''; } catch (e2) {}
    }
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

  function _renderSecurity(sec) {
    const box = byId('dt-update-security');
    if (!box) return;

    _clearEl(box);

    if (!sec || typeof sec !== 'object') {
      try { box.style.display = 'none'; } catch (e) {}
      try { box.className = 'dt-alert'; } catch (e) {}
      return;
    }

    const warnings = Array.isArray(sec.warnings) ? sec.warnings.map((w) => String(w)) : [];
    const willBlock = !!sec.will_block_run;

    // Derive severity from warnings.
    let sev = 'warn';
    if (willBlock) sev = 'bad';
    if (warnings.some((w) => w.indexOf('blocked') >= 0 || w.indexOf('required_missing') >= 0 || w === 'checksum_required_missing')) sev = 'bad';

    // If nothing to show — hide.
    if (!willBlock && (!warnings || !warnings.length)) {
      try { box.style.display = 'none'; } catch (e) {}
      try { box.className = 'dt-alert'; } catch (e) {}
      return;
    }

    try { box.style.display = ''; } catch (e) {}
    try { box.className = 'dt-alert ' + sev; } catch (e) {}

    const title = document.createElement('strong');
    if (willBlock) title.textContent = '⚠️ Обновление будет заблокировано политикой безопасности';
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

    for (const w of warnings) {
      if (w === 'checksum_required_missing') {
        addLine('Checksum required: не найден sha-файл (XKEEN_UI_UPDATE_REQUIRE_SHA=1).');
        continue;
      }
      if (w.startsWith('download_url_blocked:')) {
        const reason = w.slice('download_url_blocked:'.length);
        addLine('Загрузка архива заблокирована: ' + _prettyUrlReason(reason) + '.');
        continue;
      }
      if (w.startsWith('checksum_url_blocked:')) {
        const reason = w.slice('checksum_url_blocked:'.length);
        addLine('Загрузка checksum заблокирована: ' + _prettyUrlReason(reason) + '.');
        continue;
      }
      addLine(w);
    }

    // Add compact policy summary (helps debug allow-list / strict sha).
    try {
      const st = (sec.settings && typeof sec.settings === 'object') ? sec.settings : {};
      const allowHosts = st.allow_hosts ? String(st.allow_hosts) : '';
      const requireSha = st.require_sha ? String(st.require_sha) : '';
      const shaStrict = st.sha_strict ? String(st.sha_strict) : '';
      const maxBytes = st.max_bytes ? _fmtBytes(st.max_bytes) : '';
      const dlTimeout = st.download_timeout ? String(st.download_timeout) : '';
      const parts = [];
      if (allowHosts) parts.push('allow_hosts=' + allowHosts);
      if (requireSha) parts.push('require_sha=' + requireSha);
      if (shaStrict) parts.push('sha_strict=' + shaStrict);
      if (maxBytes) parts.push('max=' + maxBytes);
      if (dlTimeout) parts.push('dl_timeout=' + dlTimeout + 's');
      if (parts.length) addLine('Policy: ' + parts.join(' · '), 0.85);
    } catch (e) {}

    box.appendChild(linesWrap);
  }

  const state = {
    pollTimer: null,
    lastCheck: null,
    lastInfo: null,
    lastStatus: null,
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

  function _startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      loadStatus(true).catch(() => {});
    }, 1500);
  }

  function _stopPolling() {
    if (!state.pollTimer) return;
    try { clearInterval(state.pollTimer); } catch (e) {}
    state.pollTimer = null;
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
    _setText('dt-update-current-commit', commit ? ('(' + commit + ')') : '');
    _setText('dt-update-current-built', builtUtc ? ('Сборка: ' + _fmtIso(builtUtc)) : '');

    const caps = (data && data.capabilities && typeof data.capabilities === 'object') ? data.capabilities : {};
    const miss = [];
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'curl') && !caps.curl) miss.push('curl');
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'tar') && !caps.tar) miss.push('tar');
    if (caps && Object.prototype.hasOwnProperty.call(caps, 'sha256sum') && !caps.sha256sum) {
      // sha256sum optional; don't treat as fatal.
    }

    if (miss.length) {
      _setSubStatus('Внимание: отсутствуют зависимости: ' + miss.join(', '));
    }
  }

  function _renderCheck(data) {
    const latest = (data && data.latest && typeof data.latest === 'object') ? data.latest : null;
    const stale = !!(data && data.stale);

    _renderSecurity((data && data.security) ? data.security : null);

    if (!latest) {
      _setText('dt-update-latest-kind', '—');
      _setText('dt-update-latest-version', '—');
      _setText('dt-update-latest-date', '');
      _setText('dt-update-latest-hint', (data && data.ok) ? 'Данные не найдены.' : 'Не удалось получить данные о latest.');
      return;
    }

    const kind = latest.kind ? String(latest.kind) : 'stable';
    _setText('dt-update-latest-kind', kind);

    const updateAvail = !!(data && data.update_available);

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
    if (updateAvail) hintParts.push('Доступно обновление');
    else hintParts.push('У вас актуальная версия');
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
        if (!haveAsset) hintParts.push('нет xkeen-ui-routing.tar.gz / xkeen-ui.tar.gz в релизе');
      } catch (e) {}
    }

    _setText('dt-update-latest-hint', hintParts.join(' · '));

    if (updateAvail) _setStatus('Update available: ' + verLabel, 'ok');
    else _setStatus('Up to date', 'ok');
  }

  function _renderStatus(data) {
    const st = (data && data.status && typeof data.status === 'object') ? data.status : {};
    const lock = (data && data.lock && typeof data.lock === 'object') ? data.lock : {};

    const stateVal = st && st.state ? String(st.state) : 'idle';
    const step = st && st.step ? String(st.step) : '';
    const err = st && st.error ? String(st.error) : '';

    if (stateVal === 'running') {
      _setStatus('Running' + (step ? (': ' + step) : ''), 'warn');
    } else if (stateVal === 'done') {
      _setStatus('Done' + (step ? (': ' + step) : ''), 'ok');
    } else if (stateVal === 'failed') {
      _setStatus('Failed' + (step ? (': ' + step) : ''), 'bad');
    } else {
      _setStatus('Idle', '');
    }

    const parts = [];
    if (step && stateVal !== 'running') parts.push('Step: ' + step);
    if (err) parts.push('Error: ' + err);

    try {
      if (lock && lock.exists) {
        const pid = lock.pid ? String(lock.pid) : '?';
        const age = (lock.age_sec !== null && lock.age_sec !== undefined) ? _fmtAgeSec(lock.age_sec) : '';
        parts.push('Lock: pid ' + pid + (age ? (', age ' + age) : ''));
      }
    } catch (e) {}

    // backups info (for rollback)
    try {
      const bks = (data && Array.isArray(data.backups)) ? data.backups : [];
      if (bks && bks.length) parts.push('Backups: ' + bks.length);
    } catch (e) {}

    // runner pid if known
    try {
      const pid = st && st.pid ? String(st.pid) : '';
      if (pid) parts.push('Runner pid: ' + pid);
      const msg = st && st.message ? String(st.message) : '';
      if (msg && stateVal === 'running') parts.push(msg);
    } catch (e) {}

    _setSubStatus(parts.join(' · '));

    const logTail = (data && Array.isArray(data.log_tail)) ? data.log_tail : [];
    _renderLog(logTail);

    // Rollback button visibility (only when backups exist)
    try {
      const btnRb = byId('dt-update-rollback');
      const bks = (data && Array.isArray(data.backups)) ? data.backups : [];
      const hasBk = !!(data && (data.has_backup || (bks && bks.length)));
      if (btnRb) {
        btnRb.style.display = hasBk ? '' : 'none';
        if (hasBk && bks && bks.length) btnRb.textContent = 'Rollback (' + bks.length + ')';
        else btnRb.textContent = 'Rollback';
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

  async function checkLatest(forceRefresh) {
    try {
      _setStatus('Checking GitHub…', 'warn');
      const data = await postJSON('/api/devtools/update/check', {
        force_refresh: !!forceRefresh,
        wait_seconds: 2.5,
      });
      state.lastCheck = data;
      if (data && data.ok) {
        _renderCheck(data);
      } else {
        const err = data && data.error ? String(data.error) : 'check_failed';
        _setStatus('Check failed: ' + err, 'bad');
        _renderCheck(data || {});
      }
    } catch (e) {
      _setStatus('Check error: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  async function loadStatus(isSilent) {
    try {
      const tail = 200;
      const data = await getJSON('/api/devtools/update/status?tail=' + tail);
      state.lastStatus = data;
      _renderStatus(data);
    } catch (e) {
      if (!isSilent) _setStatus('Status error: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  async function runRollback() {
    try {
      let ok = true;
      try {
        ok = window.confirm('Откатить панель на предыдущую версию из бэкапа?');
      } catch (e) { ok = true; }
      if (!ok) return;

      _setStatus('Starting rollback…', 'warn');
      const data = await postJSON('/api/devtools/update/rollback', {});
      if (data && data.ok) {
        if (data.started) {
          toast('Rollback started');
          _setButtonsDisabled(true);
          setTimeout(() => loadStatus(true).catch(() => {}), 400);
          _startPolling();
        } else if (data.reason === 'locked') {
          toast('Operation already running', false);
          _renderStatus({ status: data.status, lock: data.lock, log_tail: [] });
          _startPolling();
        } else {
          toast('Rollback not started', true);
        }
      } else {
        const err = data && data.error ? String(data.error) : 'rollback_failed';
        _setStatus('Rollback failed: ' + err, 'bad');
      }
    } catch (e) {
      _setStatus('Rollback error: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  async function runUpdate() {
    try {
      _setStatus('Starting update…', 'warn');
      const data = await postJSON('/api/devtools/update/run', {});
      if (data && data.ok) {
        if (data.started) {
          toast('Update started');
          _setButtonsDisabled(true);
          setTimeout(() => loadStatus(true).catch(() => {}), 400);
          _startPolling();
        } else if (data.reason === 'locked') {
          toast('Update already running', false);
          _renderStatus({ status: data.status, lock: data.lock, log_tail: [] });
          _startPolling();
        } else {
          toast('Update not started', true);
        }
      } else {
        const err = data && data.error ? String(data.error) : 'run_failed';
        _setStatus('Run failed: ' + err, 'bad');
      }
    } catch (e) {
      _setStatus('Run error: ' + (e && e.message ? e.message : String(e)), 'bad');
    }
  }

  function openLogsTab() {
    try {
      // Prefer feature API if present.
      if (XK.features && XK.features.devtools && typeof XK.features.devtools.setActiveTab === 'function') {
        XK.features.devtools.setActiveTab('logs');
        return;
      }
    } catch (e) {}

    try {
      const btn = byId('dt-tab-btn-logs');
      if (btn) btn.click();
    } catch (e) {}
  }

  function init() {
    const btnCheck = byId('dt-update-check');
    const btnRun = byId('dt-update-run');
    const btnRollback = byId('dt-update-rollback');
    const btnRefresh = byId('dt-update-refresh');
    const btnOpenLogs = byId('dt-update-open-logs');

    if (btnCheck) btnCheck.addEventListener('click', () => checkLatest(true));
    if (btnRun) btnRun.addEventListener('click', () => runUpdate());
    if (btnRollback) btnRollback.addEventListener('click', () => runRollback());
    if (btnRefresh) btnRefresh.addEventListener('click', () => loadStatus(false));
    if (btnOpenLogs) btnOpenLogs.addEventListener('click', openLogsTab);

    // Initial paint
    loadInfo().catch(() => {});
    loadStatus(true).catch(() => {});
  }

  XK.features.devtoolsUpdate = { init, loadInfo, checkLatest, loadStatus, runUpdate, runRollback };
})();
