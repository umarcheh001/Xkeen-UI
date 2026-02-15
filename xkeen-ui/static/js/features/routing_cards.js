/*
  Routing extra cards: DAT manager + interactive rules list for Xray routing.
  - DAT: Upload / Download / Update by URL for geosite.dat / geoip.dat
  - Rules: list + reorder + JSON edit modal + apply back into routing editor
*/
(function () {
  'use strict';

  // Namespace
  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const IDS = {
    // DAT
    datHeader: 'routing-dat-header',
    datBody: 'routing-dat-body',
    datArrow: 'routing-dat-arrow',
    datRefresh: 'routing-dat-refresh-btn',
    datStatus: 'routing-dat-status',
    datGeositeMeta: 'routing-dat-geosite-meta',
    datGeoipMeta: 'routing-dat-geoip-meta',
    datGeositeDir: 'routing-dat-geosite-dir',
    datGeositeName: 'routing-dat-geosite-name',
    datGeositeNameList: 'routing-dat-geosite-name-list',
    datGeositeBrowse: 'routing-dat-geosite-browse',
    datGeositeFound: 'routing-dat-geosite-found',
    datGeoipDir: 'routing-dat-geoip-dir',
    datGeoipName: 'routing-dat-geoip-name',
    datGeoipNameList: 'routing-dat-geoip-name-list',
    datGeoipBrowse: 'routing-dat-geoip-browse',
    datGeoipFound: 'routing-dat-geoip-found',
    datGeositeUrl: 'routing-dat-geosite-url',
    datGeoipUrl: 'routing-dat-geoip-url',
    datGeositeUpload: 'routing-dat-geosite-upload-btn',
    datGeoipUpload: 'routing-dat-geoip-upload-btn',
    datGeositeDownload: 'routing-dat-geosite-download-btn',
    datGeoipDownload: 'routing-dat-geoip-download-btn',
    datGeositeUpdate: 'routing-dat-geosite-update-btn',
    datGeoipUpdate: 'routing-dat-geoip-update-btn',
    datGeositeContent: 'routing-dat-geosite-content-btn',
    datGeoipContent: 'routing-dat-geoip-content-btn',
    datGeositeInRouting: 'routing-dat-geosite-inrouting-btn',
    datGeoipInRouting: 'routing-dat-geoip-inrouting-btn',
    datGeositeFile: 'routing-dat-geosite-file',
    datGeoipFile: 'routing-dat-geoip-file',
    datGeodatInstall: 'routing-dat-geodat-install-btn',
    datGeodatInstallFileBtn: 'routing-dat-geodat-install-file-btn',
    datGeodatInstallFile: 'routing-dat-geodat-install-file',

    // Rules
    rulesHeader: 'routing-rules-header',
    rulesBody: 'routing-rules-body',
    rulesArrow: 'routing-rules-arrow',
    rulesCount: 'routing-rules-count',
    rulesGeo: 'routing-rules-geo',
    rulesFilter: 'routing-rules-filter',
    rulesRefresh: 'routing-rules-refresh-btn',
    rulesReload: 'routing-rules-reload-btn',
    rulesApply: 'routing-rules-apply-btn',
    rulesAdd: 'routing-rules-add-btn',
    rulesList: 'routing-rules-list',
    rulesEmpty: 'routing-rules-empty',
    domainStrategy: 'routing-domain-strategy',

    balancersList: 'routing-balancers-list',
    balancerAdd: 'routing-balancer-add-btn',

    // Sidebar: extra collapsible cards (right column)
    backupsHeader: 'routing-backups-header',
    backupsBody: 'routing-backups-body',
    backupsArrow: 'routing-backups-arrow',
    helpHeader: 'routing-help-header',
    helpBody: 'routing-help-body',
    helpArrow: 'routing-help-arrow',
  };

  // -------- field help (ported from legacy routing.js) --------
  const FIELD_HELP_MODAL_ID = 'xkeen-routing-field-help-modal';
  const FIELD_HELP_TITLE_ID = 'xkeen-routing-field-help-title';
  const FIELD_HELP_BODY_ID = 'xkeen-routing-field-help-body';

  const ROUTING_FIELD_DOCS = {
      domainStrategy: {
        title: 'domainStrategy',
        desc: 'Стратегия разрешения доменных имен для маршрутизации.',
        items: [
          '"AsIs": использовать домен как есть (значение по умолчанию).',
          '"IPIfNonMatch": если домен не совпал с правилами, резолвится в IP и выполняется повторное сопоставление.',
          '"IPOnDemand": домен резолвится в IP при первом правиле, требующем IP сопоставления.',
        ],
      },
      domain: {
        title: 'domain',
        desc: 'Список доменных условий. Правило срабатывает при совпадении любого элемента.',
        items: [
          'Простая строка: совпадение по подстроке.',
          'regexp: регулярное выражение.',
          'domain: домен и поддомены.',
          'full: точное совпадение домена.',
          'geosite: имя списка доменов.',
          'ext:файл:тег — домены из файла ресурсов (формат как geosite.dat).',
        ],
      },
      ip: {
        title: 'ip',
        desc: 'Список диапазонов IP назначения. Совпадение любого элемента.',
        items: [
          'IP-адрес, например 127.0.0.1.',
          'CIDR, например 10.0.0.0/8 или ::/0.',
          'geoip:код_страны, например geoip:cn.',
          'geoip:private — частные адреса.',
          'geoip:!cn — исключение (поддерживается отрицание).',
          'ext:файл:тег — IP из файла ресурсов (формат как geoip.dat).',
        ],
      },
      port: {
        title: 'port',
        desc: 'Порты назначения.',
        items: [
          '"a-b": диапазон портов.',
          '"a": один порт.',
          '"a,b,..." смесь диапазонов и одиночных значений.',
        ],
      },
      sourcePort: {
        title: 'sourcePort',
        desc: 'Порты источника. Формат как у port.',
      },
      localPort: {
        title: 'localPort',
        desc: 'Порт локального inbound. Формат как у port/sourcePort.',
      },
      network: {
        title: 'network',
        desc: 'Тип сети для сопоставления.',
        items: [
          '"tcp"', '"udp"', '"tcp,udp"',
        ],
        note: 'tcp,udp можно использовать в качестве catch‑all в конце списка правил.',
      },
      sourceIP: {
        title: 'sourceIP',
        desc: 'IP источника. Форматы такие же, как у ip.',
        note: 'Псевдоним: source.',
      },
      localIP: {
        title: 'localIP',
        desc: 'IP, на котором принято входящее соединение.',
        note: 'Для UDP не работает — localIP не отслеживается.',
      },
      user: {
        title: 'user',
        desc: 'Email пользователя. Поддерживает regexp: для регулярных выражений.',
      },
      vlessRoute: {
        title: 'vlessRoute',
        desc: 'Диапазон данных VLESS (7–8 байты UUID). Формат как у port.',
        note: 'Интерпретируется как uint16 (big‑endian), можно задавать диапазоны.',
      },
      inboundTag: {
        title: 'inboundTag',
        desc: 'Список тегов inbound. Совпадение любого тега.',
      },
      protocol: {
        title: 'protocol',
        desc: 'Протоколы, определяемые sniffing.',
        items: [
          'http, tls, quic, bittorrent',
        ],
        note: 'Для определения протокола должен быть включен sniffing.',
      },
      attrs: {
        title: 'attrs',
        desc: 'HTTP‑атрибуты: ключ/значение строками. Срабатывает, если присутствуют все ключи.',
        items: [
          'Примеры: :method=GET',
          ':path=/test',
          'accept=text/html',
        ],
      },
      outboundTag: {
        title: 'outboundTag',
        desc: 'Тег outbound, куда направлять трафик.',
      },
      balancerTag: {
        title: 'balancerTag',
        desc: 'Тег балансировщика (используется вместо outboundTag).',
        note: 'Нужно указать либо outboundTag, либо balancerTag; при наличии обоих используется outboundTag.',
      },
      balancer: {
        title: 'balancer (routing.balancers)',
        desc: 'Балансировщик выбирает outbound из набора selector и используется в правилах через balancerTag.',
        items: [
          'tag — идентификатор балансировщика (нужен для balancerTag в правилах).',
          'selector — список префиксов outboundTag (выбираются все outbound, чьи теги начинаются с префикса).',
          'strategy — алгоритм выбора (например random или leastPing).',
          'fallbackTag — запасной outbound, если выбранные недоступны (обычно требует observatory).',
        ],
      },
      ruleTag: {
        title: 'ruleTag',
        desc: 'Тег правила для идентификации и логов; на маршрутизацию не влияет.',
      },
      'balancer.tag': {
        title: 'balancer.tag',
        desc: 'Тег балансировщика; используется в balancerTag правил.',
      },
      'balancer.selector': {
        title: 'balancer.selector',
        desc: 'Список префиксов тегов outbound. Выбираются все outbound, чьи теги начинаются с элемента selector.',
        items: [
          'Пример: "vless-" выберет outbounds с тегами vless-1, vless-2 и т.п.',
          'Можно указывать и полный tag для точного выбора.',
        ],
      },
      'balancer.fallbackTag': {
        title: 'balancer.fallbackTag',
        desc: 'Запасной outbound, если все выбранные недоступны.',
        note: 'Требуется observatory или burstObservatory.',
      },
      'balancer.strategy': {
        title: 'balancer.strategy',
        desc: 'StrategyObject: JSON с алгоритмом балансировки (random/leastLoad и др.).',
      },
    };


  // -------- helpers --------
  function $(id) {
    return document.getElementById(id);
  }

  function toast(msg, isErr) {
    try {
      if (XK.ui && typeof XK.ui.toast === 'function') {
        XK.ui.toast(String(msg || ''), isErr ? 'error' : 'info');
        return;
      }
    } catch (e) {}
    try {
      // Fallback
      // eslint-disable-next-line no-alert
      alert(String(msg || ''));
    } catch (e) {}
  }

  async function confirmModal(opts) {
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') {
        return await XK.ui.confirm(opts || {});
      }
    } catch (e) {}
    const msg = String((opts && (opts.message || opts.text)) || 'Confirm?');
    // eslint-disable-next-line no-restricted-globals
    return confirm(msg);
  }

  function safeJsonParse(text) {
    try {
      // Prefer shared helper (handles JSONC)
      if (XK.util && typeof XK.util.stripJsonComments === 'function') {
        return JSON.parse(XK.util.stripJsonComments(text));
      }
    } catch (e) {}

    // Best-effort JSONC stripping (simple)
    try {
      const cleaned = String(text || '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return JSON.parse(cleaned);
    } catch (e) {
      return { __error: e };
    }
  }

  function editorInstance() {
    try {
      if (XK.state && XK.state.routingEditor) return XK.state.routingEditor;
    } catch (e) {}
    return null;
  }

  function getEditorText() {
    const cm = editorInstance();
    if (cm && typeof cm.getValue === 'function') return cm.getValue();
    const ta = $('routing-editor');
    return ta ? ta.value : '';
  }

  function setEditorText(text) {
    const cm = editorInstance();
    if (cm && typeof cm.setValue === 'function') {
      cm.setValue(String(text || ''));
      return;
    }
    const ta = $('routing-editor');
    if (ta) ta.value = String(text || '');
  }

  function isViewVisible() {
    const v = document.getElementById('view-routing');
    if (!v) return false;
    const st = window.getComputedStyle(v);
    return st && st.display !== 'none' && st.visibility !== 'hidden';
  }

  function debounce(fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait || 0);
    };
  }

  // -------- collapses --------
  function wireCollapse(headerId, bodyId, arrowId, key, onOpen, defaultOpen) {
    const h = $(headerId);
    const b = $(bodyId);
    const a = $(arrowId);
    if (!h || !b || !a) return;

    const prefKey = key || null;
    let open = (typeof defaultOpen === 'boolean') ? defaultOpen : true;
    if (prefKey) {
      try {
        const v = localStorage.getItem(prefKey);
        if (v === '0') open = false;
        if (v === '1') open = true;
      } catch (e) {}
    }

    function applyState() {
      b.style.display = open ? '' : 'none';
      a.textContent = open ? '▼' : '►';
    }
    applyState();

    h.addEventListener('click', () => {
      open = !open;
      if (prefKey) {
        try { localStorage.setItem(prefKey, open ? '1' : '0'); } catch (e) {}
      }
      applyState();
      if (open && typeof onOpen === 'function') {
        try { onOpen(); } catch (e) {}
      }
    });
  }

  // Sidebar (auxiliary) cards: keep folded by default and remember per-card state.
  function initSidebarExtraCards() {
    try {
      wireCollapse(IDS.backupsHeader, IDS.backupsBody, IDS.backupsArrow, 'xk.routing.backups.open.v1', null, false);
    } catch (e) {}
    try {
      wireCollapse(IDS.helpHeader, IDS.helpBody, IDS.helpArrow, 'xk.routing.help.open.v1', null, false);
    } catch (e) {}
  }

  // ===================== DAT CARD =====================
  const DAT_PREF_KEY = 'xk.routing.dat.prefs.v1';
  const DAT_DEFAULTS = {
    geosite: {
      dir: '/opt/etc/xray/dat',
      name: 'geosite.dat',
      url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat',
    },
    geoip: {
      dir: '/opt/etc/xray/dat',
      name: 'geoip.dat',
      url: 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat',
    },
  };

  function normalizePath(dir, name) {
    const d = String(dir || '').trim().replace(/\/+$/g, '');
    const n = String(name || '').trim().replace(/^\/+/, '');
    if (!d) return '/' + n;
    if (!n) return d;
    return d + '/' + n;
  }

  function loadDatPrefs() {
    try {
      const raw = localStorage.getItem(DAT_PREF_KEY);
      if (!raw) return JSON.parse(JSON.stringify(DAT_DEFAULTS));
      const v = JSON.parse(raw);
      return {
        geosite: { ...DAT_DEFAULTS.geosite, ...(v.geosite || {}) },
        geoip: { ...DAT_DEFAULTS.geoip, ...(v.geoip || {}) },
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DAT_DEFAULTS));
    }
  }

  function saveDatPrefs(prefs) {
    try {
      localStorage.setItem(DAT_PREF_KEY, JSON.stringify(prefs || {}));
    } catch (e) {}
  }


  // One control: input + ▼ popover with detected .dat files
  const DAT_COMBO = {
    // openValue: value in the input at the moment the popover was opened.
    // It prevents the initial render from being filtered down to a single exact match.
    geosite: { open: false, entries: [], openValue: '' },
    geoip: { open: false, entries: [], openValue: '' },
  };
  let DAT_COMBO_GLOBAL_BOUND = false;

  function datGetComboRoot(nameEl) {
    try {
      if (!nameEl) return null;
      if (typeof nameEl.closest === 'function') return nameEl.closest('.routing-dat-combo');
      return null;
    } catch (e) {
      return null;
    }
  }

  function datSetComboOpen(kind, root, open) {
    try {
      const k = String(kind || '').toLowerCase();
      if (DAT_COMBO[k]) DAT_COMBO[k].open = !!open;
      if (!root) return;
      if (open) root.classList.add('is-open');
      else root.classList.remove('is-open');
    } catch (e) {}
  }

  function datCloseAllCombos(exceptKind) {
    const ex = String(exceptKind || '').toLowerCase();
    try {
      document.querySelectorAll('.routing-dat-combo.is-open').forEach((root) => {
        const k = String((root && (root.getAttribute('data-kind') || (root.dataset && root.dataset.kind))) || '').toLowerCase();
        if (ex && k === ex) return;
        root.classList.remove('is-open');
      });
    } catch (e) {}
    try {
      Object.keys(DAT_COMBO).forEach((k) => {
        if (ex && k === ex) return;
        DAT_COMBO[k].open = false;
      });
    } catch (e) {}
  }

  function datRenderCombo(kind, m) {
    const k = String(kind || '').toLowerCase();
    const st = DAT_COMBO[k] || { entries: [], open: false };
    const entries = Array.isArray(st.entries) ? st.entries : [];
    let q = (m && m.name) ? String(m.name.value || '').trim().toLowerCase() : '';

    // If the value hasn't changed since opening the popover, don't auto-filter.
    // Users expect to see the full list when clicking ▼, even if the input contains
    // a fully-matching filename.
    try {
      const opened = String((st && st.openValue) || '').trim().toLowerCase();
      if (opened && q === opened) q = '';
    } catch (e) {}

    if (!m || !m.found) return;

    // Filter only when user types (q != openValue); show a dedicated "нет совпадений" message.
    let list = entries;
    if (q) {
      list = entries.filter((e) => String((e && e.name) || '').toLowerCase().includes(q));
      if (entries.length && !list.length) {
        try {
          m.found.innerHTML = '';
          const e = document.createElement('div');
          e.className = 'routing-dat-found-empty';
          e.textContent = '— нет совпадений';
          m.found.appendChild(e);
        } catch (err) {}
        return;
      }
    }

    datRenderFoundList(m.found, list, (m && m.name) ? m.name.value : '', (picked) => {
      try {
        if (m && m.name) {
          m.name.value = String(picked || '');
          // trigger save (wireDatInputs listens to input/change)
          m.name.dispatchEvent(new Event('input', { bubbles: true }));
          m.name.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (e) {}
      try {
        const root = datGetComboRoot(m && m.name);
        datSetComboOpen(k, root, false);
      } catch (e) {}
      try { if (typeof m.refreshLater === 'function') m.refreshLater(); else refreshDatMeta(); } catch (e) {}
    });
  }

  function datEnsureComboGlobalListeners() {
    if (DAT_COMBO_GLOBAL_BOUND) return;
    DAT_COMBO_GLOBAL_BOUND = true;

    // Close on click outside
    document.addEventListener('click', (e) => {
      try {
        const t = e && e.target ? e.target : null;
        if (!t) return;
        const inside = (typeof t.closest === 'function') ? t.closest('.routing-dat-combo') : null;
        if (!inside) datCloseAllCombos();
      } catch (err) {}
    }, true);

    // Close on Esc
    document.addEventListener('keydown', (e) => {
      try {
        if (e && e.key === 'Escape') datCloseAllCombos();
      } catch (err) {}
    }, true);
  }

  function bindDatCombo(kind, m, refreshLater) {
    const k = String(kind || '').toLowerCase();
    if (!m) return;
    datEnsureComboGlobalListeners();

    // attach refresh function to map object (used by datRenderCombo)
    try { m.refreshLater = refreshLater; } catch (e) {}

    const nameEl = m.name;
    const browseEl = m.browse;

    if (browseEl) {
      browseEl.addEventListener('click', (ev) => {
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}
        const root = datGetComboRoot(nameEl) || (browseEl.closest ? browseEl.closest('.routing-dat-combo') : null);
        const isOpen = !!(root && root.classList.contains('is-open'));
        if (!isOpen) datCloseAllCombos(k);
        // Remember the input value at the moment of opening so we don't auto-filter.
        try { if (!isOpen && DAT_COMBO && DAT_COMBO[k]) DAT_COMBO[k].openValue = String((nameEl && nameEl.value) || ''); } catch (e) {}
        datSetComboOpen(k, root, !isOpen);
        if (!isOpen) datRenderCombo(k, m);
      });
    }

    if (nameEl) {
      nameEl.addEventListener('input', () => {
        try { if (DAT_COMBO[k] && DAT_COMBO[k].open) datRenderCombo(k, m); } catch (e) {}
      });

      nameEl.addEventListener('keydown', (ev) => {
        try {
          if (!ev) return;
          if (ev.key === 'ArrowDown') {
            const root = datGetComboRoot(nameEl);
            datCloseAllCombos(k);
            try { if (DAT_COMBO && DAT_COMBO[k]) DAT_COMBO[k].openValue = String((nameEl && nameEl.value) || ''); } catch (e) {}
            datSetComboOpen(k, root, true);
            datRenderCombo(k, m);
          } else if (ev.key === 'Escape') {
            const root = datGetComboRoot(nameEl);
            datSetComboOpen(k, root, false);
          }
        } catch (e) {}
      });
    }
  }

  function wireDatInputs() {
    const prefs = loadDatPrefs();


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
      if (m.dir) m.dir.value = prefs[kind].dir || '';
      if (m.name) m.name.value = prefs[kind].name || '';
      if (m.url) m.url.value = prefs[kind].url || '';

      const onChange = () => {
        const p = loadDatPrefs();
        p[kind] = {
          dir: (m.dir && m.dir.value) || '',
          name: (m.name && m.name.value) || '',
          url: (m.url && m.url.value) || '',
        };
        saveDatPrefs(p);
      };

      ['input', 'change'].forEach((ev) => {
        if (m.dir) m.dir.addEventListener(ev, onChange);
        if (m.name) m.name.addEventListener(ev, onChange);
        if (m.url) m.url.addEventListener(ev, onChange);
      });

      // One control: input + ▼ popover with detected .dat
      try { bindDatCombo(kind, m, refreshLater); } catch (e) {}
    });
  }

  async function datStatBatch(paths) {
    const resp = await fetch('/api/fs/stat-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: 'local', paths: paths || [] }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      throw new Error((data && (data.error || data.message)) || 'stat_failed');
    }
    return data;
  }

  function fmtSize(n) {
    const b = Number(n || 0);
    if (!isFinite(b) || b <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let v = b;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    const prec = i === 0 ? 0 : (v >= 10 ? 1 : 2);
    return `${v.toFixed(prec)} ${units[i]}`;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      const d = new Date(ts * 1000);
      return d.toLocaleString();
    } catch (e) {
      return '';
    }
  }


  // DAT: resolve existing files in a folder (router often keeps them in /opt/etc/xray/dat
  // and names may differ: geosite_v2fly.dat, geoip_v2fly.dat, *_refilter.dat, etc.)
  async function fsListLocalDir(path) {
    const p = String(path || '').trim();
    if (!p) return null;
    try {
      const resp = await fetch('/api/fs/list?target=local&path=' + encodeURIComponent(p));
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return null;
      return data;
    } catch (e) {
      return null;
    }
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

  function datChooseBest(kind, candidates) {
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
    // fallback: first alphabetically
    list.sort((a, b) => String(a).localeCompare(String(b)));
    return list[0] || '';
  }

  function datFormatCandidates(cands, maxItems) {
    const list = Array.isArray(cands) ? cands.slice() : [];
    const max = Math.max(1, Number(maxItems || 3));
    if (!list.length) return '';
    const shown = list.slice(0, max);
    const rest = list.length - shown.length;
    return shown.join(', ') + (rest > 0 ? ` +${rest}` : '');
  }

  function datSetDatalist(listEl, options) {
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

  function datSetSelect(selectEl, entries, currentName) {
    if (!selectEl) return;
    try {
      const list = Array.isArray(entries) ? entries : [];
      const current = String(currentName || '').trim();

      selectEl.innerHTML = '';

      if (!list.length) {
        const o = document.createElement('option');
        o.value = '';
        o.textContent = '— нет .dat';
        selectEl.appendChild(o);
        selectEl.disabled = true;
        return;
      }

      selectEl.disabled = false;
      const lower = list.map((e) => String((e && e.name) || '').toLowerCase());
      if (current && lower.indexOf(current.toLowerCase()) < 0) {
        const o = document.createElement('option');
        o.value = current;
        o.textContent = '(текущий) ' + current;
        selectEl.appendChild(o);
      }

      list.forEach((e) => {
        const name = String((e && e.name) || '');
        if (!name) return;
        const o = document.createElement('option');
        o.value = name;
        const sz = (e && e.size !== undefined && e.size !== null) ? fmtSize(e.size) : '';
        o.textContent = sz ? (name + ' • ' + sz) : name;
        try {
          const mt = (e && e.mtime) ? fmtTime(e.mtime) : '';
          if (mt) o.title = mt;
        } catch (err) {}
        selectEl.appendChild(o);
      });

      if (current) {
        try { selectEl.value = current; } catch (e) {}
      }
    } catch (e) {}
  }

  function datRenderFoundList(containerEl, entries, currentName, onPick) {
    if (!containerEl) return;
    try {
      const list = Array.isArray(entries) ? entries : [];
      const current = String(currentName || '').trim().toLowerCase();

      containerEl.innerHTML = '';

      if (!list.length) {
        const e = document.createElement('div');
        e.className = 'routing-dat-found-empty';
        e.textContent = '— нет .dat';
        containerEl.appendChild(e);
        return;
      }

      const frag = document.createDocumentFragment();
      list.forEach((it) => {
        const name = String((it && it.name) || '');
        if (!name) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'routing-dat-found-item' + (name.toLowerCase() === current ? ' is-current' : '');
        btn.dataset.name = name;

        const n = document.createElement('span');
        n.className = 'routing-dat-found-name';
        n.textContent = name;

        const meta = document.createElement('span');
        meta.className = 'routing-dat-found-meta';
        const sz = (it && it.size !== undefined && it.size !== null) ? fmtSize(it.size) : '';
        const mt = (it && it.mtime) ? fmtTime(it.mtime) : '';
        meta.textContent = (sz ? sz : '') + (mt ? (' • ' + mt) : '');

        btn.appendChild(n);
        btn.appendChild(meta);

        if (typeof onPick === 'function') {
          btn.addEventListener('click', () => {
            try { onPick(name); } catch (e) {}
          });
        }

        frag.appendChild(btn);
      });

      containerEl.appendChild(frag);
    } catch (e) {
      try { containerEl.textContent = '—'; } catch (err) {}
    }
  }

  async function datListEntriesForDir(dir, kind) {
    const d = String(dir || '').trim().replace(/\/+$/g, '');
    if (!d) return [];
    const data = await fsListLocalDir(d);
    if (!data) return [];
    const items = Array.isArray(data.items) ? data.items : [];
    const out = [];
    items.forEach((it) => {
      const name = it && it.name ? String(it.name) : '';
      const t = it && it.type ? String(it.type) : '';
      if (!name) return;
      // allow file or link (symlink) for DAT
      if (t !== 'file' && t !== 'link') return;
      if (!datKindMatch(kind, name)) return;
      out.push({
        name: name,
        size: it.size,
        mtime: it.mtime,
        type: t,
      });
    });
    out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }

  async function datResolveKindPrefs(kind, prefs, els) {
    const k = String(kind || '').toLowerCase();
    const p = prefs && prefs[k] ? prefs[k] : null;
    if (!p) return { dir: '', name: '', candidates: [], entries: [] };

    // Directory: migrate old default (/opt/etc/xray) -> new (/opt/etc/xray/dat).
    let dir = String(p.dir || '').trim();
    if (!dir) dir = DAT_DEFAULTS[k].dir;
    if (dir === '/opt/etc/xray') dir = DAT_DEFAULTS[k].dir;

    let entries = await datListEntriesForDir(dir, k);
    let candidates = entries.map((e) => String((e && e.name) || '')).filter(Boolean);

    // If user still points to /opt/etc/xray (or any /.../xray), try /.../xray/dat automatically.
    if ((!candidates || !candidates.length) && /\/xray\/?$/.test(dir) && !/\/xray\/dat$/.test(dir)) {
      const alt = dir.replace(/\/+$/g, '') + '/dat';
      const altEntries = await datListEntriesForDir(alt, k);
      const altCand = altEntries.map((e) => String((e && e.name) || '')).filter(Boolean);
      if (altCand && altCand.length) {
        dir = alt;
        entries = altEntries;
        candidates = altCand;
      }
    }

    // Update datalist (suggestions) if present.
    if (els && els.list) datSetDatalist(els.list, candidates);

    // Filename: keep user's choice, but auto-pick when it's the stock default and the file isn't present.
    let name = String(p.name || '').trim();
    if (!name) name = DAT_DEFAULTS[k].name;

    const lower = candidates.map((x) => String(x || '').toLowerCase());
    const idx = lower.indexOf(String(name).toLowerCase());
    if (idx >= 0) {
      name = candidates[idx]; // preserve real case
    } else {
      const isDefaultName = String(name).toLowerCase() === String(DAT_DEFAULTS[k].name).toLowerCase();
      if (isDefaultName && candidates && candidates.length) {
        const chosen = datChooseBest(k, candidates);
        if (chosen) name = chosen;
      }
    }

    // Apply to inputs + prefs (so all buttons/modals use the resolved file).
    try {
      if (els && els.dir && String(els.dir.value || '') !== String(dir || '')) els.dir.value = dir;
      if (els && els.name && String(els.name.value || '') !== String(name || '')) els.name.value = name;
    } catch (e) {}

    try {
      p.dir = dir;
      p.name = name;
    } catch (e) {}

    // One control: store detected entries for combo and render popover list.
    try { if (DAT_COMBO && DAT_COMBO[k]) DAT_COMBO[k].entries = Array.isArray(entries) ? entries : []; } catch (e) {}
    try {
      if (els && els.found) {
        datRenderFoundList(els.found, entries, name, (picked) => {
          try {
            if (els && els.name) {
              els.name.value = String(picked || '');
              // trigger save (wireDatInputs listens to input/change)
              els.name.dispatchEvent(new Event('input', { bubbles: true }));
              els.name.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } catch (e) {}
          try {
            const root = datGetComboRoot(els && els.name);
            datSetComboOpen(k, root, false);
          } catch (e) {}
          try { refreshDatMeta(); } catch (e) {}
        });
      }
      // If popover is currently open, re-render to keep filtering in sync.
      try { if (DAT_COMBO && DAT_COMBO[k] && DAT_COMBO[k].open) datRenderCombo(k, { name: els && els.name, found: els && els.found, refreshLater: null }); } catch (e) {}
    } catch (e) {}

    return { dir, name, candidates, entries };
  }


  async function getGeodatStatus() {
    try {
      const resp = await fetch('/api/routing/geodat/status', { method: 'GET' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return { ok: false };
      return data;
    } catch (e) {
      return { ok: false };
    }
  }

  async function installGeodat(opts) {
    const o = opts || {};
    const mode = o.mode || 'release'; // release | url | file
    const url = (o.url ? String(o.url) : '').trim();
    const file = o.file || null;

    let title = 'Установка xk-geodat';
    let message = 'Установить/обновить xk-geodat? Это включит просмотр содержимого DAT (GeoIP/GeoSite) и кнопку «В правило».';
    if (mode === 'url' && url) {
      message = 'Скачать и установить xk-geodat по URL?\n\n' + url;
    } else if (mode === 'file' && file && file.name) {
      message = 'Установить xk-geodat из файла?\n\n' + String(file.name);
    }

    const ok = await confirmModal({
      title,
      message,
      okText: 'Установить',
      cancelText: 'Отмена',
      danger: false,
    });
    if (!ok) return { ok: false, cancelled: true };

    const btnMain = $(IDS.datGeodatInstall);
    const btnFile = $(IDS.datGeodatInstallFileBtn);
    try { if (btnMain) btnMain.disabled = true; } catch (e) {}
    try { if (btnFile) btnFile.disabled = true; } catch (e) {}

    try {
      if (XK && XK.ui && typeof XK.ui.showGlobalXkeenSpinner === 'function') {
        XK.ui.showGlobalXkeenSpinner('Установка xk-geodat…');
      }

      let resp = null;
      if (mode === 'file' && file) {
        const fd = new FormData();
        fd.append('file', file);
        resp = await fetch('/api/routing/geodat/install', { method: 'POST', body: fd });
      } else {
        const body = {};
        if (mode === 'url' && url) body.url = url;
        resp = await fetch('/api/routing/geodat/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }

      const data = await (resp ? resp.json().catch(() => ({})) : Promise.resolve({}));
      if (!resp || !resp.ok || !data || data.ok === false) {
        const msg = (data && (data.hint || data.error || data.message)) || (resp ? ('install_failed_' + resp.status) : 'install_failed');
        throw new Error(String(msg));
      }

      const installed = !!data.installed;
      if (installed) toast('xk-geodat установлен.', false);
      else toast('xk-geodat: установка не выполнена. ' + (data.hint || data.error || ''), true);

      try { await refreshDatMeta(); } catch (e) {}
      return data;
    } catch (e) {
      toast('xk-geodat: ошибка установки: ' + String(e && e.message ? e.message : e), true);
      return { ok: false, error: String(e && e.message ? e.message : e) };
    } finally {
      try {
        if (XK && XK.ui && typeof XK.ui.hideGlobalXkeenSpinner === 'function') {
          XK.ui.hideGlobalXkeenSpinner();
        }
      } catch (e) {}
      try { if (btnMain) btnMain.disabled = false; } catch (e) {}
      try { if (btnFile) btnFile.disabled = false; } catch (e) {}
    }
  }

  async function refreshDatMeta() {
    const status = $(IDS.datStatus);
    const metaSite = $(IDS.datGeositeMeta);
    const metaIp = $(IDS.datGeoipMeta);
    if (status) status.textContent = 'Загрузка…';

    const prefs = loadDatPrefs();

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

    // Resolve legacy defaults and auto-detect existing DAT names like geosite_v2fly.dat / geoip_v2fly.dat.
    let rSite = null;
    let rIp = null;
    try { rSite = await datResolveKindPrefs('geosite', prefs, els.geosite); } catch (e) { rSite = null; }
    try { rIp = await datResolveKindPrefs('geoip', prefs, els.geoip); } catch (e) { rIp = null; }

    // Persist any auto-resolve changes (so "Содержимое" / "В правило" works immediately).
    try { saveDatPrefs(prefs); } catch (e) {}

    const pSite = normalizePath((rSite && rSite.dir) ? rSite.dir : prefs.geosite.dir, (rSite && rSite.name) ? rSite.name : prefs.geosite.name);
    const pIp = normalizePath((rIp && rIp.dir) ? rIp.dir : prefs.geoip.dir, (rIp && rIp.name) ? rIp.name : prefs.geoip.name);

    try {
      const data = await datStatBatch([pSite, pIp]);
      const items = Array.isArray(data.items) ? data.items : [];
      const map = {};
      items.forEach((it) => {
        if (it && it.path) map[it.path] = it;
      });

      function renderMeta(path, el, candidates) {
        if (!el) return;
        const it = map[path];        // /api/fs/stat-batch returns { exists: boolean, ... } (no `ok` per item).
        // If the file doesn't exist (or we can't stat it), show a clear "нет файла" + hint about other DAT files.
        if (!it || it.exists === false) {
          const err = it && it.error ? String(it.error) : '';
          const base = (err === 'forbidden') ? 'нет доступа' : 'нет файла';
          const cands = Array.isArray(candidates) ? candidates : [];
          if (cands.length && base === 'нет файла') {
            el.textContent = base + ' • есть: ' + datFormatCandidates(cands, 3);
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
      // Also show xk-geodat status (installed / missing)
      let gs = null;
      try { gs = await getGeodatStatus(); } catch (e) { gs = null; }
      if (status) {
        const installed = !!(gs && (gs.installed === true || gs.ok === true && gs.installed));
        status.textContent = installed ? 'OK • xk-geodat: ✓' : 'OK • xk-geodat: ✕';
        status.setAttribute('data-tooltip', installed
          ? 'xk-geodat установлен (просмотр содержимого DAT доступен)'
          : 'xk-geodat не установлен (нажмите «xk-geodat» для установки)');
      }
    } catch (e) {
      if (status) status.textContent = 'Ошибка';
      toast('DAT: не удалось получить статусы: ' + String(e && e.message ? e.message : e), true);
    }
  }

  async function uploadDat(kind) {
    const prefs = loadDatPrefs();
    const p = prefs[kind];
    const path = normalizePath(p.dir, p.name);

    const inputId = kind === 'geosite' ? IDS.datGeositeFile : IDS.datGeoipFile;
    const fi = $(inputId);
    if (!fi) return;

    fi.value = '';
    fi.onchange = async () => {
      const file = fi.files && fi.files[0];
      if (!file) return;

      const ok = await confirmModal({
        title: 'Upload DAT',
        message: `Загрузить файл ${file.name} в ${path}?`,
        okText: 'Загрузить',
        cancelText: 'Отмена',
      });
      if (!ok) return;

      const doUpload = async (overwrite) => {
        const fd = new FormData();
        fd.append('file', file);
        const url = '/api/fs/upload?target=local&path=' + encodeURIComponent(path) + (overwrite ? '&overwrite=1' : '');
        const resp = await fetch(url, { method: 'POST', body: fd });
        const data = await resp.json().catch(() => ({}));
        return { resp, data };
      };

      try {
        let r = await doUpload(false);
        if (r.resp.status === 409) {
          const ow = await confirmModal({
            title: 'Файл уже существует',
            message: `Файл ${path} уже существует. Перезаписать?`,
            okText: 'Перезаписать',
            cancelText: 'Отмена',
            danger: true,
          });
          if (!ow) return;
          r = await doUpload(true);
        }
        if (!r.resp.ok || r.data.ok === false) {
          throw new Error((r.data && (r.data.error || r.data.message)) || ('upload_failed_' + r.resp.status));
        }
        toast('DAT загружен: ' + path, false);
        refreshDatMeta();
      } catch (e) {
        toast('Upload failed: ' + String(e && e.message ? e.message : e), true);
      }
    };

    fi.click();
  }

  async function downloadDat(kind) {
    const prefs = loadDatPrefs();
    const p = prefs[kind];
    const path = normalizePath(p.dir, p.name);

    try {
      const url = '/api/fs/download?target=local&path=' + encodeURIComponent(path);
      window.open(url, '_blank');
    } catch (e) {
      toast('Download failed: ' + String(e && e.message ? e.message : e), true);
    }
  }

  async function updateDatByUrl(kind) {
    const prefs = loadDatPrefs();
    const p = prefs[kind];
    const path = normalizePath(p.dir, p.name);
    const url = String(p.url || '').trim();

    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
      toast('Укажите корректный URL (http/https)', true);
      return;
    }

    const ok = await confirmModal({
      title: 'Update DAT by URL',
      message: `Скачать ${kind} из URL и заменить файл?\n\n${url}\n→ ${path}`,
      okText: 'Обновить',
      cancelText: 'Отмена',
      danger: true,
    });
    if (!ok) return;

    try {
      const resp = await fetch('/api/routing/dat/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, url, path }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) {
        const msg = (data && (data.error || data.message)) || ('update_failed_' + resp.status);
        throw new Error(msg);
      }
      toast('DAT обновлён: ' + path, false);
      refreshDatMeta();
    } catch (e) {
      toast('Update failed: ' + String(e && e.message ? e.message : e), true);
    }
  }

  function initDatCard() {
    if (!$(IDS.datHeader) || !$(IDS.datBody)) return;
    wireDatInputs();
    // DAT card: collapsed by default (sidebar), with a versioned key.
    wireCollapse(IDS.datHeader, IDS.datBody, IDS.datArrow, 'xk.routing.dat.open.v3', refreshDatMeta, false);

    const refreshBtn = $(IDS.datRefresh);
    if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.preventDefault(); refreshDatMeta(); });

    const installBtn = $(IDS.datGeodatInstall);
    if (installBtn) installBtn.addEventListener('click', (e) => { e.preventDefault(); installGeodat({ mode: 'release' }); });

    const installFileBtn = $(IDS.datGeodatInstallFileBtn);
    const installFileInput = $(IDS.datGeodatInstallFile);
    if (installFileBtn && installFileInput) {
      installFileBtn.addEventListener('click', (e) => {
        e.preventDefault();
        try { installFileInput.value = ''; } catch (err) {}
        installFileInput.click();
      });
      installFileInput.addEventListener('change', (e) => {
        const f = installFileInput.files && installFileInput.files[0];
        if (f) installGeodat({ mode: 'file', file: f });
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
    const b9 = $(IDS.datGeositeInRouting);
    const b10 = $(IDS.datGeoipInRouting);

    if (b1) b1.addEventListener('click', (e) => { e.preventDefault(); uploadDat('geosite'); });
    if (b2) b2.addEventListener('click', (e) => { e.preventDefault(); uploadDat('geoip'); });
    if (b3) b3.addEventListener('click', (e) => { e.preventDefault(); downloadDat('geosite'); });
    if (b4) b4.addEventListener('click', (e) => { e.preventDefault(); downloadDat('geoip'); });
    if (b5) b5.addEventListener('click', (e) => { e.preventDefault(); updateDatByUrl('geosite'); });
    if (b6) b6.addEventListener('click', (e) => { e.preventDefault(); updateDatByUrl('geoip'); });

    // Content viewer modal (tags + items + copy geosite:TAG / geoip:TAG)
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

    // PR3: "➕ В правило" opens the same modal but focuses the routing picker.
    if (b9) b9.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.open === 'function') {
          XKeen.ui.datContents.open('geosite', { intent: 'inrouting' });
        } else {
          toast('DAT: модуль просмотра содержимого не загружен.', true);
        }
      } catch (err) {
        toast('DAT: не удалось открыть содержимое.', true);
      }
    });
    if (b10) b10.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        if (window.XKeen && XKeen.ui && XKeen.ui.datContents && typeof XKeen.ui.datContents.open === 'function') {
          XKeen.ui.datContents.open('geoip', { intent: 'inrouting' });
        } else {
          toast('DAT: модуль просмотра содержимого не загружен.', true);
        }
      } catch (err) {
        toast('DAT: не удалось открыть содержимое.', true);
      }
    });

    // Initial meta load (defer a bit until fs feature is ready)
    setTimeout(() => {
      try { refreshDatMeta(); } catch (e) {}
    }, 400);
  }

  // Sidebar-only collapses (these cards do not have their own feature modules)
  function initSidebarCards() {
    // Backups card
    try {
      wireCollapse(IDS.backupsHeader, IDS.backupsBody, IDS.backupsArrow, 'xk.routing.backups.open.v1', null, false);
    } catch (e) {}

    // Help/links card
    try {
      wireCollapse(IDS.helpHeader, IDS.helpBody, IDS.helpArrow, 'xk.routing.help.open.v1', null, false);
    } catch (e) {}
  }

  // ===================== RULES CARD =====================

  let _model = null;
  let _root = null;
  let _rootHasKey = true;
  let _dirty = false;
  let _filter = '';
  // Tracks expanded rule bodies. Stores rule object references (stable across reorder).
  const _openSet = new Set();
  // Tracks expanded balancer bodies. Stores balancer object references.
  const _balOpenSet = new Set();

  // Drag & drop reorder state (enabled only when filter is empty).
  let _dragRuleIdx = null;
  let _dropInsertIdx = null;
  let _placeholderEl = null;

  // Pointer-based drag state (no native HTML5 DnD). Smoother and avoids flicker/snapback.
  let _pDndActive = false;
  let _pDndStarted = false;
  let _pDndPointerId = null;
  let _pDndFromIdx = null;
  let _pDndCardEl = null;
  let _pDndGhostEl = null;
  let _pDndBaseLeft = 0;
  let _pDndBaseTop = 0;
  let _pDndShiftX = 0;
  let _pDndShiftY = 0;
  let _pDndStartX = 0;
  let _pDndStartY = 0;

  const JSON_MODAL_ID = 'xkeen-routing-json-modal';
  let _jsonCtx = null; // { kind: 'rule'|'balancer', idx: number, isNew: boolean }

  function ensureJsonModal() {
    let modal = document.getElementById(JSON_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = JSON_MODAL_ID;
    modal.className = 'modal hidden routing-json-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '860px';

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('span');
    title.className = 'modal-title';
    title.id = JSON_MODAL_ID + '-title';
    title.textContent = 'Редактор JSON';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body routing-json-body';

    const textarea = document.createElement('textarea');
    textarea.id = JSON_MODAL_ID + '-text';
    textarea.className = 'routing-json-textarea';
    textarea.spellcheck = false;

    const status = document.createElement('div');
    status.id = JSON_MODAL_ID + '-status';
    status.className = 'status routing-json-status';

    body.appendChild(textarea);
    body.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.style.justifyContent = 'space-between';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Отмена';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Сохранить';

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(actions);
    modal.appendChild(content);

    function close() { closeJsonModal(); }
    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', (e) => { e.preventDefault(); saveJsonModal(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.body.appendChild(modal);
    return modal;
  }

  function setJsonModalStatus(message, isError) {
    const el = document.getElementById(JSON_MODAL_ID + '-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.style.color = isError ? '#fca5a5' : '';
  }

  function openJsonModal(obj, titleText, ctx) {
    const modal = ensureJsonModal();
    _jsonCtx = ctx || null;

    const title = document.getElementById(JSON_MODAL_ID + '-title');
    const ta = document.getElementById(JSON_MODAL_ID + '-text');
    if (title) title.textContent = String(titleText || 'Редактор JSON');
    if (ta) {
      try { ta.value = JSON.stringify(obj || {}, null, 2); } catch (e) { ta.value = String(obj || ''); }
      ta.scrollTop = 0;
    }
    setJsonModalStatus('', false);
    modal.classList.remove('hidden');

    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}

    if (ta) setTimeout(() => { try { ta.focus(); } catch (e) {} }, 0);
  }

  function closeJsonModal() {
    const modal = document.getElementById(JSON_MODAL_ID);
    if (!modal) return;
    modal.classList.add('hidden');
    _jsonCtx = null;
    setJsonModalStatus('', false);

    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function ensureModel() {
    if (!_model) {
      _model = { domainStrategy: '', rules: [], balancers: [] };
    }
    if (!_model.rules) _model.rules = [];
    if (!_model.balancers) _model.balancers = [];
    return _model;
  }

  function markDirty(v) {
    _dirty = !!v;
    const btn = $(IDS.rulesApply);
    if (btn) {
      // In compact UI we keep icon-only apply button and show "dirty" via styling + tooltip.
      if (btn.classList && btn.classList.contains('btn-icon')) {
        btn.classList.toggle('is-dirty', _dirty);
        btn.setAttribute('data-tooltip', _dirty
          ? 'Применить изменения в JSON-редактор (есть несохранённые изменения)'
          : 'Применить изменения в JSON-редактор');
        btn.setAttribute('aria-label', _dirty
          ? 'Применить в JSON (есть изменения)'
          : 'Применить в JSON');
      } else {
        btn.textContent = _dirty ? '💾 Применить в JSON *' : '💾 Применить в JSON';
      }
    }
  }

  function extractRoutingFromRoot(root) {
    if (!root || typeof root !== 'object' || Array.isArray(root)) {
      return { root: root || {}, routing: {}, hasKey: true };
    }
    if (root.routing && typeof root.routing === 'object' && !Array.isArray(root.routing)) {
      return { root, routing: root.routing, hasKey: true };
    }
    // Some fragments may be routing-only
    return { root, routing: root, hasKey: false };
  }

  function loadModelFromEditor() {
    const raw = getEditorText();
    const parsed = safeJsonParse(raw);
    if (parsed && parsed.__error) {
      return { ok: false, error: parsed.__error };
    }

    const { root, routing, hasKey } = extractRoutingFromRoot(parsed);
    _root = root;
    _rootHasKey = hasKey;

    const model = {
      domainStrategy: String(routing.domainStrategy || ''),
      rules: Array.isArray(routing.rules) ? routing.rules.slice() : [],
      balancers: Array.isArray(routing.balancers) ? routing.balancers.slice() : [],
    };
    _model = model;
    try { _openSet.clear(); } catch (e) {}
    _dragRuleIdx = null;
    _dropInsertIdx = null;
    if (_placeholderEl && _placeholderEl.parentNode) { try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {} }
    _placeholderEl = null;
    markDirty(false);
    return { ok: true, model };
  }

  function buildRootFromModel() {
    const m = ensureModel();
    const routing = {
      ...(_rootHasKey ? (_root && _root.routing ? _root.routing : {}) : (_root || {})),
      domainStrategy: m.domainStrategy || undefined,
      rules: m.rules || [],
      balancers: m.balancers || [],
    };

    // Clean undefined keys
    Object.keys(routing).forEach((k) => {
      if (routing[k] === undefined) delete routing[k];
    });

    let out;
    if (_rootHasKey) {
      out = { ...(_root || {}) };
      out.routing = routing;
    } else {
      out = routing;
    }
    return out;
  }

  function applyModelToEditor() {
    const out = buildRootFromModel();
    const text = JSON.stringify(out, null, 2) + '\n';
    setEditorText(text);
    markDirty(false);

    // Best-effort validate/update UI in routing.js
    try {
      if (XK.routing && typeof XK.routing.validate === 'function') {
        XK.routing.validate();
      }
    } catch (e) {}
  }

  function anyGeo(rule) {
    if (!rule || typeof rule !== 'object') return false;
    const keys = Object.keys(rule);
    for (const k of keys) {
      const v = rule[k];
      if (typeof v === 'string') {
        if (v.includes('geoip:') || v.includes('geosite:')) return true;
      } else if (Array.isArray(v)) {
        for (const it of v) {
          if (typeof it === 'string' && (it.includes('geoip:') || it.includes('geosite:'))) return true;
        }
      }
    }
    return false;
  }

  function ruleMatchesFilter(rule, filter) {
    if (!filter) return true;
    const f = filter.toLowerCase();
    try {
      const j = JSON.stringify(rule || {}).toLowerCase();
      return j.includes(f);
    } catch (e) {
      return true;
    }
  }

  // Compact header/match summary for a rule card.
  // Legacy UI showed "#N → <target>" in the title and rendered type + ruleTag as badges.
  function summarizeRule(rule) {
    if (!rule || typeof rule !== 'object') return { title: '(invalid)', badges: [], geo: false };
    const type = String(rule.type || 'field');
    const target = rule.outboundTag
      ? String(rule.outboundTag)
      : (rule.balancerTag ? String(rule.balancerTag) : '—');
    const ruleTag = rule.ruleTag ? String(rule.ruleTag) : '';

    // Try to build a short match summary
    const parts = [];
    const pushArr = (k) => {
      const v = rule[k];
      if (Array.isArray(v) && v.length) parts.push(`${k}:${v.slice(0, 2).join(',')}${v.length > 2 ? '…' : ''}`);
      else if (typeof v === 'string' && v) parts.push(`${k}:${v}`);
    };

    ['inboundTag', 'domain', 'ip', 'port', 'network', 'protocol', 'source', 'sourcePort', 'sourceIP', 'user'].forEach(pushArr);

    const match = parts.length ? parts.join(' • ') : 'без условий';
    return {
      // Leading spaces keep the legacy "#N → target" look (idxSpan is a separate node).
      title: ` → ${target}`,
      match,
      badges: [type, ruleTag || 'без тега'],
      type,
      target,
      ruleTag,
      geo: anyGeo(rule),
    };
  }

  // ===== Legacy "form fields" inside rule cards (ported from older routing.js) =====
  const RULE_MULTI_FIELDS = [
    { key: 'domain', label: 'domain', placeholder: 'example.com, geosite:cn' },
    { key: 'ip', label: 'ip', placeholder: 'geoip:private, 8.8.8.8' },
    { key: 'sourceIP', label: 'sourceIP (source)', placeholder: '10.0.0.1, geoip:private' },
    { key: 'localIP', label: 'localIP', placeholder: '192.168.0.25' },
    { key: 'user', label: 'user', placeholder: 'email@user' },
    { key: 'inboundTag', label: 'inboundTag', placeholder: 'in-1' },
    { key: 'protocol', label: 'protocol', placeholder: 'http, tls, quic, bittorrent' },
  ];

  const RULE_TEXT_FIELDS = [
    { key: 'port', label: 'port', placeholder: '53, 80-443' },
    { key: 'sourcePort', label: 'sourcePort', placeholder: '1024-65535' },
    { key: 'localPort', label: 'localPort', placeholder: '10000-20000' },
    { key: 'network', label: 'network', placeholder: 'tcp, udp, tcp,udp' },
    { key: 'vlessRoute', label: 'vlessRoute', placeholder: '1, 14, 1000-2000' },
  ];

  function normalizeListValue(value) {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (value === null || typeof value === 'undefined') return [];
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    try { return [JSON.stringify(value)]; } catch (e) { return [String(value)]; }
  }

  function splitMultiValue(raw) {
    return String(raw || '')
      .split(/[\n,]+/)
      .map((v) => v.trim())
      .filter(Boolean);
  }

  function formatMultiValue(values) {
    return (values || []).map((v) => String(v)).join('\n');
  }

  function parseAttrs(raw) {
    const out = {};
    const lines = String(raw || '').split('\n');
    lines.forEach((line) => {
      const s = line.trim();
      if (!s) return;
      const eq = s.indexOf('=');
      let idx = -1;
      if (eq >= 0) idx = eq;
      else idx = s.indexOf(':');
      if (idx < 0) return;
      const key = s.slice(0, idx).trim();
      const val = s.slice(idx + 1).trim();
      if (key) out[key] = val;
    });
    return out;
  }

  function formatAttrs(attrs) {
    if (!attrs || typeof attrs !== 'object') return '';
    return Object.entries(attrs)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  }

  function cleanEmptyValue(val) {
    if (val === null || typeof val === 'undefined') return null;
    if (Array.isArray(val)) {
      const arr = val.map((v) => String(v)).filter(Boolean);
      return arr.length ? arr : null;
    }
    if (typeof val === 'object') {
      const keys = Object.keys(val || {});
      return keys.length ? val : null;
    }
    const s = String(val).trim();
    return s ? s : null;
  }

  function setRuleValue(rule, key, value) {
    const cleaned = cleanEmptyValue(value);
    if (cleaned === null) {
      try { delete rule[key]; } catch (e) {}
      return;
    }
    rule[key] = cleaned;
  }

  function autoResizeTextarea(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    const value = String(ta.value || '');
    const lines = value.split('\n').length;
    let minHeight = 0;
    try {
      const cs = window.getComputedStyle(ta);
      const toPx = (v) => {
        const n = parseFloat(String(v || ''));
        return Number.isFinite(n) ? n : 0;
      };
      let lineHeight = cs.lineHeight;
      if (!lineHeight || lineHeight === 'normal') {
        const fontSize = toPx(cs.fontSize) || 16;
        lineHeight = fontSize * 1.2;
      } else {
        lineHeight = toPx(lineHeight);
      }
      const padding = toPx(cs.paddingTop) + toPx(cs.paddingBottom);
      minHeight = lineHeight + padding;

      // Respect CSS min-height when it is explicitly set on a textarea.
      // (Used for fields that should stay comfortably tall, like balancer.selector.)
      const cssMin = toPx(cs.minHeight);
      if (cssMin && cssMin > minHeight) minHeight = cssMin;
    } catch (e) {
      minHeight = 42;
    }
    const targetHeight = lines <= 1 ? minHeight : ta.scrollHeight;
    ta.style.height = Math.max(targetHeight, minHeight) + 'px';
  }

  function createRuleTextarea(value, placeholder, onChange) {
    const ta = document.createElement('textarea');
    ta.className = 'routing-rule-textarea';
    ta.rows = 2;
    ta.spellcheck = false;
    if (placeholder) ta.placeholder = placeholder;
    ta.value = value || '';
    ta.addEventListener('input', () => {
      autoResizeTextarea(ta);
      onChange(ta.value);
    });
    requestAnimationFrame(() => autoResizeTextarea(ta));
    return ta;
  }

  function createRuleInput(value, placeholder, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'routing-rule-input';
    if (placeholder) input.placeholder = placeholder;
    input.value = value || '';
    input.addEventListener('input', () => onChange(input.value));
    return input;
  }

  // -------- field help modal --------
  let _routingHelpWired = false;

  function ensureFieldHelpModal() {
      let modal = document.getElementById(FIELD_HELP_MODAL_ID);
      if (modal) return modal;

      modal = document.createElement('div');
      modal.id = FIELD_HELP_MODAL_ID;
      modal.className = 'modal hidden';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', 'Routing field help');

      const content = document.createElement('div');
      content.className = 'modal-content';
      content.style.maxWidth = '720px';

      const header = document.createElement('div');
      header.className = 'modal-header';

      const title = document.createElement('span');
      title.className = 'modal-title';
      title.id = FIELD_HELP_TITLE_ID;
      title.textContent = 'Описание параметра';

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'modal-close';
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.textContent = '×';

      header.appendChild(title);
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'modal-body routing-help-body';
      body.id = FIELD_HELP_BODY_ID;

      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      actions.style.justifyContent = 'flex-end';

      const okBtn = document.createElement('button');
      okBtn.type = 'button';
      okBtn.className = 'btn-secondary';
      okBtn.textContent = 'Закрыть';

      actions.appendChild(okBtn);

      content.appendChild(header);
      content.appendChild(body);
      content.appendChild(actions);
      modal.appendChild(content);

      function close() { closeFieldHelp(); }
      closeBtn.addEventListener('click', close);
      okBtn.addEventListener('click', close);
      // Close only via modal buttons.

      document.body.appendChild(modal);
      return modal;
    }

    function renderFieldHelp(doc) {
      const body = document.getElementById(FIELD_HELP_BODY_ID);
      if (!body) return;
      body.innerHTML = '';

      if (!doc) {
        const p = document.createElement('p');
        p.textContent = 'Описание не найдено.';
        body.appendChild(p);
        return;
      }

      if (doc.desc) {
        const p = document.createElement('p');
        p.textContent = doc.desc;
        body.appendChild(p);
      }

      if (Array.isArray(doc.items) && doc.items.length) {
        const ul = document.createElement('ul');
        doc.items.forEach((item) => {
          const li = document.createElement('li');
          li.textContent = item;
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }

      if (doc.note) {
        const p = document.createElement('p');
        p.className = 'routing-help-note';
        p.textContent = doc.note;
        body.appendChild(p);
      }
    }

    function openFieldHelp(docKey) {
      const key = String(docKey || '').trim();
      const doc = key ? ROUTING_FIELD_DOCS[key] : null;
      const modal = ensureFieldHelpModal();
      const titleEl = document.getElementById(FIELD_HELP_TITLE_ID);
      if (titleEl) titleEl.textContent = doc ? ('Параметр: ' + doc.title) : 'Описание параметра';
      renderFieldHelp(doc);
      modal.classList.remove('hidden');
      try { document.body.classList.add('modal-open'); } catch (e) {}
    }

    function closeFieldHelp() {
      const modal = document.getElementById(FIELD_HELP_MODAL_ID);
      if (!modal) return;
      modal.classList.add('hidden');
      try { document.body.classList.remove('modal-open'); } catch (e) {}
    }

  function wireRoutingHelpButtons() {
      if (_routingHelpWired) return;
      document.addEventListener('click', (e) => {
        const btn = e.target && e.target.classList && e.target.classList.contains('routing-help-btn') ? e.target : null;
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset ? btn.dataset.doc : '';
        openFieldHelp(key);
      }, true);
      document.addEventListener('keydown', (e) => {
        const btn = e.target && e.target.classList && e.target.classList.contains('routing-help-btn') ? e.target : null;
        if (!btn) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        const key = btn.dataset ? btn.dataset.doc : '';
        openFieldHelp(key);
      }, true);
      _routingHelpWired = true;
    }

  function buildKeyLabel(labelText, docKey, className) {
    const wrap = document.createElement('span');
    wrap.className = className || 'routing-rule-key';
    const text = document.createElement('span');
    text.textContent = labelText;
    wrap.appendChild(text);
    if (docKey) {
      const btn = document.createElement('span');
      btn.className = 'routing-help-btn';
      btn.dataset.doc = docKey;
      btn.setAttribute('role', 'button');
      btn.setAttribute('tabindex', '0');
      btn.setAttribute('aria-label', 'Описание: ' + labelText);
      btn.title = 'Описание: ' + labelText;
      btn.textContent = '?';
      wrap.appendChild(btn);
    }
    return wrap;
  }

  function buildField(labelText, inputEl, docKey) {
    const label = document.createElement('label');
    label.className = 'routing-rule-field';
    label.appendChild(buildKeyLabel(labelText, docKey));
    label.appendChild(inputEl);
    return label;
  }

  function updateJsonPreview(pre, rule) {
    if (!pre) return;
    try {
      const json = JSON.stringify(rule || {}, null, 2);
      pre.textContent = json.length > 1800 ? (json.slice(0, 1800) + '\n…') : json;
    } catch (e) {
      pre.textContent = String(rule || '');
    }
  }

  function updateRuleHeadDom(rule, refs) {
    if (!refs) return;
    const sum = summarizeRule(rule);
    try {
      if (refs.titleEl) refs.titleEl.textContent = sum.title;
      if (refs.typeBadge) refs.typeBadge.textContent = String(rule && rule.type ? rule.type : 'field');
      // Legacy header badge shows ruleTag (or "без тега") rather than the target.
      if (refs.ruleTagBadge) refs.ruleTagBadge.textContent = (rule && rule.ruleTag) ? String(rule.ruleTag) : 'без тега';
      if (refs.matchEl) refs.matchEl.textContent = sum.match;
      if (refs.geoBadgeEl) refs.geoBadgeEl.style.display = sum.geo ? '' : 'none';
    } catch (e) {}
  }

  function ensureRuleTypeDatalist() {
    try {
      if (document.getElementById('routing-rule-types')) return;
      const dl = document.createElement('datalist');
      dl.id = 'routing-rule-types';
      ['field', 'chinaip', 'chinasites', 'geoip', 'geosite'].forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v;
        dl.appendChild(opt);
      });
      document.body.appendChild(dl);
    } catch (e) {}
  }

  function getRuleExtraObject(rule) {
    const extra = {};
    if (!rule || typeof rule !== 'object') return extra;

    const known = new Set([
      'type',
      'ruleTag',
      'outboundTag',
      'balancerTag',
      'attrs',
    ]);
    RULE_MULTI_FIELDS.forEach((f) => known.add(f.key));
    RULE_TEXT_FIELDS.forEach((f) => known.add(f.key));
    // legacy alias
    known.add('source');

    Object.keys(rule).forEach((k) => {
      // Internal drafts/metadata should never be surfaced as "extra".
      if (String(k).startsWith('__xk')) return;
      if (!known.has(k)) extra[k] = rule[k];
    });
    return extra;
  }

  function getBalancerExtraObject(bal) {
    const extra = {};
    if (!bal || typeof bal !== 'object') return extra;
    const known = new Set(['tag', 'fallbackTag', 'selector', 'strategy', '__xkStrategyDraft', '__xkExtraDraft']);
    Object.keys(bal).forEach((k) => {
      if (String(k).startsWith('__xk')) return;
      if (!known.has(k)) extra[k] = bal[k];
    });
    return extra;
  }


  function getExistingBalancerTags() {
    try {
      const m = ensureModel();
      const out = [];
      const seen = new Set();
      (Array.isArray(m && m.balancers) ? m.balancers : []).forEach((b) => {
        const t = (b && b.tag != null) ? String(b.tag).trim() : '';
        if (!t) return;
        if (seen.has(t)) return;
        seen.add(t);
        out.push(t);
      });
      try { out.sort((a, b) => a.localeCompare(b)); } catch (e) {}
      return out;
    } catch (e) {
      return [];
    }
  }


  function buildRuleForm(rule, idx, onChanged) {
    const form = document.createElement('div');
    form.className = 'routing-rule-form';

    // type
    ensureRuleTypeDatalist();
    const typeInput = createRuleInput(String(rule && rule.type ? rule.type : 'field'), 'field', (val) => {
      setRuleValue(rule, 'type', (val || '').trim());
      if (typeof onChanged === 'function') onChanged();
    });
    try { typeInput.setAttribute('list', 'routing-rule-types'); } catch (e) {}
    form.appendChild(buildField('type', typeInput, null));

    // ruleTag
    const ruleTagInput = createRuleInput(String(rule && rule.ruleTag ? rule.ruleTag : ''), 'media', (val) => {
      setRuleValue(rule, 'ruleTag', val);
      if (typeof onChanged === 'function') onChanged();
    });
    form.appendChild(buildField('ruleTag', ruleTagInput, 'ruleTag'));

    // outbound/balancer target
    const targetWrap = document.createElement('div');
    targetWrap.className = 'routing-rule-target';
    const targetName = 'routing-target-' + String(idx);

    const outboundRow = document.createElement('div');
    outboundRow.className = 'routing-rule-target-row';
    const outboundRadio = document.createElement('input');
    outboundRadio.type = 'radio';
    outboundRadio.name = targetName;
    outboundRadio.value = 'outbound';
    const outboundLabel = buildKeyLabel('outboundTag', 'outboundTag', 'routing-rule-target-label');
    const outboundInput = createRuleInput(String(rule && rule.outboundTag ? rule.outboundTag : ''), 'direct', (val) => {
      if (val) {
        outboundRadio.checked = true;
        setRuleValue(rule, 'outboundTag', val);
        try { delete rule.balancerTag; } catch (e) {}
      } else {
        setRuleValue(rule, 'outboundTag', '');
      }
      if (typeof onChanged === 'function') onChanged();
    });
    outboundRow.appendChild(outboundRadio);
    outboundRow.appendChild(outboundLabel);
    outboundRow.appendChild(outboundInput);

    const balancerRow = document.createElement('div');
    balancerRow.className = 'routing-rule-target-row';
    const balancerRadio = document.createElement('input');
    balancerRadio.type = 'radio';
    balancerRadio.name = targetName;
    balancerRadio.value = 'balancer';
    const balancerLabel = buildKeyLabel('balancerTag', 'balancerTag', 'routing-rule-target-label');

    // Prefer selecting from existing balancers (but keep manual input as fallback).
    const balTags = getExistingBalancerTags();
    const initialBal = String(rule && rule.balancerTag ? rule.balancerTag : '').trim();

    const balancerSelect = document.createElement('select');
    balancerSelect.className = 'routing-rule-input routing-rule-select';
    balancerSelect.setAttribute('aria-label', 'balancerTag');
    balancerSelect.setAttribute('data-tooltip', 'Выберите существующий balancer.tag или переключитесь на "Вручную…"');

    function fillBalancerSelectOptions() {
      try { balancerSelect.innerHTML = ''; } catch (e) {}
      const optEmpty = document.createElement('option');
      optEmpty.value = '';
      optEmpty.textContent = '— выбрать —';
      balancerSelect.appendChild(optEmpty);

      (Array.isArray(balTags) ? balTags : []).forEach((t) => {
        const o = document.createElement('option');
        o.value = String(t);
        o.textContent = String(t);
        balancerSelect.appendChild(o);
      });

      const optCustom = document.createElement('option');
      optCustom.value = '__custom__';
      optCustom.textContent = 'Вручную…';
      balancerSelect.appendChild(optCustom);
    }
    fillBalancerSelectOptions();

    if (initialBal && balTags.indexOf(initialBal) >= 0) {
      balancerSelect.value = initialBal;
    } else if (initialBal) {
      balancerSelect.value = '__custom__';
    } else {
      balancerSelect.value = '';
    }

    const balancerInput = createRuleInput(initialBal, 'auto', (val) => {
      const v = String(val || '').trim();
      if (v) {
        balancerRadio.checked = true;
        setRuleValue(rule, 'balancerTag', v);
        try { delete rule.outboundTag; } catch (e) {}
      } else {
        setRuleValue(rule, 'balancerTag', '');
      }

      // sync select with typed value
      try {
        if (!v) balancerSelect.value = '';
        else if (balTags.indexOf(v) >= 0) balancerSelect.value = v;
        else balancerSelect.value = '__custom__';
      } catch (e) {}

      // keep input enabled only for custom mode (or empty)
      requestAnimationFrame(() => {
        try {
          const isOutbound = !!outboundRadio.checked;
          const sel = String(balancerSelect.value || '');
          balancerSelect.disabled = isOutbound;
          balancerInput.disabled = isOutbound || (sel && sel !== '__custom__');
        } catch (e) {}
      });

      if (typeof onChanged === 'function') onChanged();
    });

    function syncBalancerPickDisabled() {
      try {
        const isOutbound = !!outboundRadio.checked;
        const sel = String(balancerSelect.value || '');
        balancerSelect.disabled = isOutbound;
        balancerInput.disabled = isOutbound || (sel && sel !== '__custom__');
      } catch (e) {}
    }

    balancerSelect.addEventListener('change', () => {
      const sel = String(balancerSelect.value || '');
      if (sel === '__custom__') {
        balancerRadio.checked = true;
        // keep current input value
        syncBalancerPickDisabled();
        try { balancerInput.focus(); } catch (e) {}
        return;
      }

      if (!sel) {
        // Clear balancer target
        balancerRadio.checked = true;
        try { balancerInput.value = ''; } catch (e) {}
        setRuleValue(rule, 'balancerTag', '');
      } else {
        // Pick existing balancer tag
        balancerRadio.checked = true;
        try { balancerInput.value = sel; } catch (e) {}
        setRuleValue(rule, 'balancerTag', sel);
        try { delete rule.outboundTag; } catch (e) {}
      }

      syncBalancerPickDisabled();
      if (typeof onChanged === 'function') onChanged();
    });

    const balancerPickWrap = document.createElement('div');
    balancerPickWrap.className = 'routing-rule-target-pick';
    balancerPickWrap.appendChild(balancerSelect);
    balancerPickWrap.appendChild(balancerInput);

    balancerRow.appendChild(balancerRadio);
    balancerRow.appendChild(balancerLabel);
    balancerRow.appendChild(balancerPickWrap);

    const preferBalancer = !!(rule && rule.balancerTag && !rule.outboundTag);
    outboundRadio.checked = !preferBalancer;
    balancerRadio.checked = preferBalancer;
    outboundInput.disabled = preferBalancer;
    // picker (select+input) depends on selected mode + custom vs preset
    try { syncBalancerPickDisabled(); } catch (e) { try { balancerInput.disabled = !preferBalancer; } catch (e2) {} }

    function syncTargetMode() {
      const isOutbound = outboundRadio.checked;
      outboundInput.disabled = !isOutbound;
      // balancerTag picker: select + manual input
      try { syncBalancerPickDisabled(); } catch (e) { try { balancerInput.disabled = isOutbound; } catch (e2) {} }

      if (isOutbound) {
        try { delete rule.balancerTag; } catch (e) {}
      } else {
        try { delete rule.outboundTag; } catch (e) {}
      }
      if (typeof onChanged === 'function') onChanged();
    }

    outboundRadio.addEventListener('change', syncTargetMode);
    balancerRadio.addEventListener('change', syncTargetMode);

    targetWrap.appendChild(outboundRow);
    targetWrap.appendChild(balancerRow);
    form.appendChild(targetWrap);

    // multi fields
    RULE_MULTI_FIELDS.forEach((field) => {
      let values = normalizeListValue(rule ? rule[field.key] : null);
      // compat: old key "source"
      if (field.key === 'sourceIP' && rule && !Object.prototype.hasOwnProperty.call(rule, 'sourceIP') && rule.source != null) {
        values = normalizeListValue(rule.source);
      }
      const ta = createRuleTextarea(formatMultiValue(values), field.placeholder, (raw) => {
        const arr = splitMultiValue(raw);
        if (field.key === 'sourceIP') {
          setRuleValue(rule, 'sourceIP', arr);
          try { delete rule.source; } catch (e) {}
        } else {
          setRuleValue(rule, field.key, arr);
        }
        if (typeof onChanged === 'function') onChanged();
      });
      form.appendChild(buildField(field.label, ta, field.key));
    });

    // text fields
    RULE_TEXT_FIELDS.forEach((field) => {
      const input = createRuleInput(String(rule && rule[field.key] ? rule[field.key] : ''), field.placeholder, (val) => {
        setRuleValue(rule, field.key, val);
        if (typeof onChanged === 'function') onChanged();
      });
      form.appendChild(buildField(field.label, input, field.key));
    });

    // attrs
    const attrsTextarea = createRuleTextarea(formatAttrs(rule && rule.attrs ? rule.attrs : {}), 'key=value', (raw) => {
      const obj = parseAttrs(raw);
      setRuleValue(rule, 'attrs', obj);
      if (typeof onChanged === 'function') onChanged();
    });
    form.appendChild(buildField('attrs', attrsTextarea, 'attrs'));

    // extra (unknown keys) as JSON
    // Keep draft text while user types (even if invalid), so closing/reopening doesn't lose input.
    const initExtraRaw = (rule && typeof rule.__xkExtraDraft === 'string')
      ? rule.__xkExtraDraft
      : (() => {
          try {
            const extraObj = getRuleExtraObject(rule);
            return Object.keys(extraObj).length ? JSON.stringify(extraObj, null, 2) : '';
          } catch (e) { return ''; }
        })();

    const extraTextarea = createRuleTextarea(initExtraRaw, '{\n  \n}', (raw) => {
      rule.__xkExtraDraft = String(raw || '');

      const txt = String(raw || '').trim();
      if (!txt) {
        // remove existing extra keys
        try {
          const old = getRuleExtraObject(rule);
          Object.keys(old).forEach((k) => { try { delete rule[k]; } catch (e) {} });
        } catch (e) {}
        try { delete rule.__xkExtraDraft; } catch (e) {}
        extraTextarea.classList.remove('is-invalid');
        if (typeof onChanged === 'function') onChanged();
        return;
      }

      const parsed = safeJsonParse(txt);
      if (parsed && !parsed.__error && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // wipe old extras then apply new
        try {
          const old = getRuleExtraObject(rule);
          Object.keys(old).forEach((k) => { try { delete rule[k]; } catch (e) {} });
          Object.keys(parsed).forEach((k) => {
            try {
              if (parsed[k] === undefined) return;
              rule[k] = parsed[k];
            } catch (e) {}
          });
        } catch (e) {}
        try { delete rule.__xkExtraDraft; } catch (e) {}
        extraTextarea.classList.remove('is-invalid');
        if (typeof onChanged === 'function') onChanged();
      } else {
        extraTextarea.classList.add('is-invalid');
        // Still mark as dirty to indicate there are unapplied changes.
        markDirty(true);
      }
    });

    form.appendChild(buildField('extra (JSON)', extraTextarea, null));

    // Ensure textareas fit content after mount.
    requestAnimationFrame(() => {
      try {
        form.querySelectorAll('.routing-rule-textarea').forEach((ta) => autoResizeTextarea(ta));
      } catch (e) {}
    });

    return form;
  }

  
  // -------- Balancer selector UI (outbound tags + chips) --------
  const _balSelectorMode = new WeakMap(); // balancer object -> 'ui' | 'raw'
  const _outboundTagsCache = { ts: 0, tags: [], inflight: null, ttlMs: 30000 };
  let _activeSelectorPanelCloser = null;

  function closeActiveSelectorPanel() {
    if (_activeSelectorPanelCloser) {
      try { _activeSelectorPanelCloser(); } catch (e) {}
      _activeSelectorPanelCloser = null;
    }
  }

  function getBalancerSelectorMode(bal) {
    try {
      const v = _balSelectorMode.get(bal);
      if (v === 'raw' || v === 'ui') return v;
    } catch (e) {}
    return 'ui';
  }

  function setBalancerSelectorMode(bal, mode) {
    try {
      if (mode === 'raw' || mode === 'ui') _balSelectorMode.set(bal, mode);
    } catch (e) {}
  }

  function normalizeStringList(arr) {
    const out = [];
    const seen = new Set();
    (Array.isArray(arr) ? arr : []).forEach((v) => {
      const s = String(v == null ? '' : v).trim();
      if (!s) return;
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
    });
    return out;
  }

  async function getOutboundTags(force) {
    const now = Date.now();
    if (!force && _outboundTagsCache.ts && (now - _outboundTagsCache.ts) < _outboundTagsCache.ttlMs) {
      return Array.isArray(_outboundTagsCache.tags) ? _outboundTagsCache.tags : [];
    }
    if (_outboundTagsCache.inflight) {
      try { return await _outboundTagsCache.inflight; } catch (e) { /* fallthrough */ }
    }

    const p = (async () => {
      try {
        const resp = await fetch('/api/xray/outbound-tags', { method: 'GET' });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.ok === false) {
          _outboundTagsCache.tags = [];
        } else {
          _outboundTagsCache.tags = normalizeStringList(data.tags || []);
        }
      } catch (e) {
        _outboundTagsCache.tags = [];
      } finally {
        _outboundTagsCache.ts = Date.now();
        _outboundTagsCache.inflight = null;
      }
      return _outboundTagsCache.tags;
    })();

    _outboundTagsCache.inflight = p;
    return await p;
  }


  // -------- Observatory check (leastPing) --------
  const _observatoryCache = { ts: 0, info: { exists: false, name: '' }, inflight: null, ttlMs: 30000, dir: '/opt/etc/xray/configs' };

  async function detectObservatory(force) {
    const now = Date.now();
    if (!force && _observatoryCache.ts && (now - _observatoryCache.ts) < _observatoryCache.ttlMs) {
      return _observatoryCache.info || { exists: false, name: '' };
    }
    if (_observatoryCache.inflight) {
      try { return await _observatoryCache.inflight; } catch (e) { /* fallthrough */ }
    }

    const p = (async () => {
      let info = { exists: false, name: '' };
      try {
        const url = '/api/fs/list?target=local&path=' + encodeURIComponent(_observatoryCache.dir);
        const resp = await fetch(url, { method: 'GET' });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data && data.ok !== false && Array.isArray(data.items)) {
          const names = data.items
            .map((it) => (it && it.name != null ? String(it.name) : ''))
            .filter((s) => !!(s && String(s).trim()));
          let found = '';
          if (names.indexOf('07_observatory.json') >= 0) found = '07_observatory.json';
          else if (names.indexOf('07_observatory.jsonc') >= 0) found = '07_observatory.jsonc';
          else found = names.find((n) => /observatory/i.test(n) && /\.jsonc?$/i.test(n)) || '';
          info = { exists: !!found, name: found || '' };
        }
      } catch (e) {
        info = { exists: false, name: '' };
      } finally {
        _observatoryCache.info = info;
        _observatoryCache.ts = Date.now();
        _observatoryCache.inflight = null;
      }
      return info;
    })();

    _observatoryCache.inflight = p;
    return await p;
  }

function updateBalancerTitleDom(bal, titleEl, idx) {
    if (!titleEl) return;
    const tag = bal && bal.tag ? String(bal.tag) : `balancer#${Number(idx) + 1}`;
    titleEl.textContent = `Балансировщик: ${tag}`;
  }

  function updateBalancerBadgesDom(bal, refs) {
    if (!refs) return;
    try {
      const fb = bal && bal.fallbackTag ? String(bal.fallbackTag) : '';
      const selN = Array.isArray(bal && bal.selector) ? bal.selector.length : 0;
      const stType = (bal && bal.strategy && typeof bal.strategy === 'object' && !Array.isArray(bal.strategy))
        ? String(bal.strategy.type || '')
        : '';

      if (refs.fallbackBadge) {
        refs.fallbackBadge.textContent = fb ? `fallback: ${fb}` : 'fallback: —';
      }
      if (refs.selectorBadge) {
        refs.selectorBadge.textContent = `selector: ${selN}`;
      }
      if (refs.strategyBadge) {
        refs.strategyBadge.textContent = stType ? `strategy: ${stType}` : 'strategy: —';
      }
    } catch (e) {}
  }

  function buildBalancerForm(bal, idx, onChanged) {
    const form = document.createElement('div');
    form.className = 'routing-rule-form';

    // tag
    const tagInput = createRuleInput(String(bal && bal.tag ? bal.tag : ''), 'balancer', (val) => {
      const v = String(val || '').trim();
      if (v) bal.tag = v;
      else { try { delete bal.tag; } catch (e) {} }
      if (typeof onChanged === 'function') onChanged();
    });
    form.appendChild(buildField('tag', tagInput, 'balancer.tag'));

    // fallbackTag
    const fbInput = createRuleInput(String(bal && bal.fallbackTag ? bal.fallbackTag : ''), 'direct', (val) => {
      const v = String(val || '').trim();
      if (v) bal.fallbackTag = v;
      else { try { delete bal.fallbackTag; } catch (e) {} }
      if (typeof onChanged === 'function') onChanged();
    });
    form.appendChild(buildField('fallbackTag', fbInput, 'balancer.fallbackTag'));

    // selector (UI/Raw)
    // Raw editor (textarea) remains available for advanced cases; UI mode provides chips + search backed by /api/xray/outbound-tags
    const selectorVals = normalizeListValue(bal ? bal.selector : null);

    // --- Raw textarea ---
    const selectorTa = createRuleTextarea(formatMultiValue(selectorVals), 'vless-reality\\nvless-ws\\nvless-tcp', (raw) => {
      const arr = splitMultiValue(raw);
      if (arr && arr.length) bal.selector = arr;
      else { try { delete bal.selector; } catch (e) {} }
      if (typeof onChanged === 'function') onChanged();
    });

    // UI parity: selector field has an inline "expand" button (opens JSON modal for quick editing).
    try { selectorTa.classList.add('routing-balancer-selector-ta'); } catch (e) {}
    const selectorRawWrap = document.createElement('div');
    selectorRawWrap.className = 'routing-balancer-selector-wrap routing-selector-raw-wrap';

    const selectorExpand = document.createElement('button');
    selectorExpand.type = 'button';
    selectorExpand.className = 'btn-secondary btn-icon routing-balancer-selector-expand';
    selectorExpand.textContent = '›';
    selectorExpand.setAttribute('data-tooltip', 'Открыть selector в JSON-редакторе');
    selectorExpand.setAttribute('aria-label', 'Открыть selector в JSON-редакторе');
    selectorExpand.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tag = bal && bal.tag ? String(bal.tag) : `balancer#${Number(idx) + 1}`;
      const cur = normalizeListValue(bal ? bal.selector : null);
      openJsonModal({ selector: cur }, `Балансировщик: ${tag} — selector`, { kind: 'balancerSelector', idx });
    });

    selectorRawWrap.appendChild(selectorTa);
    selectorRawWrap.appendChild(selectorExpand);

    // --- UI chips + search ---
    const selectorUiWrap = document.createElement('div');
    selectorUiWrap.className = 'routing-selector-ui-wrap';

    const chipField = document.createElement('div');
    chipField.className = 'routing-selector-chipfield';

    const entry = document.createElement('input');
    entry.type = 'text';
    entry.className = 'routing-selector-entry';
    entry.placeholder = 'Добавить outbound или префикс…';
    entry.setAttribute('aria-label', 'Добавить outbound или префикс в selector');

    const panel = document.createElement('div');
    panel.className = 'routing-selector-panel hidden';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', 'Список outbound tags');

    const panelTitle = document.createElement('div');
    panelTitle.className = 'routing-selector-panel-title';
    panelTitle.textContent = 'Outbounds';

    const panelList = document.createElement('div');
    panelList.className = 'routing-selector-list';

    panel.appendChild(panelTitle);
    panel.appendChild(panelList);

    selectorUiWrap.appendChild(chipField);
    selectorUiWrap.appendChild(panel);

    // top controls: UI/Raw + refresh + count
    const selectorFieldWrap = document.createElement('div');
    selectorFieldWrap.className = 'routing-selector-fieldwrap';

    const selectorTop = document.createElement('div');
    selectorTop.className = 'routing-selector-top';

    const modeGroup = document.createElement('div');
    modeGroup.className = 'routing-selector-mode';

    const modeUiBtn = document.createElement('button');
    modeUiBtn.type = 'button';
    modeUiBtn.className = 'btn-secondary routing-selector-mode-btn';
    modeUiBtn.textContent = 'UI';
    modeUiBtn.setAttribute('data-tooltip', 'Выбор outbounds через чипы');
    modeUiBtn.setAttribute('aria-label', 'Режим UI для selector');

    const modeRawBtn = document.createElement('button');
    modeRawBtn.type = 'button';
    modeRawBtn.className = 'btn-secondary routing-selector-mode-btn';
    modeRawBtn.textContent = 'Raw';
    modeRawBtn.setAttribute('data-tooltip', 'Ручной ввод selector (каждая строка — префикс)');
    modeRawBtn.setAttribute('aria-label', 'Режим Raw для selector');

    modeGroup.appendChild(modeUiBtn);
    modeGroup.appendChild(modeRawBtn);

    const topRight = document.createElement('div');
    topRight.className = 'routing-selector-top-right';

    const countEl = document.createElement('span');
    countEl.className = 'routing-selector-count';
    countEl.textContent = '';

    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className = 'btn-secondary btn-icon routing-selector-refresh-btn';
    refreshBtn.textContent = '↻';
    refreshBtn.setAttribute('data-tooltip', 'Обновить список outbound tags');
    refreshBtn.setAttribute('aria-label', 'Обновить список outbound tags');

    topRight.appendChild(countEl);
    topRight.appendChild(refreshBtn);

    const prefixHint = document.createElement('span');
    prefixHint.className = 'routing-selector-prefix-hint';
    prefixHint.textContent = 'ⓘ';
    prefixHint.setAttribute('tabindex', '0');
    prefixHint.setAttribute('role', 'note');
    prefixHint.setAttribute('data-tooltip', 'selector — это префиксы тегов outbound. Например "vless-" выберет все outbounds, чьи tag начинаются с vless-. Можно указывать и полный tag для точного выбора.');
    topRight.appendChild(prefixHint);

    selectorTop.appendChild(modeGroup);
    selectorTop.appendChild(topRight);

    selectorFieldWrap.appendChild(selectorTop);
    selectorFieldWrap.appendChild(selectorUiWrap);
    selectorFieldWrap.appendChild(selectorRawWrap);

    // wiring state
    let availableTags = [];
    let availableSet = new Set();
    let tagsLoaded = false;

    function getSelected() {
      return normalizeListValue(bal ? bal.selector : null);
    }

    function setSelected(next) {
      const arr = normalizeStringList(Array.isArray(next) ? next : []);
      if (arr.length) bal.selector = arr;
      else { try { delete bal.selector; } catch (e) {} }

      // sync raw textarea
      try {
        selectorTa.value = formatMultiValue(arr);
        autoResizeTextarea(selectorTa);
      } catch (e) {}

      if (typeof onChanged === 'function') onChanged();
    }

    function isMissingTag(tag) {
      if (!tagsLoaded) return false;
      if (!tag) return false;
      return !availableSet.has(String(tag));
    }

    function renderChips() {
      // keep input as last child
      const sel = getSelected();
      chipField.innerHTML = '';
      sel.forEach((tag) => {
        const chip = document.createElement('span');
        chip.className = 'routing-selector-chip' + (isMissingTag(tag) ? ' is-missing' : '');
        const t = document.createElement('span');
        t.className = 'routing-selector-chip-text';
        if (isMissingTag(tag)) {
          t.textContent = `⚠ ${tag}`;
          t.setAttribute('title', 'Нет в outbounds');
        } else {
          t.textContent = String(tag);
        }

        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'routing-selector-chip-x';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Удалить: ' + String(tag));
        x.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cur = getSelected();
          setSelected(cur.filter((v) => String(v) !== String(tag)));
        });

        chip.appendChild(t);
        chip.appendChild(x);
        chipField.appendChild(chip);
      });

      chipField.appendChild(entry);
    }

    function renderPanel(query) {
      const rawQ = String(query || '').trim();
      const q = rawQ.toLowerCase();
      const sel = new Set(getSelected().map((s) => String(s)));
      const items = [];

      // Missing selected values should stay visible (top) to avoid silent data loss.
      if (tagsLoaded) {
        const missing = getSelected().filter((t) => isMissingTag(t));
        missing.forEach((t) => {
          items.push({ value: String(t), label: `⚠ ${t} (нет в outbounds)`, missing: true });
        });
      }

      availableTags.forEach((t) => {
        const v = String(t);
        if (q && !v.toLowerCase().includes(q)) return;
        items.push({ value: v, label: v, missing: false });
      });

      // "Add custom" item
      const exact = q ? items.some((it) => String(it.value).toLowerCase() === q) : false;
      if (q && !exact) {
        items.unshift({ value: rawQ, label: `＋ Добавить "${rawQ}"`, add: true });
      }

      panelList.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'routing-selector-empty';
        empty.textContent = tagsLoaded ? 'Нет совпадений.' : 'Загрузка…';
        panelList.appendChild(empty);
        return;
      }

      items.forEach((it) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'routing-selector-item' + (sel.has(String(it.value)) && !it.add ? ' is-selected' : '') + (it.missing ? ' is-missing' : '');
        btn.setAttribute('role', 'option');

        const left = document.createElement('span');
        left.className = 'routing-selector-item-left';
        left.textContent = it.label;

        const right = document.createElement('span');
        right.className = 'routing-selector-item-right';
        right.textContent = it.add ? '' : (sel.has(String(it.value)) ? '✓' : '');

        btn.appendChild(left);
        btn.appendChild(right);

        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();

          const cur = getSelected();
          const v = String(it.value);

          if (it.add) {
            // add custom value
            if (v) setSelected(cur.concat([v]));
            entry.value = '';
            renderPanel('');
            renderChips();
            return;
          }

          if (cur.some((x) => String(x) === v)) {
            setSelected(cur.filter((x) => String(x) !== v));
          } else {
            setSelected(cur.concat([v]));
          }
          renderPanel(entry.value);
          renderChips();
        });

        panelList.appendChild(btn);
      });
    }

    function openPanel() {
      closeActiveSelectorPanel();
      panel.classList.remove('hidden');
      renderPanel(entry.value);

      const onDoc = (ev) => {
        try {
          if (selectorUiWrap.contains(ev.target)) return;
          closePanel();
        } catch (e) { closePanel(); }
      };

      const onEsc = (ev) => {
        if (ev && ev.key === 'Escape') {
          ev.preventDefault();
          closePanel();
        }
      };

      function closePanel() {
        try { panel.classList.add('hidden'); } catch (e) {}
        try { document.removeEventListener('mousedown', onDoc, true); } catch (e) {}
        try { document.removeEventListener('keydown', onEsc, true); } catch (e) {}
        if (_activeSelectorPanelCloser === closer) _activeSelectorPanelCloser = null;
      }

      const closer = () => closePanel();
      _activeSelectorPanelCloser = closer;

      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onEsc, true);
    }

    // entry behaviors
    entry.addEventListener('focus', (e) => { openPanel(); });
    entry.addEventListener('click', (e) => { openPanel(); });
    entry.addEventListener('input', (e) => {
      if (panel.classList.contains('hidden')) openPanel();
      renderPanel(entry.value);
    });
    entry.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const v = String(entry.value || '').trim();
        if (!v) return;
        e.preventDefault();
        const cur = getSelected();
        if (!cur.some((x) => String(x) === v)) setSelected(cur.concat([v]));
        entry.value = '';
        renderChips();
        renderPanel('');
      }
    });

    // Initial chips render
    renderChips();

    async function loadTags(force) {
      try {
        const tags = await getOutboundTags(!!force);
        availableTags = normalizeStringList(tags || []);
        availableSet = new Set(availableTags.map((t) => String(t)));
        tagsLoaded = true;
        countEl.textContent = availableTags.length ? (`outbounds: ${availableTags.length}`) : 'outbounds: —';
      } catch (e) {
        availableTags = [];
        availableSet = new Set();
        tagsLoaded = false;
        countEl.textContent = 'outbounds: —';
      }
      renderChips();
      if (!panel.classList.contains('hidden')) renderPanel(entry.value);
    }

    refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      loadTags(true);
    });

    // Load tags lazily
    loadTags(false);

    // Mode switching
    function applyMode(mode) {
      const m = (mode === 'raw') ? 'raw' : 'ui';
      setBalancerSelectorMode(bal, m);

      // Close dropdown if leaving UI mode
      if (m !== 'ui') closeActiveSelectorPanel();

      if (m === 'ui') {
        selectorUiWrap.style.display = '';
        selectorRawWrap.style.display = 'none';
        modeUiBtn.classList.add('is-active');
        modeRawBtn.classList.remove('is-active');
      } else {
        selectorUiWrap.style.display = 'none';
        selectorRawWrap.style.display = '';
        modeUiBtn.classList.remove('is-active');
        modeRawBtn.classList.add('is-active');
      }
    }

    modeUiBtn.addEventListener('click', (e) => { e.preventDefault(); applyMode('ui'); });
    modeRawBtn.addEventListener('click', (e) => { e.preventDefault(); applyMode('raw'); });

    applyMode(getBalancerSelectorMode(bal));

    form.appendChild(buildField('selector', selectorFieldWrap, 'balancer.selector'));

    // strategy (JSON)
    let strategyTa = null;
    const initStrategyRaw = (bal && typeof bal.__xkStrategyDraft === 'string')
      ? bal.__xkStrategyDraft
      : ((bal && bal.strategy && typeof bal.strategy === 'object' && !Array.isArray(bal.strategy)) ? JSON.stringify(bal.strategy, null, 2) : '');

    strategyTa = createRuleTextarea(initStrategyRaw, '{\n  "type": "random"\n}', (raw) => {
      // Always keep draft while user types (even if JSON is invalid)
      bal.__xkStrategyDraft = String(raw || '');

      const trimmed = String(raw || '').trim();
      if (!trimmed) {
        try { delete bal.strategy; } catch (e) {}
        try { delete bal.__xkStrategyDraft; } catch (e) {}
        try { strategyTa.classList.remove('is-invalid'); } catch (e) {}
        if (typeof onChanged === 'function') onChanged();
        return;
      }

      const parsed = safeJsonParse(trimmed);
      if (parsed && !parsed.__error && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        bal.strategy = parsed;
        try { delete bal.__xkStrategyDraft; } catch (e) {}
        try { strategyTa.classList.remove('is-invalid'); } catch (e) {}
        if (typeof onChanged === 'function') onChanged();
      } else {
        try { strategyTa.classList.add('is-invalid'); } catch (e) {}
        // Still mark as dirty to indicate there are unapplied changes
        markDirty(true);
      }
    });
    try { strategyTa.classList.add('routing-balancer-json-ta'); } catch (e) {}

    // Strategy presets: quick chips (random / leastPing)
    const strategyWrap = document.createElement('div');
    strategyWrap.className = 'routing-strategy-wrap';

    const presets = document.createElement('div');
    presets.className = 'routing-strategy-presets';

    const chipRandom = document.createElement('button');
    chipRandom.type = 'button';
    chipRandom.className = 'btn-secondary routing-strategy-chip';
    chipRandom.textContent = 'random';
    chipRandom.setAttribute('data-tooltip', 'Preset strategy: {"type":"random"}');

    const chipLeastPing = document.createElement('button');
    chipLeastPing.type = 'button';
    chipLeastPing.className = 'btn-secondary routing-strategy-chip';
    chipLeastPing.textContent = 'leastPing';
    chipLeastPing.setAttribute('data-tooltip', 'Preset strategy: {"type":"leastPing"} (обычно нужен observatory)');

    presets.appendChild(chipRandom);
    presets.appendChild(chipLeastPing);


    // leastPing requires observatory (warn if missing)
    const obsWarn = document.createElement('div');
    obsWarn.className = 'routing-observatory-warning';
    obsWarn.style.display = 'none';

    const obsWarnText = document.createElement('div');
    obsWarnText.className = 'routing-observatory-warning-text';

    const obsWarnActions = document.createElement('div');
    obsWarnActions.className = 'routing-observatory-warning-actions';

    const obsRefreshBtn = document.createElement('button');
    obsRefreshBtn.type = 'button';
    obsRefreshBtn.className = 'btn-secondary btn-icon';
    obsRefreshBtn.textContent = '⟳';
    obsRefreshBtn.setAttribute('data-tooltip', 'Проверить наличие observatory ещё раз');

    const obsCreateBtn = document.createElement('button');
    obsCreateBtn.type = 'button';
    obsCreateBtn.className = 'btn-secondary';
    obsCreateBtn.textContent = 'Создать observatory';
    obsCreateBtn.disabled = true;
    obsCreateBtn.setAttribute('data-tooltip', 'Создать 07_observatory.json по шаблону (jameszero 4025)');

    obsWarnActions.appendChild(obsRefreshBtn);
    obsWarnActions.appendChild(obsCreateBtn);
    obsWarn.appendChild(obsWarnText);
    obsWarn.appendChild(obsWarnActions);

    let _obsToken = 0;
    async function refreshObsWarning(force) {
      // Show only for leastPing
      let stType = '';
      try {
        const trimmed = String(strategyTa.value || '').trim();
        const parsed = safeJsonParse(trimmed);
        stType = (parsed && !parsed.__error && parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          ? String(parsed.type || '')
          : '';
      } catch (e) {
        stType = '';
      }

      if (stType !== 'leastPing') {
        obsWarn.style.display = 'none';
        try { obsCreateBtn.disabled = true; } catch (e) {}
        return;
      }

      const token = ++_obsToken;
      obsWarn.style.display = '';
      obsWarnText.textContent = '⚠ leastPing требует observatory (например 07_observatory.json). Проверяем наличие файла…';
      try { obsCreateBtn.disabled = true; } catch (e) {}

      try {
        const info = await detectObservatory(!!force);
        if (token !== _obsToken) return;

        if (info && info.exists) {
          obsWarn.style.display = 'none';
          try { obsCreateBtn.disabled = true; } catch (e) {}
          return;
        }
        const dir = (_observatoryCache && _observatoryCache.dir) ? _observatoryCache.dir : '/opt/etc/xray/configs';
        obsWarnText.textContent = `⚠ leastPing требует observatory (например 07_observatory.json). Файл не найден в ${dir}. См. jameszero 4025.`;
        try { obsCreateBtn.disabled = false; } catch (e) {}
      } catch (e) {
        if (token !== _obsToken) return;
        obsWarnText.textContent = '⚠ leastPing требует observatory: не удалось проверить наличие файла.';
        try { obsCreateBtn.disabled = false; } catch (e2) {}
      }
    }

    const scheduleObsWarning = debounce(() => { refreshObsWarning(false); }, 250);
    obsRefreshBtn.addEventListener('click', (e) => { e.preventDefault(); refreshObsWarning(true); });

    // Create observatory config by template
    obsCreateBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const prevText = obsCreateBtn.textContent;
      try {
        obsCreateBtn.disabled = true;
        obsCreateBtn.textContent = 'Создаю…';
      } catch (e2) {}

      try {
        const resp = await fetch('/api/xray/observatory/preset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ restart: false })
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || !data || data.ok === false) {
          toast('Не удалось создать observatory', true);
        } else {
          const files = Array.isArray(data.files) ? data.files : [];
          if (data.existed) {
            toast('Observatory уже существует' + (files.length ? (': ' + files.join(', ')) : ''), false);
          } else {
            toast('Observatory создан' + (files.length ? (': ' + files.join(', ')) : ''), false);
          }
          toast('Теперь сохраните routing и перезапустите Xray', false);
        }
      } catch (err) {
        toast('Не удалось создать observatory: ' + String(err && err.message ? err.message : err), true);
      } finally {
        try {
          obsCreateBtn.textContent = prevText;
        } catch (e3) {}
        try {
          await refreshObsWarning(true);
        } catch (e4) {}
      }
    });


    function setStrategyChipActive(type) {
      const t = String(type || '');
      const active = (name) => (t === name);
      try { chipRandom.classList.toggle('is-active', active('random')); } catch (e) {}
      try { chipLeastPing.classList.toggle('is-active', active('leastPing')); } catch (e) {}
    }

    function syncStrategyChips() {
      try {
        const trimmed = String(strategyTa.value || '').trim();
        const parsed = safeJsonParse(trimmed);
        const t = (parsed && !parsed.__error && parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          ? String(parsed.type || '')
          : '';
        setStrategyChipActive(t);
      } catch (e) {
        setStrategyChipActive('');
      }
    }

    function applyStrategyPreset(type) {
      try {
        const obj = { type: String(type || '') };
        strategyTa.value = JSON.stringify(obj, null, 2);
        autoResizeTextarea(strategyTa);
        strategyTa.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (e) {}
    }

    chipRandom.addEventListener('click', (e) => { e.preventDefault(); applyStrategyPreset('random'); });
    chipLeastPing.addEventListener('click', (e) => { e.preventDefault(); applyStrategyPreset('leastPing'); });

    strategyTa.addEventListener('input', () => { syncStrategyChips(); scheduleObsWarning(); });
    requestAnimationFrame(() => { try { syncStrategyChips(); } catch (e) {} try { refreshObsWarning(false); } catch (e2) {} });

    strategyWrap.appendChild(presets);
    strategyWrap.appendChild(obsWarn);
    strategyWrap.appendChild(strategyTa);

    form.appendChild(buildField('strategy (JSON)', strategyWrap, 'balancer.strategy'));

    // extra (unknown keys) as JSON
    let extraTa = null;
    const initExtraRaw = (bal && typeof bal.__xkExtraDraft === 'string')
      ? bal.__xkExtraDraft
      : (() => {
          try {
            const extraObj = getBalancerExtraObject(bal);
            return Object.keys(extraObj).length ? JSON.stringify(extraObj, null, 2) : '';
          } catch (e) { return ''; }
        })();

    // NOTE: keep placeholder as a single-line JS string (no literal newlines)
    extraTa = createRuleTextarea(initExtraRaw, '{\n  \n}', (raw) => {
      bal.__xkExtraDraft = String(raw || '');

      const trimmed = String(raw || '').trim();
      if (!trimmed) {
        try {
          const old = getBalancerExtraObject(bal);
          Object.keys(old).forEach((k) => { try { delete bal[k]; } catch (e) {} });
        } catch (e) {}
        try { delete bal.__xkExtraDraft; } catch (e) {}
        try { extraTa.classList.remove('is-invalid'); } catch (e) {}
        if (typeof onChanged === 'function') onChanged();
        return;
      }

      const parsed = safeJsonParse(trimmed);
      if (parsed && !parsed.__error && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        try {
          const old = getBalancerExtraObject(bal);
          Object.keys(old).forEach((k) => { try { delete bal[k]; } catch (e) {} });
          Object.keys(parsed).forEach((k) => {
            try { bal[k] = parsed[k]; } catch (e) {}
          });
        } catch (e) {}
        try { delete bal.__xkExtraDraft; } catch (e) {}
        try { extraTa.classList.remove('is-invalid'); } catch (e) {}
        if (typeof onChanged === 'function') onChanged();
      } else {
        try { extraTa.classList.add('is-invalid'); } catch (e) {}
        markDirty(true);
      }
    });
    try { extraTa.classList.add('routing-balancer-json-ta'); } catch (e) {}
    form.appendChild(buildField('extra (JSON)', extraTa, null));

    requestAnimationFrame(() => {
      try {
        form.querySelectorAll('.routing-rule-textarea').forEach((ta) => autoResizeTextarea(ta));
      } catch (e) {}
    });

    return form;
  }



  function renderBalancers() {
    const list = $(IDS.balancersList);
    if (!list) return;
    list.innerHTML = '';

    const m = ensureModel();
    if (!m.balancers.length) {
      const empty = document.createElement('div');
      empty.className = 'routing-rule-empty';
      empty.textContent = 'Балансировщиков нет.';
      list.appendChild(empty);
      return;
    }

    m.balancers.forEach((b, idx) => {
      const card = document.createElement('div');
      card.className = 'routing-balancer-card';
      card.dataset.idx = String(idx);

      // UI parity: balancer card shows the form by default (as on the reference screenshot).
      // We keep data-open=1 so existing CSS won't hide the body.
      card.dataset.open = '1';

      const head = document.createElement('div');
      head.className = 'routing-balancer-head';

      const titleBlock = document.createElement('div');
      titleBlock.className = 'routing-balancer-titleblock';

      const title = document.createElement('div');
      title.className = 'routing-balancer-title';
      updateBalancerTitleDom(b || {}, title, idx);

      const meta = document.createElement('div');
      meta.className = 'routing-rule-meta routing-balancer-meta';

      const fbBadge = document.createElement('span');
      fbBadge.className = 'routing-rule-badge';

      const stBadge = document.createElement('span');
      stBadge.className = 'routing-rule-badge';

      const selBadge = document.createElement('span');
      selBadge.className = 'routing-rule-badge';

      meta.appendChild(fbBadge);
      meta.appendChild(stBadge);
      meta.appendChild(selBadge);

      const headRefs = { fallbackBadge: fbBadge, strategyBadge: stBadge, selectorBadge: selBadge };
      updateBalancerBadgesDom(b || {}, headRefs);

      titleBlock.appendChild(title);
      titleBlock.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'routing-balancer-actions';

      const infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'btn-secondary btn-icon routing-balancer-info-btn';
      infoBtn.textContent = 'i';
      infoBtn.setAttribute('data-tooltip', 'Справка по балансировщику');
      infoBtn.setAttribute('aria-label', 'Справка по балансировщику');
      infoBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFieldHelp('balancer');
      });

      const moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'btn-secondary routing-balancer-more-btn';
      moreBtn.textContent = 'Подробнее';
      moreBtn.setAttribute('data-tooltip', 'Открыть балансировщик в JSON-редакторе');
      moreBtn.setAttribute('aria-label', 'Открыть балансировщик в JSON-редакторе');
      moreBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tag = b && b.tag ? String(b.tag) : `balancer#${idx + 1}`;
        openJsonModal(b || {}, `Балансировщик: ${tag}`, { kind: 'balancer', idx, isNew: false });
      });

      actions.appendChild(infoBtn);
      actions.appendChild(moreBtn);

      head.appendChild(titleBlock);
      head.appendChild(actions);

      card.appendChild(head);

      // Body (details)
      const body = document.createElement('div');
      body.className = 'routing-balancer-body';

      const onChanged = () => {
        markDirty(true);
        updateBalancerTitleDom(b || {}, title, idx);
        updateBalancerBadgesDom(b || {}, headRefs);
      };

      const form = buildBalancerForm(b || {}, idx, onChanged);
      body.appendChild(form);
      card.appendChild(body);

      list.appendChild(card);
    });
  }



  function moveRuleToIndex(fromIdx, toIdx) {
    const m = ensureModel();
    const n = m.rules.length;
    if (fromIdx == null || toIdx == null) return false;
    const a = Number(fromIdx);
    const b = Number(toIdx);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a < 0 || a >= n) return false;
    let t = b;
    if (t < 0) t = 0;
    if (t > n - 1) t = n - 1;
    if (t === a) return false;

    const [rule] = m.rules.splice(a, 1);
    m.rules.splice(t, 0, rule);
    return true;
  }

  function pulseRuleCardByIdx(idx) {
    const list = $(IDS.rulesList);
    if (!list) return;
    const el = list.querySelector(`.routing-rule-card[data-idx="${idx}"]`);
    if (!el) return;
    el.classList.add('is-drop-pulse');
    setTimeout(() => {
      try { el.classList.remove('is-drop-pulse'); } catch (e) {}
    }, 750);
  }

  function supportsPointerDnD() {
    try { return typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined'; } catch (e) { return false; }
  }

  function ensureRulesDnD() {
    const list = $(IDS.rulesList);
    if (!list || list.__xkDnDHooked) return;
    list.__xkDnDHooked = true;

    function cleanup() {
      _dragRuleIdx = null;
      _dropInsertIdx = null;
      if (_placeholderEl && _placeholderEl.parentNode) {
        try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {}
      }
      _placeholderEl = null;
      try {
        const dragging = list.querySelector('.routing-rule-card.is-dragging');
        if (dragging) dragging.classList.remove('is-dragging');
      } catch (e) {}
      try {
        list.querySelectorAll('.routing-rule-card.is-drop-before,.routing-rule-card.is-drop-after').forEach((el) => {
          el.classList.remove('is-drop-before');
          el.classList.remove('is-drop-after');
        });
      } catch (e) {}
    }

    function ensurePlaceholder() {
      if (_placeholderEl) return _placeholderEl;
      const ph = document.createElement('div');
      ph.className = 'routing-rule-placeholder';
      ph.textContent = 'Переместить сюда';
      _placeholderEl = ph;
      return _placeholderEl;
    }

    function computeInsertIndex(targetIdx, before) {
      if (targetIdx == null || _dragRuleIdx == null) return null;
      let insertIdx = Number(targetIdx) + (before ? 0 : 1);
      // Adjust for removal of the dragged element.
      if (Number(_dragRuleIdx) < insertIdx) insertIdx -= 1;
      if (insertIdx < 0) insertIdx = 0;
      const m = ensureModel();
      if (insertIdx > m.rules.length - 1) insertIdx = m.rules.length - 1;
      return insertIdx;
    }


    // Pointer-based DnD (preferred): avoids native drag ghost / flicker / snapback.
    if (supportsPointerDnD() && !list.__xkPointerDnDHooked) {
      list.__xkPointerDnDHooked = true;

      function clearDropMarkers() {
        try {
          list.querySelectorAll('.routing-rule-card.is-drop-before,.routing-rule-card.is-drop-after').forEach((el) => {
            el.classList.remove('is-drop-before');
            el.classList.remove('is-drop-after');
          });
        } catch (e) {}
      }

      function pointerResetState() {
        _pDndActive = false;
        _pDndStarted = false;
        _pDndPointerId = null;
        _pDndFromIdx = null;
        _pDndCardEl = null;
        _pDndShiftX = 0;
        _pDndShiftY = 0;
        _pDndStartX = 0;
        _pDndStartY = 0;
        _pDndBaseLeft = 0;
        _pDndBaseTop = 0;
        try { document.body.classList.remove('xk-pointer-dnd-active'); } catch (e) {}
      }

      function pointerRemoveGhost() {
        if (_pDndGhostEl && _pDndGhostEl.parentNode) {
          try { _pDndGhostEl.parentNode.removeChild(_pDndGhostEl); } catch (e) {}
        }
        _pDndGhostEl = null;
      }

      function pointerCleanupDom() {
        clearDropMarkers();
        if (_placeholderEl && _placeholderEl.parentNode) {
          try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {}
        }
        _placeholderEl = null;
        pointerRemoveGhost();
        _dragRuleIdx = null;
        _dropInsertIdx = null;
      }

      function pointerEnd(commit) {
        if (!_pDndActive) return;

        const started = _pDndStarted;
        const fromIdx = Number(_pDndFromIdx);
        const toIdx = _dropInsertIdx;

        pointerCleanupDom();
        pointerResetState();

        // If we never started (small tap), do nothing.
        if (!started) return;

        // Restore list UI (we removed the card into body)
        if (commit && toIdx != null && Number.isFinite(toIdx) && fromIdx !== toIdx) {
          const moved = moveRuleToIndex(fromIdx, toIdx);
          if (moved) markDirty(true);
          renderAll();
          if (moved) pulseRuleCardByIdx(toIdx);
        } else {
          renderAll();
        }
      }

      function pointerStartDragging() {
        if (_pDndStarted) return;
        const card = _pDndCardEl;
        if (!card || !card.parentNode) return;

        const rect = card.getBoundingClientRect();
        const ph = ensurePlaceholder();
        ph.style.minHeight = Math.max(48, rect.height) + 'px';
        ph.style.height = Math.max(48, rect.height) + 'px';
        ph.style.width = rect.width + 'px';

        try { card.parentNode.replaceChild(ph, card); } catch (e) {}

        // Turn the actual card into a fixed-position ghost.
        _pDndGhostEl = card;
        _pDndBaseLeft = rect.left;
        _pDndBaseTop = rect.top;
        _pDndShiftX = _pDndStartX - rect.left;
        _pDndShiftY = _pDndStartY - rect.top;

        try {
          card.classList.add('is-pointer-ghost');
          card.classList.add('is-dragging');
          card.style.position = 'fixed';
          card.style.left = rect.left + 'px';
          card.style.top = rect.top + 'px';
          card.style.width = rect.width + 'px';
          card.style.height = rect.height + 'px';
          card.style.margin = '0';
          card.style.zIndex = '9999';
          card.style.pointerEvents = 'none';
          card.style.willChange = 'transform';
          card.style.transform = 'translate3d(0,0,0)';
          document.body.appendChild(card);
        } catch (e) {}

        _pDndStarted = true;
        try { document.body.classList.add('xk-pointer-dnd-active'); } catch (e) {}
      }

      function pointerUpdateGhost(x, y) {
        if (!_pDndGhostEl) return;
        const left = x - _pDndShiftX;
        const top = y - _pDndShiftY;
        const dx = left - _pDndBaseLeft;
        const dy = top - _pDndBaseTop;
        try { _pDndGhostEl.style.transform = `translate3d(${dx}px, ${dy}px, 0)`; } catch (e) {}
      }

      function pointerAutoScroll(y) {
        try {
          const margin = 70;
          if (y < margin) window.scrollBy(0, -18);
          else if (y > window.innerHeight - margin) window.scrollBy(0, 18);
        } catch (e) {}
      }

      function pointerMovePlaceholder(x, y) {
        if (!_pDndStarted) return;
        const ph = _placeholderEl || ensurePlaceholder();
        const listRect = list.getBoundingClientRect();

        // Clear previous highlights.
        clearDropMarkers();

        // Find a card under pointer (ghost has pointer-events:none).
        let el = null;
        try { el = document.elementFromPoint(x, y); } catch (e) {}
        let card = el && el.closest ? el.closest('.routing-rule-card') : null;

        // Ignore the dragged ghost (it is not in the list), and ignore missing/invalid cards.
        if (card && (!list.contains(card) || !card.dataset || card.classList.contains('is-dragging'))) {
          card = null;
        }

        // If pointer is above/below list, snap placeholder to start/end.
        const m = ensureModel();
        if (!card) {
          if (y < listRect.top + 8) {
            // start
            const first = list.firstElementChild;
            if (first) {
              try { list.insertBefore(ph, first); } catch (e) {}
            } else {
              try { list.appendChild(ph); } catch (e) {}
            }
            _dropInsertIdx = 0;
          } else if (y > listRect.bottom - 8) {
            // end
            try { list.appendChild(ph); } catch (e) {}
            _dropInsertIdx = Math.max(0, (m.rules ? m.rules.length : 1) - 1);
          }
          return;
        }

        const rect = card.getBoundingClientRect();
        let before = y < (rect.top + rect.height / 2);
        // Near midline, use X as tie-breaker (helps in 2-column grid).
        try {
          const midY = rect.top + rect.height / 2;
          if (Math.abs(y - midY) < 14) before = x < (rect.left + rect.width / 2);
        } catch (e) {}

        card.classList.add(before ? 'is-drop-before' : 'is-drop-after');

        const targetIdx = Number(card.dataset.idx);
        const insertIdx = computeInsertIndex(targetIdx, before);
        if (insertIdx == null) return;
        _dropInsertIdx = insertIdx;

        try {
          if (before) card.parentNode.insertBefore(ph, card);
          else card.parentNode.insertBefore(ph, card.nextSibling);
        } catch (e) {}
      }

      // Event delegation: drag starts only from a small handle (avoids accidental drag on buttons).
      list.addEventListener('pointerdown', (ev) => {
        if (list.dataset.dndEnabled !== '1') return;
        if (ev.button != null && ev.button !== 0) return; // left click only
        const handle = ev.target && ev.target.closest ? ev.target.closest('.routing-rule-handle') : null;
        if (!handle) return;

        const card = handle.closest ? handle.closest('.routing-rule-card') : null;
        if (!card || !card.dataset) return;

        _pDndActive = true;
        _pDndStarted = false;
        _pDndPointerId = ev.pointerId;
        _pDndFromIdx = Number(card.dataset.idx);
        _pDndCardEl = card;
        _pDndStartX = ev.clientX;
        _pDndStartY = ev.clientY;
        _dragRuleIdx = _pDndFromIdx;
        _dropInsertIdx = _pDndFromIdx;

        try { handle.setPointerCapture(ev.pointerId); } catch (e) {}
        try { ev.preventDefault(); } catch (e) {}
      });

      window.addEventListener('pointermove', (ev) => {
        if (!_pDndActive) return;
        if (_pDndPointerId != null && ev.pointerId !== _pDndPointerId) return;
        if (list.dataset.dndEnabled !== '1') return;

        const x = ev.clientX;
        const y = ev.clientY;

        // Start after a small threshold.
        if (!_pDndStarted) {
          const dx = x - _pDndStartX;
          const dy = y - _pDndStartY;
          if ((dx * dx + dy * dy) < 36) return; // 6px
          pointerStartDragging();
        }

        pointerUpdateGhost(x, y);
        pointerMovePlaceholder(x, y);
        pointerAutoScroll(y);

        try { ev.preventDefault(); } catch (e) {}
      }, { passive: false });

      window.addEventListener('pointerup', (ev) => {
        if (!_pDndActive) return;
        if (_pDndPointerId != null && ev.pointerId !== _pDndPointerId) return;
        pointerEnd(true);
      });

      window.addEventListener('pointercancel', (ev) => {
        if (!_pDndActive) return;
        if (_pDndPointerId != null && ev.pointerId !== _pDndPointerId) return;
        pointerEnd(false);
      });

      window.addEventListener('keydown', (ev) => {
        if (!_pDndActive) return;
        if (ev.key === 'Escape') {
          try { ev.preventDefault(); } catch (e) {}
          pointerEnd(false);
        }
      });
    }

    list.addEventListener('dragover', (ev) => {
      if (list.dataset.dndEnabled !== '1') return;
      if (_dragRuleIdx == null) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';

      const card = ev.target && ev.target.closest ? ev.target.closest('.routing-rule-card') : null;
      if (!card || !card.dataset || card.classList.contains('is-dragging')) return;

      // Clear previous highlights
      try {
        list.querySelectorAll('.routing-rule-card.is-drop-before,.routing-rule-card.is-drop-after').forEach((el) => {
          el.classList.remove('is-drop-before');
          el.classList.remove('is-drop-after');
        });
      } catch (e) {}

      const rect = card.getBoundingClientRect();
      const before = ev.clientY < (rect.top + rect.height / 2);
      card.classList.add(before ? 'is-drop-before' : 'is-drop-after');

      const targetIdx = Number(card.dataset.idx);
      const insertIdx = computeInsertIndex(targetIdx, before);
      if (insertIdx == null) return;
      _dropInsertIdx = insertIdx;

      const ph = ensurePlaceholder();
      try {
        if (before) card.parentNode.insertBefore(ph, card);
        else card.parentNode.insertBefore(ph, card.nextSibling);
      } catch (e) {}
    });

    list.addEventListener('drop', (ev) => {
      if (list.dataset.dndEnabled !== '1') return;
      if (_dragRuleIdx == null) return;
      ev.preventDefault();

      const fromIdx = Number(_dragRuleIdx);
      const toIdx = _dropInsertIdx;
      cleanup();

      if (toIdx == null || !Number.isFinite(toIdx)) return;
      if (fromIdx === toIdx) return;

      const moved = moveRuleToIndex(fromIdx, toIdx);
      if (!moved) return;
      markDirty(true);
      renderAll();
      pulseRuleCardByIdx(toIdx);
    });

    list.addEventListener('dragleave', (ev) => {
      if (list.dataset.dndEnabled !== '1') return;
      // If leaving the list area entirely, remove placeholder and highlights.
      const rel = ev.relatedTarget;
      if (rel && list.contains(rel)) return;
      try {
        list.querySelectorAll('.routing-rule-card.is-drop-before,.routing-rule-card.is-drop-after').forEach((el) => {
          el.classList.remove('is-drop-before');
          el.classList.remove('is-drop-after');
        });
      } catch (e) {}
      if (_placeholderEl && _placeholderEl.parentNode) {
        try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {}
      }
    });

    // Global escape hatch
    window.addEventListener('dragend', () => {
      if (list.dataset.dndEnabled !== '1') return;
      cleanup();
    });
  }

  function renderRules() {
    const list = $(IDS.rulesList);
    const empty = $(IDS.rulesEmpty);
    if (!list) return;

    const m = ensureModel();
    const filter = String(_filter || '').trim();

    // Enable DnD only when filter is empty (stable indexes / expectations).
    const dragEnabled = !filter;
    list.dataset.dndEnabled = dragEnabled ? '1' : '0';
    list.dataset.dndMode = supportsPointerDnD() ? 'pointer' : 'native';
    ensureRulesDnD();

    // When DnD is disabled, ensure placeholder is removed.
    if (!dragEnabled && _placeholderEl && _placeholderEl.parentNode) {
      try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {}
      _placeholderEl = null;
    }

    list.innerHTML = '';

    // Build visible list with stable indexes (no indexOf issues for duplicates)
    const visible = [];
    for (let i = 0; i < (m.rules || []).length; i++) {
      const r = m.rules[i];
      if (ruleMatchesFilter(r, filter)) visible.push({ idx: i, rule: r });
    }

    // Summary
    const c = $(IDS.rulesCount);
    if (c) c.textContent = `${m.rules.length} правил`;
    const geo = $(IDS.rulesGeo);
    if (geo) {
      const geoCount = m.rules.filter((r) => anyGeo(r)).length;
      geo.textContent = `${geoCount} geo*`;
    }

    if (!visible.length) {
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';

    visible.forEach(({ idx, rule }) => {
      const sum = summarizeRule(rule);

      const card = document.createElement('div');
      card.className = 'routing-rule-card' + (dragEnabled ? ' is-draggable' : '');
      const isOpen = _openSet.has(rule);

      card.dataset.idx = String(idx);
      card.dataset.open = isOpen ? '1' : '0';

      if (dragEnabled) {
        const pointerMode = supportsPointerDnD();
        if (pointerMode) {
          // Prevent native HTML5 DnD ghost/image (we use pointer events instead).
          card.draggable = false;
          card.addEventListener('dragstart', (e) => {
            try { e.preventDefault(); } catch (err) {}
          });
        } else {
          card.draggable = true;
          card.addEventListener('dragstart', (ev) => {
            _dragRuleIdx = idx;
            _dropInsertIdx = null;
            card.classList.add('is-dragging');
            try {
              ev.dataTransfer.effectAllowed = 'move';
              ev.dataTransfer.setData('text/plain', String(idx));
            } catch (e) {}
          });
          card.addEventListener('dragend', () => {
            try { card.classList.remove('is-dragging'); } catch (e) {}
            _dragRuleIdx = null;
            _dropInsertIdx = null;
            if (_placeholderEl && _placeholderEl.parentNode) {
              try { _placeholderEl.parentNode.removeChild(_placeholderEl); } catch (e) {}
            }
            _placeholderEl = null;
          });
        }
      }


      const head = document.createElement('div');
      head.className = 'routing-rule-head';

      const main = document.createElement('div');
      main.className = 'routing-rule-main';

      const title = document.createElement('div');
      title.className = 'routing-rule-title';

      // Small drag handle (pointer-based DnD starts from here).
      if (dragEnabled) {
        const handle = document.createElement('span');
        handle.className = 'routing-rule-handle';
        handle.setAttribute('title', 'Перетащить');
        handle.setAttribute('aria-label', 'Перетащить');
        handle.setAttribute('role', 'button');
        handle.tabIndex = 0;
        handle.textContent = '⠿';
        title.appendChild(handle);
      }

      const idxSpan = document.createElement('span');
      idxSpan.className = 'routing-rule-index';
      idxSpan.textContent = `#${idx + 1}`;

      const tText = document.createElement('span');
      tText.className = 'routing-rule-outbound';
      tText.textContent = sum.title;

      title.appendChild(idxSpan);
      title.appendChild(tText);

      const meta = document.createElement('div');
      meta.className = 'routing-rule-meta';

      const typeBadge = document.createElement('span');
      typeBadge.className = 'routing-rule-badge is-type';
      typeBadge.textContent = String(rule && rule.type ? rule.type : 'field');
      meta.appendChild(typeBadge);

      // Legacy header badge: ruleTag (or "без тега")
      const ruleTagBadge = document.createElement('span');
      ruleTagBadge.className = 'routing-rule-badge is-tag';
      ruleTagBadge.textContent = (rule && rule.ruleTag) ? String(rule.ruleTag) : 'без тега';
      meta.appendChild(ruleTagBadge);

      const geoBadge = document.createElement('span');
      geoBadge.className = 'routing-rule-badge is-geo';
      geoBadge.textContent = 'geo';
      if (!sum.geo) geoBadge.style.display = 'none';
      meta.appendChild(geoBadge);

      const match = document.createElement('div');
      match.className = 'routing-rule-empty';
      match.textContent = sum.match;

      main.appendChild(title);
      main.appendChild(meta);
      main.appendChild(match);

      const actions = document.createElement('div');
      actions.className = 'routing-rule-actions';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'routing-rule-toggle';
      toggleBtn.textContent = isOpen ? 'Свернуть' : 'Детали';
      toggleBtn.setAttribute('title', isOpen ? 'Свернуть форму правила' : 'Развернуть форму правила');
      toggleBtn.setAttribute('aria-label', isOpen ? 'Свернуть форму правила' : 'Развернуть форму правила');
      toggleBtn.addEventListener('click', () => {
        if (_openSet.has(rule)) _openSet.delete(rule);
        else _openSet.add(rule);
        renderRules();
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-secondary btn-icon';
      editBtn.textContent = '✏️';
      editBtn.setAttribute('title', 'Открыть правило в JSON-редакторе');
      editBtn.setAttribute('aria-label', 'Открыть правило в JSON-редакторе');
      editBtn.addEventListener('click', () => {
        openJsonModal(rule || {}, `Правило #${idx + 1}`, { kind: 'rule', idx, isNew: false });
      });

      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'btn-secondary btn-icon';
      upBtn.textContent = '⬆';
      upBtn.setAttribute('title', 'Переместить правило вверх');
      upBtn.setAttribute('aria-label', 'Переместить правило вверх');
      upBtn.disabled = idx <= 0;
      upBtn.addEventListener('click', () => {
        if (idx <= 0) return;
        if (moveRuleToIndex(idx, idx - 1)) {
          markDirty(true);
          renderAll();
          pulseRuleCardByIdx(idx - 1);
        }
      });

      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'btn-secondary btn-icon';
      downBtn.textContent = '⬇';
      downBtn.setAttribute('title', 'Переместить правило вниз');
      downBtn.setAttribute('aria-label', 'Переместить правило вниз');
      downBtn.disabled = idx >= m.rules.length - 1;
      downBtn.addEventListener('click', () => {
        if (idx >= m.rules.length - 1) return;
        if (moveRuleToIndex(idx, idx + 1)) {
          markDirty(true);
          renderAll();
          pulseRuleCardByIdx(idx + 1);
        }
      });

      const dupBtn = document.createElement('button');
      dupBtn.type = 'button';
      dupBtn.className = 'btn-secondary btn-icon';
      dupBtn.textContent = '📄';
      dupBtn.setAttribute('title', 'Дублировать правило');
      dupBtn.setAttribute('aria-label', 'Дублировать правило');
      dupBtn.addEventListener('click', () => {
        const copy = JSON.parse(JSON.stringify(rule || {}));
        m.rules.splice(idx + 1, 0, copy);
        markDirty(true);
        renderAll();
        pulseRuleCardByIdx(idx + 1);
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger btn-icon';
      delBtn.textContent = '🗑';
      delBtn.setAttribute('title', 'Удалить правило');
      delBtn.setAttribute('aria-label', 'Удалить правило');
      delBtn.addEventListener('click', async () => {
        const ok = await confirmModal({
          title: 'Удалить правило',
          message: `Удалить правило #${idx + 1}?`,
          okText: 'Удалить',
          cancelText: 'Отмена',
          danger: true,
        });
        if (!ok) return;
        const removed = m.rules[idx];
        m.rules.splice(idx, 1);
        _openSet.delete(removed);
        markDirty(true);
        renderAll();
      });

      // Order: Details -> JSON -> Duplicate -> Move -> Delete
      actions.appendChild(toggleBtn);
      actions.appendChild(editBtn);
      actions.appendChild(dupBtn);
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
      actions.appendChild(delBtn);

      head.appendChild(main);
      head.appendChild(actions);

      card.appendChild(head);

      // Body
      const body = document.createElement('div');
      body.className = 'routing-rule-body';

      const pre = document.createElement('pre');
      pre.className = 'routing-json-pre';
      updateJsonPreview(pre, rule || {});

      const refs = { titleEl: tText, typeBadge, ruleTagBadge, matchEl: match, geoBadgeEl: geoBadge };
      const onRuleChanged = () => {
        markDirty(true);
        updateRuleHeadDom(rule, refs);
        updateJsonPreview(pre, rule || {});
        // If a filter is active, immediately hide/show the card when edits change match.
        if (filter) {
          try { card.style.display = ruleMatchesFilter(rule, filter) ? '' : 'none'; } catch (e) {}
        }
      };

      if (isOpen) {
        const form = buildRuleForm(rule || {}, idx, onRuleChanged);
        body.appendChild(form);
      }

      body.appendChild(pre);
      card.appendChild(body);

      list.appendChild(card);
    });
  }

  function renderAll() {
    renderBalancers();
    renderRules();
  }

  function saveJsonModal() {
    const ta = document.getElementById(JSON_MODAL_ID + '-text');
    if (!ta) return;
    const raw = String(ta.value || '').trim();
    if (!raw) {
      setJsonModalStatus('Пустой JSON', true);
      return;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      setJsonModalStatus('Ошибка JSON: ' + String(e && e.message ? e.message : e), true);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setJsonModalStatus('Ожидается JSON-объект', true);
      return;
    }

    const ctx = _jsonCtx;
    const m = ensureModel();
    if (!ctx || !ctx.kind) {
      setJsonModalStatus('Нет контекста сохранения', true);
      return;
    }

    try {
      if (ctx.kind === 'rule') {
        if (ctx.isNew) {
          m.rules.push(obj);
        } else {
          // Preserve open state (openSet stores rule object references)
          const prev = m.rules[ctx.idx];
          const wasOpen = _openSet.has(prev);
          _openSet.delete(prev);
          m.rules[ctx.idx] = obj;
          if (wasOpen) _openSet.add(obj);
        }
      } else if (ctx.kind === 'balancer') {
        if (ctx.isNew) {
          m.balancers.push(obj);
        } else {
          // Preserve open state (balOpenSet stores object references)
          const prev = m.balancers[ctx.idx];
          const wasOpen = _balOpenSet.has(prev);
          _balOpenSet.delete(prev);
          m.balancers[ctx.idx] = obj;
          if (wasOpen) _balOpenSet.add(obj);
        }
      } else if (ctx.kind === 'balancerSelector') {
        const b = m.balancers[ctx.idx];
        if (!b) {
          setJsonModalStatus('Балансировщик не найден', true);
          return;
        }
        const sel = obj && obj.selector;
        if (!Array.isArray(sel)) {
          setJsonModalStatus('Ожидается объект вида {"selector": ["..."]}', true);
          return;
        }
        const arr = sel.map((x) => String(x || '').trim()).filter(Boolean);
        if (arr.length) b.selector = arr;
        else { try { delete b.selector; } catch (e) {} }
      }
      markDirty(true);
      closeJsonModal();
      renderAll();
    } catch (e) {
      setJsonModalStatus('Не удалось сохранить: ' + String(e && e.message ? e.message : e), true);
    }
  }

  function wireRulesControls() {
    // Collapse
    // Collapsed by default (user expands only when needed)
    wireCollapse(IDS.rulesHeader, IDS.rulesBody, IDS.rulesArrow, 'xk.routing.rules.open.v2', () => {
      // Ensure fresh render when opened
      try { loadModelFromEditor(); } catch (e) {}
      renderAll();
    }, false);

    const filter = $(IDS.rulesFilter);
    if (filter) {
      filter.addEventListener('input', debounce(() => {
        _filter = filter.value || '';
        renderRules();
      }, 120));
    }

    const refreshBtn = $(IDS.rulesRefresh);
    if (refreshBtn) refreshBtn.addEventListener('click', (e) => { e.preventDefault(); renderAll(); });

    const reloadBtn = $(IDS.rulesReload);
    if (reloadBtn) reloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const r = loadModelFromEditor();
      if (!r.ok) {
        toast('Не удалось прочитать JSON: ' + String(r.error && r.error.message ? r.error.message : r.error), true);
      }
      renderAll();
    });

    const applyBtn = $(IDS.rulesApply);
    if (applyBtn) applyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!_dirty) {
        toast('Нет изменений для применения', false);
        return;
      }
      const ok = await confirmModal({
        title: 'Применить изменения',
        message: 'Перезаписать routing.rules / routing.balancers / domainStrategy в редакторе JSON?\n(Комментарии в JSONC будут потеряны.)',
        okText: 'Применить',
        cancelText: 'Отмена',
        danger: true,
      });
      if (!ok) return;
      applyModelToEditor();
      toast('Изменения применены в JSON', false);
    });

    const addBtn = $(IDS.rulesAdd);
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const rule = { type: 'field', outboundTag: 'direct' };
      openJsonModal(rule, 'Новое правило', { kind: 'rule', idx: -1, isNew: true });
    });

    const balAdd = $(IDS.balancerAdd);
    if (balAdd) balAdd.addEventListener('click', (e) => {
      e.preventDefault();
      const bal = { tag: 'balancer', selector: [], strategy: { type: 'random' } };
      openJsonModal(bal, 'Новый балансировщик', { kind: 'balancer', idx: -1, isNew: true });
    });

    const ds = $(IDS.domainStrategy);
    if (ds) {
      ds.addEventListener('change', () => {
        const m = ensureModel();
        m.domainStrategy = ds.value || '';
        markDirty(true);
      });
    }
  }

  function syncDomainStrategySelect() {
    const ds = $(IDS.domainStrategy);
    if (!ds) return;
    const m = ensureModel();
    const v = String(m.domainStrategy || '');
    if (ds.value !== v) ds.value = v;
  }

  function renderFromEditor() {
    if (!isViewVisible()) return;
    const r = loadModelFromEditor();
    if (!r.ok) {
      const c = $(IDS.rulesCount);
      if (c) c.textContent = 'ошибка JSON';
      return;
    }
    syncDomainStrategySelect();
    renderAll();
  }

  function hookEditorChanges() {
    const cm = editorInstance();
    if (!cm || typeof cm.on !== 'function') return;
    if (cm.__xkRoutingRulesHooked) return;
    cm.__xkRoutingRulesHooked = true;
    cm.on('change', debounce(() => {
      // Avoid heavy re-render when rules card is collapsed
      const body = $(IDS.rulesBody);
      const isOpen = body && body.style.display !== 'none';
      if (!isOpen) return;
      renderFromEditor();
    }, 250));
  }

  function initRulesCard() {
    if (!$(IDS.rulesHeader) || !$(IDS.rulesBody)) return;

    wireRulesControls();
    renderFromEditor();

    // Re-render after routing editor becomes ready
    document.addEventListener('xkeen-editors-ready', () => {
      try { hookEditorChanges(); } catch (e) {}
      try { renderFromEditor(); } catch (e) {}
    });

    // If editor is already ready
    setTimeout(() => {
      try { hookEditorChanges(); } catch (e) {}
      try { renderFromEditor(); } catch (e) {}
    }, 700);
  }

  // ===================== PR3: DAT -> routing.rules helpers =====================
  function ensureRulesCardOpen() {
    const body = $(IDS.rulesBody);
    const arrow = $(IDS.rulesArrow);
    if (body && body.style.display === 'none') {
      body.style.display = '';
      if (arrow) arrow.textContent = '▼';
      try { localStorage.setItem('xk.routing.rules.open.v2', '1'); } catch (e) {}
    }
  }

  function scrollRuleIntoView(idx) {
    const list = $(IDS.rulesList);
    if (!list) return;
    const el = list.querySelector(`.routing-rule-card[data-idx="${idx}"]`);
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }

  function getDatRoutingTargets() {
    // Do NOT reload from editor if user has local unsaved changes.
    if (!_root && !_dirty) {
      try { loadModelFromEditor(); } catch (e) {}
    }
    const m = ensureModel();
    const rules = Array.isArray(m.rules) ? m.rules : [];
    const outSet = new Set();
    rules.forEach((r) => {
      try {
        if (r && r.outboundTag != null && String(r.outboundTag).trim()) outSet.add(String(r.outboundTag).trim());
      } catch (e) {}
    });

    const defaults = ['direct', 'proxy', 'block'];
    const outbounds = [];
    defaults.forEach((d) => { if (!outbounds.includes(d)) outbounds.push(d); });
    Array.from(outSet).sort().forEach((v) => { if (!outbounds.includes(v)) outbounds.push(v); });

    const items = rules.map((r, idx) => {
      const s = summarizeRule(r || {});
      return {
        idx,
        title: s && s.title ? s.title : (r && r.ruleTag ? String(r.ruleTag) : 'rule'),
        match: s && s.match ? s.match : '',
        outboundTag: (r && r.outboundTag != null) ? String(r.outboundTag) : '',
        balancerTag: (r && r.balancerTag != null) ? String(r.balancerTag) : '',
        type: (r && r.type) ? String(r.type) : 'field',
        ruleTag: (r && r.ruleTag) ? String(r.ruleTag) : '',
      };
    });

    return { rules: items, outbounds };
  }

  function mostCommonOutboundTag(rules) {
    const freq = new Map();
    (rules || []).forEach((r) => {
      const v = r && r.outboundTag != null ? String(r.outboundTag).trim() : '';
      if (!v) return;
      freq.set(v, (freq.get(v) || 0) + 1);
    });
    let best = '';
    let bestN = 0;
    freq.forEach((n, v) => {
      if (n > bestN) { bestN = n; best = v; }
    });
    return best;
  }

  function appendUniqueListValue(rule, key, value) {
    if (!rule || !key) return false;
    const v = String(value || '').trim();
    if (!v) return false;
    const list = normalizeListValue(rule[key]);
    if (list.some((x) => String(x || '').trim() === v)) return false;
    list.push(v);
    setRuleValue(rule, key, list);
    return true;
  }

  function applyDatSelector(opts) {
    const kind = (opts && opts.kind === 'geoip') ? 'geoip' : 'geosite';
    const tag = String(opts && opts.tag ? opts.tag : '').trim();
    if (!tag) return { ok: false, error: 'tag_required' };

    // Prefer ext:<file>.dat:<tag> when caller passes DAT path.
    // This matches how many Keenetic setups reference custom file names
    // like geosite_v2fly.dat / geoip_zkeenip.dat in routing rules.
    const datPath = String(opts && opts.datPath ? opts.datPath : '').trim();
    let selector = (kind === 'geoip' ? 'geoip:' : 'geosite:') + tag;
    if (datPath) {
      const p = datPath.replace(/\\/g, '/');
      const base = (p.split('/').pop() || '').trim();
      if (base) selector = 'ext:' + base + ':' + tag;
    }
    const fieldKey = (kind === 'geoip') ? 'ip' : 'domain';
    const mode = String(opts && opts.mode ? opts.mode : 'new');

    if (!_root && !_dirty) {
      try { loadModelFromEditor(); } catch (e) {}
    }
    const m = ensureModel();
    if (!Array.isArray(m.rules)) m.rules = [];

    // Make sure rules card is visible (it is often collapsed by default).
    ensureRulesCardOpen();

    // Clear filter so the target rule is always visible.
    try {
      _filter = '';
      const fi = $(IDS.rulesFilter);
      if (fi) fi.value = '';
    } catch (e) {}

    let idx = -1;
    let created = false;
    let added = false;

    if (mode === 'existing') {
      idx = Number(opts && opts.ruleIdx);
      if (!Number.isFinite(idx) || idx < 0 || idx >= m.rules.length) {
        return { ok: false, error: 'bad_rule_index' };
      }
      const r = m.rules[idx] || {};
      m.rules[idx] = r;
      added = appendUniqueListValue(r, fieldKey, selector);
      try { _openSet.add(idx); } catch (e) {}
    } else {
      const rules = m.rules;
      const outboundTag = String(opts && opts.outboundTag ? opts.outboundTag : '').trim() || mostCommonOutboundTag(rules) || 'direct';
      const rule = { type: 'field', outboundTag, ruleTag: selector };
      rule[fieldKey] = [selector];
      rules.push(rule);
      idx = rules.length - 1;
      created = true;
      added = true;
      try { _openSet.add(idx); } catch (e) {}
    }

    if (created || added) markDirty(true);
    renderAll();

    // Scroll/pulse after DOM updates
    setTimeout(() => {
      try { scrollRuleIntoView(idx); } catch (e) {}
      try { pulseRuleCardByIdx(idx); } catch (e) {}
    }, 20);

    return { ok: true, idx, created, added };
  }


  // ===================== PR5: detect used geosite/geoip tags in routing.rules =====================
  function _walkDeep(val, fn, depth) {
    const d = depth || 0;
    if (d > 10) return;
    if (val == null) return;
    if (typeof val === 'string') { fn(val); return; }
    if (typeof val === 'number' || typeof val === 'boolean') return;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) _walkDeep(val[i], fn, d + 1);
      return;
    }
    if (typeof val === 'object') {
      try {
        for (const k in val) {
          if (!Object.prototype.hasOwnProperty.call(val, k)) continue;
          _walkDeep(val[k], fn, d + 1);
        }
      } catch (e) {}
    }
  }

  function _basenameLower(s) {
  const v = String(s || '').trim();
  if (!v) return '';
  const parts = v.split(/[\/]/);
  return String(parts[parts.length - 1] || '').toLowerCase();
}

