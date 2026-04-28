import {
  ensureXkeenTerminalInViewport,
  focusXkeenTerminal,
  getXkeenLazyRuntimeApi,
  getXkeenTerminalApi,
  isXkeenTerminalPtyConnected,
  openXkeenTerminal,
  sendXkeenTerminal,
  toastXkeen,
} from './xkeen_runtime.js';

let coresStatusModuleApi = null;

(() => {
  'use strict';

  const CS = {};
  coresStatusModuleApi = CS;

  const API_VERSIONS = '/api/cores/versions';
  const API_UPDATES = '/api/cores/updates';
  const NOT_INSTALLED_LABEL = '—';
  let lastInstalled = {};

  function $(id) {
    return document.getElementById(id);
  }

  function setText(el, text) {
    if (!el) return;
    el.textContent = String(text == null ? '' : text);
  }

  function show(el, yes) {
    if (!el) return;
    el.style.display = yes ? '' : 'none';
  }

  function setBusy(el, isBusy) {
    if (!el) return;
    el.disabled = !!isBusy;
    el.classList.toggle('loading', !!isBusy);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  async function waitFor(fn, timeoutMs = 3000, stepMs = 100) {
    const startedAt = Date.now();
    const timeout = Math.max(100, Number(timeoutMs) || 0);
    const step = Math.max(25, Number(stepMs) || 0);
    while ((Date.now() - startedAt) <= timeout) {
      try {
        if (fn()) return true;
      } catch (e) {}
      await sleep(step);
    }
    return false;
  }

  function clampTerminalViewportSoon() {
    const run = () => {
      try { ensureXkeenTerminalInViewport(); } catch (e) {}
    };
    try { setTimeout(run, 0); } catch (e0) {}
    try { setTimeout(run, 120); } catch (e1) {}
    try { setTimeout(run, 360); } catch (e2) {}
  }

  function normVer(v) {
    let s = String(v || '').trim();
    if (s.toLowerCase().startsWith('v')) s = s.slice(1).trim();
    return s;
  }

  function isSemverLikeTag(v) {
    return /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?$/.test(normVer(v));
  }

  function formatReleaseLabel(tag, { preferV = false } = {}) {
    const raw = String(tag || '').trim();
    if (!raw) return '';
    if (preferV || isSemverLikeTag(raw) || raw.toLowerCase().startsWith('v')) {
      return `v${normVer(raw)}`;
    }
    return raw;
  }

  function formatReleaseTitle(baseTitle, release) {
    const parts = [String(baseTitle || '').trim()].filter(Boolean);
    const publishedAt = String((release && release.published_at) || '').trim();
    if (publishedAt) {
      try {
        parts.push(new Date(publishedAt).toLocaleDateString());
      } catch (e) {}
    }
    return parts.join(' | ');
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

  function shSingleQuote(value) {
    const raw = String(value == null ? '' : value).replace(/[\r\n]+/g, '');
    return `'${raw.replace(/'/g, `'\\''`)}'`;
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

  function applyReleaseLink(linkEl, release, {
    versionSelector,
    preferV = false,
    title = '',
  } = {}) {
    if (!linkEl) return;
    const has = !!(release && release.tag);
    show(linkEl, has);
    if (!has) return;
    const verSpan = versionSelector ? linkEl.querySelector(versionSelector) : null;
    if (verSpan) verSpan.textContent = formatReleaseLabel(release.tag, { preferV });
    try { linkEl.href = release.url || '#'; } catch (e) {}
    const nextTitle = formatReleaseTitle(title, release);
    if (nextTitle) linkEl.title = nextTitle;
  }

  function findCommandButton(flag) {
    try {
      return document.querySelector(`.command-item[data-flag="${CSS.escape(String(flag || ''))}"]`);
    } catch (e) {
      return document.querySelector(`.command-item[data-flag="${String(flag || '')}"]`);
    }
  }

  async function runXkeenCommand(flag) {
    const btn = findCommandButton(flag);
    if (btn) {
      try { btn.click(); return true; } catch (e) {}
    }

    const label = `xkeen ${flag}`;
    try {
      await Promise.resolve(openXkeenTerminal({ cmd: label, mode: 'xkeen' }));
      return true;
    } catch (e) {
      return false;
    }
  }

  function toastMsg(msg, kind) {
    toastXkeen(String(msg || ''), kind || 'info');
  }

  function wasDelivered(sendRes) {
    return !!(
      sendRes === true ||
      (sendRes && sendRes.ok === true) ||
      (sendRes && sendRes.handled === true) ||
      (sendRes && sendRes.result && sendRes.result.ok === true)
    );
  }

  function buildPrereleaseUpdateCommand(flag, tag) {
    const normalizedFlag = String(flag || '').trim();
    const normalizedTag = String(tag || '').trim();
    if (!normalizedFlag || !normalizedTag) return '';
    return `printf '%s\\n%s\\n' '9' ${shSingleQuote(normalizedTag)} | xkeen ${normalizedFlag}`;
  }

  async function runTerminalCommand(command, source = 'cores_status') {
    const cmd = String(command || '').trim();
    if (!cmd) return false;

    try {
      const lazyRuntime = getXkeenLazyRuntimeApi();
      const ensureReady = lazyRuntime && typeof lazyRuntime.ensureTerminalReady === 'function'
        ? lazyRuntime.ensureTerminalReady
        : null;
      if (ensureReady) await Promise.resolve(ensureReady());
    } catch (e0) {}

    try {
      await Promise.resolve(openXkeenTerminal({ mode: 'pty', cmd: '' }));
    } catch (e1) {
      return false;
    }

    clampTerminalViewportSoon();

    const apiReady = await waitFor(() => {
      const api = getXkeenTerminalApi();
      return !!(api && typeof api.send === 'function');
    }, 4000, 100);
    if (!apiReady) return false;

    const api = getXkeenTerminalApi();
    if (!api || typeof api.send !== 'function') return false;

    let mode = 'shell';
    try {
      mode = typeof api.getMode === 'function' ? String(api.getMode() || 'shell') : 'shell';
    } catch (e2) {}

    if (mode === 'pty') {
      const connected = await waitFor(() => isXkeenTerminalPtyConnected(), 12000, 150);
      if (!connected) {
        toastMsg('PTY не подключён, не удалось запустить команду.', 'error');
        return false;
      }
    } else {
      await sleep(120);
    }

    let sendRes = null;
    try {
      sendRes = await Promise.resolve(api.send(cmd, { source }));
    } catch (e3) {
      sendRes = null;
    }

    if (!wasDelivered(sendRes)) {
      try {
        if (mode === 'pty') {
          sendRes = await Promise.resolve(sendXkeenTerminal(`${cmd}\r`, {
            raw: true,
            prefer: 'pty',
            allowWhenDisconnected: false,
            source,
          }));
        } else {
          sendRes = await Promise.resolve(sendXkeenTerminal(cmd, { source }));
        }
      } catch (e4) {
        sendRes = null;
      }
    }

    if (!wasDelivered(sendRes)) return false;

    try { focusXkeenTerminal(); } catch (e5) {}
    clampTerminalViewportSoon();
    return true;
  }

  async function runPrereleaseUpdate(btn) {
    if (!btn) return;
    const flag = String(btn.dataset.prereleaseFlag || '').trim();
    const tag = String(btn.dataset.prereleaseTag || '').trim();
    const coreLabel = String(btn.dataset.prereleaseCore || '').trim() || 'ядра';
    const command = buildPrereleaseUpdateCommand(flag, tag);
    if (!command) {
      toastMsg(`Не удалось определить pre-release для ${coreLabel}.`, 'error');
      return;
    }

    setBusy(btn, true);
    try {
      const ok = await runTerminalCommand(command, `cores_status_prerelease_${coreLabel.toLowerCase()}`);
      if (!ok) {
        toastMsg(`Не удалось запустить обновление ${coreLabel} до pre-release.`, 'error');
        return;
      }
      toastMsg(`${coreLabel}: команда обновления до pre-release ${tag} отправлена в терминал.`, 'info');
    } finally {
      setBusy(btn, false);
    }
  }

  function configurePrereleaseAction(btn, release, installedVersion, { flag, coreLabel } = {}) {
    if (!btn) return;
    const tag = String((release && release.tag) || '').trim();
    const shouldShow = !!tag && normVer(installedVersion) !== normVer(tag);
    show(btn, shouldShow);
    if (!shouldShow) {
      btn.removeAttribute('data-prerelease-tag');
      btn.removeAttribute('data-prerelease-flag');
      btn.removeAttribute('data-prerelease-core');
      btn.title = '';
      return;
    }
    btn.dataset.prereleaseTag = tag;
    btn.dataset.prereleaseFlag = String(flag || '').trim();
    btn.dataset.prereleaseCore = String(coreLabel || '').trim();
    btn.title = `Запустить обновление ${coreLabel} до pre-release ${tag} через терминал.`;
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
    lastInstalled = { xray, mihomo };

    setText($('core-xray-installed'), xray.installed ? (xray.version ? `v${normVer(xray.version)}` : 'v?') : NOT_INSTALLED_LABEL);
    setText($('core-mihomo-installed'), mihomo.installed ? (mihomo.version ? `v${normVer(mihomo.version)}` : 'v?') : NOT_INSTALLED_LABEL);

    const pillX = $('core-pill-xray');
    const pillM = $('core-pill-mihomo');
    if (pillX) pillX.classList.toggle('not-installed', !xray.installed);
    if (pillM) pillM.classList.toggle('not-installed', !mihomo.installed);
  }

  function applyUpdates(payload) {
    const latest = (payload && payload.latest) ? payload.latest : {};
    const upd = (payload && payload.update_available) ? payload.update_available : {};
    const installed = (payload && payload.installed) ? payload.installed : lastInstalled;
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

    const x = latest.xray || {};
    const xStable = x.stable || ((x.tag || x.url) ? x : null);
    const xPre = x.prerelease || null;
    const xLatestEl = $('core-xray-latest');
    const xPreEl = $('core-xray-prerelease');
    const xUpdateBtn = $('core-xray-update-btn');
    const xPreUpdateBtn = $('core-xray-prerelease-update-btn');
    const pillX = $('core-pill-xray');

    applyReleaseLink(xLatestEl, xStable, {
      versionSelector: '.core-latest-ver',
      preferV: true,
      title: 'Открыть стабильный релиз на GitHub',
    });
    applyReleaseLink(xPreEl, xPre, {
      versionSelector: '.core-prerelease-ver',
      title: 'Открыть pre-release на GitHub',
    });
    configurePrereleaseAction(xPreUpdateBtn, xPre, installed && installed.xray ? installed.xray.version : '', {
      flag: '-ux',
      coreLabel: 'Xray',
    });
    show(xUpdateBtn, !!upd.xray);
    setPillState(pillX, { hasUpdate: !!upd.xray, hasError: x.ok === false });

    const m = latest.mihomo || {};
    const mStable = m.stable || ((m.tag || m.url) ? m : null);
    const mPre = m.prerelease || null;
    const mLatestEl = $('core-mihomo-latest');
    const mPreEl = $('core-mihomo-prerelease');
    const mUpdateBtn = $('core-mihomo-update-btn');
    const mPreUpdateBtn = $('core-mihomo-prerelease-update-btn');
    const pillM = $('core-pill-mihomo');

    applyReleaseLink(mLatestEl, mStable, {
      versionSelector: '.core-latest-ver',
      preferV: true,
      title: 'Открыть стабильный релиз на GitHub',
    });
    applyReleaseLink(mPreEl, mPre, {
      versionSelector: '.core-prerelease-ver',
      title: 'Открыть pre-release на GitHub',
    });
    configurePrereleaseAction(mPreUpdateBtn, mPre, installed && installed.mihomo ? installed.mihomo.version : '', {
      flag: '-um',
      coreLabel: 'Mihomo',
    });
    show(mUpdateBtn, !!upd.mihomo);
    setPillState(pillM, { hasUpdate: !!upd.mihomo, hasError: m.ok === false });
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
      xUpd.addEventListener('click', async () => {
        const ok = await runXkeenCommand('-ux');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      xUpd.dataset.xkWired = '1';
    }

    const xPreUpd = $('core-xray-prerelease-update-btn');
    if (xPreUpd && !xPreUpd.dataset.xkWired) {
      xPreUpd.addEventListener('click', async () => {
        await runPrereleaseUpdate(xPreUpd);
      });
      xPreUpd.dataset.xkWired = '1';
    }

    const mUpd = $('core-mihomo-update-btn');
    if (mUpd && !mUpd.dataset.xkWired) {
      mUpd.addEventListener('click', async () => {
        const ok = await runXkeenCommand('-um');
        if (!ok) toastMsg('Терминал недоступен.', 'error');
      });
      mUpd.dataset.xkWired = '1';
    }

    const mPreUpd = $('core-mihomo-prerelease-update-btn');
    if (mPreUpd && !mPreUpd.dataset.xkWired) {
      mPreUpd.addEventListener('click', async () => {
        await runPrereleaseUpdate(mPreUpd);
      });
      mPreUpd.dataset.xkWired = '1';
    }
  }

  let started = false;
  CS.init = function init() {
    const row = $('commands-status-row');
    if (!row || started) return;
    started = true;

    wire();

    (async () => {
      try {
        await refreshVersions();
      } catch (e) {}

      setLoading(true);
      try {
        await refreshUpdates(false);
      } catch (e) {
      } finally {
        setLoading(false);
      }
    })();
  };
})();

export function getCoresStatusApi() {
  try {
    return coresStatusModuleApi && typeof coresStatusModuleApi.init === 'function' ? coresStatusModuleApi : null;
  } catch (error) {
    return null;
  }
}

export function initCoresStatus(...args) {
  const api = getCoresStatusApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export const coresStatusApi = Object.freeze({
  get: getCoresStatusApi,
  init: initCoresStatus,
});
