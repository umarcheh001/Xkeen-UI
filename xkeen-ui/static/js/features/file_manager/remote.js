(() => {
  'use strict';

  // File Manager remote UI (connect/disconnect + profiles + known_hosts)
  // No ES modules / bundler: attach to window.XKeen.features.fileManager.remote

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  FM.remote = FM.remote || {};
  const R = FM.remote;

  const C = FM.common || {};
  FM.api = FM.api || {};
  const A = FM.api;
  const E = FM.errors || {};

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function show(node) {
    if (!node) return;
    try { node.style.display = ''; } catch (e) {}
  }

  function hide(node) {
    if (!node) return;
    try { node.style.display = 'none'; } catch (e) {}
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function _errFromResponse(res, data, ctx) {
    try { if (E && typeof E.fromResponse === 'function') return E.fromResponse(res, data, ctx); } catch (e) {}
    try { if (A && typeof A.errorFromResponse === 'function') return A.errorFromResponse(res, data, ctx); } catch (e) {}
    const msg = (data && (data.error || data.message)) ? String(data.error || data.message) : 'request_failed';
    return new Error(msg);
  }

  function presentError(err, opts) {
    try { if (E && typeof E.present === 'function') return E.present(err, Object.assign({ place: 'toast', action: 'remote' }, opts || {})); } catch (e) {}
    const m = (err && (err.message || err.toString)) ? String(err.message || err) : 'Ошибка';
    toast(m, 'error');
  }

  function storageGetJSON(key, fallback) {
    try { if (C && typeof C.storageGetJSON === 'function') return C.storageGetJSON(key, fallback); } catch (e) {}
    try {
      const raw = window.localStorage ? window.localStorage.getItem(String(key)) : null;
      if (!raw) return fallback;
      const j = JSON.parse(raw);
      return (j == null) ? fallback : j;
    } catch (e2) {
      return fallback;
    }
  }

  function storageSetJSON(key, val) {
    try { if (C && typeof C.storageSetJSON === 'function') return C.storageSetJSON(key, val); } catch (e) {}
    try { if (window.localStorage) window.localStorage.setItem(String(key), JSON.stringify(val)); } catch (e2) {}
  }

  function fetchJson(url, init) {
    try { if (A && typeof A.fetchJson === 'function') return A.fetchJson(url, init); } catch (e) {}
    return Promise.reject(new Error('FM.api.fetchJson missing'));
  }

  async function listPanel(side, opts) {
    try { if (A && typeof A.listPanel === 'function') return await A.listPanel(side, opts); } catch (e) {}
    return false;
  }

  function renderPanel(side) {
    try { if (A && typeof A.renderPanel === 'function') return A.renderPanel(side); } catch (e) {}
  }

  // -------------------------- connect / disconnect --------------------------
  // Remote connection profiles (localStorage)
  // Store without password: { id, proto, host, port, user, updatedAt }
  const _LS_REMOTE_PROFILES_KEY = 'xkeen.fm.remoteProfiles.v1';
  const _LS_REMOTE_PROFILES_LAST_KEY = 'xkeen.fm.remoteProfiles.last.v1';
  // Remember "remember profile" checkbox state (UX: user doesn't have to re-check every time)
  const _LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY = 'xkeen.fm.remoteProfiles.rememberFlag.v1';

  function _loadRememberProfileFlag() {
    try { return !!storageGetJSON(_LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY, false); } catch (e) { return false; }
  }

  function _saveRememberProfileFlag(v) {
    try { storageSetJSON(_LS_REMOTE_PROFILES_REMEMBER_FLAG_KEY, !!v); } catch (e) {}
  }

  function _profileSig(p) {
    try {
      const proto = String(p && (p.proto || p.protocol) || '').trim().toLowerCase();
      const host = String(p && p.host || '').trim().toLowerCase();
      const port = String(p && (p.port == null ? '' : p.port) || '').trim();
      const user = String(p && (p.user || p.username) || '').trim().toLowerCase();
      return `${proto}://${user}@${host}:${port}`;
    } catch (e) {
      return '';
    }
  }

  function _loadRemoteProfiles() {
    const arr = storageGetJSON(_LS_REMOTE_PROFILES_KEY, []);
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const it of arr) {
      if (!it) continue;
      const proto = String(it.proto || it.protocol || '').trim().toLowerCase();
      const host = String(it.host || '').trim();
      const user = String(it.user || it.username || '').trim();
      let port = it.port;
      try { if (port != null && port !== '') port = parseInt(String(port), 10); } catch (e) { port = null; }
      const id = String(it.id || '') || _profileSig({ proto, host, user, port });
      if (!proto || !host || !user) continue;
      out.push({ id, proto, host, user, port: (port && isFinite(port)) ? port : null, updatedAt: Number(it.updatedAt || 0) || 0 });
    }
    out.sort((a, b) => (Number(b.updatedAt || 0) - Number(a.updatedAt || 0)));
    return out;
  }

  function _saveRemoteProfiles(list) {
    const arr = Array.isArray(list) ? list.slice(0, 50) : [];
    storageSetJSON(_LS_REMOTE_PROFILES_KEY, arr);
  }

  function _fmtProfileLabel(p) {
    const proto = String(p && p.proto || '').toLowerCase();
    const user = String(p && p.user || '').trim();
    const host = String(p && p.host || '').trim();
    const port = (p && p.port) ? String(p.port) : '';
    const p2 = port ? `:${port}` : '';
    return `${proto}://${user}@${host}${p2}`;
  }

  function _renderRemoteProfilesSelect(selectedId) {
    const sel = el('fm-conn-profile');
    const delBtn = el('fm-conn-profile-del-btn');
    if (!sel) return;

    const profiles = _loadRemoteProfiles();
    const cur = String(selectedId || sel.value || '').trim();

    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = '—';
    sel.appendChild(opt0);

    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = String(p.id || '');
      opt.textContent = _fmtProfileLabel(p);
      sel.appendChild(opt);
    }

    const exists = [...sel.options].some(o => String(o.value) === cur);
    sel.value = exists ? cur : '';

    if (delBtn) delBtn.disabled = !sel.value;
  }

  function _applyProfileToConnectInputs(p) {
    if (!p) return;
    try { if (el('fm-proto')) el('fm-proto').value = String(p.proto || 'sftp'); } catch (e) {}
    try { if (el('fm-host')) el('fm-host').value = String(p.host || ''); } catch (e) {}
    try { if (el('fm-user')) el('fm-user').value = String(p.user || ''); } catch (e) {}
    try {
      const portEl = el('fm-port');
      if (portEl) portEl.value = (p.port != null && p.port !== '') ? String(p.port) : '';
    } catch (e) {}
    try {
      if (el('fm-auth-type')) el('fm-auth-type').value = 'password';
      if (el('fm-pass')) el('fm-pass').value = '';
      if (el('fm-passphrase')) el('fm-passphrase').value = '';
      if (el('fm-key-path')) el('fm-key-path').value = '';
      if (el('fm-key-file')) { try { el('fm-key-file').value = ''; } catch (e2) {} }
    } catch (e) {}
    try { updateConnectAuthUi(); } catch (e) {}
    try { updateHostKeyFingerprintPreview(); } catch (e) {}
  }

  function _getConnectProfileFromInputs() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp').trim().toLowerCase();
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    const user = String((el('fm-user') && el('fm-user').value) || '').trim();
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    let port = null;
    try { if (portRaw) port = parseInt(portRaw, 10); } catch (e) { port = null; }
    return { proto, host, user, port: (port && isFinite(port)) ? port : null };
  }

  function _rememberConnectProfileIfNeeded() {
    const cb = el('fm-remember-profile');
    if (!cb || !cb.checked) return;

    const p = _getConnectProfileFromInputs();
    if (!p || !p.proto || !p.host || !p.user) return;

    const id = _profileSig(p);
    const now = Date.now();
    const list = _loadRemoteProfiles();
    const idx = list.findIndex(x => String(x && x.id) === id);
    const isNew = idx < 0;
    const entry = { id, proto: p.proto, host: p.host, user: p.user, port: p.port, updatedAt: now };
    if (idx >= 0) list.splice(idx, 1);
    list.unshift(entry);
    _saveRemoteProfiles(list.slice(0, 20));
    storageSetJSON(_LS_REMOTE_PROFILES_LAST_KEY, id);

    try { _renderRemoteProfilesSelect(id); } catch (e) {}
    try { if (isNew) toast('Профиль сохранён (в браузере)', 'info'); } catch (e) {}
  }

  function _loadLastProfileId() {
    try { return String(storageGetJSON(_LS_REMOTE_PROFILES_LAST_KEY, '') || '').trim(); } catch (e) { return ''; }
  }

  function _findRemoteProfileById(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    try {
      const list = _loadRemoteProfiles();
      return list.find(p => String(p && p.id) === key) || null;
    } catch (e) {
      return null;
    }
  }

  async function loadRemoteCaps() {
    const S = _S();
    if (!S) return;
    try {
      const { res, data } = await fetchJson('/api/remotefs/capabilities', { method: 'GET' });
      if (res && res.ok && data && data.ok) {
        S.remoteCaps = data;
      }
    } catch (e) {}
  }

  function applyCapsToConnectModal() {
    const S = _S();
    const caps = S ? S.remoteCaps : null;
    if (!caps || !caps.security) return;

    const hk = el('fm-hostkey-policy');
    const tls = el('fm-tls-verify');
    const authType = el('fm-auth-type');

    try {
      const sftp = caps.security.sftp || {};
      if (hk && Array.isArray(sftp.hostkey_policies)) {
        hk.innerHTML = '';
        sftp.hostkey_policies.forEach((p) => {
          const opt = document.createElement('option');
          opt.value = String(p);
          opt.textContent = String(p);
          hk.appendChild(opt);
        });
        hk.value = String(sftp.default_policy || 'accept_new');
      }

      if (authType && Array.isArray(sftp.auth_types) && sftp.auth_types.length) {
        authType.innerHTML = '';
        sftp.auth_types.forEach((t) => {
          const opt = document.createElement('option');
          opt.value = String(t);
          opt.textContent = String(t);
          authType.appendChild(opt);
        });
        if (![...authType.options].some(o => o.value === authType.value)) {
          authType.value = String(sftp.auth_types.includes('password') ? 'password' : sftp.auth_types[0]);
        }
      }
    } catch (e) {}

    try {
      const ftps = caps.security.ftps || {};
      if (tls && Array.isArray(ftps.tls_verify_modes)) {
        tls.innerHTML = '';
        ftps.tls_verify_modes.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = String(m);
          opt.textContent = String(m);
          tls.appendChild(opt);
        });
        tls.value = String(ftps.default_mode || 'none');
      }
    } catch (e) {}
  }

  // -------------------------- connect modal: auth UI toggles --------------------------
  function _labelForInput(inputId) {
    try { return document.querySelector(`label[for="${inputId}"]`) || el(inputId + '-label'); } catch (e) { return el(inputId + '-label'); }
  }

  function _toggleRow(inputId, showIt) {
    const inp = el(inputId);
    const lbl = _labelForInput(inputId);
    if (lbl) lbl.style.display = showIt ? '' : 'none';
    if (inp) inp.style.display = showIt ? '' : 'none';
  }

  function updateConnectAuthUi() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const authType = String((el('fm-auth-type') && el('fm-auth-type').value) || 'password');

    const isSftp = proto === 'sftp';
    const useKey = isSftp && authType === 'key';

    _toggleRow('fm-auth-type', isSftp);

    _toggleRow('fm-pass', !useKey);

    _toggleRow('fm-key-file', useKey);
    _toggleRow('fm-key-path', useKey);
    _toggleRow('fm-passphrase', useKey);

    try {
      const hkLbl = _labelForInput('fm-hostkey-policy');
      const hk = el('fm-hostkey-policy');
      if (hkLbl) hkLbl.style.display = isSftp ? '' : 'none';
      if (hk) {
        const wrap = hk.parentElement;
        if (wrap) wrap.style.display = isSftp ? '' : 'none';
      }
    } catch (e) {}

    try {
      const fpLbl = el('fm-hostkey-fp-label');
      const fpRow = el('fm-hostkey-row');
      const fp = el('fm-hostkey-fp');
      const rm = el('fm-hostkey-remove-btn');
      if (fpLbl) fpLbl.style.display = isSftp ? '' : 'none';
      if (fpRow) fpRow.style.display = isSftp ? 'flex' : 'none';
      if (fp) fp.style.display = isSftp ? '' : 'none';
      if (rm) rm.style.display = isSftp ? '' : 'none';
    } catch (e) {}

    _toggleRow('fm-tls-verify', proto === 'ftps');
  }

  function _htmlEscape(s) {
    const str = String(s == null ? '' : s);
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _ruPlural(n, one, few, many) {
    try {
      const nn = Math.abs(parseInt(n, 10) || 0);
      const mod100 = nn % 100;
      const mod10 = nn % 10;
      if (mod100 > 10 && mod100 < 20) return many;
      if (mod10 === 1) return one;
      if (mod10 >= 2 && mod10 <= 4) return few;
      return many;
    } catch (e) {
      return many;
    }
  }

  function _toastHostkeyDeleteResult(deletedCount, prefix) {
    const p = String(prefix || 'Hostkey').trim();
    try {
      if (typeof deletedCount !== 'number') {
        toast(p + ': готово', 'success');
        return;
      }
      if (deletedCount <= 0) {
        toast(p + ': совпадений не найдено', 'info');
        return;
      }
      const w = _ruPlural(deletedCount, 'строка', 'строки', 'строк');
      toast(`${p}: удалено ${deletedCount} ${w}`, 'success');
    } catch (e) {}
  }

  async function updateHostKeyFingerprintPreview() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const fpEl = el('fm-hostkey-fp');
    if (!fpEl) return;
    if (proto !== 'sftp') { fpEl.textContent = ''; return; }

    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    if (!host) { fpEl.textContent = ''; return; }
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    const port = portRaw ? portRaw : '22';
    try {
      const { res, data } = await fetchJson(`/api/remotefs/known_hosts/fingerprint?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`, { method: 'GET' });
      if (res && res.ok && data && data.ok) {
        const m = Array.isArray(data.matches) ? data.matches : [];
        if (!m.length) {
          fpEl.textContent = 'Нет записи (ещё не добавлялся)';
        } else {
          const first = m[0] || {};
          const extra = (m.length > 1) ? ` (+${m.length - 1})` : '';
          fpEl.textContent = `${String(first.key_type || '')}  ${String(first.fingerprint || '')}${extra}`.trim();
        }
      } else {
        fpEl.textContent = '';
      }
    } catch (e) {
      fpEl.textContent = '';
    }
  }

  async function loadKnownHostsIntoModal() {
    const body = el('fm-knownhosts-body');
    const pathEl = el('fm-knownhosts-path');
    const errEl = el('fm-knownhosts-error');
    const hintEl = el('fm-knownhosts-hashed-hint');
    if (errEl) errEl.textContent = '';
    if (hintEl) { hintEl.textContent = ''; hintEl.style.display = 'none'; }
    if (body) body.innerHTML = '<div class="fm-empty">Загрузка…</div>';
    try {
      const { res, data } = await fetchJson('/api/remotefs/known_hosts', { method: 'GET' });
      if (!res || !res.ok || !data || !data.ok) {
        if (body) body.innerHTML = '';
        if (errEl) errEl.textContent = (data && (data.error || data.message)) ? String(data.error || data.message) : 'known_hosts_failed';
        return;
      }
      if (pathEl) pathEl.textContent = String(data.path || '');
      const entries = Array.isArray(data.entries) ? data.entries : [];
      if (!entries.length) {
        if (body) body.innerHTML = '<div class="fm-empty">known_hosts пуст</div>';
        if (hintEl) { hintEl.textContent = ''; hintEl.style.display = 'none'; }
        return;
      }

      try {
        const hasHashed = entries.some((e) => !!e && !!e.hashed);
        if (hintEl && hasHashed) {
          hintEl.textContent = 'Есть hashed записи (|1|…). Имя хоста скрыто. Удалить можно по индексу (кнопка «Запись») или через «Удалить по host», если знаете хост.';
          hintEl.style.display = '';
        }
      } catch (e) {}

      const rows = entries.map((e) => {
        const idx = String(e.idx);
        const rawHosts = String(e.hosts || '');
        const hostsEsc = _htmlEscape(rawHosts);
        const kt = _htmlEscape(e.key_type || '');
        const fp = _htmlEscape(e.fingerprint || '');
        const bad = e.bad ? ' style="opacity:.7;"' : '';
        const isHashed = !!e.hashed;

        let firstTok = '';
        try {
          firstTok = rawHosts.split(',').map((s) => String(s || '').trim()).filter(Boolean)[0] || '';
        } catch (e2) {}
        const canByHost = !!firstTok && !isHashed;

        const hostCell = isHashed
          ? `<span style="display:inline-block; padding:1px 6px; border:1px solid currentColor; border-radius:999px; font-size:12px; opacity:.75; margin-right:6px;" title="hashed entry: имя хоста скрыто">hashed</span><span style="font-family:monospace;">${hostsEsc}</span>`
          : hostsEsc;

        const byHostBtn = canByHost
          ? `<button type="button" class="btn-secondary" data-kh-action="delete_host" data-kh-host="${_htmlEscape(firstTok)}" title="Удалить hostkey для ${_htmlEscape(firstTok)}">Hostkey</button>`
          : `<button type="button" class="btn-secondary" disabled title="Для hashed записи используйте «Удалить по host» сверху">Hostkey</button>`;

        return `<tr${bad}>
          <td style="white-space:nowrap;">${idx}</td>
          <td style="max-width:360px; overflow:hidden; text-overflow:ellipsis;">${hostCell}</td>
          <td style="white-space:nowrap;">${kt}</td>
          <td style="font-family:monospace; max-width:240px; overflow:hidden; text-overflow:ellipsis;">${fp}</td>
          <td style="text-align:right; white-space:nowrap; display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap;">
            ${byHostBtn}
            <button type="button" class="btn-secondary" data-kh-action="delete" data-kh-idx="${idx}" title="Удалить конкретную строку">Запись</button>
          </td>
        </tr>`;
      }).join('');

      if (body) {
        body.innerHTML = `
          <table class="table" style="width:100%; border-collapse:collapse;">
            <thead>
              <tr>
                <th style="text-align:left;">#</th>
                <th style="text-align:left;">Host</th>
                <th style="text-align:left;">Type</th>
                <th style="text-align:left;">Fingerprint</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;
      }
    } catch (e) {
      if (body) body.innerHTML = '';
      if (errEl) errEl.textContent = 'known_hosts_failed';
    }
  }

  function openKnownHostsModal() {
    const errEl = el('fm-knownhosts-error');
    if (errEl) errEl.textContent = '';
    modalOpen(el('fm-knownhosts-modal'));
    void loadKnownHostsIntoModal();
  }

  async function removeHostKeyForCurrentHost() {
    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    if (proto !== 'sftp') return;
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    if (!host) return;
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    let port = 22;
    try { if (portRaw) port = parseInt(portRaw, 10) || 22; } catch (e) {}

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({
        title: 'known_hosts',
        message: `Удалить hostkey для ${host}${(port && port !== 22) ? (':' + port) : ''}?`,
        okText: 'Удалить',
        cancelText: 'Отмена',
        danger: true,
      })
      : Promise.resolve(window.confirm('Delete hostkey?')));
    if (!ok) return;

    try {
      const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: host, port: port }),
      });
      const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
      _toastHostkeyDeleteResult(n, 'Hostkey');
    } catch (e) {
      try { toast('Hostkey: ошибка удаления', 'error'); } catch (e2) {}
    }

    try { await updateHostKeyFingerprintPreview(); } catch (e) {}
    try {
      const khModal = el('fm-knownhosts-modal');
      if (khModal && !khModal.classList.contains('hidden')) {
        await loadKnownHostsIntoModal();
      }
    } catch (e) {}
  }

  async function connectRemoteToSide(side) {
    const S = _S();
    if (!S) return;
    S.connectForSide = side;

    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    applyCapsToConnectModal();

    try {
      const cb = el('fm-remember-profile');
      if (cb) cb.checked = _loadRememberProfileFlag();
    } catch (e) {}

    try {
      const lastId = _loadLastProfileId();
      _renderRemoteProfilesSelect(lastId);
      const h0 = String((el('fm-host') && el('fm-host').value) || '').trim();
      const u0 = String((el('fm-user') && el('fm-user').value) || '').trim();
      if ((!h0 || !u0) && lastId) {
        const pr = _findRemoteProfileById(lastId);
        if (pr) _applyProfileToConnectInputs(pr);
      }
    } catch (e) {}

    try { updateConnectAuthUi(); } catch (e) {}
    try { updateHostKeyFingerprintPreview(); } catch (e) {}
    modalOpen(el('fm-connect-modal'));

    setTimeout(() => {
      try { const h = el('fm-host'); h && h.focus && h.focus(); } catch (e) {}
    }, 0);
  }

  async function doConnect() {
    const S = _S();
    if (!S) return;

    const side = S.connectForSide;
    const p = S.panels && S.panels[side] ? S.panels[side] : null;
    if (!p) return;

    const proto = String((el('fm-proto') && el('fm-proto').value) || 'sftp');
    const host = String((el('fm-host') && el('fm-host').value) || '').trim();
    const portRaw = String((el('fm-port') && el('fm-port').value) || '').trim();
    const user = String((el('fm-user') && el('fm-user').value) || '').trim();
    const pass = String((el('fm-pass') && el('fm-pass').value) || '');
    const authTypeRaw = String((el('fm-auth-type') && el('fm-auth-type').value) || 'password');
    const authType = (proto === 'sftp') ? authTypeRaw : 'password';

    const hkPolicy = String((el('fm-hostkey-policy') && el('fm-hostkey-policy').value) || 'accept_new');
    const tlsVerify = String((el('fm-tls-verify') && el('fm-tls-verify').value) || 'none');

    const errEl = el('fm-connect-error');
    const warnEl = el('fm-connect-warn');
    if (errEl) errEl.textContent = '';
    if (warnEl) { warnEl.textContent = ''; hide(warnEl); }

    if (!host) {
      if (errEl) errEl.textContent = 'Host обязателен';
      return;
    }
    if (!user) {
      if (errEl) errEl.textContent = 'User обязателен';
      return;
    }

    let auth = null;
    if (authType === 'password') {
      if (!pass) {
        if (errEl) errEl.textContent = 'Password обязателен';
        return;
      }
      auth = { type: 'password', password: pass };
    } else {
      const keyPath = String((el('fm-key-path') && el('fm-key-path').value) || '').trim();
      const passphrase = String((el('fm-passphrase') && el('fm-passphrase').value) || '');
      const f = el('fm-key-file') && el('fm-key-file').files ? el('fm-key-file').files[0] : null;

      let keyData = '';
      if (f) {
        try {
          if (typeof f.text === 'function') {
            keyData = await f.text();
          } else {
            keyData = await new Promise((resolve, reject) => {
              try {
                const r = new FileReader();
                r.onload = () => resolve(String(r.result || ''));
                r.onerror = () => reject(new Error('read_failed'));
                r.readAsText(f);
              } catch (e) { reject(e); }
            });
          }
        } catch (e) {
          if (errEl) errEl.textContent = 'Не удалось прочитать ключ';
          return;
        }
      }

      if (!keyData && !keyPath) {
        if (errEl) errEl.textContent = 'Укажите ключ (upload) или путь к ключу';
        return;
      }
      auth = { type: 'key', key_data: keyData || undefined, key_path: keyData ? undefined : keyPath, passphrase: passphrase || undefined };
    }

    let port = null;
    try { if (portRaw) port = parseInt(portRaw, 10); } catch (e) { port = null; }

    const options = {};
    if (proto === 'sftp') {
      options.hostkey_policy = hkPolicy;
    }
    if (proto === 'ftps') {
      options.tls_verify_mode = tlsVerify;
      options.tls_verify = tlsVerify;
    }

    const payload = {
      protocol: proto,
      host,
      port: port || undefined,
      username: user,
      auth,
      options,
    };

    const { res, data } = await fetchJson('/api/remotefs/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res || !res.ok || !data) {
      const ae = _errFromResponse(res, data, { action: 'connect' });
      if (errEl) errEl.textContent = String(ae.message || 'connect_failed');
      if (ae && ae.hint && warnEl) { warnEl.textContent = String(ae.hint); show(warnEl); }
      presentError(ae, { place: 'toast', action: 'connect' });
      return;
    }

    if (!data.ok) {
      const ae = _errFromResponse(res, data, { action: 'connect' });
      if (errEl) errEl.textContent = String(ae.message || 'connect_failed');
      if (ae && ae.hint && warnEl) { warnEl.textContent = String(ae.hint); show(warnEl); }
      // Do not open extra modals, just toast (connect modal already shows inline error).
      presentError(ae, { place: 'toast', action: 'connect' });
      return;
    }

    if (Array.isArray(data.warnings) && data.warnings.length && warnEl) {
      warnEl.textContent = data.warnings.map(String).join('\n');
      show(warnEl);
    }

    p.target = 'remote';
    p.sid = String(data.session_id || '');
    p.rproto = String(proto || '');
    p.cwd = (proto === 'ftp' || proto === 'ftps') ? '/' : '.';
    p.items = [];
    p.selected.clear();
    p.focusName = '';

    try { _rememberConnectProfileIfNeeded(); } catch (e) {}

    modalClose(el('fm-connect-modal'));

    try {
      const ptxt = String(proto || '').trim().toLowerCase();
      const pport = String(port || '').trim();
      const head = ptxt ? (ptxt.toUpperCase() + ' ') : '';
      const tail = pport ? (':' + pport) : '';
      toast('Подключено: ' + head + user + '@' + host + tail, 'success');
    } catch (e) {
      toast('Подключено: ' + user + '@' + host, 'success');
    }

    renderPanel(side);
    await listPanel(side, { fromInput: false });
  }

  async function pickLocalCwdAfterRemoteDisconnect() {
    const fallback = '/opt';
    try {
      const url = `/api/fs/list?target=local&path=${encodeURIComponent('/tmp/mnt')}`;
      const { res, data } = await fetchJson(url, { method: 'GET' });
      if (!res || !res.ok || !data || !data.ok) return fallback;

      const items = Array.isArray(data.items) ? data.items : [];
      const disks = items.filter((it) => {
        const t = String(it && it.type);
        return (t === 'dir') || (t === 'link' && !!(it && it.link_dir));
      });
      if (disks.length > 1) return '/tmp/mnt';
    } catch (e) {}
    return fallback;
  }

  async function disconnectSide(side) {
    const S = _S();
    if (!S) return;
    const p = S.panels && S.panels[side] ? S.panels[side] : null;
    if (!p || !p.sid) return;

    const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
      ? XKeen.ui.confirm({ title: 'Disconnect', message: 'Отключиться от текущего удалённого сервера?', okText: 'Disconnect', cancelText: 'Отмена', danger: false })
      : Promise.resolve(window.confirm('Disconnect?')));

    if (!ok) return;

    const sid = p.sid;
    try {
      const { res, data } = await fetchJson(`/api/remotefs/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
      if (!res || !res.ok || (data && data.ok === false)) {
        presentError(_errFromResponse(res, data, { action: 'disconnect' }), { place: 'toast', action: 'disconnect' });
      }
    } catch (e) {
      presentError(e, { place: 'toast', action: 'disconnect' });
    }

    p.sid = '';
    p.rproto = '';
    p.items = [];
    p.selected.clear();
    p.focusName = '';

    p.target = 'local';
    p.cwd = await pickLocalCwdAfterRemoteDisconnect();

    renderPanel(side);
    toast('Отключено', 'info');
    await listPanel(side, { fromInput: false });
  }

  // -------------------------- wiring --------------------------
  let _wired = false;

  function wireModals() {
    if (_wired) return;
    _wired = true;

    // connect modal buttons
    const connectOk = el('fm-connect-ok-btn');
    const connectCancel = el('fm-connect-cancel-btn');
    const connectClose = el('fm-connect-close-btn');
    const profileSel = el('fm-conn-profile');
    const profileDelBtn = el('fm-conn-profile-del-btn');
    const protoSel = el('fm-proto');
    const authTypeSel = el('fm-auth-type');
    const hostInp = el('fm-host');
    const portInp = el('fm-port');
    const khBtn = el('fm-knownhosts-btn');
    const hkRemoveBtn = el('fm-hostkey-remove-btn');
    const rememberCb = el('fm-remember-profile');

    const closeConnect = () => {
      modalClose(el('fm-connect-modal'));

      // UX fix: roll panel back to local when user cancels connect.
      try {
        const S = _S();
        const side = String(S && S.connectForSide ? S.connectForSide : '');
        const p = (S && S.panels) ? S.panels[side] : null;
        if (p && String(p.target || '') === 'remote' && !String(p.sid || '')) {
          p.target = 'local';
          p.sid = '';
          if (!p.cwd) p.cwd = (side === 'right') ? '/tmp/mnt' : '/opt/var';
          try { renderPanel(side); } catch (e) {}
          setTimeout(() => {
            try { void listPanel(side, { fromInput: false }); } catch (e) {}
          }, 0);
        }
      } catch (e) {}
    };

    if (connectOk) connectOk.addEventListener('click', (e) => { e.preventDefault(); void doConnect(); });
    if (connectCancel) connectCancel.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });
    if (connectClose) connectClose.addEventListener('click', (e) => { e.preventDefault(); closeConnect(); });

    const modal = el('fm-connect-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeConnect();
      });
    }

    const scheduleFp = (() => {
      let t = null;
      return () => {
        try { if (t) clearTimeout(t); } catch (e) {}
        t = setTimeout(() => { try { void updateHostKeyFingerprintPreview(); } catch (e2) {} }, 250);
      };
    })();

    if (protoSel) protoSel.addEventListener('change', () => {
      try { updateConnectAuthUi(); } catch (e) {}
      try {
        const p = String(protoSel.value || '').trim().toLowerCase();
        const cur = portInp ? String(portInp.value || '').trim() : '';
        const want = (p === 'sftp') ? '22' : '21';
        if (portInp) {
          if (!cur) portInp.value = want;
          else if ((cur === '22' || cur === '21') && cur !== want) portInp.value = want;
        }
      } catch (e) {}
      scheduleFp();
    });
    if (authTypeSel) authTypeSel.addEventListener('change', () => { try { updateConnectAuthUi(); } catch (e) {} });
    if (hostInp) hostInp.addEventListener('input', () => scheduleFp());
    if (portInp) portInp.addEventListener('input', () => scheduleFp());
    if (khBtn) khBtn.addEventListener('click', (e) => { e.preventDefault(); openKnownHostsModal(); });
    if (hkRemoveBtn) hkRemoveBtn.addEventListener('click', (e) => { e.preventDefault(); void removeHostKeyForCurrentHost(); });
    if (rememberCb) rememberCb.addEventListener('change', () => {
      try { _saveRememberProfileFlag(!!rememberCb.checked); } catch (e) {}
    });

    // Connection profiles
    if (profileSel) profileSel.addEventListener('change', () => {
      const id = String(profileSel.value || '').trim();
      try { if (profileDelBtn) profileDelBtn.disabled = !id; } catch (e) {}
      if (!id) return;
      try {
        const pr = _findRemoteProfileById(id);
        if (pr) {
          _applyProfileToConnectInputs(pr);
          storageSetJSON(_LS_REMOTE_PROFILES_LAST_KEY, id);
        }
      } catch (e) {}
    });
    if (profileDelBtn) profileDelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = el('fm-conn-profile');
      const id = sel ? String(sel.value || '').trim() : '';
      if (!id) return;
      try {
        const list = _loadRemoteProfiles();
        const next = list.filter(p => String(p && p.id) !== id);
        _saveRemoteProfiles(next);
        const lastId = _loadLastProfileId();
        if (String(lastId || '') === id) storageSetJSON(_LS_REMOTE_PROFILES_LAST_KEY, '');
        _renderRemoteProfilesSelect('');
      } catch (e2) {
        try { _renderRemoteProfilesSelect(''); } catch (e3) {}
      }
    });

    // known_hosts modal buttons
    const khModal = el('fm-knownhosts-modal');
    const khClose = el('fm-knownhosts-close-btn');
    const khOk = el('fm-knownhosts-ok-btn');
    const khRefresh = el('fm-knownhosts-refresh-btn');
    const khClear = el('fm-knownhosts-clear-btn');
    const khRemoveHost = el('fm-knownhosts-remove-host');
    const khRemoveHostBtn = el('fm-knownhosts-remove-host-btn');
    const khBody = el('fm-knownhosts-body');
    const closeKh = () => modalClose(el('fm-knownhosts-modal'));

    if (khClose) khClose.addEventListener('click', (e) => { e.preventDefault(); closeKh(); });
    if (khOk) khOk.addEventListener('click', (e) => { e.preventDefault(); closeKh(); });
    if (khModal) khModal.addEventListener('click', (e) => { if (e.target === khModal) closeKh(); });
    if (khRefresh) khRefresh.addEventListener('click', (e) => { e.preventDefault(); void loadKnownHostsIntoModal(); });
    if (khClear) khClear.addEventListener('click', async (e) => {
      e.preventDefault();
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({ title: 'known_hosts', message: 'Очистить known_hosts? Это удалит все запомненные host key.', okText: 'Очистить', cancelText: 'Отмена', danger: true })
        : Promise.resolve(window.confirm('Clear known_hosts?')));
      if (!ok) return;
      try {
        await fetchJson('/api/remotefs/known_hosts/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await loadKnownHostsIntoModal();
        scheduleFp();
      } catch (e2) {}
    });

    async function deleteKnownHostByInput() {
      const raw = String((khRemoveHost && khRemoveHost.value) || '').trim();
      if (!raw) return;

      let payload = null;
      try {
        const m = raw.match(/^\[([^\]]+)\]:(\d{1,5})$/);
        if (m) {
          payload = { host: String(m[1] || '').trim(), port: parseInt(m[2], 10) };
        } else {
          const m2 = raw.match(/^([^:]+):(\d{1,5})$/);
          if (m2) payload = { host: String(m2[1] || '').trim(), port: parseInt(m2[2], 10) };
          else payload = { host: raw };
        }
      } catch (e) {
        payload = { host: raw };
      }
      if (!payload || !payload.host) return;

      const label = payload.port ? `${payload.host}:${payload.port}` : String(payload.host);
      const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить hostkey для ${label}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
        : Promise.resolve(window.confirm('Delete hostkey?')));
      if (!ok) return;

      try {
        const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
        _toastHostkeyDeleteResult(n, 'Hostkey');
        if (khRemoveHost) khRemoveHost.value = '';
        await loadKnownHostsIntoModal();
        scheduleFp();
      } catch (e) {}
    }

    if (khRemoveHostBtn) khRemoveHostBtn.addEventListener('click', (e) => { e.preventDefault(); void deleteKnownHostByInput(); });
    if (khRemoveHost) khRemoveHost.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); void deleteKnownHostByInput(); }
    });

    if (khBody) khBody.addEventListener('click', async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('button[data-kh-action]') : null;
      if (!btn) return;
      const act = String(btn.getAttribute('data-kh-action') || '');
      const idx = String(btn.getAttribute('data-kh-idx') || '');

      if (act === 'delete' && idx !== '') {
        e.preventDefault();
        const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
          ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить запись #${idx}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
          : Promise.resolve(window.confirm('Delete entry?')));
        if (!ok) return;
        try {
          await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idx: parseInt(idx, 10) }) });
          await loadKnownHostsIntoModal();
          scheduleFp();
        } catch (e2) {}
        return;
      }

      if (act === 'delete_host') {
        const hostTok = String(btn.getAttribute('data-kh-host') || '').trim();
        if (!hostTok) return;
        e.preventDefault();
        const ok = await (XKeen.ui && typeof XKeen.ui.confirm === 'function'
          ? XKeen.ui.confirm({ title: 'known_hosts', message: `Удалить hostkey для ${hostTok}?`, okText: 'Удалить', cancelText: 'Отмена', danger: true })
          : Promise.resolve(window.confirm('Delete hostkey?')));
        if (!ok) return;
        try {
          const { res, data } = await fetchJson('/api/remotefs/known_hosts/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: hostTok }) });
          const n = (data && typeof data.deleted_count === 'number') ? data.deleted_count : null;
          _toastHostkeyDeleteResult(n, 'Hostkey');
          await loadKnownHostsIntoModal();
          scheduleFp();
        } catch (e2) {}
      }
    });
  }

  // exports
  R.wireModals = wireModals;
  R.loadRemoteCaps = loadRemoteCaps;
  R.applyCapsToConnectModal = applyCapsToConnectModal;
  R.connectRemoteToSide = connectRemoteToSide;
  R.openConnectModal = connectRemoteToSide;
  R.disconnectSide = disconnectSide;
  R.disconnectSideFromPanel = disconnectSide;
  R.openKnownHostsModal = openKnownHostsModal;
  R.updateConnectAuthUi = updateConnectAuthUi;
  R.updateHostKeyFingerprintPreview = updateHostKeyFingerprintPreview;
})();
