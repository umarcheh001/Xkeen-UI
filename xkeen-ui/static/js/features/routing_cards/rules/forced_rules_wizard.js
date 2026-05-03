import { getRoutingApi } from '../../routing.js';

import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/rules/forced_rules_wizard.js
  Quick wizard: “forced rules” (bypass balancer): domains/IP -> specific outboundTag.

  Inspired by XKEEN_VLESS_Configurator_v3.py (forced rules section).

  Public API:
    RC.rules.forcedRulesWizard.init()
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.rules = RC.rules || {};

  RC.rules.forcedRulesWizard = RC.rules.forcedRulesWizard || {};
  const FW = RC.rules.forcedRulesWizard;

  const C = RC.common || {};
  const toast = (typeof C.toast === 'function') ? C.toast : function (msg, isErr) {
    try { console[(isErr ? 'error' : 'log')](String(msg || '')); } catch (e) {}
  };

  const RM = (RC.rules && RC.rules.model) ? RC.rules.model : {};
  const RA = (RC.rules && RC.rules.apply) ? RC.rules.apply : {};
  const RR = (RC.rules && RC.rules.render) ? RC.rules.render : {};

  const BTN_ID = 'routing-forced-rules-btn';
  const MODAL_ID = 'routing-forced-rules-modal';

  const IDS = {
    close: 'routing-forced-rules-close-btn',
    cancel: 'routing-forced-rules-cancel-btn',
    run: 'routing-forced-rules-run-btn',
    dry: 'routing-forced-rules-dry-btn',
    refresh: 'routing-forced-rules-refresh-tags-btn',
    status: 'routing-forced-rules-status',
    list: 'routing-forced-rules-list',
    outbound: 'routing-forced-rules-outbound',
    type: 'routing-forced-rules-type',
    values: 'routing-forced-rules-values',
    add: 'routing-forced-rules-add-btn',
    clearProxy: 'routing-forced-rules-clear-proxy-btn',
    clearAll: 'routing-forced-rules-clear-all-btn',
    inboundOnly: 'routing-forced-rules-inbound-only',
    priority: 'routing-forced-rules-priority',
    importLegacy: 'routing-forced-rules-import-legacy',
    summary: 'routing-forced-rules-summary',
  };

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function ensureModalDom() {
    let modal = $(MODAL_ID);
    if (modal) return modal;
    if (!document.body) return null;

    document.body.insertAdjacentHTML('beforeend', `
      <div id="routing-forced-rules-modal" class="modal hidden" data-modal-key="routing-forced-rules-premium-v4" role="dialog" aria-modal="true" aria-label="Принудительные правила (обход балансировщика)">
        <div class="modal-content" data-modal-key="routing-forced-rules-premium-v4-content">
          <div class="modal-header">
            <span class="modal-title">Принудительные правила (обход балансировщика)</span>
            <button type="button" class="modal-close" id="routing-forced-rules-close-btn" title="Закрыть">×</button>
          </div>
          <div class="modal-body">
            <div class="xk-forced-wizard-lead">
              <div class="xk-forced-wizard-lead-icon">⇄</div>
              <div class="xk-forced-wizard-lead-text">
                <div class="xk-forced-wizard-lead-title">Домены и IP → конкретный outbound</div>
                <p class="modal-description" style="margin:0;">
                  Мастер создаёт правила <code>type: field</code>, которые отправляют выбранные значения <b>мимо балансировщика</b> прямо на нужный <code>outboundTag</code>.
                </p>
              </div>
            </div>

            <div class="xk-forced-wizard-grid">
              <section class="xk-forced-wizard-panel xk-forced-wizard-input-panel">
                <div class="xk-forced-wizard-panelhead">
                  <div>
                    <div class="xk-forced-wizard-kicker">Шаг 1</div>
                    <div class="terminal-menu-title" style="margin:0;">Добавить значения</div>
                  </div>
                </div>

                <div class="xk-forced-controls-grid">
                  <label class="xk-forced-fieldgroup">
                    <span class="xk-forced-fieldlabel">outbound</span>
                    <div class="xk-forced-outbound-wrap">
                      <select id="routing-forced-rules-outbound" class="routing-rule-input"></select>
                      <button type="button" class="btn-secondary btn-icon xk-icon-btn" id="routing-forced-rules-refresh-tags-btn" data-tooltip="Обновить список outbound-тегов" aria-label="Обновить список outbound-тегов"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16.2 10a6.2 6.2 0 1 1-1.83-4.39"/><path d="M16.2 4.6v3.62h-3.62"/></svg></button>
                    </div>
                  </label>

                  <label class="xk-forced-fieldgroup xk-forced-fieldgroup-compact">
                    <span class="xk-forced-fieldlabel">Тип</span>
                    <select id="routing-forced-rules-type" class="routing-rule-input">
                      <option value="domain">domain</option>
                      <option value="ip">ip</option>
                    </select>
                  </label>
                </div>

                <div class="xk-forced-editor-block">
                  <div class="xk-forced-editor-head">
                    <span class="xk-forced-fieldlabel">Значения</span>
                    <div class="xk-forced-wizard-toolbar">
                      <button type="button" class="btn-secondary btn-icon xk-icon-btn" id="routing-forced-rules-add-btn" data-tooltip="Добавить значения в выбранный outbound" aria-label="Добавить значения"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4.2v11.6"/><path d="M4.2 10h11.6"/></svg></button>
                      <button type="button" class="btn-secondary btn-icon xk-icon-btn" id="routing-forced-rules-clear-proxy-btn" data-tooltip="Очистить значения только у выбранного outbound" aria-label="Очистить выбранный outbound"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.1 5h6.95a1.4 1.4 0 0 1 1.4 1.4v7.2a1.4 1.4 0 0 1-1.4 1.4H8.1L3.55 10 8.1 5Z"/><path d="m9.3 8 4.1 4.1"/><path d="m13.4 8-4.1 4.1"/></svg></button>
                      <button type="button" class="btn-danger btn-icon xk-icon-btn" id="routing-forced-rules-clear-all-btn" data-tooltip="Удалить все записи мастера" aria-label="Удалить все записи"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 6.2h8.4"/><path d="M7.1 6.2V5a1 1 0 0 1 1-1h3.8a1 1 0 0 1 1 1v1.2"/><path d="M7.2 8.2v6.1"/><path d="M10 8.2v6.1"/><path d="M12.8 8.2v6.1"/><path d="M6.5 6.2l.6 9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-9"/></svg></button>
                    </div>
                  </div>

                  <textarea id="routing-forced-rules-values" class="xkeen-textarea" spellcheck="false" rows="7" placeholder="По одному на строке
example.com
domain:google.com
geosite:youtube

Для ip:
1.2.3.4/32
geoip:private"></textarea>
                </div>

                <div class="xk-forced-wizard-note">
                  Поддерживаются обычные значения Xray для <code>domain</code>/<code>ip</code>: <code>domain:example.com</code>, <code>geosite:TAG</code>, <code>geoip:TAG</code> и другие.
                </div>
              </section>

              <section class="xk-forced-wizard-panel xk-forced-wizard-preview-panel">
                <div class="xk-forced-wizard-panelhead">
                  <div>
                    <div class="xk-forced-wizard-kicker">Шаг 2</div>
                    <div class="terminal-menu-title" style="margin:0;">Параметры и результат</div>
                  </div>
                  <div id="routing-forced-rules-summary" class="xk-forced-wizard-summary" data-tooltip="Количество outbound, domain и ip в мастере">0 outbound · 0 domain · 0 ip</div>
                </div>

                <div class="xk-forced-options-grid">
                  <label class="xk-forced-option-card global-autorestart-toggle">
                    <input type="checkbox" id="routing-forced-rules-inbound-only" checked>
                    <div class="xk-forced-option-copy">
                      <strong>Только redirect / tproxy</strong>
                      <small>Не трогать другие inbound</small>
                    </div>
                  </label>

                  <label class="xk-forced-option-card xk-forced-option-select">
                    <span class="xk-forced-fieldlabel">Приоритет</span>
                    <select id="routing-forced-rules-priority" class="routing-rule-input">
                      <option value="after_block">После block-правил</option>
                      <option value="before_balancer">Перед балансировщиком</option>
                    </select>
                  </label>

                  <label class="xk-forced-option-card global-autorestart-toggle xk-forced-option-wide">
                    <input type="checkbox" id="routing-forced-rules-import-legacy">
                    <div class="xk-forced-option-copy">
                      <strong>Импорт legacy-правил</strong>
                      <small>Подтянуть правила без <code>ruleTag</code></small>
                    </div>
                  </label>
                </div>

                <div class="xk-forced-wizard-listbox">
                  <div class="xk-forced-wizard-listhead">
                    <div class="xk-forced-wizard-listtitle">
                      <div class="terminal-menu-title" style="margin:0;">Текущие правила</div>
                      <div class="xk-forced-list-subtitle">Карточки по outboundTag: компактный обзор, клик по chip удаляет значение</div>
                    </div>
                    <div id="routing-forced-rules-status" class="modal-hint" style="margin:0;"></div>
                  </div>
                  <div id="routing-forced-rules-list" class="xk-card-desc xk-forced-wizard-list">—</div>
                </div>
              </section>
            </div>
          </div>

          <div class="modal-actions xk-forced-wizard-footer">
            <button type="button" class="btn-compact" id="routing-forced-rules-cancel-btn">Отмена</button>
            <div class="xk-forced-wizard-footer-actions">
              <button type="button" class="btn-secondary btn-compact xk-forced-primary-action" id="routing-forced-rules-dry-btn" data-tooltip="Только применить изменения в редакторе без сохранения и рестарта"><span class="xk-btn-inline-glyph" aria-hidden="true">✓</span><span>Только применить</span></button>
              <button type="button" class="btn-danger btn-compact xk-forced-primary-action" id="routing-forced-rules-run-btn"><span class="xk-btn-inline-glyph" aria-hidden="true">⟳</span><span>Применить + Рестарт</span></button>
            </div>
          </div>
        </div>
      </div>
    `);

    modal = $(MODAL_ID);
    return modal;
  }

  function _syncBodyScroll() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function openModal() {
    const m = ensureModalDom();
    if (!m) return;
    try { m.classList.remove('hidden'); } catch (e) {}
    _syncBodyScroll();
  }

  function closeModal() {
    const m = $(MODAL_ID);
    if (!m) return;
    try { m.classList.add('hidden'); } catch (e) {}
    _syncBodyScroll();
  }

  function setStatus(msg, isErr) {
    const el = $(IDS.status);
    if (!el) return;
    try {
      el.textContent = String(msg || '');
      el.style.color = isErr ? 'var(--danger, #ef4444)' : 'var(--modal-muted, var(--muted, #9ca3af))';
    } catch (e) {}
  }

  function updateSummary() {
    const el = $(IDS.summary);
    if (!el) return;
    const forced = FW._state.forced || {};
    const tags = Object.keys(forced);
    let domains = 0;
    let ips = 0;
    tags.forEach((tag) => {
      const item = forced[tag] || {};
      domains += Array.isArray(item.domains) ? item.domains.length : 0;
      ips += Array.isArray(item.ips) ? item.ips.length : 0;
    });
    try {
      el.textContent = `${tags.length} outbound · ${domains} domain · ${ips} ip`;
    } catch (e) {}
  }

  function setBusy(busy) {
    const ids = [IDS.run, IDS.dry, IDS.refresh, IDS.cancel, IDS.close, IDS.add, IDS.clearProxy, IDS.clearAll, IDS.outbound, IDS.type, IDS.values, IDS.inboundOnly, IDS.priority, IDS.importLegacy];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      try { el.disabled = !!busy; } catch (e) {}
      try { el.classList.toggle('is-busy', !!busy); } catch (e2) {}
    });
  }

  // --- State ---
  const RULETAG_PREFIX = 'xk_forced_';

  FW._state = FW._state || {
    forced: {}, // tag -> { domains:[], ips:[] }
    tags: [],
  };

  function normalizeList(values) {
    const raw = String(values || '')
      .replace(/,/g, '\n')
      .split(/\r?\n/)
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    for (const v of raw) {
      if (seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }

  function safeRuleTagForOutbound(tag) {
    const t = String(tag || '').trim();
    const safe = t.replace(/[^a-zA-Z0-9_-]/g, '_');
    return RULETAG_PREFIX + (safe || 'proxy');
  }

  function isBlockOutbound(tag) {
    const t = String(tag || '').toLowerCase();
    return t === 'block' || t === 'blackhole' || t === 'reject';
  }

  function looksLikeLegacyForcedRule(rule) {
    // Best-effort heuristic, used only when user explicitly enabled import.
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    if (rule.balancerTag) return false;
    if (!rule.outboundTag) return false;
    const out = String(rule.outboundTag || '').trim();
    if (!out) return false;
    if (isBlockOutbound(out) || out.toLowerCase() === 'direct') return false;
    if (!rule.domain && !rule.ip) return false;
    const keys = Object.keys(rule);
    // allow only minimal forced keys
    const allowed = new Set(['type', 'outboundTag', 'inboundTag', 'domain', 'ip', 'ruleTag']);
    for (const k of keys) {
      if (!allowed.has(k)) return false;
    }
    if (rule.inboundTag && Array.isArray(rule.inboundTag)) {
      const s = new Set(rule.inboundTag.map((x) => String(x || '').trim()).filter(Boolean));
      // classic case: redirect/tproxy
      if (!(s.has('redirect') || s.has('tproxy'))) return false;
    }
    return true;
  }

  function extractWizardForcedFromModel(model, importLegacy) {
    const forced = {};
    if (!model || !Array.isArray(model.rules)) return forced;

    for (const r of model.rules) {
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      const rt = String(r.ruleTag || '');
      const isWizard = rt.startsWith(RULETAG_PREFIX);
      const isLegacy = !isWizard && !!importLegacy && looksLikeLegacyForcedRule(r);
      if (!isWizard && !isLegacy) continue;
      const out = String(r.outboundTag || '').trim();
      if (!out) continue;
      if (!forced[out]) forced[out] = { domains: [], ips: [] };
      if (Array.isArray(r.domain)) {
        forced[out].domains = forced[out].domains.concat(r.domain.map((x) => String(x || '').trim()).filter(Boolean));
      }
      if (Array.isArray(r.ip)) {
        forced[out].ips = forced[out].ips.concat(r.ip.map((x) => String(x || '').trim()).filter(Boolean));
      }
    }

    // Dedupe
    for (const k of Object.keys(forced)) {
      forced[k].domains = normalizeList(forced[k].domains.join('\n'));
      forced[k].ips = normalizeList(forced[k].ips.join('\n'));
      if (!forced[k].domains.length && !forced[k].ips.length) delete forced[k];
    }

    return forced;
  }

  function renderList() {
    const el = $(IDS.list);
    if (!el) return;

    const forced = FW._state.forced || {};
    const tags = Object.keys(forced);
    updateSummary();
    if (!tags.length) {
      el.innerHTML = '<div class="xk-forced-wizard-empty">Пока пусто. Добавьте домены или IP слева.</div>';
      return;
    }

    function renderChip(tag, kind, value) {
      return `<span class="xk-chip" data-kind="${escapeHtml(kind)}" data-tag="${escapeHtml(tag)}" data-value="${escapeHtml(value)}" title="Удалить значение">${escapeHtml(value)} ×</span>`;
    }

    function renderInlineRow(tag, kind, values) {
      if (!values.length) return '';
      const chips = values.map((v) => renderChip(tag, kind, v)).join(' ');
      return (
        `<div class="xk-forced-inline-row" data-kind="${escapeHtml(kind)}">` +
          `<span class="xk-forced-inline-label">${escapeHtml(kind)}</span>` +
          `<div class="xk-forced-rule-chips is-inline">${chips}</div>` +
        `</div>`
      );
    }

    tags.sort((a, b) => a.localeCompare(b, 'ru'));
    const parts = [];
    for (const tag of tags) {
      const it = forced[tag] || { domains: [], ips: [] };
      const d = Array.isArray(it.domains) ? it.domains : [];
      const ip = Array.isArray(it.ips) ? it.ips : [];
      const total = d.length + ip.length;
      const compactInline = total <= 5 && d.length <= 3 && ip.length <= 3;
      const dHtml = d.map((v) => renderChip(tag, 'domain', v)).join(' ');
      const ipHtml = ip.map((v) => renderChip(tag, 'ip', v)).join(' ');
      const groups = [];

      if (compactInline) {
        if (d.length) groups.push(renderInlineRow(tag, 'domain', d));
        if (ip.length) groups.push(renderInlineRow(tag, 'ip', ip));
      } else {
        if (d.length) {
          groups.push(
            `<div class="xk-forced-rule-group" data-kind="domain">` +
              `<div class="xk-forced-rule-group-head">` +
                `<span class="xk-forced-rule-group-title">domain</span>` +
                `<span class="xk-forced-rule-group-meta">${d.length}</span>` +
              `</div>` +
              `<div class="xk-forced-rule-chips">${dHtml}</div>` +
            `</div>`
          );
        }
        if (ip.length) {
          groups.push(
            `<div class="xk-forced-rule-group" data-kind="ip">` +
              `<div class="xk-forced-rule-group-head">` +
                `<span class="xk-forced-rule-group-title">ip</span>` +
                `<span class="xk-forced-rule-group-meta">${ip.length}</span>` +
              `</div>` +
              `<div class="xk-forced-rule-chips">${ipHtml}</div>` +
            `</div>`
          );
        }
      }

      parts.push(
        `<div class="xk-forced-rule-card${compactInline ? ' is-inline' : ''}">` +
          `<div class="xk-forced-rule-head">` +
            `<div class="xk-forced-rule-tagwrap">` +
              `<span class="xk-forced-rule-accent" aria-hidden="true"></span>` +
              `<div class="xk-forced-rule-tag"><code>${escapeHtml(tag)}</code></div>` +
            `</div>` +
            `<div class="xk-forced-rule-badges">` +
              `<span class="xk-forced-count is-total">${total} знач.</span>` +
              `<span class="xk-forced-count is-domain">domain ${d.length}</span>` +
              `<span class="xk-forced-count is-ip">ip ${ip.length}</span>` +
            `</div>` +
          `</div>` +
          `<div class="xk-forced-rule-groups${compactInline ? ' is-inline' : ''}">${groups.join('') || '<span class="xk-forced-rule-empty">—</span>'}</div>` +
        `</div>`
      );
    }
    el.innerHTML = parts.join('');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function deleteChip(tag, kind, value) {
    const t = String(tag || '').trim();
    if (!t) return;
    const k = (kind === 'ip') ? 'ips' : 'domains';
    const v = String(value || '').trim();
    const it = FW._state.forced && FW._state.forced[t];
    if (!it || !Array.isArray(it[k])) return;
    it[k] = it[k].filter((x) => String(x || '').trim() !== v);
    if (!it.domains.length && !it.ips.length) {
      try { delete FW._state.forced[t]; } catch (e) {}
    }
    renderList();
  }

  async function fetchOutboundTags() {
    const url = (C && typeof C.buildOutboundTagsUrl === 'function')
      ? C.buildOutboundTagsUrl()
      : '/api/xray/outbound-tags';
    try {
      const resp = await fetch(url, { method: 'GET' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return [];
      if (!Array.isArray(data.tags)) return [];
      return data.tags.map((t) => String(t || '').trim()).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  const RESERVED = new Set([
    // We intentionally allow 'direct' and 'block' in the wizard.
    'dns',
    'freedom', 'blackhole', 'reject', 'bypass',
  ]);

  function isReservedOutbound(tag) {
    const t = String(tag || '').trim();
    if (!t) return true;
    const lc = t.toLowerCase();
    if (RESERVED.has(lc)) return true;
    if (lc === 'api' || lc === 'xray-api' || lc === 'metrics') return true;
    return false;
  }

  function fillOutboundSelect(tags) {
    const sel = $(IDS.outbound);
    if (!sel) return;
    const prev = String(sel.value || '').trim();

    const filtered = (tags || []).filter((t) => !isReservedOutbound(t));
    // Common targets (always offer them)
    if (!filtered.includes('proxy')) filtered.unshift('proxy');
    if (!filtered.includes('block')) filtered.unshift('block');
    if (!filtered.includes('direct')) filtered.unshift('direct');

    sel.innerHTML = '';
    for (const t of filtered) {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      sel.appendChild(opt);
    }
    if (prev && filtered.includes(prev)) sel.value = prev;
    else sel.value = filtered[0] || 'proxy';
  }

  function addValuesToState(outboundTag, kind, values) {
    const tag = String(outboundTag || '').trim();
    if (!tag) return { added: 0 };
    if (!FW._state.forced[tag]) FW._state.forced[tag] = { domains: [], ips: [] };
    const it = FW._state.forced[tag];
    const key = (kind === 'ip') ? 'ips' : 'domains';

    const existing = new Set((it[key] || []).map((x) => String(x || '').trim()).filter(Boolean));
    let added = 0;
    for (const v of values) {
      const vv = String(v || '').trim();
      if (!vv || existing.has(vv)) continue;
      existing.add(vv);
      it[key].push(vv);
      added++;
    }
    it[key] = normalizeList(it[key].join('\n'));

    if (!it.domains.length && !it.ips.length) {
      try { delete FW._state.forced[tag]; } catch (e) {}
    }
    return { added };
  }

  function clearSelected() {
    const sel = $(IDS.outbound);
    const tag = sel ? String(sel.value || '').trim() : '';
    if (!tag) return;
    if (FW._state.forced && FW._state.forced[tag]) {
      try { delete FW._state.forced[tag]; } catch (e) {}
    }
    renderList();
  }

  function clearAll() {
    FW._state.forced = {};
    renderList();
  }

  function removeExistingWizardForcedRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.filter((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return true;
      const rt = String(r.ruleTag || '');
      if (rt.startsWith(RULETAG_PREFIX)) return false;
      return true;
    });
  }

  function findBalancerRuleIndex(rules) {
    if (!Array.isArray(rules)) return -1;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      if (r.balancerTag) return i;
    }
    return -1;
  }

  function isUnconditionalTailRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const keys = Object.keys(rule);
    const allowed = new Set(['type', 'outboundTag', 'balancerTag', 'ruleTag']);
    for (const k of keys) {
      if (allowed.has(k)) continue;
      return false;
    }
    return true;
  }

  function chooseInsertBeforeTail(rules) {
    if (!Array.isArray(rules) || !rules.length) return 0;
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (!isUnconditionalTailRule(r)) return rules.length;
      const out = String((r && (r.outboundTag || r.balancerTag)) || '').toLowerCase();
      if (out === 'direct' || out === 'block' || out === 'blackhole' || out === 'reject') return i;
    }
    return rules.length;
  }

  function computeInsertIndex(rules, mode) {
    const balIdx = findBalancerRuleIndex(rules);
    if (mode === 'before_balancer') {
      if (balIdx >= 0) return balIdx;
      return chooseInsertBeforeTail(rules);
    }

    // after_block (highest priority): insert after leading block rules,
    // but never after balancer rule.
    const limit = (balIdx >= 0) ? balIdx : rules.length;
    let i = 0;
    for (; i < limit; i++) {
      const r = rules[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) break;
      const out = String(r.outboundTag || '').trim();
      if (!isBlockOutbound(out)) break;
    }
    return i;
  }

  function buildForcedRule(outboundTag, domains, ips, opts) {
    const r = {
      type: 'field',
      outboundTag: outboundTag,
      ruleTag: safeRuleTagForOutbound(outboundTag),
    };
    if (opts && opts.inboundOnly) r.inboundTag = ['redirect', 'tproxy'];
    if (domains && domains.length) r.domain = domains.slice();
    if (ips && ips.length) r.ip = ips.slice();
    return r;
  }

  async function applyModelToEditor() {
    if (!RA || typeof RA.applyToEditor !== 'function') {
      toast('Не найден модуль применения (applyToEditor).', true);
      return false;
    }
    return await RA.applyToEditor({ silent: false });
  }

  async function saveWithForcedRestart() {
    // Prefer routing module (job + log rendering)
    const routingApi = getRoutingApi();
    if (routingApi && typeof routingApi.save === 'function') {
      const chk = document.getElementById('global-autorestart-xkeen');
      const prev = chk ? !!chk.checked : null;
      try {
        if (chk) chk.checked = true;
        await routingApi.save();
        return true;
      } finally {
        try { if (chk && prev !== null) chk.checked = prev; } catch (e) {}
      }
    }
    // Fallback
    try {
      const text = (C && typeof C.getEditorText === 'function') ? C.getEditorText() : '';
      const res = await fetch('/api/routing?restart=1&async=1', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: String(text || ''),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok === false) {
        throw new Error(String((data && data.error) || res.statusText || ('HTTP ' + res.status)));
      }
      return true;
    } catch (e) {
      toast('Не удалось сохранить routing: ' + String(e && e.message ? e.message : e), true);
      return false;
    }
  }

  async function runFlow(opts) {
    setBusy(true);
    setStatus('Подготовка…', false);

    try {
      const importLegacy = !!($(IDS.importLegacy) && $(IDS.importLegacy).checked);

      const rr = (RM && typeof RM.loadFromEditor === 'function') ? RM.loadFromEditor({ setError: true }) : { ok: false };
      if (!rr || rr.ok === false) {
        setStatus('Сначала исправьте JSON в редакторе (или дождитесь загрузки файла).', true);
        return false;
      }

      const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (rr.model || {});
      if (!m || !Array.isArray(m.rules)) m.rules = [];

      // Pull state -> rules
      const forced = FW._state.forced || {};
      const tags = Object.keys(forced).filter((t) => {
        const it = forced[t];
        if (!it) return false;
        const dLen = (Array.isArray(it.domains) ? it.domains.length : 0);
        const ipLen = (Array.isArray(it.ips) ? it.ips.length : 0);
        return (dLen + ipLen) > 0;
      });

      if (!tags.length) {
        setStatus('Список принудительных правил пуст. Добавьте домены/IP и повторите.', true);
        return false;
      }

      // Remove previous wizard forced rules first.
      m.rules = removeExistingWizardForcedRules(m.rules);

      // Build new forced rules (one rule per outboundTag)
      tags.sort((a, b) => a.localeCompare(b, 'ru'));
      const inboundOnly = !!($(IDS.inboundOnly) && $(IDS.inboundOnly).checked);
      const newRules = [];
      for (const tag of tags) {
        const it = forced[tag] || { domains: [], ips: [] };
        const domains = normalizeList((it.domains || []).join('\n'));
        const ips = normalizeList((it.ips || []).join('\n'));
        if (!domains.length && !ips.length) continue;
        newRules.push(buildForcedRule(tag, domains, ips, { inboundOnly }));
      }

      const mode = String(($(IDS.priority) && $(IDS.priority).value) || 'after_block');
      const ins = computeInsertIndex(m.rules, mode);
      m.rules.splice(ins, 0, ...newRules);

      // If user asked to import legacy rules, refresh UI after apply (but do not delete legacy).
      // This keeps the wizard from “fighting” the user’s manual rules.
      if (importLegacy) {
        // no-op here
      }

      try { if (RM && typeof RM.markDirty === 'function') RM.markDirty(true); } catch (e) {}
      try { if (RR && typeof RR.renderAll === 'function') RR.renderAll(); } catch (e2) {}

      setStatus('Применяю изменения в JSON‑редактор…', false);
      const applied = await applyModelToEditor();
      if (!applied) {
        setStatus('Не удалось применить изменения в редактор.', true);
        return false;
      }

      if (opts && opts.dry) {
        setStatus('Готово: изменения применены в редактор (без сохранения/рестарта).', false);
        toast('Изменения применены в редактор', false);
        return true;
      }

      setStatus('Сохраняю и перезапускаю…', false);
      const ok = await saveWithForcedRestart();
      if (ok) {
        setStatus('Готово. Лог операции — в “Журнал операций Xkeen”.', false);
        toast('Готово', false);
        closeModal();
        return true;
      }

      setStatus('Сохранение/перезапуск завершились с ошибкой. См. журнал.', true);
      return false;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      setStatus('Ошибка: ' + msg, true);
      toast('Ошибка: ' + msg, true);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function refreshOutboundTags() {
    setStatus('Получаю теги из outbounds…', false);
    const tags = await fetchOutboundTags();
    FW._state.tags = tags;
    fillOutboundSelect(tags);
    setStatus(tags.length ? `Теги загружены: ${tags.length}` : 'Не удалось получить outbound‑теги.', !tags.length);
  }

  function ensureModelSyncToState() {
    const importLegacy = !!($(IDS.importLegacy) && $(IDS.importLegacy).checked);
    const rr = (RM && typeof RM.loadFromEditor === 'function') ? RM.loadFromEditor({ setError: false }) : { ok: false };
    if (!rr || rr.ok === false) return;
    const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (rr.model || {});
    FW._state.forced = extractWizardForcedFromModel(m, importLegacy);
  }

  function wireOnce() {
    if (FW.__wired) return;

    const modal = ensureModalDom();
    const btn = $(BTN_ID);
    if (!btn || !modal) return;
    FW.__wired = true;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      setStatus('', false);
      openModal();

      setBusy(true);
      try {
        // 1) Refresh tags (best effort)
        await refreshOutboundTags();
      } catch (e2) {
        setStatus('Не удалось обновить список outbound‑тегов. Можно ввести значения и всё равно применить.', true);
      } finally {
        setBusy(false);
      }

      // 2) Import existing wizard rules from current editor
      try {
        ensureModelSyncToState();
        renderList();
      } catch (e3) {
        renderList();
      }
    });

    const closeBtn = $(IDS.close);
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    const cancelBtn = $(IDS.cancel);
    if (cancelBtn) cancelBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    modal.addEventListener('click', (e) => {
      try {
        if (e && e.target === modal) closeModal();
      } catch (e2) {}
    });

    document.addEventListener('keydown', (e) => {
      try {
        if (e.key !== 'Escape') return;
        const m = $(MODAL_ID);
        if (!m || m.classList.contains('hidden')) return;
        closeModal();
      } catch (e2) {}
    });

    const refreshBtn = $(IDS.refresh);
    if (refreshBtn) refreshBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      setBusy(true);
      try { await refreshOutboundTags(); } finally { setBusy(false); }
    });

    const addBtn = $(IDS.add);
    if (addBtn) addBtn.addEventListener('click', (e) => {
      e.preventDefault();
      const sel = $(IDS.outbound);
      const typeEl = $(IDS.type);
      const valEl = $(IDS.values);
      const tag = sel ? String(sel.value || '').trim() : '';
      const kind = typeEl ? String(typeEl.value || 'domain') : 'domain';
      const values = normalizeList(valEl ? valEl.value : '');
      if (!tag) {
        setStatus('Выберите outboundTag.', true);
        return;
      }
      if (!values.length) {
        setStatus('Добавьте хотя бы одно значение.', true);
        return;
      }
      const r = addValuesToState(tag, kind, values);
      try { if (valEl) valEl.value = ''; } catch (e2) {}
      renderList();
      setStatus(`Добавлено: ${r.added}.`, false);
    });

    const clearProxyBtn = $(IDS.clearProxy);
    if (clearProxyBtn) clearProxyBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearSelected();
      setStatus('Очищено.', false);
    });

    const clearAllBtn = $(IDS.clearAll);
    if (clearAllBtn) clearAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      clearAll();
      setStatus('Удалены все записи мастера.', false);
    });

    const importLegacyEl = $(IDS.importLegacy);
    if (importLegacyEl) importLegacyEl.addEventListener('change', () => {
      try {
        ensureModelSyncToState();
        renderList();
      } catch (e) {}
    });

    const listEl = $(IDS.list);
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        try {
          const t = e && e.target;
          if (!t || !t.getAttribute) return;
          if (!t.classList || !t.classList.contains('xk-chip')) return;
          const tag = t.getAttribute('data-tag');
          const kind = t.getAttribute('data-kind');
          const val = t.getAttribute('data-value');
          deleteChip(tag, kind, val);
        } catch (e2) {}
      });
    }

    const dryBtn = $(IDS.dry);
    if (dryBtn) dryBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await runFlow({ dry: true });
    });

    const runBtn = $(IDS.run);
    if (runBtn) runBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await runFlow({ dry: false });
    });
  }

  FW.init = function init() {
    setTimeout(() => {
      try { wireOnce(); } catch (e) {}
    }, 0);
  };

  // Auto-init
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => FW.init());
  } else {
    FW.init();
  }
})();
