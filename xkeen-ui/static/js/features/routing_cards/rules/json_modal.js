import { getRoutingCardsNamespace } from '../../routing_cards_namespace.js';

/*
  routing_cards/rules/json_modal.js
  JSON modal editor for Rules card (rules/balancers JSON editing).

  RC-07b
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.rules = RC.rules || {};

  const C = RC.common || {};
  const $ = (typeof C.$ === 'function') ? C.$ : function (id) { return document.getElementById(id); };
  const toast = (typeof C.toast === 'function') ? C.toast : function (msg) { try { /* eslint-disable-next-line no-alert */ alert(String(msg || '')); } catch (e) {} };

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};

  const RA = RC.rules.apply = RC.rules.apply || {};

  const MOD = RC.rules.jsonModal = RC.rules.jsonModal || {};

  const JSON_MODAL_ID = 'xkeen-routing-json-modal';
  let _jsonCtx = null; // { kind: 'rule'|'balancer'|'balancerSelector', idx: number, isNew: boolean }

  function setJsonModalStatus(message, isError) {
    const el = document.getElementById(JSON_MODAL_ID + '-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.style.color = isError ? '#fca5a5' : '';
  }

  function close() {
    const modal = document.getElementById(JSON_MODAL_ID);
    if (!modal) return;
    modal.classList.add('hidden');
    _jsonCtx = null;
    setJsonModalStatus('', false);

    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.remove('modal-open');
      }
    } catch (e) {}
  }

  function ensureJsonModal() {
    let modal = document.getElementById(JSON_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = JSON_MODAL_ID;
    modal.className = 'modal hidden routing-json-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '860px';

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('span');
    title.className = 'modal-title';
    title.id = JSON_MODAL_ID + '-title';
    title.textContent = 'Редактор JSON';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close');

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body routing-json-body';

    const textarea = document.createElement('textarea');
    textarea.id = JSON_MODAL_ID + '-text';
    textarea.className = 'routing-json-textarea';
    textarea.spellcheck = false;

    const status = document.createElement('div');
    status.id = JSON_MODAL_ID + '-status';
    status.className = 'status routing-json-status';

    body.appendChild(textarea);
    body.appendChild(status);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.style.justifyContent = 'space-between';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn-secondary';
    cancelBtn.textContent = 'Отмена';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn-primary';
    saveBtn.textContent = 'Сохранить';

    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);

    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(actions);
    modal.appendChild(content);

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    saveBtn.addEventListener('click', (e) => { e.preventDefault(); save(); });
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    document.body.appendChild(modal);
    return modal;
  }

  function open(obj, titleText, ctx) {
    const modal = ensureJsonModal();
    _jsonCtx = ctx || null;

    const title = document.getElementById(JSON_MODAL_ID + '-title');
    const ta = document.getElementById(JSON_MODAL_ID + '-text');
    if (title) title.textContent = String(titleText || 'Редактор JSON');
    if (ta) {
      try {
        const safeObj = (RM && typeof RM.sanitizeForExport === 'function') ? RM.sanitizeForExport(obj || {}) : (obj || {});
        ta.value = JSON.stringify(safeObj, null, 2);
      } catch (e) { ta.value = String(obj || ''); }
      ta.scrollTop = 0;
    }
    setJsonModalStatus('', false);
    modal.classList.remove('hidden');

    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      } else {
        document.body.classList.add('modal-open');
      }
    } catch (e) {}

    if (ta) setTimeout(() => { try { ta.focus(); } catch (e) {} }, 0);
  }

  function save() {
    const ta = document.getElementById(JSON_MODAL_ID + '-text');
    if (!ta) return;
    const raw = String(ta.value || '').trim();
    if (!raw) {
      setJsonModalStatus('Пустой JSON', true);
      return;
    }

    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      setJsonModalStatus('Ошибка JSON: ' + String(e && e.message ? e.message : e), true);
      return;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      setJsonModalStatus('Ожидается JSON-объект', true);
      return;
    }


    // Drop internal draft keys ("__xk*") if user copied from UI preview.
    try {
      if (RM && typeof RM.sanitizeForExport === 'function') obj = RM.sanitizeForExport(obj);
    } catch (e) {}

    const ctx = _jsonCtx;
    const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : null;
    if (!ctx || !ctx.kind || !m) {
      setJsonModalStatus('Нет контекста сохранения', true);
      return;
    }

    try {
      if (ctx.kind === 'rule') {
        if (ctx.isNew) {
          m.rules.push(obj);
        } else {
          const prev = m.rules[ctx.idx];
          const wasOpen = S._openSet && S._openSet.has(prev);
          if (S._openSet) S._openSet.delete(prev);
          m.rules[ctx.idx] = obj;
          if (wasOpen && S._openSet) S._openSet.add(obj);
        }
      } else if (ctx.kind === 'balancer') {
        if (ctx.isNew) {
          m.balancers.push(obj);
        } else {
          const prev = m.balancers[ctx.idx];
          const prevTag = prev && prev.tag ? String(prev.tag).trim() : '';
          const nextTag = obj && obj.tag ? String(obj.tag).trim() : '';
          const wasOpen = S._balOpenSet && S._balOpenSet.has(prev);
          if (S._balOpenSet) S._balOpenSet.delete(prev);
          m.balancers[ctx.idx] = obj;
          if (prevTag && nextTag && prevTag !== nextTag && RM && typeof RM.retargetRulesForBalancer === 'function') {
            try { RM.retargetRulesForBalancer(prevTag, nextTag); } catch (e) {}
          }
          if (wasOpen && S._balOpenSet) S._balOpenSet.add(obj);
        }
      } else if (ctx.kind === 'balancerSelector') {
        const b = m.balancers[ctx.idx];
        if (!b) {
          setJsonModalStatus('Балансировщик не найден', true);
          return;
        }
        const sel = obj && obj.selector;
        if (!Array.isArray(sel)) {
          setJsonModalStatus('Ожидается объект вида {"selector": ["..."]}', true);
          return;
        }
        const arr = sel.map((x) => String(x || '').trim()).filter(Boolean);
        if (arr.length) b.selector = arr;
        else { try { delete b.selector; } catch (e) {} }
      }

      if (RM && typeof RM.markDirty === 'function') RM.markDirty(true);

      close();

      // renderAll пока живёт в routing_cards.js — временно экспортируем через RC.rules.renderAll.
      try {
        if (RC.rules && typeof RC.rules.renderAll === 'function') RC.rules.renderAll();
      } catch (e) {}

      // Old behavior: reflect changes in the main JSON editor immediately.
      try {
        if (RA && typeof RA.requestAutoApply === 'function') {
          RA.requestAutoApply({ immediate: true });
        } else if (RA && typeof RA.applyToEditor === 'function') {
          setTimeout(() => {
            try { Promise.resolve(RA.applyToEditor()).catch(() => {}); } catch (e3) {}
          }, 0);
        }
      } catch (e) {}

    } catch (e) {
      setJsonModalStatus('Не удалось сохранить: ' + String(e && e.message ? e.message : e), true);
    }
  }

  // Public interface
  MOD.open = open;
  MOD.close = close;
  MOD.save = save;
  MOD.ensure = ensureJsonModal;
})();
