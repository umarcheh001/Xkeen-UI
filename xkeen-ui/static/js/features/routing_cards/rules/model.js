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
  function markDirty(v) {
    S._dirty = !!v;
    const btn = $(IDS.rulesApply);
    if (btn) {
      // In compact UI we keep icon-only apply button and show "dirty" via styling + tooltip.
      if (btn.classList && btn.classList.contains('btn-icon')) {
        btn.classList.toggle('is-dirty', S._dirty);
        btn.setAttribute('data-tooltip', S._dirty
          ? 'Применить изменения в JSON-редактор (есть несохранённые изменения)'
          : 'Применить изменения в JSON-редактор');
        btn.setAttribute('aria-label', S._dirty
          ? 'Применить в JSON (есть изменения)'
          : 'Применить в JSON');
      } else {
        btn.textContent = S._dirty ? '💾 Применить в JSON *' : '💾 Применить в JSON';
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

  function buildRootFromModel() {
    const m = ensureModel();
    const routing = {
      ...(S._rootHasKey ? (S._root && S._root.routing ? S._root.routing : {}) : (S._root || {})),
      domainStrategy: m.domainStrategy || undefined,
      rules: (Array.isArray(m.rules) ? m.rules : []).map(_stripInternalDeep),
      balancers: (Array.isArray(m.balancers) ? m.balancers : []).map(_stripInternalDeep),
    };

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

  // Public interface
  M.ensureModel = ensureModel;
  M.markDirty = markDirty;
  M.extractRoutingFromRoot = extractRoutingFromRoot;

  M.loadModelFromEditor = loadModelFromEditor;
  M.loadFromEditor = loadModelFromEditor;

  M.buildRootFromModel = buildRootFromModel;
  M.buildRoot = buildRootFromModel;
})();
