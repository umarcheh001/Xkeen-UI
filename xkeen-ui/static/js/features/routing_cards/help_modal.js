import { getRoutingCardsNamespace } from '../routing_cards_namespace.js';

/*
  routing_cards/help_modal.js
  RC-05: Field help modal extracted from routing_cards.js.
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const RC = getRoutingCardsNamespace();
  RC.state = RC.state || {};

  const FIELD_HELP_MODAL_ID = 'xkeen-routing-field-help-modal';
  const FIELD_HELP_TITLE_ID = 'xkeen-routing-field-help-title';
  const FIELD_HELP_BODY_ID = 'xkeen-routing-field-help-body';

  let _routingHelpWired = false;

  function getModalApi() {
    try {
      if (window.XKeen && XK.ui && XK.ui.modal) return XK.ui.modal;
    } catch (e) {}
    return null;
  }

  function ensureFieldHelpModal() {
    let modal = document.getElementById(FIELD_HELP_MODAL_ID);
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = FIELD_HELP_MODAL_ID;
    modal.className = 'modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Routing field help');

    const content = document.createElement('div');
    content.className = 'modal-content';
    content.style.maxWidth = '720px';

    const header = document.createElement('div');
    header.className = 'modal-header';

    const title = document.createElement('span');
    title.className = 'modal-title';
    title.id = FIELD_HELP_TITLE_ID;
    title.textContent = 'Описание параметра';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';

    header.appendChild(title);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body routing-help-body';
    body.id = FIELD_HELP_BODY_ID;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    actions.style.justifyContent = 'flex-end';

    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'btn-secondary';
    okBtn.textContent = 'Закрыть';

    actions.appendChild(okBtn);

    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(actions);
    modal.appendChild(content);

    function close() { closeFieldHelp(); }
    closeBtn.addEventListener('click', close);
    okBtn.addEventListener('click', close);

    document.body.appendChild(modal);
    return modal;
  }

  function renderFieldHelp(doc) {
    const body = document.getElementById(FIELD_HELP_BODY_ID);
    if (!body) return;
    body.innerHTML = '';

    if (!doc) {
      const p = document.createElement('p');
      p.textContent = 'Описание не найдено.';
      body.appendChild(p);
      return;
    }

    if (doc.desc) {
      const p = document.createElement('p');
      p.textContent = doc.desc;
      body.appendChild(p);
    }

    if (Array.isArray(doc.items) && doc.items.length) {
      const ul = document.createElement('ul');
      doc.items.forEach((item) => {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      });
      body.appendChild(ul);
    }

    if (doc.note) {
      const p = document.createElement('p');
      p.className = 'routing-help-note';
      p.textContent = doc.note;
      body.appendChild(p);
    }
  }

  function openFieldHelp(docKey) {
    const key = String(docKey || '').trim();
    const docs = RC.ROUTING_FIELD_DOCS || {};
    const doc = key ? docs[key] : null;
    const modal = ensureFieldHelpModal();
    const titleEl = document.getElementById(FIELD_HELP_TITLE_ID);
    if (titleEl) titleEl.textContent = doc ? ('Параметр: ' + doc.title) : 'Описание параметра';
    renderFieldHelp(doc);
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') api.open(modal, { source: 'routing_cards_help_modal' });
      else modal.classList.remove('hidden');
    } catch (e) {}
    try {
      if (!api || typeof api.open !== 'function') document.body.classList.add('modal-open');
    } catch (e2) {}
  }

  function closeFieldHelp() {
    const modal = document.getElementById(FIELD_HELP_MODAL_ID);
    if (!modal) return;
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') api.close(modal, { source: 'routing_cards_help_modal' });
      else modal.classList.add('hidden');
    } catch (e) {}
    try {
      if (!api || typeof api.close !== 'function') document.body.classList.remove('modal-open');
    } catch (e2) {}
  }

  function wireRoutingHelpButtons() {
    if (_routingHelpWired) return;
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.classList && e.target.classList.contains('routing-help-btn') ? e.target : null;
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset ? btn.dataset.doc : '';
      openFieldHelp(key);
    }, true);
    document.addEventListener('keydown', (e) => {
      const btn = e.target && e.target.classList && e.target.classList.contains('routing-help-btn') ? e.target : null;
      if (!btn) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      const key = btn.dataset ? btn.dataset.doc : '';
      openFieldHelp(key);
    }, true);
    _routingHelpWired = true;
  }

  // Export
  RC.helpModal = RC.helpModal || {};
  RC.helpModal.ensureFieldHelpModal = ensureFieldHelpModal;
  RC.helpModal.openFieldHelp = openFieldHelp;
  RC.helpModal.closeFieldHelp = closeFieldHelp;
  RC.helpModal.wireRoutingHelpButtons = wireRoutingHelpButtons;
})();
