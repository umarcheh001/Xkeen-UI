/*
  routing_cards/rules/model.js
  Rules card: model/root IO + dirty flag control.

  RC-07a
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};
  const S = RC.rules.state = RC.rules.state || {};

  RC.rules.model = RC.rules.model || {};
  const M = RC.rules.model;

  const IDS = RC.IDS || {};
  const C = RC.common || {};

  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };
  const safeJsonParse = (typeof C.safeJsonParse === 'function') ? C.safeJsonParse : function (text) {
    try { return JSON.parse(String(text || '')); } catch (e) { return { __error: e }; }
  };
  const getEditorText = (typeof C.getEditorText === 'function') ? C.getEditorText : function () {
    try {
      if (XK.state && XK.state.routingEditor && typeof XK.state.routingEditor.getValue === 'function') {
        return XK.state.routingEditor.getValue();
      }
    } catch (e) {}
    const ta = document.getElementById('routing-editor');
    return ta ? ta.value : '';
  };

  function ensureModel() {
    if (!S._model) {
      S._model = { domainStrategy: '', rules: [], balancers: [] };
    }
    if (!S._model.rules) S._model.rules = [];
    if (!S._model.balancers) S._model.balancers = [];
    return S._model;
  }


// Strip internal draft keys ("__xk*") when exporting model to JSON editor.
function _stripInternalDeep(v) {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map(_stripInternalDeep);
  if (typeof v !== 'object') return v;
  const out = {};
  Object.keys(v).forEach((k) => {
    if (String(k).startsWith('__xk')) return;
    out[k] = _stripInternalDeep(v[k]);
  });
  return out;
}

// Public helper: sanitize a single rule/balancer object for export.
M.sanitizeForExport = function (obj) {
  return _stripInternalDeep(obj);
};

// Public helper: sanitize the whole model for export.
M.sanitizeModelForExport = function (model) {
  const mm = model || ensureModel();
  return {
    domainStrategy: String(mm.domainStrategy || ''),
    rules: (Array.isArray(mm.rules) ? mm.rules : []).map(_stripInternalDeep),
    balancers: (Array.isArray(mm.balancers) ? mm.balancers : []).map(_stripInternalDeep),
  };
};

  function _editorDirtyFromCards() {
    return !!S._editorDirtyFromCards;
  }

  function _isApplyButtonDirty() {
    return !!S._dirty || _editorDirtyFromCards();
  }

  function refreshApplyButtonState() {
    const btn = $(IDS.rulesApply);
    if (!btn) return;
    const dirty = _isApplyButtonDirty();
    const tip = dirty
      ? (S._dirty
          ? 'Применить изменения в JSON-редактор (есть несохранённые изменения в карточках)'
          : 'Изменения из карточек уже попали в редактор, но сам файл ещё не сохранён')
      : 'Применить изменения в JSON-редактор';
    const label = dirty
      ? (S._dirty ? 'Применить в JSON (есть изменения)' : 'Изменения из карточек применены в редактор')
      : 'Применить в JSON';
    if (btn.classList && btn.classList.contains('btn-icon')) {
      btn.classList.toggle('is-dirty', dirty);
      btn.setAttribute('data-tooltip', tip);
      btn.setAttribute('aria-label', label);
    } else {
      btn.textContent = dirty ? '💾 Применить в JSON *' : '💾 Применить в JSON';
    }
  }

  function markDirty(v) {
    S._dirty = !!v;
    refreshApplyButtonState();
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

  // opts:
  //  - setError: boolean (default true) - whether to set S._error on parse failure.
  function loadModelFromEditor(opts) {
    const o = opts || {};
    const setError = (o.setError !== false);
    const raw = getEditorText();
    const parsed = safeJsonParse(raw);
    if (parsed && parsed.__error) {
      // IMPORTANT: while the editor is being programmatically updated (load/switch engine),
      // it may be transiently incomplete. In such cases we must NOT wipe UI state.
      if (setError) {
        try {
          if (C && typeof C.normalizeError === 'function') S._error = C.normalizeError(parsed.__error, { action: 'parse_editor_json' });
        } catch (e) {
          try {
            S._error = {
              code: 'json_parse',
              message: 'Ошибка JSON',
              hint: 'Проверьте синтаксис JSON в редакторе.',
              retryable: false,
              details: String(parsed.__error && parsed.__error.message ? parsed.__error.message : parsed.__error),
            };
          } catch (e2) {}
        }
      }
      return { ok: false, error: parsed.__error };
    }

    const { root, routing, hasKey } = extractRoutingFromRoot(parsed);
    S._root = root;
    S._rootHasKey = hasKey;
    S._routingKeyPresence = {
      domainStrategy: !!(routing && typeof routing === 'object' && !Array.isArray(routing) && Object.prototype.hasOwnProperty.call(routing, 'domainStrategy')),
      rules: !!(routing && typeof routing === 'object' && !Array.isArray(routing) && Object.prototype.hasOwnProperty.call(routing, 'rules')),
      balancers: !!(routing && typeof routing === 'object' && !Array.isArray(routing) && Object.prototype.hasOwnProperty.call(routing, 'balancers')),
    };

    const model = {
      domainStrategy: String(routing.domainStrategy || ''),
      rules: Array.isArray(routing.rules) ? routing.rules.slice() : [],
      balancers: Array.isArray(routing.balancers) ? routing.balancers.slice() : [],
    };
    S._model = model;

    // Clear errors on successful parse.
    try { S._error = null; } catch (e) {}

    try { if (S._openSet && S._openSet.clear) S._openSet.clear(); } catch (e) {}
    S._dragRuleIdx = null;
    S._dropInsertIdx = null;
    if (S._placeholderEl && S._placeholderEl.parentNode) {
      try { S._placeholderEl.parentNode.removeChild(S._placeholderEl); } catch (e) {}
    }
    S._placeholderEl = null;

    // Reset pointer DnD state too (safe).
    S._pDndActive = false;
    S._pDndStarted = false;
    S._pDndPointerId = null;
    S._pDndFromIdx = null;
    S._pDndCardEl = null;
    if (S._pDndGhostEl && S._pDndGhostEl.parentNode) {
      try { S._pDndGhostEl.parentNode.removeChild(S._pDndGhostEl); } catch (e) {}
    }
    S._pDndGhostEl = null;

    markDirty(false);
    return { ok: true, model };
  }


  function _normTag(tag) {
    return String(tag || '').trim();
  }

  function countRulesUsingBalancer(tag) {
    const t = _normTag(tag);
    if (!t) return 0;
    const m = ensureModel();
    const rules = Array.isArray(m.rules) ? m.rules : [];
    let n = 0;
    rules.forEach((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return;
      if (_normTag(r.balancerTag) === t) n += 1;
    });
    return n;
  }

  function retargetRulesForBalancer(oldTag, newTag) {
    const from = _normTag(oldTag);
    const to = _normTag(newTag);
    if (!from || !to || from === to) return 0;
    const m = ensureModel();
    const rules = Array.isArray(m.rules) ? m.rules : [];
    let changed = 0;
    rules.forEach((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return;
      if (_normTag(r.balancerTag) !== from) return;
      r.balancerTag = to;
      changed += 1;
    });
    return changed;
  }

  function removeBalancerAt(idx, opts) {
    const o = opts || {};
    const removeRules = (o.removeRules !== false);
    const m = ensureModel();
    if (!Array.isArray(m.balancers)) m.balancers = [];
    if (!Array.isArray(m.rules)) m.rules = [];
    const i = Number(idx);
    if (!Number.isInteger(i) || i < 0 || i >= m.balancers.length) {
      return { ok: false, removed: null, removedTag: '', removedRules: 0 };
    }

    const removed = m.balancers[i];
    const removedTag = _normTag(removed && removed.tag);
    m.balancers.splice(i, 1);

    let removedRules = 0;
    if (removeRules && removedTag) {
      const nextRules = [];
      m.rules.forEach((r) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) {
          nextRules.push(r);
          return;
        }
        if (_normTag(r.balancerTag) === removedTag) {
          removedRules += 1;
          return;
        }
        nextRules.push(r);
      });
      m.rules = nextRules;
    }

    return { ok: true, removed, removedTag, removedRules };
  }

  function buildRootFromModel() {
    const m = ensureModel();
    const presence = S._routingKeyPresence || {};
    const baseRouting = S._rootHasKey ? (S._root && S._root.routing ? S._root.routing : {}) : (S._root || {});
    const routing = {
      ...baseRouting,
      rules: (Array.isArray(m.rules) ? m.rules : []).map(_stripInternalDeep),
    };

    const domainStrategy = String(m.domainStrategy || '').trim();
    if (domainStrategy || presence.domainStrategy) routing.domainStrategy = domainStrategy || undefined;
    else delete routing.domainStrategy;

    const balancers = (Array.isArray(m.balancers) ? m.balancers : []).map(_stripInternalDeep);
    if (balancers.length || presence.balancers) routing.balancers = balancers;
    else delete routing.balancers;

    // Clean undefined keys
    Object.keys(routing).forEach((k) => {
      if (routing[k] === undefined) delete routing[k];
    });

    let out;
    if (S._rootHasKey) {
      out = { ...(S._root || {}) };
      out.routing = routing;
    } else {
      out = routing;
    }
    return out;
  }


  try {
    if (!document.__xkRulesApplyDirtyHooked) {
      document.addEventListener('xkeen:routing-editor-dirty', function (ev) {
        try {
          const dirty = !!(ev && ev.detail && ev.detail.dirty);
          if (!dirty) S._editorDirtyFromCards = false;
          refreshApplyButtonState();
        } catch (e) {}
      });
      document.__xkRulesApplyDirtyHooked = true;
    }
  } catch (e) {}

  // Public interface
  M.ensureModel = ensureModel;
  M.markDirty = markDirty;
  M.refreshApplyButtonState = refreshApplyButtonState;
  M.extractRoutingFromRoot = extractRoutingFromRoot;

  M.loadModelFromEditor = loadModelFromEditor;
  M.loadFromEditor = loadModelFromEditor;

  M.buildRootFromModel = buildRootFromModel;
  M.buildRoot = buildRootFromModel;

  M.countRulesUsingBalancer = countRulesUsingBalancer;
  M.retargetRulesForBalancer = retargetRulesForBalancer;
  M.removeBalancerAt = removeBalancerAt;
})();
