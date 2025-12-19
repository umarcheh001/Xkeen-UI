(() => {
  // Backups page feature module
  // Public API: XKeen.backups.init(), XKeen.backups.load()

  window.XKeen = window.XKeen || {};
  XKeen.backups = XKeen.backups || {};

  let _inited = false;

  function el(id) {
    return document.getElementById(id);
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

  function targetLabelForBackup(filename) {
    const name = String(filename || '');
    if (name.startsWith('03_inbounds-')) return { target: 'inbounds', label: '03_inbounds.json' };
    if (name.startsWith('04_outbounds-')) return { target: 'outbounds', label: '04_outbounds.json' };
    return { target: 'routing', label: '05_routing.json' };
  }

  function getTableBody() {
    const table = document.getElementById('backups-table');
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

  function renderRow(tbody, b) {
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
    restoreBtn.innerHTML = '<img src="/static/icons/restore.svg" alt="Восстановить" class="backup-icon">';
    restoreBtn.addEventListener('click', () => restoreBackup(String(b && b.name ? b.name : '')));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'backup-icon-btn backup-delete-btn';
    deleteBtn.title = 'Удалить бэкап';
    deleteBtn.innerHTML = '<img src="/static/icons/trash.svg" alt="Удалить" class="backup-icon">';
    deleteBtn.addEventListener('click', () => deleteBackup(String(b && b.name ? b.name : '')));

    actionsDiv.appendChild(restoreBtn);
    actionsDiv.appendChild(deleteBtn);
    actionTd.appendChild(actionsDiv);
    tr.appendChild(actionTd);

    tbody.appendChild(tr);
  }

  async function load() {
    const tbody = getTableBody();
    if (!tbody) return;

    // Mark module as initialized even if load() was called directly.
    if (!_inited) _inited = true;

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
      backups.forEach((b) => renderRow(tbody, b));
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
      await load();
    } catch (e) {
      console.error(e);
      setStatus('Ошибка при запросе удаления бэкапа.', true);
    }
  }

  function refresh() {
    return load();
  }

  async function restoreAuto(target) {
    const t = String(target || '').trim();
    if (t !== 'routing' && t !== 'inbounds' && t !== 'outbounds') {
      toast('Неверная цель восстановления авто-бэкапа.', true);
      return;
    }

    const label = t === 'routing'
      ? '05_routing.json'
      : (t === 'inbounds' ? '03_inbounds.json' : '04_outbounds.json');

    const statusEl = document.getElementById(
      t === 'routing' ? 'routing-status' : (t === 'inbounds' ? 'inbounds-status' : 'outbounds-status')
    );

    if (!confirm('Восстановить из авто-бэкапа файл ' + label + '?')) return;

    try {
      const res = await fetch('/api/restore-auto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: t }),
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
  XKeen.backups.restoreBackup = restoreBackup;
  XKeen.backups.deleteBackup = deleteBackup;
  XKeen.backups.restoreAuto = restoreAuto;
})();
