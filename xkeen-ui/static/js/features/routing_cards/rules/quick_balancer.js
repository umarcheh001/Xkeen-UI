import { getRoutingApi } from '../../routing.js';

import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/rules/quick_balancer.js
  Quick wizard: create/update balancer leastPing + generate 07_observatory.json + save+restart (job).

  Goal: “одна кнопка → сразу работает”.

  Public API:
    RC.rules.quickBalancer.init()
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.rules = RC.rules || {};

  RC.rules.quickBalancer = RC.rules.quickBalancer || {};
  const QB = RC.rules.quickBalancer;

  const C = RC.common || {};
  const toast = (typeof C.toast === 'function') ? C.toast : function (msg, isErr) {
    try { console[(isErr ? 'error' : 'log')](String(msg || '')); } catch (e) {}
  };
  const safeJsonParse = (typeof C.safeJsonParse === 'function') ? C.safeJsonParse : function (t) {
    try { return JSON.parse(String(t || '')); } catch (e) { return { __error: e }; }
  };

  const RM = (RC.rules && RC.rules.model) ? RC.rules.model : {};
  const RA = (RC.rules && RC.rules.apply) ? RC.rules.apply : {};
  const RR = (RC.rules && RC.rules.render) ? RC.rules.render : {};

  const MODAL_ID = 'routing-balancer-quick-modal';
  const BTN_ID = 'routing-balancer-quick-btn';

  const IDS = {
    close: 'routing-balancer-quick-close-btn',
    cancel: 'routing-balancer-quick-cancel-btn',
    run: 'routing-balancer-quick-run-btn',
    dry: 'routing-balancer-quick-dry-btn',
    refreshTags: 'routing-balancer-quick-refresh-tags-btn',
    status: 'routing-balancer-quick-status',
    tag: 'routing-balancer-quick-tag',
    fallback: 'routing-balancer-quick-fallback',
    tags: 'routing-balancer-quick-tags',
    probeUrl: 'routing-balancer-quick-probe-url',
    probeInterval: 'routing-balancer-quick-probe-interval',
    conc: 'routing-balancer-quick-concurrency',
    defaultRule: 'routing-balancer-quick-default-rule',
    overwriteObs: 'routing-balancer-quick-overwrite-observatory',
    summary: 'routing-balancer-quick-summary',
  };

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function ensureModalDom() {
    let modal = $(MODAL_ID);
    if (modal) return modal;
    if (!document.body) return null;

    document.body.insertAdjacentHTML('beforeend', `
      <div id="routing-balancer-quick-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Быстрый старт балансировщика (leastPing)">
        <div class="modal-content xk-qb-modal" data-modal-key="routing-balancer-quick-premium-v1">
          <div class="modal-header">
            <span class="modal-title">Быстрый старт: балансировщик leastPing</span>
            <button type="button" class="modal-close" id="routing-balancer-quick-close-btn" title="Закрыть">×</button>
          </div>
          <div class="modal-body">
            <div class="xk-qb-lead">
              <div class="xk-qb-lead-icon">⚡</div>
              <div class="xk-qb-lead-text">
                <div class="xk-qb-lead-title">leastPing + observatory + готовое правило маршрутизации</div>
                <p class="modal-description" style="margin:0;">
                  Мастер создаст или обновит балансировщик <code>leastPing</code>, сформирует <code>07_observatory.json</code>, при необходимости добавит дефолтное правило и затем выполнит <b>Сохранить + Перезапуск</b> с логом.
                </p>
              </div>
            </div>

            <div class="xk-qb-grid">
              <section class="xk-qb-panel xk-qb-main-panel">
                <div class="xk-qb-panelhead">
                  <div>
                    <div class="xk-qb-kicker">Шаг 1</div>
                    <div class="terminal-menu-title" style="margin:0;">Параметры балансировщика</div>
                  </div>
                  <div id="routing-balancer-quick-summary" class="xk-qb-summary" data-tooltip="Текущий balancer.tag и количество выбранных прокси-тегов">proxy · 0 tag</div>
                </div>

                <div class="xk-qb-fields-grid">
                  <label>
                    <span class="xk-qb-fieldlabel">balancer.tag</span>
                    <input id="routing-balancer-quick-tag" class="routing-rule-input" type="text" value="proxy" placeholder="proxy">
                  </label>
                  <label>
                    <span class="xk-qb-fieldlabel">fallbackTag</span>
                    <input id="routing-balancer-quick-fallback" class="routing-rule-input" type="text" value="direct" placeholder="direct">
                  </label>
                  <label class="xk-qb-fieldwide">
                    <span class="xk-qb-fieldlabel">probeUrl</span>
                    <input id="routing-balancer-quick-probe-url" class="routing-rule-input" type="text" value="https://www.gstatic.com/generate_204" placeholder="https://www.gstatic.com/generate_204">
                  </label>
                  <label>
                    <span class="xk-qb-fieldlabel">probeInterval</span>
                    <input id="routing-balancer-quick-probe-interval" class="routing-rule-input" type="text" value="60s" placeholder="60s">
                  </label>
                </div>

                <div class="xk-qb-options-grid">
                  <label class="xk-qb-option-card">
                    <input type="checkbox" id="routing-balancer-quick-default-rule" checked>
                    <div class="xk-qb-option-copy">
                      <strong>Сделать балансировщик дефолтным</strong>
                      <small>Добавить правило match-all с <code>balancerTag</code> для inbound <code>redirect / tproxy</code>.</small>
                    </div>
                  </label>
                  <label class="xk-qb-option-card">
                    <input type="checkbox" id="routing-balancer-quick-overwrite-observatory" checked>
                    <div class="xk-qb-option-copy">
                      <strong>Перезаписать observatory</strong>
                      <small>Разрешить панели обновить существующий <code>07_observatory.json</code>.</small>
                    </div>
                  </label>
                  <label class="xk-qb-option-card xk-qb-option-card-compact">
                    <input type="checkbox" id="routing-balancer-quick-concurrency" checked>
                    <div class="xk-qb-option-copy">
                      <strong>enableConcurrency</strong>
                      <small>Параллельная проверка доступности узлов.</small>
                    </div>
                  </label>
                </div>
              </section>

              <section class="xk-qb-panel xk-qb-tags-panel">
                <div class="xk-qb-panelhead">
                  <div>
                    <div class="xk-qb-kicker">Шаг 2</div>
                    <div class="terminal-menu-title" style="margin:0;">Пул тегов для selector / subjectSelector</div>
                  </div>
                  <button type="button" class="btn-secondary btn-compact xk-qb-refresh-btn" id="routing-balancer-quick-refresh-tags-btn" data-tooltip="Взять теги из 04_outbounds.json и исключить служебные outbound">
                    <span class="xk-btn-inline-glyph" aria-hidden="true">⟳</span>
                    <span>Обновить</span>
                  </button>
                </div>

                <label class="xk-qb-editor-block">
                  <span class="xk-qb-fieldlabel">Список тегов</span>
                  <textarea id="routing-balancer-quick-tags" class="xkeen-textarea" spellcheck="false" rows="9" placeholder="tag1
tag2
..."></textarea>
                </label>

                <div class="xk-qb-note">
                  <div><b>Подсказка:</b> по умолчанию мастер подтягивает все обычные outbound-теги, исключая <code>direct</code>, <code>block</code>, <code>dns</code> и другие служебные значения.</div>
                  <div>Можно оставить только нужные теги вручную — по одному на строку.</div>
                </div>

                <div id="routing-balancer-quick-status" class="xk-qb-statusbar"></div>
              </section>
            </div>
          </div>

          <div class="modal-actions xk-qb-footer">
            <div class="xk-qb-footer-left">
              <button type="button" id="routing-balancer-quick-cancel-btn" class="btn-compact">Отмена</button>
            </div>
            <div class="xk-qb-footer-actions">
              <button type="button" class="btn-secondary btn-compact xk-qb-footer-btn" id="routing-balancer-quick-dry-btn" data-tooltip="Только обновить карточки и JSON-редактор, без сохранения и рестарта.">
                <span class="xk-btn-inline-glyph" aria-hidden="true">✓</span>
                <span>Только применить</span>
              </button>
              <button type="button" class="btn-danger btn-compact xk-qb-footer-btn xk-qb-primary-action" id="routing-balancer-quick-run-btn">
                <span class="xk-btn-inline-glyph" aria-hidden="true">⟳</span>
                <span>Применить + Рестарт</span>
              </button>
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

  function setStatus(msg, isErr, isSuccess) {
    const el = $(IDS.status);
    if (!el) return;
    try {
      el.textContent = String(msg || '');
      if (el.classList) {
        el.classList.toggle('is-error', !!isErr);
        el.classList.toggle('is-success', !isErr && !!isSuccess);
      }
      if (!el.classList || (!el.classList.contains('is-error') && !el.classList.contains('is-success'))) {
        el.style.color = isErr ? 'var(--danger, #ef4444)' : 'var(--modal-muted, var(--muted, #9ca3af))';
      } else {
        el.style.color = '';
      }
    } catch (e) {}
  }

  function setBusy(busy) {
    const ids = [IDS.run, IDS.dry, IDS.refreshTags, IDS.cancel, IDS.close];
    ids.forEach((id) => {
      const el = $(id);
      if (!el) return;
      try { el.disabled = !!busy; } catch (e) {}
      try { el.classList.toggle('is-busy', !!busy); } catch (e2) {}
    });
  }

  function parseTags(text) {
    const raw = String(text || '')
      .replace(/,/g, '\n')
      .split(/\r?\n/)
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    raw.forEach((t) => {
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
    });
    return out;
  }

  function updateSummary() {
    const el = $(IDS.summary);
    if (!el) return;
    const balTag = String(($(IDS.tag) && $(IDS.tag).value) || 'proxy').trim() || 'proxy';
    const nTags = parseTags(($(IDS.tags) && $(IDS.tags).value) || '').length;
    const parts = [balTag, nTags + ' tag'];
    try {
      if ($(IDS.defaultRule) && $(IDS.defaultRule).checked) parts.push('default');
      el.textContent = parts.join(' · ');
    } catch (e) {}
  }

  function isDefaultBalancerRule(rule, balancerTag) {
    const bt = String(balancerTag || '').trim();
    if (!bt || !rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    if (String(rule.balancerTag || '').trim() !== bt) return false;

    const keys = Object.keys(rule);
    const allowed = new Set(['type', 'balancerTag', 'ruleTag', 'inboundTag']);
    for (const k of keys) {
      if (allowed.has(k)) continue;
      return false;
    }

    const inbound = Array.isArray(rule.inboundTag)
      ? rule.inboundTag.map((v) => String(v || '').trim()).filter(Boolean)
      : (rule.inboundTag ? [String(rule.inboundTag || '').trim()].filter(Boolean) : []);

    if (!inbound.length) return true;
    const s = new Set(inbound);
    return s.has('redirect') || s.has('tproxy');
  }

  function hasRuleForBalancer(model, balancerTag) {
    const rules = Array.isArray(model && model.rules) ? model.rules : [];
    return rules.some((r) => isDefaultBalancerRule(r, balancerTag));
  }

  function findLeastPingBalancer(model) {
    const balancers = Array.isArray(model && model.balancers) ? model.balancers : [];
    for (let i = 0; i < balancers.length; i++) {
      const b = balancers[i];
      const st = b && typeof b === 'object' && b.strategy && typeof b.strategy === 'object' ? String(b.strategy.type || '').trim() : '';
      if (st === 'leastPing') return b;
    }
    return null;
  }

  function prefillFromRoutingModel() {
    const rr = (RM && typeof RM.loadFromEditor === 'function') ? RM.loadFromEditor({ setError: false }) : { ok: false };
    if (!rr || rr.ok === false) return false;
    const model = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (rr.model || {});
    const bal = findLeastPingBalancer(model);
    if (!bal) return false;

    const balTag = String(bal.tag || '').trim() || 'proxy';
    const fallback = String(bal.fallbackTag || '').trim() || 'direct';
    const selector = Array.isArray(bal.selector) ? bal.selector : [];

    const tagEl = $(IDS.tag);
    const fallbackEl = $(IDS.fallback);
    const tagsEl = $(IDS.tags);
    const defaultRuleEl = $(IDS.defaultRule);

    if (tagEl) tagEl.value = balTag;
    if (fallbackEl) fallbackEl.value = fallback;
    if (tagsEl && selector.length) tagsEl.value = selector.map((t) => String(t || '').trim()).filter(Boolean).join('\n');
    if (defaultRuleEl) defaultRuleEl.checked = hasRuleForBalancer(model, balTag);

    updateSummary();
    setStatus('Найден существующий leastPing-балансировщик. Поля предзаполнены из текущего routing.', false);
    return true;
  }

  const RESERVED = new Set([
    'direct', 'block', 'dns',
    'freedom', 'blackhole', 'reject', 'bypass',
  ]);

  function isReservedTag(tag, balancerTag) {
    const t = String(tag || '').trim();
    if (!t) return true;
    if (balancerTag && t === String(balancerTag)) return true;
    const lc = t.toLowerCase();
    if (RESERVED.has(lc)) return true;
    // Common “service” tags
    if (lc === 'api' || lc === 'xray-api' || lc === 'metrics') return true;
    return false;
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

  async function fetchObservatoryConfig() {
    try {
      const resp = await fetch('/api/xray/observatory/config', { method: 'GET', cache: 'no-store' });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data || data.ok === false) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  async function refreshTagsList() {
    const balTag = String(($(IDS.tag) && $(IDS.tag).value) || 'proxy').trim() || 'proxy';
    setStatus('Получаю теги из outbounds…', false);
    const tags = await fetchOutboundTags();
    const filtered = tags.filter((t) => !isReservedTag(t, balTag));
    const ta = $(IDS.tags);
    if (ta) {
      try { ta.value = filtered.join('\n'); } catch (e) {}
    }
    updateSummary();
    if (!filtered.length) setStatus('Не удалось найти подходящие outbound-теги. Введите список вручную.', true);
    else setStatus(`Найдено тегов: ${filtered.length}`, false, true);
  }

  function ensureLeastPingBalancer(model, balancerTag, selectorTags, fallbackTag) {
    const m = model || { balancers: [], rules: [] };
    if (!Array.isArray(m.balancers)) m.balancers = [];

    let bal = null;
    for (let i = 0; i < m.balancers.length; i++) {
      const b = m.balancers[i];
      if (b && typeof b === 'object' && !Array.isArray(b) && String(b.tag || '') === balancerTag) {
        bal = b;
        break;
      }
    }
    if (!bal) {
      bal = { tag: balancerTag };
      m.balancers.push(bal);
    }

    bal.tag = balancerTag;
    bal.selector = selectorTags.slice();
    bal.strategy = { type: 'leastPing' };
    if (fallbackTag) bal.fallbackTag = fallbackTag;
    else { try { delete bal.fallbackTag; } catch (e) {} }

    // Help the UI render the selector with checkboxes by default.
    try { bal.__xkSelectorMode = 'ui'; } catch (e) {}
    try { delete bal.__xkSelectorDraft; } catch (e) {}
    try { delete bal.__xkStrategyDraft; } catch (e) {}

    return bal;
  }

  function isUnconditionalRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
    const keys = Object.keys(rule);
    const allowed = new Set(['type', 'outboundTag', 'balancerTag', 'ruleTag']);
    for (const k of keys) {
      if (allowed.has(k)) continue;
      // Treat empty keys as conditions too.
      return false;
    }
    return true;
  }

  function findAutoRuleIdx(rules, autoTag) {
    if (!Array.isArray(rules)) return -1;
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      if (r && typeof r === 'object' && !Array.isArray(r) && String(r.ruleTag || '') === autoTag) return i;
    }
    return -1;
  }

  function chooseInsertIndex(rules) {
    if (!Array.isArray(rules) || !rules.length) return 0;
    // If there is an unconditional final rule (direct/block), insert before it.
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i];
      if (!isUnconditionalRule(r)) return rules.length;
      const out = String((r && (r.outboundTag || r.balancerTag)) || '').toLowerCase();
      if (out === 'direct' || out === 'block' || out === 'blackhole' || out === 'reject') return i;
      // keep scanning further up to find the first “catch-all” tail
    }
    return rules.length;
  }

  function ensureDefaultBalancerRule(model, balancerTag) {
    const m = model || { rules: [] };
    if (!Array.isArray(m.rules)) m.rules = [];
    const AUTO_RULETAG = 'xk_auto_leastPing';

    const idx = findAutoRuleIdx(m.rules, AUTO_RULETAG);
    if (idx >= 0) {
      const r = m.rules[idx];
      r.type = 'field';
      r.balancerTag = balancerTag;
      r.inboundTag = ['redirect', 'tproxy'];
      try { delete r.outboundTag; } catch (e) {}
      r.ruleTag = AUTO_RULETAG;
      return { rule: r, idx, inserted: false };
    }

    // Do not duplicate an existing catch-all rule for this balancer. Specific
    // domain/ip rules must not block creation of the default redirect/tproxy rule.
    for (let i = 0; i < m.rules.length; i++) {
      const r = m.rules[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      if (isDefaultBalancerRule(r, balancerTag)) {
        return { rule: r, idx: i, inserted: false, existed: true };
      }
    }

    const ins = chooseInsertIndex(m.rules);
    const rNew = { type: 'field', balancerTag, inboundTag: ['redirect', 'tproxy'], ruleTag: AUTO_RULETAG };
    m.rules.splice(ins, 0, rNew);
    return { rule: rNew, idx: ins, inserted: true };
  }

  async function generateObservatory(selectorTags, opts) {
    const payload = {
      subjectSelector: selectorTags,
      probeUrl: String(opts.probeUrl || '').trim(),
      probeInterval: String(opts.probeInterval || '').trim(),
      enableConcurrency: !!opts.enableConcurrency,
      overwrite: !!opts.overwrite,
    };

    const resp = await fetch('/api/xray/observatory/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data || data.ok === false) {
      const err = (data && (data.error || data.message)) ? String(data.error || data.message) : ('HTTP ' + resp.status);
      throw new Error(err);
    }
    return data;
  }

  async function applyModelToEditor() {
    if (!RA || typeof RA.applyToEditor !== 'function') {
      toast('Не найден модуль применения (applyToEditor).', true);
      return false;
    }
    return await RA.applyToEditor({ silent: false });
  }

  async function saveWithForcedRestart() {
    // Prefer routing module (it already does async=1 job + log rendering).
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

    // Fallback: best-effort direct save without restart log.
    try {
      const text = (C && typeof C.getEditorText === 'function') ? C.getEditorText() : '';
      const parsed = safeJsonParse(text);
      if (parsed && parsed.__error) throw parsed.__error;
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
      // Ensure model is in sync with editor
      const rr = (RM && typeof RM.loadFromEditor === 'function') ? RM.loadFromEditor({ setError: true }) : { ok: false };
      if (!rr || rr.ok === false) {
        setStatus('Сначала исправьте JSON в редакторе (или дождитесь загрузки файла).', true);
        return false;
      }

      const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (rr.model || {});

      const balTag = String(($(IDS.tag) && $(IDS.tag).value) || 'proxy').trim() || 'proxy';
      const fbTag = String(($(IDS.fallback) && $(IDS.fallback).value) || 'direct').trim() || 'direct';
      const selectorTags = parseTags(($(IDS.tags) && $(IDS.tags).value) || '')
        .filter((t) => !isReservedTag(t, balTag));

      if (!selectorTags.length) {
        setStatus('Список тегов пуст. Нажмите “Обновить список” или укажите теги вручную.', true);
        return false;
      }

      setStatus(`Балансировщик: ${balTag} (selector: ${selectorTags.length})…`, false);
      ensureLeastPingBalancer(m, balTag, selectorTags, fbTag);

      const needDefaultRule = !!($(IDS.defaultRule) && $(IDS.defaultRule).checked);
      if (needDefaultRule) {
        ensureDefaultBalancerRule(m, balTag);
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
        setStatus('Готово: изменения применены в редактор (без сохранения/рестарта).', false, true);
        toast('Изменения применены в редактор', false);
        return true;
      }

      const overwriteObs = !!($(IDS.overwriteObs) && $(IDS.overwriteObs).checked);
      setStatus('Генерирую 07_observatory.json…', false);
      await generateObservatory(selectorTags, {
        probeUrl: ($(IDS.probeUrl) && $(IDS.probeUrl).value) || '',
        probeInterval: ($(IDS.probeInterval) && $(IDS.probeInterval).value) || '',
        enableConcurrency: !!($(IDS.conc) && $(IDS.conc).checked),
        overwrite: overwriteObs,
      });

      setStatus('Сохраняю и перезапускаю…', false);
      const ok = await saveWithForcedRestart();
      if (ok) {
        setStatus('Готово. Лог перезапуска — в “Журнал перезапуска”.', false, true);
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

  function wireOnce() {
    if (QB.__wired) return;

    const modal = ensureModalDom();
    const btn = $(BTN_ID);
    if (!btn || !modal) return;
    QB.__wired = true;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      setStatus('', false);
      openModal();

      let prefilledFromRouting = false;
      try {
        prefilledFromRouting = prefillFromRoutingModel();
      } catch (e0) {}

      // Best-effort prefill from existing observatory
      try {
        const info = await fetchObservatoryConfig();
        if (info && info.exists && info.config) {
          const c = info.config;
          const pUrl = $(IDS.probeUrl);
          const pInt = $(IDS.probeInterval);
          const conc = $(IDS.conc);
          const tagsTa = $(IDS.tags);

          if (pUrl && c.probeUrl) pUrl.value = String(c.probeUrl || '');
          if (pInt && c.probeInterval) pInt.value = String(c.probeInterval || '');
          if (conc && typeof c.enableConcurrency === 'boolean') conc.checked = !!c.enableConcurrency;
          if (tagsTa && (!String(tagsTa.value || '').trim()) && Array.isArray(c.subjectSelector) && c.subjectSelector.length) {
            tagsTa.value = c.subjectSelector.map((t) => String(t || '').trim()).filter(Boolean).join('\n');
          }
        }
      } catch (e2) {}

      // If tags are empty, auto-refresh them.
      try {
        const ta = $(IDS.tags);
        if (ta && !String(ta.value || '').trim()) {
          await refreshTagsList();
        }
      } catch (e3) {}

      updateSummary();
      if (!prefilledFromRouting) {
        setStatus('Заполните параметры и список тегов. Можно начать с кнопки “Обновить”.', false);
      }
      try { if ($(IDS.tag) && typeof $(IDS.tag).focus === 'function') $(IDS.tag).focus(); } catch (e4) {}
    });

    const closeBtn = $(IDS.close);
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    const cancelBtn = $(IDS.cancel);
    if (cancelBtn) cancelBtn.addEventListener('click', (e) => { e.preventDefault(); closeModal(); });

    // Overlay click closes
    modal.addEventListener('click', (e) => {
      try {
        if (e && e.target === modal) closeModal();
      } catch (e2) {}
    });

    // ESC closes
    document.addEventListener('keydown', (e) => {
      try {
        if (e.key !== 'Escape') return;
        const m = $(MODAL_ID);
        if (!m || m.classList.contains('hidden')) return;
        closeModal();
      } catch (e2) {}
    });

    [IDS.tag, IDS.tags, IDS.fallback].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('input', () => updateSummary());
      el.addEventListener('change', () => updateSummary());
    });
    [IDS.defaultRule, IDS.overwriteObs, IDS.conc].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => updateSummary());
    });

    const refreshBtn = $(IDS.refreshTags);
    if (refreshBtn) refreshBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      setBusy(true);
      try { await refreshTagsList(); } finally { setBusy(false); }
    });

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

  QB.init = function init() {
    // Delay a bit: the routing view builds a lot of DOM on slow routers.
    setTimeout(() => {
      try { wireOnce(); } catch (e) {}
    }, 0);
  };

  // Auto-init (safe)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => QB.init());
  } else {
    QB.init();
  }
})();
