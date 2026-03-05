/*
  routing_cards/rules/fields.js
  Rules card: field helpers (inputs/textarea, multi-value parsing, attrs helpers).

  RC-08a
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const F = RC.rules.fields = RC.rules.fields || {};

  // ===== Legacy "form fields" inside rule cards (ported from older routing.js) =====
  if (!F.RULE_MULTI_FIELDS) {
    F.RULE_MULTI_FIELDS = [
      { key: 'domain', label: 'domain', placeholder: 'example.com, geosite:cn' },
      { key: 'ip', label: 'ip', placeholder: 'geoip:private, 8.8.8.8' },
      { key: 'sourceIP', label: 'sourceIP (source)', placeholder: '10.0.0.1, geoip:private' },
      { key: 'localIP', label: 'localIP', placeholder: '192.168.0.25' },
      { key: 'user', label: 'user', placeholder: 'email@user' },
      { key: 'inboundTag', label: 'inboundTag', placeholder: 'in-1' },
      { key: 'protocol', label: 'protocol', placeholder: 'http, tls, quic, bittorrent' },
    ];
  }

  if (!F.RULE_TEXT_FIELDS) {
    F.RULE_TEXT_FIELDS = [
      { key: 'port', label: 'port', placeholder: '53, 80-443' },
      { key: 'sourcePort', label: 'sourcePort', placeholder: '1024-65535' },
      { key: 'localPort', label: 'localPort', placeholder: '10000-20000' },
      { key: 'network', label: 'network', placeholder: 'tcp, udp, tcp,udp' },
      { key: 'vlessRoute', label: 'vlessRoute', placeholder: '1, 14, 1000-2000' },
    ];
  }

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

  // Export helpers
  if (typeof F.normalizeListValue !== 'function') F.normalizeListValue = normalizeListValue;
  if (typeof F.splitMultiValue !== 'function') F.splitMultiValue = splitMultiValue;
  if (typeof F.formatMultiValue !== 'function') F.formatMultiValue = formatMultiValue;
  if (typeof F.parseAttrs !== 'function') F.parseAttrs = parseAttrs;
  if (typeof F.formatAttrs !== 'function') F.formatAttrs = formatAttrs;
  if (typeof F.cleanEmptyValue !== 'function') F.cleanEmptyValue = cleanEmptyValue;
  if (typeof F.setRuleValue !== 'function') F.setRuleValue = setRuleValue;
  if (typeof F.autoResizeTextarea !== 'function') F.autoResizeTextarea = autoResizeTextarea;
  if (typeof F.createRuleTextarea !== 'function') F.createRuleTextarea = createRuleTextarea;
  if (typeof F.createRuleInput !== 'function') F.createRuleInput = createRuleInput;
  if (typeof F.buildKeyLabel !== 'function') F.buildKeyLabel = buildKeyLabel;
  if (typeof F.buildField !== 'function') F.buildField = buildField;
})();
