(() => {
  // Local import/export module (upload/download configs)
  // Public API: XKeen.localIO.init()

  window.XKeen = window.XKeen || {};
  XKeen.localIO = XKeen.localIO || {};

  let _inited = false;

  function el(id) {
    return document.getElementById(id);
  }


  function setStatus(msg, isError) {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = String(msg ?? '');
    if (msg) toast(msg, !!isError);
  }

  function buildDefaultFilename() {
    const ts = new Date();
    return (
      'xkeen-config-' +
      ts.getFullYear().toString() +
      String(ts.getMonth() + 1).padStart(2, '0') +
      String(ts.getDate()).padStart(2, '0') +
      '-' +
      String(ts.getHours()).padStart(2, '0') +
      String(ts.getMinutes()).padStart(2, '0') +
      String(ts.getSeconds()).padStart(2, '0') +
      '.json'
    );
  }

  async function refreshAfterImport() {
    // Keep compatibility with current monolithic main.js.
    // If those loaders exist (panel page), call them.
    const fns = [
      'loadRouting',
      'loadInboundsMode',
      'loadPortProxying',
      'loadPortExclude',
      'loadIpExclude',
    ];

    for (const fn of fns) {
      try {
        const f = window[fn];
        if (typeof f === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await f();
        }
      } catch (e) {
        console.error(e);
      }
    }

    // Also emit an event for future modular features.
    try {
      document.dispatchEvent(new CustomEvent('xkeen-localio-imported'));
    } catch (e) {}
  }

  async function exportToFile() {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = 'Экспорт локальной конфигурации в файл...';

    try {
      const res = await fetch('/api/local/export-configs', { method: 'GET' });

      if (!res.ok) {
        const errText = 'Ошибка экспорта: ' + (res.statusText || ('HTTP ' + res.status));
        if (statusEl) statusEl.textContent = errText;
        toast(errText, true);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const fname = buildDefaultFilename();

      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const okMsg = 'Конфигурация выгружена в файл ' + fname;
      if (statusEl) statusEl.textContent = okMsg;
      toast(okMsg, false);
    } catch (e) {
      console.error(e);
      const errMsg = 'Ошибка экспорта (см. консоль браузера).';
      if (statusEl) statusEl.textContent = errMsg;
      toast(errMsg, true);
    }
  }

  async function importFromFile(file) {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = 'Загрузка конфигурации из файла...';

    if (!file) {
      const msg = 'Файл не выбран.';
      if (statusEl) statusEl.textContent = msg;
      toast(msg, true);
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/local/import-configs', {
        method: 'POST',
        body: formData,
      });

      let data = null;
      try {
        data = await res.json();
      } catch (e) {
        // Server might return non-JSON on error.
      }

      if (res.ok && data && data.ok) {
        const msg = 'Конфигурация загружена из файла. Не забудьте перезапустить xkeen после проверки.';
        if (statusEl) statusEl.textContent = msg;
        toast(msg, false);
        await refreshAfterImport();
      } else {
        const errMsg =
          'Ошибка импорта: ' +
          ((data && data.error) || res.statusText || ('HTTP ' + res.status) || 'неизвестная ошибка');
        if (statusEl) statusEl.textContent = errMsg;
        toast(errMsg, true);
      }
    } catch (e) {
      console.error(e);
      const errMsg = 'Ошибка импорта (см. консоль браузера).';
      if (statusEl) statusEl.textContent = errMsg;
      toast(errMsg, true);
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    const localExportBtn = el('routing-export-local-btn');
    const localImportBtn = el('routing-import-local-btn');
    const localConfigFileInput = el('local-config-file-input');

    // Export
    if (localExportBtn) {
      localExportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        exportToFile();
      });
    }

    // Import
    if (localImportBtn && localConfigFileInput) {
      localImportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        localConfigFileInput.value = '';
        localConfigFileInput.click();
      });

      localConfigFileInput.addEventListener('change', () => {
        const file = localConfigFileInput.files && localConfigFileInput.files[0];
        if (!file) return;
        importFromFile(file);
      });
    }
  }

  XKeen.localIO.init = init;
  XKeen.localIO.exportToFile = exportToFile;
  XKeen.localIO.importFromFile = importFromFile;
})();
