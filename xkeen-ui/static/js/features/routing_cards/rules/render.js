/*
  routing_cards/rules/render.js
  Rules card: rendering of rules/balancers list + forms + DnD glue.

  RC-08b
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const R = RC.rules.render = RC.rules.render || {};

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};
  const JM = RC.rules.jsonModal = RC.rules.jsonModal || {};
  const RF = RC.rules.fields = RC.rules.fields || {};
  const RA = RC.rules.apply = RC.rules.apply || {};

  const IDS = RC.IDS || {};
  const C = RC.common || {};
  const HM = RC.helpModal || {};

  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };
  const toast = (typeof C.toast === 'function') ? C.toast : function (msg) { try { /* eslint-disable-next-line no-alert */ alert(String(msg || '')); } catch (e) {} };
  const confirmModal = (typeof C.confirmModal === 'function') ? C.confirmModal : async function (opts) {
    const msg = String((opts && (opts.message || opts.text)) || 'Confirm?');
    // eslint-disable-next-line no-restricted-globals
    return confirm(msg);
  };
  const safeJsonParse = (typeof C.safeJsonParse === 'function') ? C.safeJsonParse : function (text) {
    try { return JSON.parse(String(text || '')); } catch (e) { return { __error: e }; }
  };

  // NOTE: render.js may be loaded before other helpers; keep local safe fallback.
  const debounce = (typeof C.debounce === 'function') ? C.debounce : function (fn, wait) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait || 0);
    };
  };

  const openFieldHelp = (typeof HM.openFieldHelp === 'function') ? HM.openFieldHelp : function () {};

  const ensureModel = (typeof RM.ensureModel === 'function') ? RM.ensureModel : function () {
    if (!S._model) S._model = { domainStrategy: '', rules: [], balancers: [] };
    if (!S._model.rules) S._model.rules = [];
    if (!S._model.balancers) S._model.balancers = [];
    return S._model;
  };

  const markDirty = (typeof RM.markDirty === 'function') ? RM.markDirty : function (v) { S._dirty = !!v; };

  function requestAutoSync(opts) {
    try {
      if (RA && typeof RA.requestAutoApply === 'function') {
        RA.requestAutoApply(opts || {});
        return;
      }
    } catch (e) {}
    // Fallback (no debounce, legacy)
    try {
      if (RA && typeof RA.applyToEditor === 'function') {
        setTimeout(() => {
          try { Promise.resolve(RA.applyToEditor({ silent: true, confirmLegacyFallback: false, allowLegacyFallback: false })).catch(() => {}); } catch (e2) {}
        }, 0);
      }
    } catch (e) {}
  }

  // Field helpers (from rules/fields.js)
  const RULE_MULTI_FIELDS = RF.RULE_MULTI_FIELDS || [];
  const RULE_TEXT_FIELDS = RF.RULE_TEXT_FIELDS || [];

  const normalizeListValue = (typeof RF.normalizeListValue === 'function') ? RF.normalizeListValue : function (value) {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (value === null || typeof value === 'undefined') return [];
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
    try { return [JSON.stringify(value)]; } catch (e) { return [String(value)]; }
  };
  const splitMultiValue = (typeof RF.splitMultiValue === 'function') ? RF.splitMultiValue : function (raw) {
    return String(raw || '').split(/[\n,]+/).map((v) => v.trim()).filter(Boolean);
  };
  const formatMultiValue = (typeof RF.formatMultiValue === 'function') ? RF.formatMultiValue : function (values) {
    return (values || []).map((v) => String(v)).join('\n');
  };
  const parseAttrs = (typeof RF.parseAttrs === 'function') ? RF.parseAttrs : function (raw) {
    const out = {};
    String(raw || '').split('\n').forEach((line) => {
      const s = String(line || '').trim();
      if (!s) return;
      const eq = s.indexOf('=');
      const idx = (eq >= 0) ? eq : s.indexOf(':');
      if (idx < 0) return;
      const k = s.slice(0, idx).trim();
      const v = s.slice(idx + 1).trim();
      if (k) out[k] = v;
    });
    return out;
  };
  const formatAttrs = (typeof RF.formatAttrs === 'function') ? RF.formatAttrs : function (attrs) {
    if (!attrs || typeof attrs !== 'object') return '';
    return Object.entries(attrs).map(([k, v]) => `${k}=${v}`).join('\n');
  };
  const setRuleValue = (typeof RF.setRuleValue === 'function') ? RF.setRuleValue : function (rule, key, value) {
    if (!rule || !key) return;
    const v = value;
    if (v === null || typeof v === 'undefined' || (typeof v === 'string' && !String(v).trim()) || (Array.isArray(v) && !v.length)) {
      try { delete rule[key]; } catch (e) {}
      return;
    }
    rule[key] = v;
  };
  const autoResizeTextarea = (typeof RF.autoResizeTextarea === 'function') ? RF.autoResizeTextarea : function () {};
  const createRuleTextarea = (typeof RF.createRuleTextarea === 'function') ? RF.createRuleTextarea : function (value, placeholder, onChange) {
    const ta = document.createElement('textarea');
    ta.value = value || '';
    if (placeholder) ta.placeholder = placeholder;
    ta.addEventListener('input', () => onChange(ta.value));
    return ta;
  };
  const createRuleInput = (typeof RF.createRuleInput === 'function') ? RF.createRuleInput : function (value, placeholder, onChange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value || '';
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener('input', () => onChange(input.value));
    return input;
  };
  const buildKeyLabel = (typeof RF.buildKeyLabel === 'function') ? RF.buildKeyLabel : function (t) { const s = document.createElement('span'); s.textContent = t; return s; };
  const buildField = (typeof RF.buildField === 'function') ? RF.buildField : function (labelText, inputEl) { const d = document.createElement('label'); d.appendChild(document.createTextNode(labelText)); d.appendChild(inputEl); return d; };
  const createChipInput = (typeof RF.createChipInput === 'function') ? RF.createChipInput : function (values, opts) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = formatMultiValue(values || []);
    input.addEventListener('change', () => {
      if (opts && typeof opts.onChange === 'function') opts.onChange(splitMultiValue(input.value));
    });
    return input;
  };

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

  const RULE_INLINE_CHIP_FIELDS = new Set(['domain', 'ip', 'sourceIP', 'port']);
  const RULE_OPTIONAL_FIELDS = (() => {
    const list = [];
    (RULE_MULTI_FIELDS || []).forEach((field) => list.push({ ...field, kind: 'multi' }));
    (RULE_TEXT_FIELDS || []).forEach((field) => list.push({ ...field, kind: 'text' }));
    list.push({ key: 'attrs', label: 'attrs', placeholder: 'key=value', kind: 'attrs' });
    list.push({ key: 'domainMatcher', label: 'domainMatcher', placeholder: 'hybrid', kind: 'text' });
    return list;
  })();
  const RULE_OPTIONAL_FIELD_MAP = RULE_OPTIONAL_FIELDS.reduce((acc, field) => {
    acc[field.key] = field;
    return acc;
  }, {});

  function sanitizeRuleTag(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeOptionalFieldList(values) {
    const out = [];
    const seen = new Set();
    (Array.isArray(values) ? values : []).forEach((raw) => {
      const key = String(raw == null ? '' : raw).trim();
      if (!key || !RULE_OPTIONAL_FIELD_MAP[key] || seen.has(key)) return;
      seen.add(key);
      out.push(key);
    });
    return out;
  }

  function isFieldValuePresent(rule, key) {
    if (!rule || !key) return false;
    if (key === 'sourceIP') {
      const src = rule.sourceIP != null ? rule.sourceIP : rule.source;
      if (Array.isArray(src)) return src.length > 0;
      return !!String(src == null ? '' : src).trim();
    }
    if (key === 'attrs') {
      return !!(rule.attrs && typeof rule.attrs === 'object' && !Array.isArray(rule.attrs) && Object.keys(rule.attrs).length);
    }
    const value = rule[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return !!String(value == null ? '' : value).trim();
  }

  function ensureVisibleField(rule, key) {
    if (!rule || !key || !RULE_OPTIONAL_FIELD_MAP[key]) return;
    const next = normalizeOptionalFieldList((rule && rule.__xkVisibleFields) || []);
    if (next.indexOf(key) >= 0) return;
    next.push(key);
    rule.__xkVisibleFields = next;
  }

  function removeVisibleField(rule, key) {
    if (!rule) return;
    const next = normalizeOptionalFieldList((rule && rule.__xkVisibleFields) || []).filter((it) => it !== key);
    if (next.length) rule.__xkVisibleFields = next;
    else {
      try { delete rule.__xkVisibleFields; } catch (e) {}
    }
  }

  function getVisibleOptionalFieldKeys(rule) {
    const next = normalizeOptionalFieldList((rule && rule.__xkVisibleFields) || []);
    Object.keys(RULE_OPTIONAL_FIELD_MAP).forEach((key) => {
      if (isFieldValuePresent(rule, key) && next.indexOf(key) < 0) next.push(key);
    });
    return next;
  }

  function clearRuleField(rule, key) {
    if (!rule || !key) return;
    if (key === 'sourceIP') {
      try { delete rule.sourceIP; } catch (e) {}
      try { delete rule.source; } catch (e) {}
    } else if (key === 'attrs') {
      try { delete rule.attrs; } catch (e) {}
    } else {
      try { delete rule[key]; } catch (e) {}
    }
    removeVisibleField(rule, key);
  }

  function setPendingRuleFieldFocus(idx, key) {
    try {
      S._ruleFieldFocus = { idx: Number(idx), key: String(key || '') };
    } catch (e) {}
  }

  function consumePendingRuleFieldFocus(card, idx) {
    try {
      const req = S._ruleFieldFocus;
      if (!req || Number(req.idx) !== Number(idx) || !req.key) return;
      S._ruleFieldFocus = null;
      requestAnimationFrame(() => {
        try {
          const row = card.querySelector(`[data-field-key="${req.key}"]`);
          if (!row) return;
          const target = row.querySelector('[data-chip-input="1"], .routing-rule-input, .routing-rule-textarea, select, input, textarea');
          if (!target) return;
          target.focus();
          if (typeof target.select === 'function') target.select();
        } catch (e) {}
      });
    } catch (e) {}
  }

  function getRuleConditionKeys(rule) {
    const keys = [];
    ['inboundTag', 'domain', 'ip', 'port', 'sourceIP', 'source', 'sourcePort', 'localIP', 'localPort', 'network', 'protocol', 'user', 'attrs', 'domainMatcher', 'vlessRoute'].forEach((key) => {
      if (isFieldValuePresent(rule, key)) keys.push(key === 'source' ? 'sourceIP' : key);
    });
    return Array.from(new Set(keys));
  }

  // Compact header/match summary for a rule card.
  function summarizeRule(rule) {
    if (!rule || typeof rule !== 'object') {
      return { title: '(invalid)', match: 'без условий', type: 'field', target: '—', targetKind: 'outbound', ruleTag: '', geo: false, conditionKeys: [], conditionCount: 0 };
    }
    const type = String(rule.type || 'field');
    const targetKind = rule.balancerTag ? 'balancer' : 'outbound';
    const target = rule.outboundTag
      ? String(rule.outboundTag)
      : (rule.balancerTag ? String(rule.balancerTag) : '—');
    const ruleTag = sanitizeRuleTag(rule.ruleTag);

    const parts = [];
    const pushPart = (k, v) => {
      if (Array.isArray(v) && v.length) parts.push(`${k}:${v.slice(0, 2).join(',')}${v.length > 2 ? '…' : ''}`);
      else if (typeof v === 'string' && v) parts.push(`${k}:${v}`);
    };

    pushPart('inboundTag', rule.inboundTag);
    pushPart('domain', rule.domain);
    pushPart('ip', rule.ip);
    pushPart('port', rule.port);
    pushPart('network', rule.network);
    pushPart('protocol', rule.protocol);
    pushPart('sourceIP', rule.sourceIP != null ? rule.sourceIP : rule.source);
    pushPart('sourcePort', rule.sourcePort);
    pushPart('user', rule.user);
    if (rule.attrs && typeof rule.attrs === 'object' && !Array.isArray(rule.attrs) && Object.keys(rule.attrs).length) {
      parts.push(`attrs:${Object.keys(rule.attrs).slice(0, 2).join(',')}${Object.keys(rule.attrs).length > 2 ? '…' : ''}`);
    }

    const conditionKeys = getRuleConditionKeys(rule);
    const match = parts.length ? parts.join(' • ') : 'без условий';
    return {
      title: `# → ${target}`,
      match,
      type,
      target,
      targetKind,
      ruleTag,
      geo: anyGeo(rule),
      conditionKeys,
      conditionCount: conditionKeys.length,
    };
  }


  function updateJsonPreview(pre, rule) {
    if (!pre) return;
    try {
      const safeObj = (RM && typeof RM.sanitizeForExport === 'function') ? RM.sanitizeForExport(rule || {}) : (rule || {});
      const json = JSON.stringify(safeObj, null, 2);
      pre.textContent = json.length > 1800 ? (json.slice(0, 1800) + '\n…') : json;
    } catch (e) {
      pre.textContent = String(rule || '');
    }
  }

  function updateRuleHeadDom(rule, refs) {
    if (!refs) return;
    const sum = summarizeRule(rule);
    try {
      if (refs.typeBadge) refs.typeBadge.textContent = String(sum.type || 'field');
      if (refs.ruleTagBadge && !refs.ruleTagBadge.classList.contains('is-editing')) refs.ruleTagBadge.textContent = sum.ruleTag || 'без тега';
      if (refs.targetBadge) refs.targetBadge.textContent = `${sum.targetKind}: ${sum.target}`;
      if (refs.conditionBadge) refs.conditionBadge.textContent = `${sum.conditionCount} усл.`;
      if (refs.matchEl) refs.matchEl.textContent = sum.match;
      if (refs.geoBadgeEl) refs.geoBadgeEl.style.display = sum.geo ? '' : 'none';
      if (refs.condBadgesWrap) {
        refs.condBadgesWrap.innerHTML = '';
        sum.conditionKeys.slice(0, 3).forEach((key) => {
          const badge = document.createElement('span');
          badge.className = 'routing-rule-badge is-cond';
          badge.textContent = key;
          refs.condBadgesWrap.appendChild(badge);
        });
      }
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
    RULE_OPTIONAL_FIELDS.forEach((f) => known.add(f.key));
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


  function buildRuleForm(rule, idx, onChanged, requestRuleRerender) {
    const form = document.createElement('div');
    form.className = 'routing-rule-form';

    const rerenderRuleForm = (fieldKey) => {
      if (typeof requestRuleRerender === 'function') requestRuleRerender(fieldKey || '');
    };

    function attachOptionalFieldUi(fieldKey, fieldEl) {
      if (!fieldEl) return fieldEl;
      fieldEl.dataset.fieldKey = fieldKey;
      fieldEl.classList.add('routing-rule-field-optional');
      const keyWrap = fieldEl.querySelector('.routing-rule-key') || fieldEl.querySelector('.routing-rule-target-label');
      if (keyWrap) {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'routing-rule-remove-field';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', 'Убрать поле ' + String(fieldKey));
        removeBtn.setAttribute('title', 'Убрать поле');
        removeBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          clearRuleField(rule, fieldKey);
          if (typeof onChanged === 'function') onChanged();
          rerenderRuleForm('');
        });
        keyWrap.appendChild(removeBtn);
      }
      return fieldEl;
    }

    function buildOptionalRuleField(field) {
      if (!field) return null;
      if (field.kind === 'multi') {
        let values = normalizeListValue(rule ? rule[field.key] : null);
        if (field.key === 'sourceIP' && rule && !Object.prototype.hasOwnProperty.call(rule, 'sourceIP') && rule.source != null) {
          values = normalizeListValue(rule.source);
        }

        let control;
        if (RULE_INLINE_CHIP_FIELDS.has(field.key)) {
          control = createChipInput(values, {
            placeholder: field.placeholder,
            ariaLabel: field.label,
            onChange: (arr) => {
              if (field.key === 'sourceIP') {
                setRuleValue(rule, 'sourceIP', arr);
                try { delete rule.source; } catch (e) {}
              } else {
                setRuleValue(rule, field.key, arr);
              }
              ensureVisibleField(rule, field.key);
              if (typeof onChanged === 'function') onChanged();
            },
          });
        } else {
          control = createRuleTextarea(formatMultiValue(values), field.placeholder, (raw) => {
            const arr = splitMultiValue(raw);
            if (field.key === 'sourceIP') {
              setRuleValue(rule, 'sourceIP', arr);
              try { delete rule.source; } catch (e) {}
            } else {
              setRuleValue(rule, field.key, arr);
            }
            ensureVisibleField(rule, field.key);
            if (typeof onChanged === 'function') onChanged();
          });
        }
        return attachOptionalFieldUi(field.key, buildField(field.label, control, field.key));
      }

      if (field.kind === 'attrs') {
        const attrsTextarea = createRuleTextarea(formatAttrs(rule && rule.attrs ? rule.attrs : {}), field.placeholder || 'key=value', (raw) => {
          const obj = parseAttrs(raw);
          setRuleValue(rule, 'attrs', obj);
          ensureVisibleField(rule, field.key);
          if (typeof onChanged === 'function') onChanged();
        });
        return attachOptionalFieldUi(field.key, buildField(field.label, attrsTextarea, field.key));
      }

      let value = String(rule && rule[field.key] ? rule[field.key] : '');
      let control;
      if (field.key === 'port') {
        const initialPortValues = value ? splitMultiValue(value) : [];
        control = createChipInput(initialPortValues, {
          placeholder: field.placeholder,
          ariaLabel: field.label,
          onChange: (arr) => {
            setRuleValue(rule, field.key, arr.join(', '));
            ensureVisibleField(rule, field.key);
            if (typeof onChanged === 'function') onChanged();
          },
        });
      } else {
        control = createRuleInput(value, field.placeholder, (val) => {
          setRuleValue(rule, field.key, val);
          ensureVisibleField(rule, field.key);
          if (typeof onChanged === 'function') onChanged();
        });
      }
      return attachOptionalFieldUi(field.key, buildField(field.label, control, field.key));
    }

    // type
    ensureRuleTypeDatalist();
    const typeInput = createRuleInput(String(rule && rule.type ? rule.type : 'field'), 'field', (val) => {
      setRuleValue(rule, 'type', (val || '').trim());
      if (typeof onChanged === 'function') onChanged();
    });
    try { typeInput.setAttribute('list', 'routing-rule-types'); } catch (e) {}
    form.appendChild(buildField('type', typeInput, null));

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

      try {
        if (!v) balancerSelect.value = '';
        else if (balTags.indexOf(v) >= 0) balancerSelect.value = v;
        else balancerSelect.value = '__custom__';
      } catch (e) {}

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
        syncBalancerPickDisabled();
        try { balancerInput.focus(); } catch (e) {}
        return;
      }

      if (!sel) {
        balancerRadio.checked = true;
        try { balancerInput.value = ''; } catch (e) {}
        setRuleValue(rule, 'balancerTag', '');
      } else {
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
    try { syncBalancerPickDisabled(); } catch (e) { try { balancerInput.disabled = !preferBalancer; } catch (e2) {} }

    function syncTargetMode() {
      const isOutbound = outboundRadio.checked;
      outboundInput.disabled = !isOutbound;
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

    const visibleFieldKeys = getVisibleOptionalFieldKeys(rule);
    RULE_OPTIONAL_FIELDS.forEach((field) => {
      if (visibleFieldKeys.indexOf(field.key) < 0) return;
      const fieldEl = buildOptionalRuleField(field);
      if (fieldEl) form.appendChild(fieldEl);
    });

    const missingFields = RULE_OPTIONAL_FIELDS.filter((field) => visibleFieldKeys.indexOf(field.key) < 0);
    if (missingFields.length) {
      const addWrap = document.createElement('div');
      addWrap.className = 'routing-rule-add-field';

      const addLabel = document.createElement('span');
      addLabel.className = 'routing-rule-add-field-label';
      addLabel.textContent = 'Добавить условие';

      const addControls = document.createElement('div');
      addControls.className = 'routing-rule-add-field-controls';

      const addSelect = document.createElement('select');
      addSelect.className = 'routing-rule-input routing-rule-select';
      addSelect.setAttribute('aria-label', 'Добавить условие');

      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '— выбрать поле —';
      addSelect.appendChild(emptyOpt);

      missingFields.forEach((field) => {
        const opt = document.createElement('option');
        opt.value = field.key;
        opt.textContent = field.label;
        addSelect.appendChild(opt);
      });

      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn-secondary';
      addBtn.textContent = 'Добавить';

      const addSelectedField = () => {
        const key = String(addSelect.value || '').trim();
        if (!key || !RULE_OPTIONAL_FIELD_MAP[key]) return;
        ensureVisibleField(rule, key);
        markDirty(true);
        requestAutoSync({ wait: 250 });
        setPendingRuleFieldFocus(idx, key);
        rerenderRuleForm(key);
      };

      addBtn.addEventListener('click', addSelectedField);
      addSelect.addEventListener('change', () => {
        if (addSelect.value) addSelectedField();
      });

      addControls.appendChild(addSelect);
      addControls.appendChild(addBtn);
      addWrap.appendChild(addLabel);
      addWrap.appendChild(addControls);
      form.appendChild(addWrap);
    }

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
        extraTextarea.classList.remove('is-invalid');
        if (typeof onChanged === 'function') onChanged();
      } else {
        extraTextarea.classList.add('is-invalid');
        markDirty(true);
      }
    });

    form.appendChild(buildField('extra (JSON)', extraTextarea, null));

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
        const resp = await fetch('/api/xray/observatory/config', { method: 'GET', cache: 'no-store' });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && data && data.ok !== false) {
          const found = data.exists ? String(data.file || '07_observatory.json') : '';
          info = { exists: !!data.exists, name: found || '' };
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
    let _lastBalancerTag = String(bal && bal.tag ? bal.tag : '').trim();
    const tagInput = createRuleInput(String(bal && bal.tag ? bal.tag : ''), 'balancer', (val) => {
      const v = String(val || '').trim();
      if (_lastBalancerTag && v && _lastBalancerTag !== v && RM && typeof RM.retargetRulesForBalancer === 'function') {
        try { RM.retargetRulesForBalancer(_lastBalancerTag, v); } catch (e) {}
        _lastBalancerTag = v;
      } else if (v) {
        _lastBalancerTag = v;
      }
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
      JM.open({ selector: cur }, `Балансировщик: ${tag} — selector`, { kind: 'balancerSelector', idx });
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
      const t = String(tag || '').trim();
      if (!t) return false;
      if (availableSet.has(t)) return false;
      // selector supports prefixes too: treat value as valid if at least one outbound starts with it.
      for (let i = 0; i < availableTags.length; i++) {
        if (String(availableTags[i] || '').startsWith(t)) return false;
      }
      return true;
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


    // Unified error UX (parse/network/etc)
    if (S && S._error) {
      try {
        const box = (C && typeof C.renderError === 'function')
          ? C.renderError(S._error, {
              title: 'Rules: ошибка',
              compact: true,
              onRetry: () => {
                try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
                try { renderAll(); } catch (e) {}
              },
            })
          : null;
        if (box) { list.appendChild(box); return; }
      } catch (e) {}
    }

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
        JM.open((RM && typeof RM.sanitizeForExport === 'function') ? RM.sanitizeForExport(b || {}) : (b || {}), `Балансировщик: ${tag}`, { kind: 'balancer', idx, isNew: false });
      });

      actions.appendChild(infoBtn);
      actions.appendChild(moreBtn);

      // Delete balancer
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn-danger btn-icon routing-balancer-del-btn';
      delBtn.textContent = '🗑';
      delBtn.setAttribute('title', 'Удалить балансировщик');
      delBtn.setAttribute('aria-label', 'Удалить балансировщик');
      delBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const tag = b && b.tag ? String(b.tag) : `balancer#${idx + 1}`;
        const refs = (RM && typeof RM.countRulesUsingBalancer === 'function') ? RM.countRulesUsingBalancer(tag) : 0;
        const msg = refs
          ? `Удалить балансировщик "${tag}"?\n\nТакже будут удалены правила, которые на него ссылаются: ${refs}.`
          : `Удалить балансировщик "${tag}"?`;
        const ok = await confirmModal({
          title: 'Удалить балансировщик',
          message: msg,
          okText: 'Удалить',
          cancelText: 'Отмена',
          danger: true,
        });
        if (!ok) return;
        const res = (RM && typeof RM.removeBalancerAt === 'function')
          ? RM.removeBalancerAt(idx, { removeRules: true })
          : { ok: false, removed: null, removedRules: 0 };
        if (!res || res.ok === false) return;
        try { if (S._balOpenSet) S._balOpenSet.delete(res.removed); } catch (e2) {}
        markDirty(true);
        renderAll();
        requestAutoSync({ immediate: true });
      });

      actions.appendChild(delBtn);

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
        // Debounced auto-sync for inline edits
        requestAutoSync({ wait: 450 });
      };

      const form = buildBalancerForm(b || {}, idx, onChanged);
      body.appendChild(form);
      card.appendChild(body);

      list.appendChild(card);
      consumePendingRuleFieldFocus(card, idx);
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
    // Prefer implementation from rules/dnd_pointer.js if loaded.
    try {
      const D = RC.rules && RC.rules.dnd;
      if (D && typeof D.supportsPointer === 'function') return !!D.supportsPointer();
    } catch (e) {}
    try { return typeof window !== 'undefined' && typeof window.PointerEvent !== 'undefined'; } catch (e) { return false; }
  }

  function ensureRulesDnD() {
    const list = $(IDS.rulesList);
    if (!list) return;

    // Delegate to separate DnD module (RC-09).
    const D = (RC.rules && RC.rules.dnd) ? RC.rules.dnd : null;
    if (!D || typeof D.attach !== 'function') return;

    D.attach(list, {
      onReorder: (from, to) => {
        const fromIdx = Number(from);
        const toIdx = Number(to);
        // Always re-render to restore DOM after pointer-ghost drag end/cancel.
        let moved = false;
        if (Number.isFinite(fromIdx) && Number.isFinite(toIdx) && fromIdx !== toIdx) {
          moved = moveRuleToIndex(fromIdx, toIdx);
        if (moved) markDirty(true);
        }
        renderAll();
        if (moved) {
          pulseRuleCardByIdx(toIdx);
          // Slight debounce after drop: avoids touching JSON while drag UI is still settling
          // and keeps the apply button visibly highlighted for a moment.
          requestAutoSync({ wait: 450 });
        }
      },
      // DnD enabled only when filter is empty (stable indexes).
      isEnabled: () => !String(S._filter || '').trim(),
    });
  }

  function createRuleTagInlineBadge(rule, onCommit) {
    const wrap = document.createElement('div');
    wrap.className = 'routing-rule-inline-tag';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'routing-rule-badge is-tag routing-rule-tag-inline-btn';
    button.textContent = sanitizeRuleTag(rule && rule.ruleTag) || 'без тега';
    button.setAttribute('title', 'Переименовать ruleTag');
    button.setAttribute('aria-label', 'Переименовать ruleTag');

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'routing-rule-inline-input';
    input.placeholder = 'ruleTag';
    input.value = sanitizeRuleTag(rule && rule.ruleTag);

    let active = false;
    function syncButton() {
      button.textContent = sanitizeRuleTag(rule && rule.ruleTag) || 'без тега';
    }
    function stopEdit(applyChange) {
      if (!active) return;
      active = false;
      wrap.classList.remove('is-editing');
      button.classList.remove('is-editing');
      if (applyChange) {
        const next = sanitizeRuleTag(input.value);
        if (next) rule.ruleTag = next;
        else {
          try { delete rule.ruleTag; } catch (e) {}
        }
        syncButton();
        if (typeof onCommit === 'function') onCommit();
      } else {
        input.value = sanitizeRuleTag(rule && rule.ruleTag);
        syncButton();
      }
    }
    function startEdit() {
      active = true;
      wrap.classList.add('is-editing');
      button.classList.add('is-editing');
      input.value = sanitizeRuleTag(rule && rule.ruleTag);
      requestAnimationFrame(() => {
        try { input.focus(); input.select(); } catch (e) {}
      });
    }

    button.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      startEdit();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        stopEdit(true);
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        stopEdit(false);
      }
    });
    input.addEventListener('blur', () => stopEdit(true));

    wrap.appendChild(button);
    wrap.appendChild(input);
    wrap.syncLabel = syncButton;
    return wrap;
  }

  function renderRules() {

    const list = $(IDS.rulesList);
    const empty = $(IDS.rulesEmpty);
    if (!list) return;

    // Unified error UX (parse/network/etc)
    if (S && S._error) {
      try { list.innerHTML = ''; } catch (e) {}
      try { if (empty) empty.style.display = 'none'; } catch (e) {}

      // Summary
      try {
        const c = $(IDS.rulesCount);
        if (c) c.textContent = 'ошибка JSON';
      } catch (e) {}
      try {
        const geo = $(IDS.rulesGeo);
        if (geo) geo.textContent = '';
      } catch (e) {}

      try {
        const box = (C && typeof C.renderError === 'function')
          ? C.renderError(S._error, {
              title: 'Не удалось прочитать routing JSON',
              onRetry: () => {
                try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
                try { renderAll(); } catch (e) {}
              },
            })
          : null;
        if (box) {
          list.appendChild(box);
          return;
        }
      } catch (e) {}
      return;
    }

    const m = ensureModel();
    const filter = String(S._filter || '').trim();

    // Enable DnD only when filter is empty (stable indexes / expectations).
    const dragEnabled = !filter;
    // DnD wiring lives in rules/dnd_pointer.js (RC-09). It self-disables when filter is active.
    list.dataset.dndMode = supportsPointerDnD() ? 'pointer' : 'native';
    ensureRulesDnD();

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
      const isOpen = S._openSet.has(rule);

      card.dataset.idx = String(idx);
      card.dataset.open = isOpen ? '1' : '0';
      if (dragEnabled) {
        // In pointer mode we use our own ghost/placeholder logic; in native mode enable HTML5 drag.
        card.draggable = !supportsPointerDnD();
      }


      const head = document.createElement('div');
      head.className = 'routing-rule-head';

      const main = document.createElement('div');
      main.className = 'routing-rule-main';

      const title = document.createElement('div');
      title.className = 'routing-rule-title';

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

      const ruleTagEditor = createRuleTagInlineBadge(rule || {}, () => {
        onRuleChanged();
      });
      const ruleTagBadge = ruleTagEditor.querySelector('.routing-rule-tag-inline-btn');

      const targetBadge = document.createElement('span');
      targetBadge.className = 'routing-rule-badge is-target';
      targetBadge.textContent = `${sum.targetKind}: ${sum.target}`;

      title.appendChild(idxSpan);
      title.appendChild(ruleTagEditor);
      title.appendChild(targetBadge);

      const meta = document.createElement('div');
      meta.className = 'routing-rule-meta';

      const typeBadge = document.createElement('span');
      typeBadge.className = 'routing-rule-badge is-type';
      typeBadge.textContent = String(rule && rule.type ? rule.type : 'field');
      meta.appendChild(typeBadge);

      const conditionBadge = document.createElement('span');
      conditionBadge.className = 'routing-rule-badge is-count';
      conditionBadge.textContent = `${sum.conditionCount} усл.`;
      meta.appendChild(conditionBadge);

      const condBadgesWrap = document.createElement('div');
      condBadgesWrap.className = 'routing-rule-cond-badges';
      meta.appendChild(condBadgesWrap);

      const geoBadge = document.createElement('span');
      geoBadge.className = 'routing-rule-badge is-geo';
      geoBadge.textContent = 'geo';
      if (!sum.geo) geoBadge.style.display = 'none';
      meta.appendChild(geoBadge);

      const match = document.createElement('div');
      match.className = 'routing-rule-empty routing-rule-summary';
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
        if (S._openSet.has(rule)) S._openSet.delete(rule);
        else S._openSet.add(rule);
        renderRules();
      });

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-secondary btn-icon';
      editBtn.textContent = '✏️';
      editBtn.setAttribute('title', 'Открыть правило в JSON-редакторе');
      editBtn.setAttribute('aria-label', 'Открыть правило в JSON-редакторе');
      editBtn.addEventListener('click', () => {
        JM.open((RM && typeof RM.sanitizeForExport === 'function') ? RM.sanitizeForExport(rule || {}) : (rule || {}), `Правило #${idx + 1}`, { kind: 'rule', idx, isNew: false });
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
          requestAutoSync({ immediate: true });
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
          requestAutoSync({ immediate: true });
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
        requestAutoSync({ immediate: true });
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
        S._openSet.delete(removed);
        markDirty(true);
        renderAll();
        requestAutoSync({ immediate: true });
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

      const refs = { typeBadge, ruleTagBadge, targetBadge, conditionBadge, condBadgesWrap, matchEl: match, geoBadgeEl: geoBadge };
      const onRuleChanged = () => {
        markDirty(true);
        updateRuleHeadDom(rule, refs);
        updateJsonPreview(pre, rule || {});
        if (filter) {
          try { card.style.display = ruleMatchesFilter(rule, filter) ? '' : 'none'; } catch (e) {}
        }
        requestAutoSync({ wait: 450 });
      };
      updateRuleHeadDom(rule, refs);

      if (isOpen) {
        const form = buildRuleForm(rule || {}, idx, onRuleChanged, (focusFieldKey) => {
          if (focusFieldKey) setPendingRuleFieldFocus(idx, focusFieldKey);
          renderRules();
        });
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

  
  // Public API
  R.anyGeo = anyGeo;
  R.ruleMatchesFilter = ruleMatchesFilter;
  R.summarizeRule = summarizeRule;

  R.updateJsonPreview = updateJsonPreview;
  R.updateRuleHeadDom = updateRuleHeadDom;

  R.getRuleExtraObject = getRuleExtraObject;
  R.getBalancerExtraObject = getBalancerExtraObject;

  R.renderBalancers = renderBalancers;
  R.renderRules = renderRules;
  R.renderAll = renderAll;

  // Legacy alias for json_modal.js
  RC.rules.renderAll = renderAll;
})();
