import { getFileManagerNamespace } from '../file_manager_namespace.js';

(() => {
  'use strict';

  // File Manager core state container + panel DOM helpers (no ES modules / bundler)
  // attach to the shared file manager namespace.state

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const FM = getFileManagerNamespace();

  FM.state = FM.state || {};
  const ST = FM.state;

  const C = FM.common || {};

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qs(sel, root) {
    try { if (C && typeof C.qs === 'function') return C.qs(sel, root); } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  }

  // Prefer prefs module when available.
  const loadSortPref = (FM.prefs && typeof FM.prefs.loadSortPref === 'function')
    ? FM.prefs.loadSortPref
    : (() => ({ key: 'name', dir: 'asc', dirsFirst: true }));

  const loadShowHiddenPref = (FM.prefs && typeof FM.prefs.loadShowHiddenPref === 'function')
    ? FM.prefs.loadShowHiddenPref
    : (() => false);

  const loadPanelsPref = (FM.prefs && typeof FM.prefs.loadPanelsPref === 'function')
    ? FM.prefs.loadPanelsPref
    : ((defaults) => defaults);

  const savePanelsPref = (FM.prefs && typeof FM.prefs.savePanelsPref === 'function')
    ? FM.prefs.savePanelsPref
    : (() => {});

  const loadActiveSidePref = (FM.prefs && typeof FM.prefs.loadActiveSidePref === 'function')
    ? FM.prefs.loadActiveSidePref
    : (() => 'left');

  const saveActiveSidePref = (FM.prefs && typeof FM.prefs.saveActiveSidePref === 'function')
    ? FM.prefs.saveActiveSidePref
    : (() => {});

  // -------------------------- state --------------------------
  const S = ST.S || {
    enabled: false,
    caps: null,
    remoteCaps: null,
    liteMode: (typeof window.XKEEN_IS_MIPS === 'boolean')
      ? !!window.XKEEN_IS_MIPS
      : String(window.XKEEN_IS_MIPS || '').toLowerCase() === 'true',
    // UX guard: when opening a remote file for the editor, lock UI to prevent double-open spam.
    openBusy: false,
    openBusySinceMs: 0,
    prefs: {
      sort: loadSortPref(),
      showHidden: loadShowHiddenPref(),
    },
    activeSide: 'left',
    create: { kind: '', side: 'left' },
    rename: { side: 'left', oldName: '' },
    archive: { side: 'left', names: [], fmt: 'zip' },
    extract: { side: 'left', name: '' },
    archiveList: { side: 'left', name: '' },
    ctxMenu: { shown: false, side: 'left', name: '', isDir: false },
    dropOp: { resolve: null }, // drag&drop move/copy choice modal
    panels: {
      left: { target: 'local', sid: '', cwd: '/opt/var', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '', filter: '' },
      // Right panel default: on routers it's usually /tmp/mnt, but on dev machines it may not exist.
      right: { target: 'local', sid: '', cwd: (typeof window.XKEEN_FM_RIGHT_DEFAULT === 'string' && window.XKEEN_FM_RIGHT_DEFAULT) ? window.XKEEN_FM_RIGHT_DEFAULT : '/tmp/mnt', roots: [], items: [], selected: new Set(), focusName: '', anchorName: '', filter: '' },
    },
    connectForSide: 'left',
    pending: null, // { op, payload, conflicts }
    ws: { socket: null, jobId: '', token: '', pollTimer: null },
    jobStats: {}, // job_id -> { lastTsMs, lastBytes, speed }
    transfer: { xhr: null, kind: '', startedAtMs: 0, lastAtMs: 0, lastLoaded: 0, speed: 0 },
    renderToken: { left: 0, right: 0 },
    autoDiskDone: false,
    opsUi: {
      filter: 'all',
      hiddenIds: null, // Set<string>
      lastJobs: [],
    },
    trashUi: { lastLevel: '', lastTsMs: 0, lastNotice: '' },
  };

  // -------------------------- persisted panel state --------------------------
  function _panelsPersistSnapshot() {
    const pl = (S && S.panels) ? S.panels.left : null;
    const pr = (S && S.panels) ? S.panels.right : null;
    return {
      left: {
        target: String((pl && pl.target) || 'local'),
        cwd: String((pl && pl.cwd) || ''),
        filter: String((pl && pl.filter) || ''),
      },
      right: {
        target: String((pr && pr.target) || 'local'),
        cwd: String((pr && pr.cwd) || ''),
        filter: String((pr && pr.filter) || ''),
      },
    };
  }

  // Apply persisted state on first init of the state container.
  try {
    const defaults = {
      left: { target: S.panels.left.target, cwd: S.panels.left.cwd, filter: S.panels.left.filter },
      right: { target: S.panels.right.target, cwd: S.panels.right.cwd, filter: S.panels.right.filter },
    };
    const loaded = loadPanelsPref(defaults);
    if (loaded && loaded.left) {
      S.panels.left.target = String(loaded.left.target || S.panels.left.target || 'local');
      S.panels.left.cwd = String(loaded.left.cwd || S.panels.left.cwd || '');
      S.panels.left.filter = String(loaded.left.filter || '');
    }
    if (loaded && loaded.right) {
      S.panels.right.target = String(loaded.right.target || S.panels.right.target || 'local');
      S.panels.right.cwd = String(loaded.right.cwd || S.panels.right.cwd || '');
      S.panels.right.filter = String(loaded.right.filter || '');
    }
  } catch (e) {}

  try {
    const side = loadActiveSidePref();
    if (side === 'left' || side === 'right') S.activeSide = side;
  } catch (e) {}

  // Persist on change (debounced) without touching call sites.
  let _panelsSaveT = null;
  function _schedulePanelsSave() {
    try {
      if (_panelsSaveT) clearTimeout(_panelsSaveT);
      _panelsSaveT = setTimeout(() => {
        _panelsSaveT = null;
        try { savePanelsPref(_panelsPersistSnapshot()); } catch (e) {}
      }, 200);
    } catch (e) {}
  }

  function _watchPanelProps(panelObj) {
    if (!panelObj || typeof panelObj !== 'object') return panelObj;

    // Use Proxy when possible, fallback to defineProperty.
    if (typeof Proxy === 'function') {
      return new Proxy(panelObj, {
        set(target, prop, value) {
          const prev = target[prop];
          // eslint-disable-next-line no-param-reassign
          target[prop] = value;
          if ((prop === 'cwd' || prop === 'target' || prop === 'filter') && prev !== value) {
            _schedulePanelsSave();
          }
          return true;
        },
      });
    }

    // Old browsers: wrap just the persisted props.
    try {
      ['cwd', 'target', 'filter'].forEach((k) => {
        if (!Object.prototype.hasOwnProperty.call(panelObj, k)) return;
        const desc = Object.getOwnPropertyDescriptor(panelObj, k);
        if (desc && desc.get && desc.set) return;

        let v = panelObj[k];
        Object.defineProperty(panelObj, k, {
          configurable: true,
          enumerable: true,
          get() { return v; },
          set(next) {
            const prev = v;
            v = next;
            if (prev !== next) _schedulePanelsSave();
          },
        });
      });
    } catch (e) {}

    return panelObj;
  }

  try {
    ST.__panelPersistWrapped = ST.__panelPersistWrapped || false;
    if (!ST.__panelPersistWrapped && S && S.panels) {
      ST.__panelPersistWrapped = true;
      S.panels.left = _watchPanelProps(S.panels.left);
      S.panels.right = _watchPanelProps(S.panels.right);
    }
  } catch (e) {}

  function panelEl(side) {
    return qs(`.fm-panel[data-side="${side}"]`, el('fm-root'));
  }

  function panelDom(side) {
    const root = panelEl(side);
    if (!root) return null;
    return {
      root,
      targetSelect: qs('.fm-target-select', root),
      connectBtn: qs('.fm-connect-btn', root),
      disconnectBtn: qs('.fm-disconnect-btn', root),
      pathInput: qs('.fm-path-input', root),
      rootBtn: qs('.fm-root-btn', root),
      upBtn: qs('.fm-up-btn', root),
      refreshBtn: qs('.fm-refresh-btn', root),
      clearTrashBtn: qs('.fm-clear-trash-btn', root),
      filterInput: qs('.fm-filter-input', root),
      filterClearBtn: qs('.fm-filter-clear-btn', root),
      list: qs('.fm-list', root),
    };
  }

  function updateFmFooterNavButtons() {
    const clearTrashBtn = el('fm-clear-trash-active-btn');
    if (!clearTrashBtn) return;

    // "Очистить корзину" is only relevant for the local trash root.
    let isTrash = false;
    try {
      const p = S && S.panels ? S.panels[S.activeSide] : null;
      const fn = (ST && typeof ST.isTrashPanel === 'function') ? ST.isTrashPanel : null;
      if (fn) {
        isTrash = !!fn(p);
      } else {
        // Fallback for early init: default trash root.
        const cwd = String((p && p.cwd) || '').replace(/\/+$/, '');
        isTrash = !!p && String(p.target || 'local') === 'local' && (cwd === '/opt/var/trash' || cwd.startsWith('/opt/var/trash/'));
      }
    } catch (e) { isTrash = false; }

    try { clearTrashBtn.classList.toggle('hidden', !isTrash); } catch (e) {}
  }

  function setActiveSide(side) {
    if (side !== 'left' && side !== 'right') return;
    S.activeSide = side;

    try { saveActiveSidePref(side); } catch (e0) {}

    ['left', 'right'].forEach((s) => {
      const d = panelDom(s);
      if (!d) return;
      try { d.root.classList.toggle('fm-panel-active', s === side); } catch (e) {}
    });

    try { updateFmFooterNavButtons(); } catch (e) {}

    // Footer status depends on active side (best-effort)
    try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
  }

  function otherSide(side) {
    return side === 'left' ? 'right' : 'left';
  }

  // exports
  ST.S = S;
  ST.panelEl = panelEl;
  ST.panelDom = panelDom;
  ST.setActiveSide = setActiveSide;
  ST.updateFmFooterNavButtons = updateFmFooterNavButtons;
  ST.otherSide = otherSide;
})();
