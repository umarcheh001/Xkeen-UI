import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/dat/card.js
  DAT card wiring + meta refresh.

  RC-06c (card)
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  RC.dat = RC.dat || {};
  const DAT = RC.dat;

  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};

  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : (id) => document.getElementById(id);
  const toast = (typeof C.toast === 'function') ? C.toast : function () {};
  const debounce = (typeof C.debounce === 'function') ? C.debounce : (fn) => fn;
  const confirmModal = (typeof C.confirmModal === 'function') ? C.confirmModal : async () => true;

  const prefsMod = (DAT && DAT.prefs) ? DAT.prefs : {};
  const combo = (DAT && DAT.combo) ? DAT.combo : {};
  const api = (DAT && DAT.api) ? DAT.api : {};

  const normalizePath = (typeof prefsMod.normalizePath === 'function')
    ? prefsMod.normalizePath
    : function (dir, name) {
      const d = String(dir || '').trim().replace(/\/+$/g, '');
      const n = String(name || '').trim().replace(/^\/+/, '');
      if (!d) return '/' + n;
      if (!n) return d;
      return d + '/' + n;
    };

  const DEFAULTS = prefsMod.DEFAULTS || {
    geosite: { dir: '/opt/etc/xray/dat', name: 'geosite.dat', url: '' },
    geoip: { dir: '/opt/etc/xray/dat', name: 'geoip.dat', url: '' },
  };

  const wireCollapse = (RC.collapse && typeof RC.collapse.wireCollapse === 'function') ? RC.collapse.wireCollapse : function () {};

  function setDatControlBusy(control, busy) {
    if (!control) return;
    const active = !!busy;
    try { control.disabled = active; } catch (e) {}
    try { control.setAttribute('aria-busy', active ? 'true' : 'false'); } catch (e) {}
  }

  function setDatStatus(status, text, state, tooltip) {
    if (!status) return;
    const nextState = String(state || 'idle');
    status.textContent = String(text || '');
    try { status.dataset.state = nextState; } catch (e) {}
    try {
      status.classList.remove('is-ok', 'is-warn', 'is-bad', 'is-loading');
      if (nextState === 'ok') status.classList.add('is-ok');
      else if (nextState === 'warning') status.classList.add('is-warn');
      else if (nextState === 'error') status.classList.add('is-bad');
      else if (nextState === 'loading') status.classList.add('is-loading');
    } catch (e) {}
    try { status.setAttribute('aria-busy', nextState === 'loading' ? 'true' : 'false'); } catch (e) {}
    try {
      if (tooltip) status.setAttribute('data-tooltip', String(tooltip));
      else status.removeAttribute('data-tooltip');
    } catch (e) {}
  }

  function setDatMetaState(meta, state) {
    if (!meta) return;
    const nextState = String(state || 'idle');
    try { meta.dataset.state = nextState; } catch (e) {}
    try {
      meta.classList.remove('is-ok', 'is-warn', 'is-bad');
      if (nextState === 'ok') meta.classList.add('is-ok');
      else if (nextState === 'warning') meta.classList.add('is-warn');
      else if (nextState === 'error') meta.classList.add('is-bad');
    } catch (e) {}
  }

  function safeKind(kind) {
    return (String(kind || '').toLowerCase() === 'geoip') ? 'geoip' : 'geosite';
  }

  function loadPrefs() {
    return (typeof prefsMod.load === 'function') ? prefsMod.load() : { geosite: {}, geoip: {} };
  }

  function savePrefs(p) {
    try {
      if (typeof prefsMod.save === 'function') prefsMod.save(p);
    } catch (e) {}
  }

  function syncDatCurrentFileLabels(prefs) {
    const p = prefs || loadPrefs();
    const siteEl = $(IDS.datGeositeCurrentFile);
    const ipEl = $(IDS.datGeoipCurrentFile);

    const siteName = String((p && p.geosite && p.geosite.name) || (DEFAULTS.geosite && DEFAULTS.geosite.name) || '').trim();
    const ipName = String((p && p.geoip && p.geoip.name) || (DEFAULTS.geoip && DEFAULTS.geoip.name) || '').trim();

    try { if (siteEl) siteEl.textContent = siteName || 'geosite.dat'; } catch (e) {}
    try { if (ipEl) ipEl.textContent = ipName || 'geoip.dat'; } catch (e) {}
  }

  function datKindMatch(kind, filename) {
    const k = String(kind || '').toLowerCase();
    const n = String(filename || '').toLowerCase();
    if (!n.endsWith('.dat')) return false;
    if (k === 'geosite') {
      return n.startsWith('geosite') || n === 'zkeen.dat' || n === 'geosite_zkeen.dat';
    }
    if (k === 'geoip') {
      return n.startsWith('geoip') || n === 'zkeenip.dat' || n === 'geoip_zkeenip.dat';
    }
    return false;
  }

  function formatCandidates(cands, maxItems) {
    const list = Array.isArray(cands) ? cands.slice() : [];
    const max = Math.max(1, Number(maxItems || 3));
    if (!list.length) return '';
    const shown = list.slice(0, max);
    const rest = list.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ` +${rest}` : '');
  }

  function setDatalist(listEl, options) {
    if (!listEl) return;
    try {
      const opts = Array.isArray(options) ? options : [];
      listEl.innerHTML = '';
      opts.forEach((name) => {
        const o = document.createElement('option');
        o.value = String(name || '');
        listEl.appendChild(o);
      });
    } catch (e) {}
  }

  async function listEntriesForDir(dir, kind) {
    const d = String(dir || '').trim().replace(/\/+$/g, '');
    if (!d) return [];
    const data = (typeof api.list === 'function') ? await api.list(d) : null;
    if (!data) return [];
    const items = Array.isArray(data.items) ? data.items : [];
    const out = [];
    items.forEach((it) => {
      const name = it && it.name ? String(it.name) : '';
      const t = it && it.type ? String(it.type) : '';
      if (!name) return;
      // allow file or link (symlink)
      if (t !== 'file' && t !== 'link') return;
      if (!datKindMatch(kind, name)) return;
      out.push({ name, size: it.size, mtime: it.mtime, type: t });
    });
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }

  async function resolveKindPrefs(kind, prefs, els) {
    const k = safeKind(kind);
    const p = prefs && prefs[k] ? prefs[k] : null;
    if (!p) return { dir: '', name: '', candidates: [], entries: [] };

    // Discovery is read-only: refreshing metadata must never replace a path
    // explicitly entered by the operator.
    const dir = String(p.dir || '').trim() || ((DEFAULTS[k] && DEFAULTS[k].dir) ? DEFAULTS[k].dir : '');

    const entries = await listEntriesForDir(dir, k);
    const candidates = entries.map((e) => String((e && e.name) || '')).filter(Boolean);

    // Update datalist suggestions
    if (els && els.list) setDatalist(els.list, candidates);

    // Keep the saved filename as well. Detected files are suggestions in the
    // full-width picker; choosing one is the only action allowed to change it.
    const name = String(p.name || '').trim() || ((DEFAULTS[k] && DEFAULTS[k].name) ? DEFAULTS[k].name : '');

    // Apply to inputs
    try {
      if (els && els.dir && String(els.dir.value || '') !== String(dir || '')) els.dir.value = dir;
      if (els && els.name && String(els.name.value || '') !== String(name || '')) els.name.value = name;
    } catch (e) {}

    // Preserve the current values in the prefs object. This makes refreshes
    // idempotent and prevents panel updates from resetting custom locations.
    try {
      p.dir = dir;
      p.name = name;
    } catch (e) {}

    // Store detected entries for combo
    try {
      if (typeof combo.setEntries === 'function') combo.setEntries(k, entries);
    } catch (e) {}

    // Render list (also keeps UI in sync if popover open)
    try {
      if (els && els.found && typeof combo.renderFoundList === 'function') {
        combo.renderFoundList(els.found, entries, name, (picked) => {
          try {
            if (els && els.name) {
              els.name.value = String(picked || '');
              els.name.dispatchEvent(new Event('input', { bubbles: true }));
              els.name.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (err) {}
          try {
            if (typeof combo.closeAll === 'function') combo.closeAll();
          } catch (err) {}
          try { refreshDatMeta(); } catch (err) {}
        });
      }
      try {
        if (typeof combo.rerenderIfOpen === 'function') combo.rerenderIfOpen(k, { name: els && els.name, found: els && els.found });
      } catch (e) {}
    } catch (e) {}

    return { dir, name, candidates, entries };
  }

  function wireDatInputs() {
    const prefs = loadPrefs();

    const refreshLater = debounce(() => { try { refreshDatMeta(); } catch (e) {} }, 300);

    const map = {
      geosite: {
        dir: $(IDS.datGeositeDir),
        name: $(IDS.datGeositeName),
        url: $(IDS.datGeositeUrl),
        browse: $(IDS.datGeositeBrowse),
        found: $(IDS.datGeositeFound),
      },
      geoip: {
        dir: $(IDS.datGeoipDir),
        name: $(IDS.datGeoipName),
        url: $(IDS.datGeoipUrl),
        browse: $(IDS.datGeoipBrowse),
        found: $(IDS.datGeoipFound),
      },
    };

    Object.keys(map).forEach((kind) => {
      const m = map[kind];
      if (m.dir) m.dir.value = (prefs[kind] && prefs[kind].dir) ? prefs[kind].dir : '';
      if (m.name) m.name.value = (prefs[kind] && prefs[kind].name) ? prefs[kind].name : '';
      if (m.url) m.url.value = (prefs[kind] && prefs[kind].url) ? prefs[kind].url : '';

      const onChange = (source) => {
        const p = loadPrefs();
        p[kind] = {
          dir: (m.dir && m.dir.value) || '',
          name: (m.name && m.name.value) || '',
          url: (m.url && m.url.value) || '',
        };
        savePrefs(p);
        syncDatCurrentFileLabels(p);

        if (source === 'dir' || source === 'name') refreshLater();
      };

      ['input', 'change'].forEach((ev) => {
        if (m.dir) m.dir.addEventListener(ev, () => onChange('dir'));
        if (m.name) m.name.addEventListener(ev, () => onChange('name'));
        if (m.url) m.url.addEventListener(ev, () => onChange('url'));
      });

      try {
        if (typeof combo.bind === 'function') combo.bind(kind, m, refreshLater);
      } catch (e) {}
    });
  }

  async function refreshDatMeta() {
    const status = $(IDS.datStatus);
    const metaSite = $(IDS.datGeositeMeta);
    const metaIp = $(IDS.datGeoipMeta);
    const refreshBtn = $(IDS.datRefresh);
    setDatControlBusy(refreshBtn, true);
    setDatStatus(status, 'Загрузка…', 'loading');

    const prefs = loadPrefs();
    syncDatCurrentFileLabels(prefs);

    const els = {
      geosite: {
        dir: $(IDS.datGeositeDir),
        name: $(IDS.datGeositeName),
        list: $(IDS.datGeositeNameList),
        found: $(IDS.datGeositeFound),
      },
      geoip: {
        dir: $(IDS.datGeoipDir),
        name: $(IDS.datGeoipName),
        list: $(IDS.datGeoipNameList),
        found: $(IDS.datGeoipFound),
      },
    };

    // Auto-resolve existing files
    let rSite = null;
    let rIp = null;
    try { rSite = await resolveKindPrefs('geosite', prefs, els.geosite); } catch (e) { rSite = null; }
    try { rIp = await resolveKindPrefs('geoip', prefs, els.geoip); } catch (e) { rIp = null; }

    // Persist any auto-resolve changes
    try { savePrefs(prefs); } catch (e) {}

    const pSite = normalizePath((rSite && rSite.dir) ? rSite.dir : (prefs.geosite && prefs.geosite.dir), (rSite && rSite.name) ? rSite.name : (prefs.geosite && prefs.geosite.name));
    const pIp = normalizePath((rIp && rIp.dir) ? rIp.dir : (prefs.geoip && prefs.geoip.dir), (rIp && rIp.name) ? rIp.name : (prefs.geoip && prefs.geoip.name));

    const fmtSize = (typeof combo.fmtSize === 'function') ? combo.fmtSize : (n) => String(n || 0);
    const fmtTime = (typeof combo.fmtTime === 'function') ? combo.fmtTime : () => '';

    try {
      const data = (typeof api.statBatch === 'function') ? await api.statBatch([pSite, pIp]) : { items: [] };
      const items = Array.isArray(data.items) ? data.items : [];
      const map = {};
      items.forEach((it) => {
        if (it && it.path) map[it.path] = it;
      });

      function renderMeta(path, el, candidates) {
        if (!el) return;
        const it = map[path];
        if (!it || it.exists === false) {
          const err = it && it.error ? String(it.error) : '';
          const base = (err === 'forbidden') ? 'нет доступа' : 'нет файла';
          const cands = Array.isArray(candidates) ? candidates : [];
          if (cands.length && base === 'нет файла') {
            el.textContent = base + ' • есть: ' + formatCandidates(cands, 3);
            try { el.setAttribute('data-tooltip', 'Найдены DAT в папке: ' + cands.join(', ')); } catch (e) {}
          } else {
            el.textContent = base;
            try { el.removeAttribute('data-tooltip'); } catch (e) {}
          }
          setDatMetaState(el, err === 'forbidden' ? 'error' : 'warning');
          return;
        }
        const size = fmtSize(it.size);
        const mt = fmtTime(it.mtime);
        el.textContent = `${size}${mt ? ' • ' + mt : ''}`;
        setDatMetaState(el, 'ok');
      }

      renderMeta(pSite, metaSite, (rSite && rSite.candidates) ? rSite.candidates : []);
      renderMeta(pIp, metaIp, (rIp && rIp.candidates) ? rIp.candidates : []);

      // xk-geodat status
      let gs = null;
      try { gs = (typeof api.getGeodatStatus === 'function') ? await api.getGeodatStatus() : null; } catch (e) { gs = null; }
      if (status) {
        const installed = !!(gs && (gs.installed === true || (gs.ok === true && gs.installed)));
        const plat = (gs && gs.platform) ? gs.platform : null;

        const unsupported = !!(plat && plat.supported === false);

        // Release install is unavailable on unsupported platforms; content
        // actions are unavailable until xk-geodat is installed.
        try {
          const btnMain = $(IDS.datGeodatInstall);
          if (btnMain) {
            btnMain.disabled = unsupported;
            btnMain.setAttribute('aria-disabled', unsupported ? 'true' : 'false');
          }
          [$(IDS.datGeositeContent), $(IDS.datGeoipContent)].forEach((button) => {
            if (!button) return;
            button.disabled = !installed;
            button.setAttribute('aria-disabled', installed ? 'false' : 'true');
          });
        } catch (e) {}

        let tip = installed
          ? 'xk-geodat установлен (просмотр содержимого DAT доступен)'
          : 'xk-geodat не установлен (нажмите «xk-geodat» для установки)';
        if (!installed && unsupported) {
          const note = String(plat.note || '').trim();
          if (note) tip = note;
        } else if (!installed && gs && gs.reason) {
          tip += "\\nПричина: " + String(gs.reason);
        }
        setDatStatus(
          status,
          installed ? 'OK • xk-geodat: ✓' : (unsupported ? 'Недоступно • xk-geodat' : 'OK • xk-geodat: ✕'),
          installed ? 'ok' : 'warning',
          tip,
        );
      }
    } catch (e) {
      setDatStatus(status, 'Ошибка', 'error');
      setDatMetaState(metaSite, 'error');
      setDatMetaState(metaIp, 'error');
      toast('DAT: не удалось получить статусы: ' + String(e && e.message ? e.message : e), true);
    } finally {
      setDatControlBusy(refreshBtn, false);
    }
  }

  function initDatCard() {
    const datHeader = $(IDS.datHeader);
    const datBody = $(IDS.datBody);
    if (!datHeader || !datBody) return false;
    if (datBody.dataset && datBody.dataset.xkDatCardWired === '1') return true;

    wireDatInputs();

    // Collapsed by default
    wireCollapse(IDS.datHeader, IDS.datBody, IDS.datArrow, (LS_KEYS.datOpen || 'xk.routing.dat.open.v3'), refreshDatMeta, false);

    const refreshBtn = $(IDS.datRefresh);
    if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.preventDefault(); refreshDatMeta(); });

    const installBtn = $(IDS.datGeodatInstall);
    if (installBtn && api && typeof api.installGeodat === 'function') {
      installBtn.addEventListener('click', (e) => { e.preventDefault(); api.installGeodat({ mode: 'release' }); });
    }

    const installFileBtn = $(IDS.datGeodatInstallFileBtn);
    const installFileInput = $(IDS.datGeodatInstallFile);
    if (installFileBtn && installFileInput && api && typeof api.installGeodat === 'function') {
      installFileBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try { installFileInput.value = ''; } catch (err) {}
        installFileInput.click();
      });
      installFileInput.addEventListener('change', () => {
        const f = installFileInput.files && installFileInput.files[0];
        if (f) api.installGeodat({ mode: 'file', file: f });
      });
    }

    const b1 = $(IDS.datGeositeUpload);
    const b2 = $(IDS.datGeoipUpload);
    const b3 = $(IDS.datGeositeDownload);
    const b4 = $(IDS.datGeoipDownload);
    const b5 = $(IDS.datGeositeUpdate);
    const b6 = $(IDS.datGeoipUpdate);
    const b7 = $(IDS.datGeositeContent);
    const b8 = $(IDS.datGeoipContent);

    if (b1 && api && typeof api.uploadDat === 'function') b1.addEventListener('click', (e) => { e.preventDefault(); api.uploadDat('geosite'); });
    if (b2 && api && typeof api.uploadDat === 'function') b2.addEventListener('click', (e) => { e.preventDefault(); api.uploadDat('geoip'); });
    if (b3 && api && typeof api.downloadDat === 'function') b3.addEventListener('click', (e) => { e.preventDefault(); api.downloadDat('geosite'); });
    if (b4 && api && typeof api.downloadDat === 'function') b4.addEventListener('click', (e) => { e.preventDefault(); api.downloadDat('geoip'); });
    if (b5 && api && typeof api.updateDatByUrl === 'function') b5.addEventListener('click', (e) => { e.preventDefault(); api.updateDatByUrl('geosite'); });
    if (b6 && api && typeof api.updateDatByUrl === 'function') b6.addEventListener('click', (e) => { e.preventDefault(); api.updateDatByUrl('geoip'); });

    // Content viewer modal
    if (b7) b7.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.open === 'function') {
          XKeen.ui.datContents.open('geosite');
        } else {
          toast('DAT: модуль просмотра содержимого не загружен.', true);
        }
      } catch (err) {
        toast('DAT: не удалось открыть содержимое.', true);
      }
    });

    if (b8) b8.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.open === 'function') {
          XKeen.ui.datContents.open('geoip');
        } else {
          toast('DAT: модуль просмотра содержимого не загружен.', true);
        }
      } catch (err) {
        toast('DAT: не удалось открыть содержимое.', true);
      }
    });

    try {
      if (datBody.dataset) datBody.dataset.xkDatCardWired = '1';
    } catch (e) {}

    // Initial meta load
    setTimeout(() => {
      try { refreshDatMeta(); } catch (e) {}
    }, 400);
    return true;
  }

  DAT.card = DAT.card || {};
  DAT.card.initDatCard = initDatCard;
  DAT.card.refreshDatMeta = refreshDatMeta;
})();
