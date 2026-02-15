(() => {
  // Backups feature module.
  // Supports two modes depending on the page:
  //  - history: /backups page (old timestamped backups)  -> /api/backups, /api/restore, /api/delete-backup
  //  - snapshots: panel card (rollback snapshots per file) -> /api/xray/snapshots, /api/xray/snapshots/read, /api/xray/snapshots/restore

  window.XKeen = window.XKeen || {};
  XKeen.backups = XKeen.backups || {};

  let _inited = false;
  let _mode = null; // 'history' | 'snapshots'

  // Snapshot preview modal
  let _snapWired = false;
  let _snapCm = null;
  let _snapLastText = '';

  function el(id) {
    return document.getElementById(id);
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

  function setStatus(msg, isError) {
    const statusEl = el('backups-status');
    if (statusEl) statusEl.textContent = String(msg ?? '');
    if (msg) toast(msg, !!isError);
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

    if (!confirm('Восстановить бэкап ' + name + ' в ' + label + ' и перезапустить xkeen?')) {
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

      setStatus('Бэкап восстановлен: ' + name, false);

      // Restart xkeen (spinner_fetch.js shows overlay for /api/restart)
      await fetch('/api/restart', { method: 'POST' });
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

    // Use a consistent modal confirm instead of a browser alert.
    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      const ok = await XKeen.ui.confirm({
        title: 'Удалить бэкап',
        message: 'Удалить бэкап ' + name + '? Это действие необратимо.',
        okText: 'Удалить',
        cancelText: 'Отменить',
        danger: true,
      });
      if (!ok) return;
    } else {
      if (!confirm('Удалить бэкап ' + name + '? Это действие необратимо.')) {
        return;
      }
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

  function openSnapModal() {
    const m = el('xray-snapshot-modal');
    if (!m) return;
    m.classList.remove('hidden');
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}

    try {
      // Lazy-init preview editor (CodeMirror) and refresh after showing the modal
      ensureSnapEditor();
      if (_snapCm && typeof _snapCm.refresh === 'function') {
        setTimeout(() => { try { _snapCm.refresh(); } catch (e2) {} }, 60);
      }
    } catch (e) {}
  }

  function closeSnapModal() {
    const m = el('xray-snapshot-modal');
    if (!m) return;
    m.classList.add('hidden');
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.modal && typeof XKeen.ui.modal.syncBodyScrollLock === 'function') {
        XKeen.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
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

    const cm = ensureSnapEditor();
    if (cm && typeof cm.setValue === 'function') {
      cm.setValue(value);
      try { cm.scrollTo(0, 0); } catch (e) {}
      return;
    }

    const ta = el('xray-snapshot-preview');
    if (ta) ta.value = value;
  }

  function ensureSnapEditor() {
    const ta = el('xray-snapshot-preview');
    if (!ta) return null;
    if (_snapCm) return _snapCm;

    if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') {
      return null;
    }

    // Ensure jsonc mode exists.
    try {
      if (window.XKeen && XKeen.cmLoader && typeof XKeen.cmLoader.ensureMode === 'function') {
        // Best-effort (no await here). The base javascript mode is usually already present.
        XKeen.cmLoader.ensureMode('jsonc');
      }
    } catch (e) {}

    try {
      _snapCm = window.CodeMirror.fromTextArea(ta, {
        mode: { name: 'jsonc' },
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

      try {
        _snapCm.setValue('// загрузка…');
        _snapCm.scrollTo(0, 0);
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      _snapCm = null;
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

        // Fallback: select textarea and execCommand
        try {
          const ta = el('xray-snapshot-preview');
          if (ta) {
            ta.focus();
            ta.select();
            const ok = document.execCommand('copy');
            toast(ok ? 'Скопировано.' : 'Не удалось скопировать.', !ok);
          }
        } catch (e3) {
          toast('Не удалось скопировать.', true);
        }
      });
    }

    // Close on overlay click
    if (modal && !(modal.dataset && modal.dataset.xkeenOverlayWired === '1')) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeSnapModal();
      });
      if (modal.dataset) modal.dataset.xkeenOverlayWired = '1';
    }

    // Close on ESC
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = el('xray-snapshot-modal');
      if (m && !m.classList.contains('hidden')) closeSnapModal();
    });
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

    // Wire modal on first use.
    wireSnapModalOnce();

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
    const msg = wantRestart
      ? ('Восстановить снимок ' + n + ' и перезапустить xkeen?')
      : ('Восстановить снимок ' + n + ' без перезапуска xkeen?');

    if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') {
      const ok = await XKeen.ui.confirm({
        title: 'Восстановить снимок',
        message: msg,
        okText: 'Восстановить',
        cancelText: 'Отменить',
        danger: false,
      });
      if (!ok) return;
    } else {
      if (!confirm(msg)) return;
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

      setStatus('Снимок восстановлен: ' + n, false);

      // Optional restart
      if (wantRestart) {
        await fetch('/api/restart', { method: 'POST' });
      }

      // Refresh list and visible editors.
      await loadSnapshots();

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
      }
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

  async function restoreAuto(target) {
    // Legacy helper (auto-backups restore for panel buttons)
    const t = String(target || '').trim();
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

    if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;

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
        if (statusEl) statusEl.textContent = msg;
        toast(msg, false);

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
        }
      } else {
        const msg = 'Ошибка восстановления из авто-бэкапа: ' + ((data && data.error) || res.statusText || ('HTTP ' + res.status));
        if (statusEl) statusEl.textContent = msg;
        toast(msg, true);
      }
    } catch (e) {
      console.error(e);
      const msg = 'Ошибка восстановления из авто-бэкапа.';
      if (statusEl) statusEl.textContent = msg;
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
