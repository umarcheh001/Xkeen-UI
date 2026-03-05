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
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
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
  };

  function $(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function _syncBodyScroll() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function openModal() {
    const m = $(MODAL_ID);
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
    try {
      const resp = await fetch('/api/xray/outbound-tags', { method: 'GET' });
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
    if (!filtered.length) setStatus('Не удалось найти подходящие outbound-теги. Введите список вручную.', true);
    else setStatus(`Найдено тегов: ${filtered.length}`, false);
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
      try { delete r.outboundTag; } catch (e) {}
      r.ruleTag = AUTO_RULETAG;
      return { rule: r, idx, inserted: false };
    }

    // If user already has a rule that routes via this balancer, do not add another one.
    for (let i = 0; i < m.rules.length; i++) {
      const r = m.rules[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
      if (String(r.balancerTag || '') === balancerTag) {
        return { rule: r, idx: i, inserted: false, existed: true };
      }
    }

    const ins = chooseInsertIndex(m.rules);
    const rNew = { type: 'field', balancerTag, ruleTag: AUTO_RULETAG };
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
    if (window.XKeen && XKeen.routing && typeof XKeen.routing.save === 'function') {
      const chk = document.getElementById('global-autorestart-xkeen');
      const prev = chk ? !!chk.checked : null;
      try {
        if (chk) chk.checked = true;
        await XKeen.routing.save();
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
        setStatus('Готово: изменения применены в редактор (без сохранения/рестарта).', false);
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
        setStatus('Готово. Лог перезапуска — в “Журнал перезапуска”.', false);
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
    QB.__wired = true;

    const btn = $(BTN_ID);
    const modal = $(MODAL_ID);
    if (!btn || !modal) return;

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      setStatus('', false);
      openModal();

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
          if (tagsTa && Array.isArray(c.subjectSelector) && c.subjectSelector.length) {
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
