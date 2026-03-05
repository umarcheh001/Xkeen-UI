(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.coresStatus = XKeen.features.coresStatus || {};

  const CS = XKeen.features.coresStatus;

  const API_VERSIONS = '/api/cores/versions';
  const API_UPDATES = '/api/cores/updates';

  function safe(fn) {
    try { return fn(); } catch (e) { return null; }
  }

  function $(id) { return document.getElementById(id); }

  function setText(el, text) {
    if (!el) return;
    el.textContent = String(text == null ? '' : text);
  }

  function show(el, yes) {
    if (!el) return;
    el.style.display = yes ? '' : 'none';
  }

  function normVer(v) {
    let s = String(v || '').trim();
    if (s.toLowerCase().startsWith('v')) s = s.slice(1).trim();
    return s;
  }

  function fmtTime(ts) {
    try {
      const d = new Date(ts * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    } catch (e) {
      return '';
    }
  }

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function setPillState(pillEl, state) {
    if (!pillEl) return;
    pillEl.classList.toggle('has-update', !!state.hasUpdate);
    pillEl.classList.toggle('has-error', !!state.hasError);
  }

  function findCommandButton(flag) {
    // In panel.html each command is a <button class="command-item" data-flag="-ux" ...>
    try {
      return document.querySelector(`.command-item[data-flag="${CSS.escape(String(flag || ''))}"]`);
    } catch (e) {
      return document.querySelector(`.command-item[data-flag="${String(flag || '')}"]`);
    }
  }

  function runXkeenCommand(flag) {
    // Prefer delegating to the existing command button handler (PTY when available).
    const btn = findCommandButton(flag);
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }

    // Fallback: open terminal with prefilled command.
    const label = `xkeen ${flag}`;
    try {
      if (window.XKeen && XKeen.terminal && XKeen.terminal.api && typeof XKeen.terminal.api.open === 'function') {
        XKeen.terminal.api.open({ cmd: label, mode: 'xkeen' });
        return true;
      }
    } catch (e2) {}
    try {
      if (window.XKeen && XKeen.terminal && typeof XKeen.terminal.open === 'function') {
        XKeen.terminal.open(null, { cmd: label, mode: 'xkeen' });
        return true;
      }
    } catch (e3) {}
    try {
      if (typeof window.openTerminal === 'function') {
        window.openTerminal(label, 'xkeen');
        return true;
      }
    } catch (e4) {}
    return false;
  }

  function toastMsg(msg, kind) {
    try {
      if (typeof window.toast === 'function') window.toast(String(msg || ''), kind || 'info');
    } catch (e) {}
  }

  function setLoading(isLoading) {
    const checkBtn = $('cores-check-btn');
    if (!checkBtn) return;
    checkBtn.disabled = !!isLoading;
    checkBtn.classList.toggle('loading', !!isLoading);
  }

  function applyVersions(cores) {
    const xray = (cores && cores.xray) ? cores.xray : {};
    const mihomo = (cores && cores.mihomo) ? cores.mihomo : {};

    setText($('core-xray-installed'), xray.installed ? (xray.version ? `v${normVer(xray.version)}` : 'v?') : '—');
    setText($('core-mihomo-installed'), mihomo.installed ? (mihomo.version ? `v${normVer(mihomo.version)}` : 'v?') : '—');

    const pillX = $('core-pill-xray');
    const pillM = $('core-pill-mihomo');
    if (pillX) pillX.classList.toggle('not-installed', !xray.installed);
    if (pillM) pillM.classList.toggle('not-installed', !mihomo.installed);
  }

  function applyUpdates(payload) {
    const latest = (payload && payload.latest) ? payload.latest : {};
    const upd = (payload && payload.update_available) ? payload.update_available : {};
    const checkedTs = payload && payload.checked_ts ? payload.checked_ts : null;
    const stale = !!(payload && payload.stale);

    const checkedEl = $('cores-checked-at');
    if (checkedEl) {
      if (checkedTs) {
        checkedEl.textContent = `проверено: ${fmtTime(checkedTs)}${stale ? ' (кэш)' : ''}`;
      } else {
        checkedEl.textContent = stale ? 'кэш' : '';
      }
    }

    // Xray
    const x = latest.xray || {};
    const xLatestEl = $('core-xray-latest');
    const xUpdateBtn = $('core-xray-update-btn');
    const pillX = $('core-pill-xray');

    if (xLatestEl) {
      const has = !!x.tag;
      show(xLatestEl, has);
      if (has) {
        const verSpan = xLatestEl.querySelector('.core-latest-ver');
        if (verSpan) verSpan.textContent = `v${normVer(x.tag)}`;
        try { xLatestEl.href = x.url || '#'; } catch (e) {}
      }
    }
    const xHasUpd = !!upd.xray;
    show(xUpdateBtn, xHasUpd);
    setPillState(pillX, { hasUpdate: xHasUpd, hasError: x.ok === false });

    // Mihomo
    const m = latest.mihomo || {};
    const mLatestEl = $('core-mihomo-latest');
    const mUpdateBtn = $('core-mihomo-update-btn');
    const pillM = $('core-pill-mihomo');

    if (mLatestEl) {
      const has = !!m.tag;
      show(mLatestEl, has);
      if (has) {
        const verSpan = mLatestEl.querySelector('.core-latest-ver');
        if (verSpan) verSpan.textContent = `v${normVer(m.tag)}`;
        try { mLatestEl.href = m.url || '#'; } catch (e) {}
      }
    }
    const mHasUpd = !!upd.mihomo;
    show(mUpdateBtn, mHasUpd);
    setPillState(pillM, { hasUpdate: mHasUpd, hasError: m.ok === false });
  }

  async function refreshVersions() {
    const { res, data } = await getJSON(API_VERSIONS);
    if (!res.ok || !data || data.ok === false) {
      throw new Error('versions_failed');
    }
    applyVersions(data.cores || {});
    return data;
  }

  async function refreshUpdates(force) {
    const url = API_UPDATES + (force ? '?force=1' : '');
    const { res, data } = await getJSON(url);
    if (!res.ok || !data) throw new Error('updates_failed');
    // Even if ok=false (partial failure), we still show what we have.
    if (data.installed) applyVersions(data.installed);
    applyUpdates(data);
    return data;
  }

  function wire() {
    const checkBtn = $('cores-check-btn');
    if (checkBtn && !checkBtn.dataset.xkWired) {
      checkBtn.addEventListener('click', async () => {
        setLoading(true);
        try {
          await refreshUpdates(true);
          toastMsg('Проверка обновлений выполнена.', 'info');
        } catch (e) {
          toastMsg('Не удалось проверить обновления.', 'error');
        } finally {
          setLoading(false);
        }
      });
      checkBtn.dataset.xkWired = '1';
    }

    const xUpd = $('core-xray-update-btn');
    if (xUpd && !xUpd.dataset.xkWired) {
      xUpd.addEventListener('click', () => {
        const ok = runXkeenCommand('-ux');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      xUpd.dataset.xkWired = '1';
    }

    const mUpd = $('core-mihomo-update-btn');
    if (mUpd && !mUpd.dataset.xkWired) {
      mUpd.addEventListener('click', () => {
        const ok = runXkeenCommand('-um');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      mUpd.dataset.xkWired = '1';
    }
  }

  let _started = false;
  CS.init = function init() {
    const row = $('commands-status-row');
    if (!row) return;
    if (_started) return;
    _started = true;

    wire();

    // Load installed versions quickly, then show cached update state (if any).
    (async () => {
      try {
        await refreshVersions();
      } catch (e) {
        // keep placeholders
      }

      setLoading(true);
      try {
        await refreshUpdates(false);
      } catch (e) {
        // silent: user may be offline
      } finally {
        setLoading(false);
      }
    })();
  };
})();
