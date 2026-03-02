(() => {
  'use strict';

  // File Manager: modal wiring that depends on multiple modules
  // (conflicts/progress/ops + delegates to actions modal wiring).
  //
  // Exports:
  //   FM.actions.wireModals()

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  FM.actions = FM.actions || {};
  const AC = FM.actions;

  const C = FM.common || {};
  const OPS = FM.ops || {};
  const PROG = FM.progress || {};
  const DD = FM.dragdrop || {};

  const S = (() => {
    try {
      FM.state = FM.state || {};
      FM.state.S = FM.state.S || {};
      return FM.state.S;
    } catch (e) {
      return {};
    }
  })();

  function el(id) {
    try { if (C && typeof C.el === 'function') return C.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function modalOpen(modal) {
    try { if (C && typeof C.modalOpen === 'function') return C.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    try { if (C && typeof C.modalClose === 'function') return C.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function wireModals() {
    // global guard
    try {
      if (S && S._wireModalsWired2) return;
      if (S) S._wireModalsWired2 = true;
    } catch (e) {}

    // 1) Actions' own modals (create/rename/archive/chmod/chown/pickers)
    try {
      if (AC && typeof AC._wireActionModals === 'function') AC._wireActionModals();
    } catch (e) {}

    // 2) Drag&Drop: choose Move or Copy modal
    // (idempotent guard is inside dragdrop.js)
    try {
      if (DD && typeof DD.wireDropOpModal === 'function') DD.wireDropOpModal();
    } catch (e) {}

    // 3) Conflicts modal
    const cOk = el('fm-conflicts-ok-btn');
    const cCancel = el('fm-conflicts-cancel-btn');
    const cClose = el('fm-conflicts-close-btn');
    const closeConflicts = () => {
      try { S.pending = null; } catch (e) {}
      modalClose(el('fm-conflicts-modal'));
    };

    if (cOk) cOk.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      try {
        if (OPS && typeof OPS.applyConflictsAndContinue === 'function') OPS.applyConflictsAndContinue();
      } catch (e3) {}
    });
    if (cCancel) cCancel.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeConflicts(); });
    if (cClose) cClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeConflicts(); });

    const cm = el('fm-conflicts-modal');
    if (cm) cm.addEventListener('click', (e) => { try { if (e && e.target === cm) closeConflicts(); } catch (e2) {} });

    // 4) Progress modal
    const pOk = el('fm-progress-ok-btn');
    const pCancel = el('fm-progress-cancel-btn');
    const pClose = el('fm-progress-close-btn');
    const closeProgress = () => {
      try { if (PROG && typeof PROG.clearAutoClose === 'function') PROG.clearAutoClose(); } catch (e) {}
      modalClose(el('fm-progress-modal'));
    };

    if (pOk) pOk.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeProgress(); });
    if (pClose) pClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeProgress(); });
    if (pCancel) pCancel.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}
      // If an XHR transfer is active, abort it first.
      try {
        if (S && S.transfer && S.transfer.xhr) {
          S.transfer.xhr.abort();
          // UI is handled by transfers.js (cancel handler installed per-transfer)
          return;
        }
      } catch (e3) {}
      const jobId = S && S.ws ? S.ws.jobId : '';
      try {
        if (jobId && OPS && typeof OPS.cancelJob === 'function') await OPS.cancelJob(jobId);
      } catch (e4) {}
    });

    const pm = el('fm-progress-modal');
    if (pm) pm.addEventListener('click', (e) => { try { if (e && e.target === pm) closeProgress(); } catch (e2) {} });

    // 5) Ops modal
    const opsBtn = el('fm-ops-btn');
    const opsClose = el('fm-ops-close-btn');
    const opsRefresh = el('fm-ops-refresh-btn');
    const opsFilter = el('fm-ops-filter');
    const opsClear = el('fm-ops-clear-btn');

    if (opsBtn) opsBtn.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}
      // Sync UI controls with in-memory state.
      try { if (opsFilter) opsFilter.value = String((S && S.opsUi && S.opsUi.filter) || 'all'); } catch (e0) {}
      try {
        if (OPS && typeof OPS.refreshOpsList === 'function') await OPS.refreshOpsList();
      } catch (e3) {}
      modalOpen(el('fm-ops-modal'));
    });
    if (opsClose) opsClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} modalClose(el('fm-ops-modal')); });
    if (opsRefresh) opsRefresh.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} try { if (OPS && typeof OPS.refreshOpsList === 'function') OPS.refreshOpsList(); } catch (e3) {} });

    if (opsFilter) opsFilter.addEventListener('change', () => {
      try { if (S && S.opsUi) S.opsUi.filter = String(opsFilter.value || 'all'); } catch (e) {}
      try { if (OPS && typeof OPS.renderOpsList === 'function') OPS.renderOpsList((S && S.opsUi && S.opsUi.lastJobs) || []); } catch (e2) {}
    });

    if (opsClear) opsClear.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}

      const ok = await (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function'
        ? XKeen.ui.confirm({
          title: 'Очистить историю',
          message: 'Удалить завершённые и неудачные операции из списка?\n(Активные операции останутся.)',
          okText: 'Очистить',
          cancelText: 'Отмена',
          danger: true,
        })
        : Promise.resolve(window.confirm('Очистить историю операций?')));

      if (!ok) return;

      let serverOk = false;
      try {
        if (OPS && typeof OPS.clearOpsHistory === 'function') {
          serverOk = await OPS.clearOpsHistory('history');
        }
      } catch (e3) { serverOk = false; }
      if (serverOk) return;

      // Fallback: hide locally (persisted in localStorage).
      const jobs = (S && S.opsUi && S.opsUi.lastJobs) ? S.opsUi.lastJobs : [];
      const idsToHide = [];
      (jobs || []).forEach((j) => {
        const jid = String(j && (j.job_id || '') || '');
        if (!jid) return;
        const st = String(j && (j.state || '') || '').toLowerCase();
        if (st === 'done' || st === 'error' || st === 'canceled') idsToHide.push(jid);
      });

      let n = 0;
      try {
        if (OPS && typeof OPS.hideMany === 'function') n = OPS.hideMany(idsToHide);
      } catch (e4) { n = 0; }

      toast(n ? `Скрыто: ${n}` : 'Нечего очищать', n ? 'success' : 'info');

      try {
        if (OPS && typeof OPS.renderOpsList === 'function') OPS.renderOpsList(jobs);
      } catch (e5) {}
    });

    const om = el('fm-ops-modal');
    if (om) om.addEventListener('click', (e) => { try { if (e && e.target === om) modalClose(om); } catch (e2) {} });
  }

  AC.wireModals = wireModals;
})();