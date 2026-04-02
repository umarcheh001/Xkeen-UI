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

  function chooseBest(kind, candidates) {
    const k = String(kind || '').toLowerCase();
    const list = Array.isArray(candidates) ? candidates.slice() : [];
    const prio = (k === 'geosite')
      ? ['geosite.dat', 'geosite_v2fly.dat', 'geosite_refilter.dat', 'geosite_zkeen.dat', 'zkeen.dat']
      : ['geoip.dat', 'geoip_v2fly.dat', 'geoip_refilter.dat', 'geoip_zkeenip.dat', 'zkeenip.dat'];
    const lower = list.map((x) => String(x || '').toLowerCase());
    for (let i = 0; i < prio.length; i++) {
      const want = prio[i];
      const j = lower.indexOf(want);
      if (j >= 0) return list[j];
    }
    if (list.length === 1) return list[0];
    list.sort((a, b) => String(a).localeCompare(String(b)));
    return list[0] || '';
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

    // Dir: migrate old default (/opt/etc/xray) -> /opt/etc/xray/dat
    let dir = String(p.dir || '').trim();
    if (!dir) dir = (DEFAULTS[k] && DEFAULTS[k].dir) ? DEFAULTS[k].dir : '';
    if (dir === '/opt/etc/xray') dir = (DEFAULTS[k] && DEFAULTS[k].dir) ? DEFAULTS[k].dir : dir;

    let entries = await listEntriesForDir(dir, k);
    let candidates = entries.map((e) => String((e && e.name) || '')).filter(Boolean);

    // If user points to /.../xray, try /.../xray/dat
    if ((!candidates || !candidates.length) && /\/xray\/?$/.test(dir) && !/\/xray\/dat$/.test(dir)) {
      const alt = dir.replace(/\/+$/g, '') + '/dat';
      const altEntries = await listEntriesForDir(alt, k);
      const altCand = altEntries.map((e) => String((e && e.name) || '')).filter(Boolean);
      if (altCand && altCand.length) {
        dir = alt;
        entries = altEntries;
        candidates = altCand;
      }
    }

    // Update datalist suggestions
    if (els && els.list) setDatalist(els.list, candidates);

    // Name: keep user's choice, but auto-pick when it's default and missing
    let name = String(p.name || '').trim();
    if (!name) name = (DEFAULTS[k] && DEFAULTS[k].name) ? DEFAULTS[k].name : '';

    const lower = candidates.map((x) => String(x || '').toLowerCase());
    const idx = lower.indexOf(String(name).toLowerCase());
    if (idx >= 0) {
      name = candidates[idx];
    } else {
      const isDefaultName = String(name).toLowerCase() === String((DEFAULTS[k] && DEFAULTS[k].name) || '').toLowerCase();
      if (isDefaultName && candidates && candidates.length) {
        const chosen = chooseBest(k, candidates);
        if (chosen) name = chosen;
      }
    }

    // Apply to inputs
    try {
      if (els && els.dir && String(els.dir.value || '') !== String(dir || '')) els.dir.value = dir;
      if (els && els.name && String(els.name.value || '') !== String(name || '')) els.name.value = name;
    } catch (e) {}

    // Persist into prefs object
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

      const onChange = () => {
        const p = loadPrefs();
        p[kind] = {
          dir: (m.dir && m.dir.value) || '',
          name: (m.name && m.name.value) || '',
          url: (m.url && m.url.value) || '',
        };
        savePrefs(p);
      };

      ['input', 'change'].forEach((ev) => {
        if (m.dir) m.dir.addEventListener(ev, onChange);
        if (m.name) m.name.addEventListener(ev, onChange);
        if (m.url) m.url.addEventListener(ev, onChange);
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
    if (status) status.textContent = 'Загрузка…';

    const prefs = loadPrefs();

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
          return;
        }
        const size = fmtSize(it.size);
        const mt = fmtTime(it.mtime);
        el.textContent = `${size}${mt ? ' • ' + mt : ''}`;
      }

      renderMeta(pSite, metaSite, (rSite && rSite.candidates) ? rSite.candidates : []);
      renderMeta(pIp, metaIp, (rIp && rIp.candidates) ? rIp.candidates : []);

      // xk-geodat status
      let gs = null;
      try { gs = (typeof api.getGeodatStatus === 'function') ? await api.getGeodatStatus() : null; } catch (e) { gs = null; }
      if (status) {
        const installed = !!(gs && (gs.installed === true || (gs.ok === true && gs.installed)));
        const plat = (gs && gs.platform) ? gs.platform : null;

        // Disable release install on unsupported platforms
        try {
          const btnMain = $(IDS.datGeodatInstall);
          if (btnMain && plat && plat.supported === false) btnMain.disabled = true;
        } catch (e) {}

        status.textContent = installed ? 'OK • xk-geodat: ✓' : 'OK • xk-geodat: ✕';

        let tip = installed
          ? 'xk-geodat установлен (просмотр содержимого DAT доступен)'
          : 'xk-geodat не установлен (нажмите «xk-geodat» для установки)';
        if (!installed && plat && plat.supported === false) {
          const note = String(plat.note || '').trim();
          if (note) tip = note;
        } else if (!installed && gs && gs.reason) {
          tip += "\\nПричина: " + String(gs.reason);
        }
        status.setAttribute('data-tooltip', tip);
      }
    } catch (e) {
      if (status) status.textContent = 'Ошибка';
      toast('DAT: не удалось получить статусы: ' + String(e && e.message ? e.message : e), true);
    }
  }

  function initDatCard() {
    if (!$(IDS.datHeader) || !$(IDS.datBody)) return;

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

    // Initial meta load
    setTimeout(() => {
      try { refreshDatMeta(); } catch (e) {}
    }, 400);
  }

  DAT.card = DAT.card || {};
  DAT.card.initDatCard = initDatCard;
  DAT.card.refreshDatMeta = refreshDatMeta;
})();
