(() => {
  // Backups feature module.
  // Supports two modes depending on the page:
  //  - history: /backups page (old timestamped backups)  -> /api/backups, /api/restore, /api/delete-backup
  //  - snapshots: panel card (rollback snapshots per file) -> /api/xray/snapshots, /api/xray/snapshots/read, /api/xray/snapshots/restore

  window.XKeen = window.XKeen || {};
  XKeen.backups = XKeen.backups || {};
  const UI = (window.XKeen && XKeen.ui && XKeen.ui.sharedPrimitives) ? XKeen.ui.sharedPrimitives : null;

  let _inited = false;
  let _mode = null; // 'history' | 'snapshots'

  // Snapshot preview modal
  let _snapWired = false;
  let _snapCm = null;
  let _snapCmFacade = null;
  let _snapLastText = '';
  let _snapMonaco = null;
  let _snapMonacoFacade = null;
  let _snapKind = 'codemirror';
  let _snapEngineSyncing = false;
  let _snapEngineUnsub = null;
  let _snapCurrentName = '';
  let _snapViewStateStore = null;

  function el(id) {
    try {
      if (UI && typeof UI.byId === 'function') return UI.byId(id);
    } catch (e) {}
    return document.getElementById(id);
  }

  function showNode(node) {
    if (!node) return;
    try { node.classList.remove('hidden'); } catch (e) {}
  }

  function hideNode(node) {
    if (!node) return;
    try { node.classList.add('hidden'); } catch (e) {}
  }

  function getModalApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal) return XKeen.ui.modal;
    } catch (e) {}
    return null;
  }

  function showModal(modal, source) {
    if (UI && typeof UI.openModal === 'function') return UI.openModal(modal, { source: source || 'backups' });
    if (!modal) return false;
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') return api.open(modal, { source: source || 'backups' });
    } catch (e) {}
    try { modal.classList.remove('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
    } catch (e3) {}
    return true;
  }

  function hideModal(modal, source) {
    if (UI && typeof UI.closeModal === 'function') return UI.closeModal(modal, { source: source || 'backups' });
    if (!modal) return false;
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') return api.close(modal, { source: source || 'backups' });
    } catch (e) {}
    try { modal.classList.add('hidden'); } catch (e2) {}
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') api.syncBodyScrollLock();
    } catch (e3) {}
    return true;
  }

  function cmWrapper(cm) {
    try { return cm && typeof cm.getWrapperElement === 'function' ? cm.getWrapperElement() : null; } catch (e) {}
    return null;
  }

  function modalOpen(id) {
    const m = el(id);
    return !!(m && !m.classList.contains('hidden'));
  }

  function getEngineHelper() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.editorEngine) return XKeen.ui.editorEngine;
    } catch (e) {}
    return null;
  }

  const CM6_SCOPE = 'backups';

  function withCm6Scope(opts) {
    return Object.assign({ cm6Scope: CM6_SCOPE, scope: CM6_SCOPE }, opts || {});
  }

  function getEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper || typeof helper.getRuntime !== 'function') return null;
    try { return helper.getRuntime(engine, withCm6Scope(opts)); } catch (e) {}
    return null;
  }

  async function ensureEditorRuntime(engine, opts) {
    const helper = getEngineHelper();
    if (!helper) return null;
    try {
      if (typeof helper.ensureRuntime === 'function') return await helper.ensureRuntime(engine, withCm6Scope(opts));
      if (typeof helper.getRuntime === 'function') return helper.getRuntime(engine, withCm6Scope(opts));
    } catch (e) {}
    return null;
  }

  function isCm6Runtime(runtime) {
    try { return !!(runtime && runtime.backend === 'cm6'); } catch (e) {}
    return false;
  }

  function isCm6Editor(editor) {
    try {
      if (!editor) return false;
      if (editor.__xkeenCm6Bridge || editor.backend === 'cm6') return true;
      const wrap = (typeof editor.getWrapperElement === 'function') ? editor.getWrapperElement() : null;
      return !!(wrap && wrap.classList && wrap.classList.contains('xkeen-cm6-editor'));
    } catch (e) {}
    return false;
  }

  function disposeCodeMirrorEditor(editor) {
    if (!editor) return false;
    try { if (typeof editor.dispose === 'function') return !!editor.dispose(); } catch (e) {}
    try {
      if (typeof editor.toTextArea === 'function') {
        editor.toTextArea();
        return true;
      }
    } catch (e) {}
    return false;
  }

  function createCodeMirrorFacade(cm) {
    if (!cm) return null;
    const runtime = getEditorRuntime('codemirror');
    if (runtime && typeof runtime.toFacade === 'function') {
      try {
        return runtime.toFacade(cm, {
          layout: () => {
            try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
          },
        });
      } catch (e) {}
    }
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromCodeMirror !== 'function') return null;
    try {
      return helper.fromCodeMirror(cm, {
        layout: () => {
          try { if (cm.layout) cm.layout(); else if (cm.refresh) cm.refresh(); } catch (e) {}
        },
      });
    } catch (e) {}
    return null;
  }

  function createMonacoFacade(editor) {
    if (!editor) return null;
    const helper = getEngineHelper();
    if (!helper || typeof helper.fromMonaco !== 'function') return null;
    try {
      return helper.fromMonaco(editor);
    } catch (e) {}
    return null;
  }

  function getSnapActiveFacade() {
    if (_snapKind === 'monaco' && _snapMonacoFacade) return _snapMonacoFacade;
    if (_snapCmFacade) return _snapCmFacade;
    return null;
  }

  function getSnapViewStateStore() {
    if (_snapViewStateStore) return _snapViewStateStore;
    const helper = getEngineHelper();
    if (!helper || typeof helper.createViewStateStore !== 'function') return null;
    try {
      _snapViewStateStore = helper.createViewStateStore({
        buildKey: (ctx) => {
          const name = ctx && ctx.name ? String(ctx.name || '').trim() : '';
          if (!name) return '';
          return 'xkeen.backups.snapshot.viewstate.v1::' + encodeURIComponent(name);
        },
      });
    } catch (e) {
      _snapViewStateStore = null;
    }
    return _snapViewStateStore;
  }

  function getSnapViewStateContext(name) {
    const value = String(name || _snapCurrentName || '').trim();
    if (!value) return null;
    return { name: value };
  }

  function captureSnapViewState() {
    const store = getSnapViewStateStore();
    if (!store || typeof store.capture !== 'function') return null;
    return store.capture({
      engine: _snapKind,
      facade: getSnapActiveFacade(),
      textarea: el('xray-snapshot-preview'),
      capture: () => {
        const fac = getSnapActiveFacade();
        if (fac && typeof fac.saveViewState === 'function') {
          return fac.saveViewState({ memoryOnly: true });
        }
        return null;
      },
    });
  }

  function saveSnapViewState(opts) {
    const store = getSnapViewStateStore();
    const ctx = getSnapViewStateContext(opts && opts.name ? opts.name : null);
    if (!store || !ctx || typeof store.save !== 'function') return null;
    return store.save({
      ctx,
      engine: (opts && opts.engine) || _snapKind,
      view: (opts && typeof opts.view !== 'undefined') ? opts.view : captureSnapViewState(),
    });
  }

  function loadSnapViewState(name, engine) {
    const store = getSnapViewStateStore();
    const ctx = getSnapViewStateContext(name);
    if (!store || !ctx || typeof store.load !== 'function') return null;
    return store.load({ ctx, engine: engine || _snapKind });
  }

  function restoreSnapViewState(view) {
    const store = getSnapViewStateStore();
    if (!store || typeof store.restore !== 'function') return false;
    return !!store.restore({
      engine: _snapKind,
      facade: getSnapActiveFacade(),
      textarea: el('xray-snapshot-preview'),
      view,
    });
  }

  function clearSnapViewStateTracking() {
    const store = getSnapViewStateStore();
    if (!store) return;
    try { if (typeof store.clearTimer === 'function') store.clearTimer(); } catch (e) {}
    try { if (typeof store.clearBindings === 'function') store.clearBindings(); } catch (e2) {}
  }

  function bindSnapViewStateTracking() {
    const store = getSnapViewStateStore();
    const ctx = getSnapViewStateContext();
    if (!store || !ctx || typeof store.bind !== 'function') return;
    store.bind({
      ctx,
      engine: _snapKind,
      monaco: _snapKind === 'monaco' ? _snapMonaco : null,
      codemirror: _snapKind === 'codemirror' ? _snapCm : null,
      textarea: el('xray-snapshot-preview'),
      waitMs: 180,
      capture: () => captureSnapViewState(),
    });
  }

  function normalizeEngine(v) {
    const s = String(v || '').toLowerCase();
    return (s === 'monaco' || s === 'codemirror') ? s : 'codemirror';
  }

  function tableEl() {
    return document.getElementById('backups-table');
  }

  function getMode() {
    if (_mode) return _mode;
    const t = tableEl();
    const m = t && t.dataset ? String(t.dataset.mode || '').trim() : '';
    _mode = (m === 'snapshots') ? 'snapshots' : 'history';
    return _mode;
  }

  function normalizeToastKind(value, fallback) {
    const kind = String(value || fallback || 'info').trim().toLowerCase();
    if (kind === 'error' || kind === 'warning' || kind === 'success' || kind === 'info') return kind;
    return 'info';
  }

  function toast(message, kindOrError) {
    const text = String(message || '').trim();
    if (!text) return null;
    const kind = (typeof kindOrError === 'string')
      ? normalizeToastKind(kindOrError, 'info')
      : (kindOrError ? 'error' : 'info');
    try {
      if (UI && typeof UI.toast === 'function') return UI.toast(text, kind);
    } catch (e) {}
    try {
      if (typeof window.toast === 'function') return window.toast(text, kind);
    } catch (e2) {}
    try {
      if (typeof window.showToast === 'function') return window.showToast(text, kind);
    } catch (e3) {}
    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.toast === 'function') return XKeen.ui.toast(text, kind);
    } catch (e4) {}
    try { console.log('[xkeen]', text); } catch (e5) {}
    return null;
  }

  function writeStatus(statusEl, msg, isError) {
    if (!statusEl) return;
    try {
      if (UI && typeof UI.writeStatus === 'function') {
        UI.writeStatus(statusEl, msg, isError ? 'error' : 'info');
        return;
      }
    } catch (e) {}
    statusEl.textContent = String(msg ?? '');
    try { statusEl.classList.toggle('error', !!isError); } catch (e2) {}
  }

  function setStatus(msg, isError) {
    writeStatus(el('backups-status'), msg, isError);
    if (msg) toast(msg, isError ? 'error' : 'info');
  }

  function buildConfirmText(opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    const message = String(options.message || options.text || options.body || 'Продолжить?').trim() || 'Продолжить?';
    const details = Array.isArray(options.details)
      ? options.details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : String(options.details || '').trim();
    return details ? (message + '\n\n' + details) : message;
  }

  async function confirmAction(opts) {
    const options = (opts && typeof opts === 'object') ? opts : {};
    try {
      if (UI && typeof UI.confirmAction === 'function') return !!(await UI.confirmAction(options));
    } catch (e) {}

    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      return !!(await XKeen.ui.confirm(options));
    }

    const ok = window.confirm(buildConfirmText(options));
    if (!ok && options.cancelMessage) {
      toast(options.cancelMessage, options.cancelKind || 'info');
    }
    return !!ok;
  }

  function emitOutcome(statusEl, successMessage, warnings) {
    const warningList = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    const finalMessage = warningList.length
      ? (String(successMessage || '').trim() + ' Но: ' + warningList.join(' '))
      : String(successMessage || '').trim();

    writeStatus(statusEl || el('backups-status'), finalMessage, false);
    toast(finalMessage, warningList.length ? 'warning' : 'success');
  }

  async function requestXkeenRestartWarning() {
    try {
      const res = await fetch('/api/restart', { method: 'POST' });
      if (!res || !res.ok) {
        return 'Запрос на перезапуск xkeen не подтвердился. Обновите страницу позже или перезапустите xkeen вручную.';
      }
      return '';
    } catch (e) {
      return 'Не удалось подтвердить перезапуск xkeen. Обновите страницу позже или перезапустите xkeen вручную.';
    }
  }

  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    const kb = n / 1024;
    if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
    const gb = mb / 1024;
    return gb.toFixed(gb < 10 ? 1 : 0) + ' GB';
  }

  function shouldRestartAfterAction() {
    // Panel toggle; on other pages default to true.
    const cb = el('global-autorestart-xkeen');
    if (!cb) return true;
    return !!cb.checked;
  }

  function getTableBody() {
    const table = tableEl();
    if (!table) return null;
    return table.querySelector('tbody');
  }

  function renderEmptyRow(tbody, text) {
    tbody.innerHTML = '';
    const tr = document.createElement('tr');
    tr.classList.add('backups-empty-row');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = text || 'Бэкапов пока нет.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // ------------------------- history mode -------------------------
  function targetLabelForBackup(filename) {
    const name = String(filename || '');
    // Backups are named "<prefix>-YYYYMMDD-HHMMSS.json".
    // Prefix may include variants like *_hys2 (e.g. 05_routing_hys2-...).
    function labelFromPrefix(defLabel) {
      const prefix = name.split('-')[0] || '';
      return prefix ? (prefix + '.json') : defLabel;
    }

    if (name.startsWith('03_inbounds')) return { target: 'inbounds', label: labelFromPrefix('03_inbounds.json') };
    if (name.startsWith('04_outbounds')) return { target: 'outbounds', label: labelFromPrefix('04_outbounds.json') };
    return { target: 'routing', label: labelFromPrefix('05_routing.json') };
  }

  function renderRowHistory(tbody, b) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = String(b && b.name ? b.name : '');
    nameTd.appendChild(code);
    tr.appendChild(nameTd);

    const sizeTd = document.createElement('td');
    sizeTd.textContent = formatSize(b && b.size);
    tr.appendChild(sizeTd);

    const mtimeTd = document.createElement('td');
    mtimeTd.textContent = String(b && b.mtime ? b.mtime : '');
    tr.appendChild(mtimeTd);

    const actionTd = document.createElement('td');
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'backup-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'backup-icon-btn';
    restoreBtn.title = 'Восстановить бэкап';
    restoreBtn.setAttribute('data-tooltip', 'Восстановить бэкап');
    restoreBtn.innerHTML = '<img src="/static/icons/restore.svg" alt="Восстановить" class="backup-icon">';
    restoreBtn.addEventListener('click', () => restoreBackup(String(b && b.name ? b.name : '')));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'backup-icon-btn backup-delete-btn';
    deleteBtn.title = 'Удалить бэкап';
    deleteBtn.setAttribute('data-tooltip', 'Удалить бэкап');
    deleteBtn.innerHTML = '<img src="/static/icons/trash.svg" alt="Удалить" class="backup-icon">';
    deleteBtn.addEventListener('click', () => deleteBackup(String(b && b.name ? b.name : '')));

    actionsDiv.appendChild(restoreBtn);
    actionsDiv.appendChild(deleteBtn);
    actionTd.appendChild(actionsDiv);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }

  async function loadHistory() {
    const tbody = getTableBody();
    if (!tbody) return;

    setStatus('', false);
    renderEmptyRow(tbody, 'Загрузка списка бэкапов…');

    try {
      const res = await fetch('/api/backups', { method: 'GET' });
      if (!res.ok) {
        renderEmptyRow(tbody, 'Не удалось загрузить список бэкапов.');
        setStatus('Не удалось загрузить список бэкапов.', true);
        return;
      }
      const backups = await res.json();
      if (!Array.isArray(backups) || backups.length === 0) {
        renderEmptyRow(tbody, 'Бэкапов пока нет.');
        return;
      }

      tbody.innerHTML = '';
      backups.forEach((b) => renderRowHistory(tbody, b));
    } catch (e) {
      console.error(e);
      renderEmptyRow(tbody, 'Ошибка загрузки списка бэкапов.');
      setStatus('Ошибка загрузки списка бэкапов.', true);
    }
  }

  async function restoreBackup(filename) {
    const name = String(filename || '');
    if (!name) {
      setStatus('Не указан файл бэкапа.', true);
      return;
    }

    const { label } = targetLabelForBackup(name);

    const ok = await confirmAction({
      title: 'Восстановить бэкап',
      message: 'Восстановить бэкап ' + name + '?',
      details: [
        'Файл назначения: ' + label + '.',
        'После восстановления будет запрошен перезапуск xkeen.',
      ],
      okText: 'Восстановить',
      cancelText: 'Отменить',
      danger: true,
      cancelMessage: 'Восстановление бэкапа отменено.',
      cancelKind: 'info',
    });
    if (!ok) {
      writeStatus(el('backups-status'), 'Восстановление бэкапа отменено.', false);
      return;
    }

    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name }),
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (!res.ok || !data || data.ok !== true) {
        const msg = 'Ошибка восстановления бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setStatus(msg, true);
        return;
      }

      const warnings = [];
      const restartWarning = await requestXkeenRestartWarning();
      if (restartWarning) warnings.push(restartWarning);

      emitOutcome(el('backups-status'), 'Бэкап восстановлен: ' + name, warnings);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка при запросе восстановления бэкапа.', true);
    }
  }

  async function deleteBackup(filename) {
    const name = String(filename || '');
    if (!name) {
      setStatus('Не указан файл бэкапа.', true);
      return;
    }

    const ok = await confirmAction({
      title: 'Удалить бэкап',
      message: 'Удалить бэкап ' + name + '?',
      details: 'Это действие необратимо.',
      okText: 'Удалить',
      cancelText: 'Отменить',
      danger: true,
      cancelMessage: 'Удаление бэкапа отменено.',
      cancelKind: 'info',
    });
    if (!ok) {
      writeStatus(el('backups-status'), 'Удаление бэкапа отменено.', false);
      return;
    }

    try {
      const res = await fetch('/api/delete-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: name }),
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (!res.ok || !data || data.ok !== true) {
        const msg = 'Ошибка удаления бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setStatus(msg, true);
        return;
      }

      setStatus('Бэкап удалён: ' + name, false);
      await loadHistory();
    } catch (e) {
      console.error(e);
      setStatus('Ошибка при запросе удаления бэкапа.', true);
    }
  }

  // ------------------------- snapshots mode -------------------------
  function cmThemeFromPage() {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'default' : 'material-darker';
  }

  const SNAP_PLACEHOLDER = '// загрузка…';

  function setSnapEngineSelect(engine) {
    const sel = el('xray-snapshot-engine-select');
    if (!sel) return;
    try { sel.value = normalizeEngine(engine); } catch (e) {}
  }

  async function resolvePreferredEngine() {
    let engine = 'codemirror';
    const ee = getEngineHelper();
    try {
      if (ee && typeof ee.ensureLoaded === 'function') engine = normalizeEngine(await ee.ensureLoaded());
      else if (ee && typeof ee.get === 'function') engine = normalizeEngine(ee.get());
    } catch (e) {
      try { engine = normalizeEngine(ee && ee.get ? ee.get() : 'codemirror'); } catch (e2) { engine = 'codemirror'; }
    }
    return engine;
  }

  function snapTextFallback() {
    try { if (_snapLastText) return String(_snapLastText || ''); } catch (e) {}
    try {
      const fac = getSnapActiveFacade();
      if (fac && typeof fac.get === 'function') return String(fac.get() || '');
    } catch (e) {}
    const ta = el('xray-snapshot-preview');
    return ta ? String(ta.value || '') : '';
  }

  function disposeSnapMonaco() {
    try {
      if (_snapMonacoFacade && _snapMonacoFacade.dispose) _snapMonacoFacade.dispose();
      else if (_snapMonaco && _snapMonaco.dispose) _snapMonaco.dispose();
    } catch (e) {}
    _snapMonaco = null;
    _snapMonacoFacade = null;
  }

  function resetSnapVisibility() {
    const host = el('xray-snapshot-preview-monaco');
    hideNode(host);
    const w = cmWrapper(_snapCm);
    if (w) showNode(w);
    const ta = el('xray-snapshot-preview');
    if (!w && ta) showNode(ta);
  }

  async function activateSnapEngine(engine) {
    const next = normalizeEngine(engine);
    const host = el('xray-snapshot-preview-monaco');
    const ta = el('xray-snapshot-preview');
    const preservedView = captureSnapViewState();

    if (next === 'monaco') {
      const runtime = await ensureEditorRuntime('monaco');
      if (!runtime || !host || typeof runtime.create !== 'function') {
        try { if (window.toast) window.toast('Monaco недоступен — используется CodeMirror', 'warning'); } catch (e) {}
        const ee = getEngineHelper();
        try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
        return activateSnapEngine('codemirror');
      }

      // Hide CodeMirror/textarea, show Monaco host
      const w = cmWrapper(_snapCm);
      if (w) hideNode(w);
      if (ta) hideNode(ta);
      showNode(host);

      const value = snapTextFallback() || SNAP_PLACEHOLDER;

      if (!_snapMonaco) {
        const ed = await runtime.create(host, {
          // Monaco core ships JSON support; JSONC is not always registered.
          language: 'json',
          readOnly: true,
          value: value,
        });
        if (!ed) {
          try { if (window.toast) window.toast('Не удалось загрузить Monaco — переключаю на CodeMirror', 'warning'); } catch (e) {}
          const ee = getEngineHelper();
          try { if (ee && ee.set) await ee.set('codemirror'); } catch (e2) {}
          resetSnapVisibility();
          return activateSnapEngine('codemirror');
        }
        _snapMonaco = ed;
        _snapMonacoFacade = createMonacoFacade(ed);
        try { if (runtime.layoutOnVisible) runtime.layoutOnVisible(ed, host); } catch (e2) {}
      } else if (_snapMonacoFacade && _snapMonacoFacade.set) {
        _snapMonacoFacade.set(value);
      }

      _snapKind = 'monaco';
      try {
        if (!(preservedView && restoreSnapViewState(preservedView)) && _snapMonacoFacade) {
          _snapMonacoFacade.scrollTo(0, 0);
        }
      } catch (e) {}
      try { bindSnapViewStateTracking(); } catch (e2) {}
      return 'monaco';
    }

    // CodeMirror
    try { await ensureEditorRuntime('codemirror', { mode: 'application/jsonc' }); } catch (e) {}
    if (host) hideNode(host);
    try { disposeSnapMonaco(); } catch (e) {}

    const cm = ensureSnapEditor();
    const fac = _snapCmFacade || createCodeMirrorFacade(cm);
    const value = snapTextFallback() || SNAP_PLACEHOLDER;
    if (cm && cm.setValue) {
      try {
        if (fac && typeof fac.set === 'function') fac.set(value);
        if (fac && typeof fac.scrollTo === 'function') fac.scrollTo(0, 0);
        setTimeout(() => { try { if (fac && fac.layout) fac.layout(); } catch (e2) {} }, 30);
      } catch (e) {}
      const w = cmWrapper(cm);
      if (w) showNode(w);
      if (ta) hideNode(ta);
    } else {
      if (ta) {
        try { ta.value = value; } catch (e) {}
        showNode(ta);
      }
    }

    _snapKind = 'codemirror';
    try {
      if (preservedView) restoreSnapViewState(preservedView);
    } catch (e3) {}
    try { bindSnapViewStateTracking(); } catch (e4) {}
    return 'codemirror';
  }

  async function syncSnapEngineNow() {
    if (_snapEngineSyncing) return;
    _snapEngineSyncing = true;
    try {
      const engine = await resolvePreferredEngine();
      setSnapEngineSelect(engine);
      if (modalOpen('xray-snapshot-modal')) await activateSnapEngine(engine);
    } finally {
      _snapEngineSyncing = false;
    }
  }

  function scheduleSnapEngineSync() {
    try { setTimeout(() => { try { syncSnapEngineNow(); } catch (e) {} }, 0); } catch (e) {}
  }

  function openSnapModal() {
    const m = el('xray-snapshot-modal');
    if (!m) return;
    showModal(m, 'backups_snapshot_open');

    try {
      // Activate preferred editor engine (CodeMirror / Monaco)
      scheduleSnapEngineSync();
    } catch (e) {}
  }

  function closeSnapModal() {
    const m = el('xray-snapshot-modal');
    if (!m) return;
    try { saveSnapViewState(); } catch (e) {}
    try { clearSnapViewStateTracking(); } catch (e2) {}
    hideModal(m, 'backups_snapshot_close');
    _snapCurrentName = '';
  }

  function setSnapStatus(msg, isError) {
    const s = el('xray-snapshot-status');
    if (s) {
      s.textContent = String(msg || '');
      s.classList.toggle('error', !!isError);
    }
  }

  function setSnapTitle(name) {
    const t = el('xray-snapshot-title');
    if (t) t.textContent = String(name || '');
  }

  function setSnapMeta(msg) {
    const m = el('xray-snapshot-meta');
    if (m) m.textContent = String(msg || '');
  }

  function setSnapText(text) {
    const value = String(text || '');
    _snapLastText = value;

    try {
      const fac = getSnapActiveFacade();
      if (fac && typeof fac.set === 'function') {
        fac.set(value);
        try { if (fac.scrollTo) fac.scrollTo(0, 0); } catch (e2) {}
        return;
      }
    } catch (e) {}

    const ta = el('xray-snapshot-preview');
    if (ta) {
      try { ta.value = value; } catch (e) {}
    }
  }

  function ensureSnapEditor() {
    const ta = el('xray-snapshot-preview');
    if (!ta) return null;

    const runtime = getEditorRuntime('codemirror');
    const preferCm6 = isCm6Runtime(runtime);

    if (_snapCm) {
      if (!preferCm6 || isCm6Editor(_snapCm)) {
        if (!_snapCmFacade) _snapCmFacade = createCodeMirrorFacade(_snapCm);
        return _snapCm;
      }
      try { disposeCodeMirrorEditor(_snapCm); } catch (e) {}
      _snapCm = null;
      _snapCmFacade = null;
    }

    try {
      if (!runtime || typeof runtime.create !== 'function') return null;
      if (typeof runtime.ensureAssets === 'function') runtime.ensureAssets({ mode: 'application/jsonc' });
    } catch (e) {}

    try {
      if (!runtime || typeof runtime.create !== 'function') return null;

      _snapCm = runtime.create(ta, {
        mode: 'application/jsonc',
        theme: cmThemeFromPage(),
        readOnly: 'nocursor',
        lineNumbers: true,
        lineWrapping: true,
        styleActiveLine: false,
        matchBrackets: true,
        tabSize: 2,
        indentUnit: 2,
        indentWithTabs: false,
        viewportMargin: Infinity,
      });

      try {
        if (_snapCm.getWrapperElement) {
          const w = _snapCm.getWrapperElement();
          w.classList.add('xkeen-cm');
          // Reuse existing preview skin + set custom height.
          w.classList.add('routing-template-preview-cm');
          w.classList.add('xray-snapshot-preview-cm');
        }
      } catch (e2) {}

      // Register for theme sync (ui/theme.js)
      try {
        window.__xkeenEditors = window.__xkeenEditors || [];
        window.__xkeenEditors.push(_snapCm);
      } catch (e3) {}

      _snapCmFacade = createCodeMirrorFacade(_snapCm);

      try {
        if (_snapCmFacade && typeof _snapCmFacade.set === 'function') _snapCmFacade.set(String(_snapLastText || SNAP_PLACEHOLDER));
        if (_snapCmFacade && typeof _snapCmFacade.scrollTo === 'function') _snapCmFacade.scrollTo(0, 0);
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      _snapCm = null;
      _snapCmFacade = null;
    }

    return _snapCm;
  }

  function wireSnapModalOnce() {
    if (_snapWired) return;
    _snapWired = true;

    const closeBtn = el('xray-snapshot-close-btn');
    const cancelBtn = el('xray-snapshot-cancel-btn');
    const copyBtn = el('xray-snapshot-copy-btn');
    const modal = el('xray-snapshot-modal');

    const onClose = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      closeSnapModal();
    };

    if (closeBtn) closeBtn.addEventListener('click', onClose);
    if (cancelBtn) cancelBtn.addEventListener('click', onClose);

    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        const txt = String(_snapLastText || '');
        if (!txt) {
          toast('Нечего копировать.', true);
          return;
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(txt);
            toast('Скопировано в буфер обмена.', false);
            return;
          }
        } catch (e2) {}

        // Fallback: execCommand on a temporary textarea (works even if the real textarea is hidden)
        try {
          const tmp = document.createElement('textarea');
          tmp.value = txt;
          tmp.setAttribute('readonly', '');
          tmp.style.position = 'fixed';
          tmp.style.left = '-9999px';
          tmp.style.top = '0';
          document.body.appendChild(tmp);
          tmp.focus();
          tmp.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(tmp);
          toast(ok ? 'Скопировано.' : 'Не удалось скопировать.', !ok);
        } catch (e3) {
          toast('Не удалось скопировать.', true);
        }
      });
    }

    // Engine toggle
    const sel = el('xray-snapshot-engine-select');
    if (sel && !(sel.dataset && sel.dataset.xkeenWired === '1')) {
      if (sel.dataset) sel.dataset.xkeenWired = '1';
      sel.addEventListener('change', async () => {
        const ee = getEngineHelper();
        try {
          if (ee && ee.set) await ee.set(sel.value);
        } catch (e) {}
        scheduleSnapEngineSync();
      });
    }

    // Listen for global engine changes
    if (!_snapEngineUnsub) {
      const ee = getEngineHelper();
      if (ee && typeof ee.onChange === 'function') {
        _snapEngineUnsub = ee.onChange((d) => {
          try { setSnapEngineSelect(d && d.engine ? d.engine : 'codemirror'); } catch (e) {}
          if (modalOpen('xray-snapshot-modal')) scheduleSnapEngineSync();
        });
      }
    }
  }

  function renderRowSnapshot(tbody, s) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const code = document.createElement('code');
    code.textContent = String(s && s.name ? s.name : '');
    nameTd.appendChild(code);
    tr.appendChild(nameTd);

    const sizeTd = document.createElement('td');
    sizeTd.textContent = formatSize(s && s.size);
    tr.appendChild(sizeTd);

    const mtimeTd = document.createElement('td');
    mtimeTd.textContent = String(s && s.mtime ? s.mtime : '');
    tr.appendChild(mtimeTd);

    const actionTd = document.createElement('td');
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'backup-actions';

    const viewBtn = document.createElement('button');
    viewBtn.type = 'button';
    viewBtn.className = 'backup-icon-btn';
    viewBtn.title = 'Просмотреть снимок';
    viewBtn.setAttribute('data-tooltip', 'Просмотреть');
    viewBtn.innerHTML = '<img src="/static/icons/eye.svg" alt="Просмотреть" class="backup-icon">';
    viewBtn.addEventListener('click', () => viewSnapshot(String(s && s.name ? s.name : '')));

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.className = 'backup-icon-btn';
    restoreBtn.title = 'Восстановить снимок';
    restoreBtn.setAttribute('data-tooltip', 'Восстановить');
    restoreBtn.innerHTML = '<img src="/static/icons/restore.svg" alt="Восстановить" class="backup-icon">';
    restoreBtn.addEventListener('click', () => restoreSnapshot(String(s && s.name ? s.name : '')));

    actionsDiv.appendChild(viewBtn);
    actionsDiv.appendChild(restoreBtn);
    actionTd.appendChild(actionsDiv);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }

  async function loadSnapshots() {
    const tbody = getTableBody();
    if (!tbody) return;

    setStatus('', false);
    renderEmptyRow(tbody, 'Загрузка списка снимков…');

    try {
      const res = await fetch('/api/xray/snapshots', { method: 'GET' });
      if (!res.ok) {
        renderEmptyRow(tbody, 'Не удалось загрузить список снимков.');
        setStatus('Не удалось загрузить список снимков.', true);
        return;
      }
      const items = await res.json();
      if (!Array.isArray(items) || items.length === 0) {
        renderEmptyRow(tbody, 'Снимков пока нет. Они появятся после сохранения конфигов.');
        return;
      }

      tbody.innerHTML = '';
      items.forEach((s) => renderRowSnapshot(tbody, s));
    } catch (e) {
      console.error(e);
      renderEmptyRow(tbody, 'Ошибка загрузки списка снимков.');
      setStatus('Ошибка загрузки списка снимков.', true);
    }
  }

  async function viewSnapshot(name) {
    const n = String(name || '').trim();
    if (!n) {
      toast('Не указан снимок.', true);
      return;
    }

    try { if (_snapCurrentName && _snapCurrentName !== n) saveSnapViewState({ name: _snapCurrentName }); } catch (e) {}

    // Wire modal on first use.
    wireSnapModalOnce();

    _snapCurrentName = n;
    setSnapStatus('', false);
    setSnapTitle(n);
    setSnapMeta('Загрузка…');
    setSnapText('// загрузка…');
    openSnapModal();

    try {
      const res = await fetch('/api/xray/snapshots/read?name=' + encodeURIComponent(n), { method: 'GET' });
      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (!res.ok || !data || data.ok !== true) {
        const msg = 'Не удалось прочитать снимок: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setSnapMeta('—');
        setSnapStatus(msg, true);
        setSnapText('');
        return;
      }

      const size = formatSize(data.size);
      const trunc = data.truncated ? ' · показан фрагмент (ограничение 512 KB)' : '';
      setSnapMeta('Размер: ' + (size || '—') + trunc);
      setSnapText(String(data.text || ''));
      try {
        const savedView = loadSnapViewState(n, _snapKind);
        if (!(savedView && restoreSnapViewState(savedView))) {
          const fac = getSnapActiveFacade();
          if (fac && typeof fac.scrollTo === 'function') fac.scrollTo(0, 0);
        }
      } catch (e2) {}
      try { bindSnapViewStateTracking(); } catch (e3) {}
      setSnapStatus('', false);
    } catch (e) {
      console.error(e);
      setSnapMeta('—');
      setSnapStatus('Ошибка загрузки снимка.', true);
    }
  }

  async function restoreSnapshot(name) {
    const n = String(name || '').trim();
    if (!n) {
      toast('Не указан снимок.', true);
      return;
    }

    const wantRestart = shouldRestartAfterAction();
    const ok = await confirmAction({
      title: 'Восстановить снимок',
      message: 'Восстановить снимок ' + n + '?',
      details: wantRestart
        ? [
            'Изменения будут записаны в конфиг.',
            'После этого будет запрошен перезапуск xkeen.',
          ]
        : 'Изменения будут записаны в конфиг без перезапуска xkeen.',
      okText: 'Восстановить',
      cancelText: 'Отменить',
      danger: false,
      cancelMessage: 'Восстановление снимка отменено.',
      cancelKind: 'info',
    });
    if (!ok) {
      writeStatus(el('backups-status'), 'Восстановление снимка отменено.', false);
      return;
    }

    try {
      // Restore snapshot without restart (we use /api/restart so spinner overlay appears).
      const res = await fetch('/api/xray/snapshots/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n, restart: false }),
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (!res.ok || !data || data.ok !== true) {
        const err = 'Ошибка восстановления снимка: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        setStatus(err, true);
        return;
      }

      const warnings = [];

      // Optional restart
      if (wantRestart) {
        const restartWarning = await requestXkeenRestartWarning();
        if (restartWarning) warnings.push(restartWarning);
      }

      // Refresh list and visible editors.
      try {
        await loadSnapshots();
      } catch (e) {
        console.error(e);
        warnings.push('Список снимков не удалось обновить автоматически.');
      }

      try {
        if (window.XKeen && XKeen.routing && typeof XKeen.routing.load === 'function') {
          await XKeen.routing.load();
        }
        if (window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.load === 'function') {
          await XKeen.features.inbounds.load();
        }
        if (window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.load === 'function') {
          await XKeen.features.outbounds.load();
        }
      } catch (e) {
        console.error(e);
        warnings.push('Открытые редакторы не успели перечитать восстановленный конфиг.');
      }

      emitOutcome(el('backups-status'), 'Снимок восстановлен: ' + n, warnings);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка при восстановлении снимка.', true);
    }
  }

  // ------------------------- shared API -------------------------
  async function load() {
    const tbody = getTableBody();
    if (!tbody) return;

    // Mark module as initialized even if load() was called directly.
    if (!_inited) _inited = true;

    const m = getMode();
    if (m === 'snapshots') return loadSnapshots();
    return loadHistory();
  }

  function refresh() {
    return load();
  }

  async function restoreAuto(target, opts) {
    // Legacy helper (auto-backups restore for panel buttons)
    const t = String(target || '').trim();
    const o = (opts && typeof opts === 'object') ? opts : {};
    if (t !== 'routing' && t !== 'inbounds' && t !== 'outbounds') {
      toast('Неверная цель восстановления авто-бэкапа.', true);
      return;
    }

    function _baseName(p, fallback) {
      try {
        if (!p) return fallback;
        const parts = String(p).split(/[\\/]/);
        const b = parts[parts.length - 1];
        return b || fallback;
      } catch (e) {
        return fallback;
      }
    }

    const files = (window.XKEEN_FILES && typeof window.XKEEN_FILES === 'object') ? window.XKEEN_FILES : {};
    const label = t === 'routing'
      ? _baseName(files.routing, '05_routing.json')
      : (t === 'inbounds' ? _baseName(files.inbounds, '03_inbounds.json') : _baseName(files.outbounds, '04_outbounds.json'));

    // Pass selected fragment name (if user switched files in dropdown).
    const fileParam = label;

    const statusEl = document.getElementById(
      t === 'routing' ? 'routing-status' : (t === 'inbounds' ? 'inbounds-status' : 'outbounds-status')
    );

    if (!o.confirmed) {
      const ok = await confirmAction({
        title: 'Восстановить из авто-бэкапа',
        message: 'Восстановить файл ' + label + ' из авто-бэкапа?',
        details: 'Текущий текст в редакторе будет заменён восстановленной версией.',
        okText: 'Восстановить',
        cancelText: 'Отменить',
        danger: true,
        cancelMessage: 'Восстановление из авто-бэкапа отменено.',
        cancelKind: 'info',
      });
      if (!ok) {
        writeStatus(statusEl, 'Восстановление из авто-бэкапа отменено.', false);
        return;
      }
    }

    try {
      const res = await fetch('/api/restore-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: t, file: fileParam }),
      });

      let data = null;
      try { data = await res.json(); } catch (e) {}

      if (res.ok && data && data.ok) {
        const fname = data.filename || '';
        const msg = 'Файл ' + label + ' восстановлен из авто-бэкапа ' + fname;
        const warnings = [];

        // Refresh UI
        try {
          if (t === 'routing' && window.XKeen && XKeen.routing && typeof XKeen.routing.load === 'function') {
            await XKeen.routing.load();
          }
          if (t === 'inbounds' && window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.load === 'function') {
            await XKeen.features.inbounds.load();
          }
          if (t === 'outbounds' && window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.load === 'function') {
            await XKeen.features.outbounds.load();
          }
        } catch (e) {
          console.error(e);
          warnings.push('Открытый редактор не успел перечитать восстановленный файл.');
        }

        emitOutcome(statusEl, msg, warnings);
      } else {
        const msg = 'Ошибка восстановления из авто-бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        writeStatus(statusEl, msg, true);
        toast(msg, true);
      }
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка восстановления из авто-бэкапа.';
      writeStatus(statusEl, msg, true);
      toast(msg, true);
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;
    load();
  }

  XKeen.backups.init = init;
  XKeen.backups.load = load;
  XKeen.backups.refresh = refresh;

  // History APIs (backups page)
  XKeen.backups.restoreBackup = restoreBackup;
  XKeen.backups.deleteBackup = deleteBackup;

  // Snapshots APIs (panel)
  XKeen.backups.viewSnapshot = viewSnapshot;
  XKeen.backups.restoreSnapshot = restoreSnapshot;

  // Legacy API
  XKeen.backups.restoreAuto = restoreAuto;
})();