function getUsedDatTags(kind, datFileOrPath) {
  const k = (kind === 'geoip') ? 'geoip' : 'geosite';
  const base = _basenameLower(datFileOrPath);

  // Match current editor/model (including unsaved changes).
  if (!_root && !_dirty) {
    try { loadModelFromEditor(); } catch (e) {}
  }
  const m = ensureModel();
  const rules = Array.isArray(m.rules) ? m.rules : [];

  const p = (k === 'geoip') ? 'geoip:' : 'geosite:';
  const used = new Set();

  rules.forEach((r) => {
    _walkDeep(r, (s) => {
      const raw = String(s || '').trim();
      if (!raw) return;
      const lc = raw.toLowerCase();

      // Built-in selectors: geoip:TAG / geosite:TAG
      if (lc.startsWith(p)) {
        const tag = raw.slice(p.length).trim();
        if (tag) used.add(tag.toLowerCase());
        return;
      }

      // External selectors: ext:<file>:TAG (also accept legacy ext:geoip:TAG / ext:geosite:TAG)
      if (!lc.startsWith('ext:')) return;

      const restLc = lc.slice(4);
      const restRaw = raw.slice(4);
      const j = restLc.indexOf(':');
      if (j < 0) return;

      const fileLc = restLc.slice(0, j).trim();
      const tagRaw = restRaw.slice(j + 1).trim();
      if (!tagRaw) return;

      if (base) {
        // When a specific DAT file is provided, match by basename for precision.
        const fbase = _basenameLower(fileLc);
        if (!fbase || fbase !== base) return;
        used.add(tagRaw.toLowerCase());
        return;
      }

      // No file filter: try to infer kind from "geoip"/"geosite" in file part.
      const isGeoip = (fileLc === 'geoip') || fileLc.includes('geoip');
      const isGeosite = (fileLc === 'geosite') || fileLc.includes('geosite');

      if (isGeoip || isGeosite) {
        if (k === 'geoip' && !isGeoip) return;
        if (k === 'geosite' && !isGeosite) return;
      }
      // If kind can't be inferred, still count it (better a hint than a miss).
      used.add(tagRaw.toLowerCase());
    }, 0);
  });

  return { ok: true, kind: k, file: base || null, tags: Array.from(used) };
}


  // ===================== INIT =====================
  let _inited = false;
  function init() {
    if (_inited) return;
    _inited = true;


    try { wireRoutingHelpButtons(); } catch (e) {}
    try { initSidebarCards(); } catch (e) {}
    try { initDatCard(); } catch (e) {}
    try { initRulesCard(); } catch (e) {}
  }

  XK.features.routingCards = { init, getDatRoutingTargets, getUsedDatTags, applyDatSelector, installGeodat, getGeodatStatus };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
