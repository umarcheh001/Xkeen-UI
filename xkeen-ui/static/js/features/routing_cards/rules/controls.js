import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/rules/controls.js
  Rules card: UI wiring + editor hooks.

  RC-08c
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.rules = RC.rules || {};

  const CTRL = RC.rules.controls = RC.rules.controls || {};

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};
  const RA = RC.rules.apply = RC.rules.apply || {};
  const JM = RC.rules.jsonModal = RC.rules.jsonModal || {};
  const RR = RC.rules.render = RC.rules.render || {};

  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};

  const C = RC.common || {};
  const COLL = RC.collapse || {};

  // Helpers (prefer RC.common / RC.collapse, but keep safe fallbacks)
  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };
  const toast = (typeof C.toast === 'function') ? C.toast : function (msg) { try { console.log(msg); } catch (e) {} };
  const confirmModal = (typeof C.confirmModal === 'function') ? C.confirmModal : async function () { return window.confirm('OK?'); };
  const debounce = (typeof C.debounce === 'function') ? C.debounce : function (fn, ms) {
    let t = null;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms || 0);
    };
  };
  const editorInstance = (typeof C.editorInstance === 'function') ? C.editorInstance : function () { return null; };
  const isViewVisible = (typeof C.isViewVisible === 'function') ? C.isViewVisible : function () {
    const v = document.getElementById('view-routing');
    if (!v) return false;
    const st = window.getComputedStyle(v);
    return st && st.display !== 'none' && st.visibility !== 'hidden';
  };

  const wireCollapse = (typeof COLL.wireCollapse === 'function') ? COLL.wireCollapse : function (headerId, bodyId, arrowId) {
    const h = $(headerId), b = $(bodyId), a = $(arrowId);
    if (!h || !b || !a) return;
    // naive fallback: toggle display
    h.addEventListener('click', () => {
      const open = b.style.display === 'none';
      b.style.display = open ? '' : 'none';
        a.textContent = open ? '▲' : '▼';
    });
  };

  const PERF_LIMITS = {
    softLines: 1800,
    softChars: 110000,
  };

  function isMipsTarget() {
    try {
      if (typeof window.XKEEN_IS_MIPS === 'boolean') return !!window.XKEEN_IS_MIPS;
      const v = String(window.XKEEN_IS_MIPS || '').toLowerCase();
      return v === '1' || v === 'true' || v === 'yes' || v === 'on';
    } catch (e) {}
    return false;
  }

  function isWebKitSafari() {
    try {
      const nav = window.navigator || {};
      const ua = String(nav.userAgent || '');
      const vendor = String(nav.vendor || '');
      if (!ua) return false;
      if (!/Safari/i.test(ua)) return false;
      if (!/Apple/i.test(vendor)) return false;
      if (/(Chrome|Chromium|CriOS|Edg|OPR|OPT|Opera|Vivaldi|DuckDuckGo|Firefox|FxiOS|Arc|Brave)/i.test(ua)) return false;
      return true;
    } catch (e) {}
    return false;
  }

  function countLines(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return 1;
    let out = 1;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw.charCodeAt(i) === 10) out += 1;
    }
    return out;
  }

  function getEditorTextSnapshot() {
    try {
      if (C && typeof C.getEditorText === 'function') return String(C.getEditorText() || '');
    } catch (e) {}
    const cm = editorInstance();
    try {
      if (cm && typeof cm.getValue === 'function') return String(cm.getValue() || '');
    } catch (e) {}
    const ta = $('routing-editor');
    return ta ? String(ta.value || '') : '';
  }

  function computeGuiPerfProfile(text) {
    const raw = String(text == null ? '' : text);
    const lineCount = countLines(raw);
    const charCount = raw.length;
    const lite = !!(isMipsTarget() || lineCount >= PERF_LIMITS.softLines || charCount >= PERF_LIMITS.softChars);
    return {
      lite,
      manualSync: lite,
      lineCount,
      charCount,
    };
  }

  function resolveGuiPerfProfile(input) {
    if (input && typeof input === 'object') {
      const lite = !!input.lite;
      return {
        lite,
        manualSync: (typeof input.manualSync === 'boolean') ? !!input.manualSync : lite,
        lineCount: Number.isFinite(input.lineCount) ? Math.max(1, Math.floor(input.lineCount)) : 1,
        charCount: Number.isFinite(input.charCount) ? Math.max(0, Math.floor(input.charCount)) : 0,
      };
    }
    return computeGuiPerfProfile(typeof input === 'string' ? input : getEditorTextSnapshot());
  }

  function syncGuiPerfMode(input) {
    const profile = resolveGuiPerfProfile(input);
    S._perfLite = !!profile.lite;
    S._manualGuiSync = !!profile.manualSync;

    const body = $(IDS.rulesBody);
    if (body && body.dataset) body.dataset.syncMode = profile.manualSync ? 'manual' : 'live';

    const refreshBtn = $(IDS.rulesRefresh);
    if (refreshBtn && refreshBtn.dataset) refreshBtn.dataset.syncMode = profile.manualSync ? 'manual' : 'live';

    return profile;
  }

  function markRulesStale(flag) {
    const stale = !!flag;
    S._rulesStale = stale;
    const refreshBtn = $(IDS.rulesRefresh);
    if (refreshBtn && refreshBtn.dataset) refreshBtn.dataset.stale = stale ? '1' : '0';
  }

  function shouldSkipLiveSync(detail, profile) {
    if (!profile || !profile.manualSync) return false;
    const d = detail || {};
    if (d.forceRender === true || d.setError === true) return false;
    const reason = String(d.reason || '');
    return reason === '' || reason === 'edit' || reason === 'change';
  }

  function syncDomainStrategySelect() {
    const ds = $(IDS.domainStrategy);
    if (!ds) return;
    const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (S._model || {});
    const v = String(m.domainStrategy || '');
    if (ds.value !== v) ds.value = v;
  }

  // opts:
  //  - setError: boolean (default false) - if true, show inline error UI on parse failure.
  function renderFromEditor(opts) {
    if (!isViewVisible()) return;
    const o = opts || {};
    const setError = !!o.setError; // default: false (do not wipe lists on transient editor updates)
    syncGuiPerfMode(typeof o.text === 'string' ? o.text : null);
    const r = (RM && typeof RM.loadFromEditor === 'function')
      ? RM.loadFromEditor({ setError })
      : { ok: false, error: 'no model' };
    if (!r.ok) {
      // When setError is false, this is typically a transient parse failure while the editor
      // is being programmatically updated (loading/switching engine). Keep the last good UI.
      if (!setError) return;

      const c = $(IDS.rulesCount);
      if (c) c.textContent = 'ошибка JSON';
      // Explicit reload: show inline error UI.
      try { if (RR && typeof RR.renderAll === 'function') RR.renderAll(); } catch (e) {}
      return;
    }
    syncDomainStrategySelect();
    markRulesStale(false);
    if (RR && typeof RR.renderAll === 'function') RR.renderAll();
  }

  function hookEditorChanges() {
    const cm = editorInstance();
    if (!cm || typeof cm.on !== 'function') return;
    if (cm.__xkRoutingRulesHooked) return;
    cm.__xkRoutingRulesHooked = true;
    cm.on('change', debounce(() => {
      if (S._suppressEditorChange) return;
      if (S.__rulesEditorContentWired) {
        return;
      }
      const profile = syncGuiPerfMode();
      if (profile.manualSync) {
        markRulesStale(true);
        return;
      }
      // Avoid heavy re-render when rules card is collapsed
      const body = $(IDS.rulesBody);
      const isOpen = body && body.style.display !== 'none';
      if (!isOpen) return;
      renderFromEditor({ setError: false });
    }, 250));
  }

  function wireEditorContentEvents() {
    if (S.__rulesEditorContentWired) return;
    S.__rulesEditorContentWired = true;

    const onContent = debounce((ev) => {
      if (!isViewVisible()) return;
      const detail = (ev && ev.detail) ? ev.detail : {};
      const profile = syncGuiPerfMode(detail.profile || null);
      const body = $(IDS.rulesBody);
      const isOpen = !!(body && body.style.display !== 'none');

      // When GUI card is collapsed, keep the internal model fresh so the next open
      // shows current JSON immediately, but skip expensive full re-render.
      if (!isOpen) {
        if (shouldSkipLiveSync(detail, profile)) {
          markRulesStale(true);
          return;
        }
        try {
          const r = (RM && typeof RM.loadFromEditor === 'function')
            ? RM.loadFromEditor({ setError: false })
            : { ok: false };
          if (r && r.ok) {
            syncDomainStrategySelect();
            markRulesStale(false);
          }
        } catch (e) {}
        return;
      }

      if (shouldSkipLiveSync(detail, profile)) {
        markRulesStale(true);
        return;
      }

      renderFromEditor({ setError: !!detail.setError });
    }, 140);

    try {
      document.addEventListener('xkeen:routing-editor-content', onContent);
    } catch (e) {}
  }

  function wireRulesControls() {
    // Avoid double wiring
    if (S.__rulesControlsWired) return;
    S.__rulesControlsWired = true;

    // Collapse (collapsed by default)
    wireCollapse(
      IDS.rulesHeader,
      IDS.rulesBody,
      IDS.rulesArrow,
      (LS_KEYS.rulesOpen || 'xk.routing.rules.open.v2'),
      () => {
        // Ensure fresh render when opened
        try { renderFromEditor({ setError: false }); } catch (e) {}
      },
      false
    );

    const filter = $(IDS.rulesFilter);
    if (filter) {
      filter.addEventListener('input', debounce(() => {
        S._filter = filter.value || '';
        if (RR && typeof RR.renderRules === 'function') RR.renderRules();
      }, 120));
    }

    const refreshBtn = $(IDS.rulesRefresh);
    if (refreshBtn) refreshBtn.addEventListener('click', (e) => {
      e.preventDefault();
      markRulesStale(false);
      if (RR && typeof RR.renderAll === 'function') RR.renderAll();
    });

    const reloadBtn = $(IDS.rulesReload);
    if (reloadBtn) reloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const r = (RM && typeof RM.loadFromEditor === 'function')
        ? RM.loadFromEditor({ setError: true })
        : { ok: false, error: 'no model' };
      if (!r.ok) {
        toast('Не удалось прочитать JSON: ' + String(r.error && r.error.message ? r.error.message : r.error), true);
      }
      markRulesStale(false);
      if (RR && typeof RR.renderAll === 'function') RR.renderAll();
    });

    const applyBtn = $(IDS.rulesApply);
    if (applyBtn) applyBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!S._dirty) {
        toast('Нет изменений для применения', false);
        return;
      }
      const canPreserve = (RA && typeof RA.canPreserve === 'function') ? !!RA.canPreserve() : false;
      const ok = await confirmModal({
        title: 'Применить изменения',
        message: canPreserve
          ? 'Применить изменения карточек в редактор JSON?\n(Попытаемся сохранить комментарии JSONC, если это возможно.)'
          : 'Перезаписать routing.rules / routing.balancers / domainStrategy в редакторе JSON?\n(Комментарии в JSONC будут потеряны.)',
        okText: 'Применить',
        cancelText: 'Отмена',
        danger: true,
      });
      if (!ok) return;
      const applied = (RA && typeof RA.applyToEditor === 'function') ? await RA.applyToEditor() : false;
      if (!applied) return;
      toast('Изменения применены в JSON', false);
    });

    const addBtn = $(IDS.rulesAdd);
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Ensure model is loaded from editor; otherwise applying will overwrite existing rules.
      try {
        const rr = (RM && typeof RM.loadFromEditor === 'function')
          ? RM.loadFromEditor({ setError: true })
          : { ok: false, error: 'no model' };
        if (!rr.ok) {
          toast('Сначала исправьте JSON в редакторе (или дождитесь загрузки файла).', true);
          try { if (RR && typeof RR.renderAll === 'function') RR.renderAll(); } catch (e2) {}
          return;
        }
      } catch (e2) {}
      const rule = { type: 'field', outboundTag: 'direct' };
      if (JM && typeof JM.open === 'function') JM.open(rule, 'Новое правило', { kind: 'rule', idx: -1, isNew: true });
    });

    const balAdd = $(IDS.balancerAdd);
    if (balAdd) balAdd.addEventListener('click', (e) => {
      e.preventDefault();
      // Ensure model is loaded from editor; otherwise applying will overwrite existing rules.
      try {
        const rr = (RM && typeof RM.loadFromEditor === 'function')
          ? RM.loadFromEditor({ setError: true })
          : { ok: false, error: 'no model' };
        if (!rr.ok) {
          toast('Сначала исправьте JSON в редакторе (или дождитесь загрузки файла).', true);
          try { if (RR && typeof RR.renderAll === 'function') RR.renderAll(); } catch (e2) {}
          return;
        }
      } catch (e2) {}
      const bal = { tag: 'balancer', selector: [], strategy: { type: 'random' } };
      if (JM && typeof JM.open === 'function') JM.open(bal, 'Новый балансировщик', { kind: 'balancer', idx: -1, isNew: true });
    });

    const ds = $(IDS.domainStrategy);
    if (ds) {
      ds.addEventListener('change', () => {
        const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (S._model || {});
        m.domainStrategy = ds.value || '';
        if (RM && typeof RM.markDirty === 'function') RM.markDirty(true);
        // Auto-sync like before (debounced)
        try {
          if (RA && typeof RA.requestAutoApply === 'function') RA.requestAutoApply({ wait: 250 });
        } catch (e) {}
      });
    }
  }

  function initRulesCard() {
    if (!$(IDS.rulesHeader) || !$(IDS.rulesBody)) return;

    wireRulesControls();
    syncGuiPerfMode();
    // First render: do NOT show error UI while editor is still loading.
    renderFromEditor({ setError: false });

    // Re-render after routing editor becomes ready
    document.addEventListener('xkeen-editors-ready', () => {
      try { hookEditorChanges(); } catch (e) {}
      try { wireEditorContentEvents(); } catch (e) {}
      try { renderFromEditor({ setError: false }); } catch (e) {}
    });

    // If editor is already ready
    setTimeout(() => {
      try { hookEditorChanges(); } catch (e) {}
      try { wireEditorContentEvents(); } catch (e) {}
      try { renderFromEditor({ setError: false }); } catch (e) {}
    }, 700);
  }

  // Public interface
  CTRL.wireRulesControls = wireRulesControls;
  CTRL.syncDomainStrategySelect = syncDomainStrategySelect;
  CTRL.renderFromEditor = renderFromEditor;
  CTRL.hookEditorChanges = hookEditorChanges;
  CTRL.wireEditorContentEvents = wireEditorContentEvents;
  CTRL.initRulesCard = initRulesCard;
})();
