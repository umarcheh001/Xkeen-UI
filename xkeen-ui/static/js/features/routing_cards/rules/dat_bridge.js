/*
  routing_cards/rules/dat_bridge.js
  Bridge between DAT card (GeoSite/GeoIP picker) and Rules card model.

  RC-10a

  Public API:
    RC.rules.datBridge.ensureRulesCardOpen()
    RC.rules.datBridge.scrollRuleIntoView(idx)
    RC.rules.datBridge.getDatRoutingTargets()
    RC.rules.datBridge.mostCommonOutboundTag(rules)
    RC.rules.datBridge.appendUniqueListValue(rule, key, value)
    RC.rules.datBridge.applyDatSelector(opts)
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};
  const RR = RC.rules.render = RC.rules.render || {};
  const RF = RC.rules.fields = RC.rules.fields || {};
  const RD = RC.rules.detect = RC.rules.detect || {};
  const RA = RC.rules.apply = RC.rules.apply || {};

  RC.rules.datBridge = RC.rules.datBridge || {};
  const DB = RC.rules.datBridge;

  const IDS = RC.IDS || {};
  const LS_KEYS = RC.LS_KEYS || {};
  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : (id) => document.getElementById(id);

  function ensureRulesCardOpen() {
    const body = $(IDS.rulesBody);
    const arrow = $(IDS.rulesArrow);
    if (body && body.style.display === 'none') {
      body.style.display = '';
      if (arrow) arrow.textContent = '▼';
      try { localStorage.setItem((LS_KEYS.rulesOpen || 'xk.routing.rules.open.v2'), '1'); } catch (e) {}
    }
  }

  function scrollRuleIntoView(idx) {
    const list = $(IDS.rulesList);
    if (!list) return;
    const el = list.querySelector(`.routing-rule-card[data-idx="${idx}"]`);
    if (!el) return;
    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
  }

  function pulseRuleCardByIdx(idx) {
    const list = $(IDS.rulesList);
    if (!list) return;
    const el = list.querySelector(`.routing-rule-card[data-idx="${idx}"]`);
    if (!el) return;
    try {
      el.classList.add('is-drop-pulse');
      setTimeout(() => {
        try { el.classList.remove('is-drop-pulse'); } catch (e) {}
      }, 750);
    } catch (e) {}
  }

  function ensureModel() {
    if (RM && typeof RM.ensureModel === 'function') return RM.ensureModel();
    if (!S._model) S._model = { domainStrategy: '', rules: [], balancers: [] };
    if (!S._model.rules) S._model.rules = [];
    if (!S._model.balancers) S._model.balancers = [];
    return S._model;
  }

  function markDirty(v) {
    if (RM && typeof RM.markDirty === 'function') return RM.markDirty(v);
    S._dirty = !!v;
  }

  function summarizeRule(rule) {
    if (RR && typeof RR.summarizeRule === 'function') return RR.summarizeRule(rule);
    return { title: (rule && rule.ruleTag) ? String(rule.ruleTag) : 'rule', match: '' };
  }

  function renderAll() {
    try { if (RR && typeof RR.renderAll === 'function') return RR.renderAll(); } catch (e) {}
  }

  function requestAutoSync(opts) {
    try {
      if (RA && typeof RA.requestAutoApply === 'function') {
        RA.requestAutoApply(opts || {});
      }
    } catch (e) {}
  }

  function normalizeListValue(v) {
    if (RF && typeof RF.normalizeListValue === 'function') return RF.normalizeListValue(v);
    if (Array.isArray(v)) return v.map((x) => String(x));
    if (v == null) return [];
    const s = String(v).trim();
    return s ? [s] : [];
  }

  function setRuleValue(rule, key, value) {
    if (RF && typeof RF.setRuleValue === 'function') return RF.setRuleValue(rule, key, value);
    rule[key] = value;
  }

  function getDatRoutingTargets() {
    // Do NOT reload from editor if user has local unsaved changes.
    if (!S._root && !S._dirty) {
      try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
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

  function _walkDeep(val, fn, depth) {
    try {
      if (RD && typeof RD._walkDeep === 'function') return RD._walkDeep(val, fn, depth);
    } catch (e) {}
    // Fallback (should not happen when detect.js is loaded)
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
    try {
      if (RD && typeof RD._basenameLower === 'function') return RD._basenameLower(s);
    } catch (e) {}
    const v = String(s || '').trim();
    if (!v) return '';
    const parts = v.split(/[\/]/);
    return String(parts[parts.length - 1] || '').toLowerCase();
  }

  function applyDatSelector(opts) {
    const kind = (opts && opts.kind === 'geoip') ? 'geoip' : 'geosite';
    const tag = String(opts && opts.tag ? opts.tag : '').trim();
    if (!tag) return { ok: false, error: 'tag_required' };

    // Prefer ext:<file>.dat:<tag> when caller passes DAT path.
    const datPath = String(opts && opts.datPath ? opts.datPath : '').trim();
    let selector = (kind === 'geoip' ? 'geoip:' : 'geosite:') + tag;

    if (datPath) {
      const p = datPath.replace(/\\/g, '/');
      const base = (p.split('/').pop() || '').trim();
      if (base) {
        // Prefer file-part already used in routing rules (handles geosite_zkeen.dat vs zkeen.dat).
        let filePart = base;
        const baseLc = String(base).toLowerCase();
        const kword = (kind === 'geoip') ? 'geoip' : 'geosite';

        try {
          if (!S._root && !S._dirty) {
            try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
          }
          const m0 = ensureModel();
          const rules0 = Array.isArray(m0.rules) ? m0.rules : [];
          const freq = new Map();

          rules0.forEach((r) => {
            _walkDeep(r, (s) => {
              const raw = String(s || '').trim();
              if (!raw) return;
              const lc = raw.toLowerCase();
              if (!lc.startsWith('ext:')) return;

              const restLc = lc.slice(4);
              const restRaw = raw.slice(4);
              const j = restLc.indexOf(':');
              if (j < 0) return;

              const fileLc = restLc.slice(0, j).trim();
              const fileRaw = restRaw.slice(0, j).trim();
              if (!fileLc) return;

              // ext:geoip:TAG / ext:geosite:TAG are kind-only, not a filename.
              if (fileLc === 'geoip' || fileLc === 'geosite') return;

              // Only consider files that look like the same kind.
              const looksKind = (kword === 'geoip')
                ? (fileLc === 'geoip' || fileLc.includes('geoip'))
                : (fileLc === 'geosite' || fileLc.includes('geosite'));
              if (!looksKind) return;

              const fbase = _basenameLower(fileLc);
              if (!fbase) return;

              // Match either exact basename or common suffix matches.
              if (fbase === baseLc || fbase.endsWith('_' + baseLc) || fbase.endsWith('-' + baseLc) || fbase.endsWith(baseLc)) {
                const key = fileRaw || fileLc;
                freq.set(key, (freq.get(key) || 0) + 1);
              }
            }, 0);
          });

          let best = '';
          let bestN = 0;
          freq.forEach((n, v) => {
            if (n > bestN) { bestN = n; best = v; }
          });
          if (best) filePart = best;
        } catch (e) {}

        selector = 'ext:' + filePart + ':' + tag;
      }
    }

    const fieldKey = (kind === 'geoip') ? 'ip' : 'domain';
    const mode = String(opts && opts.mode ? opts.mode : 'new');

    if (!S._root && !S._dirty) {
      try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
    }
    const m = ensureModel();
    if (!Array.isArray(m.rules)) m.rules = [];

    // Make sure rules card is visible (it is often collapsed by default).
    ensureRulesCardOpen();

    // Clear filter so the target rule is always visible.
    try {
      S._filter = '';
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
      try { S._openSet.add(r); } catch (e) {}
    } else {
      const rules = m.rules;
      const outboundTag = String(opts && opts.outboundTag ? opts.outboundTag : '').trim()
        || mostCommonOutboundTag(rules)
        || 'direct';
      const rule = { type: 'field', outboundTag, ruleTag: selector };
      rule[fieldKey] = [selector];
      rules.push(rule);
      idx = rules.length - 1;
      created = true;
      added = true;
      try { S._openSet.add(rule); } catch (e) {}
    }

    if (created || added) markDirty(true);
    renderAll();

    // Old behavior: immediately reflect changes in the main JSON editor.
    if (created || added) requestAutoSync({ immediate: true });

    // Scroll/pulse after DOM updates
    setTimeout(() => {
      try { scrollRuleIntoView(idx); } catch (e) {}
      try { pulseRuleCardByIdx(idx); } catch (e) {}
    }, 20);

    return { ok: true, idx, created, added };
  }

  // Public API
  DB.ensureRulesCardOpen = ensureRulesCardOpen;
  DB.scrollRuleIntoView = scrollRuleIntoView;
  DB.getDatRoutingTargets = getDatRoutingTargets;
  DB.mostCommonOutboundTag = mostCommonOutboundTag;
  DB.appendUniqueListValue = appendUniqueListValue;
  DB.applyDatSelector = applyDatSelector;
})();
