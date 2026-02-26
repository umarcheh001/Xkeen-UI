(() => {
  // Local import/export module (routing editor file-scoped)
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
    if (msg) toast(String(msg), !!isError);
  }

  function _basename(name) {
    const s = String(name ?? '');
    if (!s) return '';
    // support both unix and windows separators
    return s.split('/').pop().split('\\').pop();
  }

  function sanitizeFilename(name) {
    let s = _basename(name) || '';
    if (!s) return '';
    // Windows-forbidden chars + control chars
    s = s.replace(/[<>:\"/\\|?*\x00-\x1F]/g, '_');
    // Trim trailing dots/spaces (Windows)
    s = s.replace(/[\.\s]+$/g, '');
    // avoid empty
    if (!s) s = 'routing.json';
    return s;
  }

  function getSelectedRoutingFileName() {
    try {
      const sel = el('routing-fragment-select');
      if (sel) {
        const v = String(sel.value || '').trim();
        if (v) return v;
        const cur = String(sel.getAttribute('data-current') || '').trim();
        if (cur) return cur;
      }
    } catch (e) {}
    return 'routing.json';
  }

  function buildExportFilename() {
    const raw = getSelectedRoutingFileName();
    let fname = sanitizeFilename(raw);
    if (!/\.[A-Za-z0-9]{1,6}$/.test(fname)) fname += '.json';
    return fname;
  }

  function getEditorFacade() {
    try {
      if (window.XKeen && window.XKeen.state && window.XKeen.state.routingEditor) {
        return window.XKeen.state.routingEditor;
      }
    } catch (e) {}
    return null;
  }

  function getEditorText() {
    const ed = getEditorFacade();
    try {
      if (ed && typeof ed.getValue === 'function') return String(ed.getValue() ?? '');
    } catch (e) {}

    // Fallbacks
    try {
      const ta = el('routing-editor');
      if (ta) return String(ta.value ?? '');
    } catch (e2) {}

    return '';
  }

  function setEditorText(text) {
    const ed = getEditorFacade();
    const v = String(text ?? '');
    try {
      if (ed && typeof ed.setValue === 'function') {
        ed.setValue(v);
        if (typeof ed.focus === 'function') ed.focus();
        if (typeof ed.scrollTo === 'function') ed.scrollTo(0, 0);
        return true;
      }
    } catch (e) {}

    try {
      const ta = el('routing-editor');
      if (ta) {
        ta.value = v;
        ta.focus();
        return true;
      }
    } catch (e2) {}

    return false;
  }

  async function exportToFile() {
    const fname = buildExportFilename();
    const text = getEditorText();

    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setStatus('Файл выгружен: ' + fname, false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка экспорта (см. консоль браузера).', true);
    }
  }

  async function importFromFile(file) {
    if (!file) {
      setStatus('Файл не выбран.', true);
      return;
    }

    // Soft size limit (keep router UI responsive)
    try {
      const maxBytes = 2 * 1024 * 1024; // 2MB
      if (file.size && file.size > maxBytes) {
        setStatus('Файл слишком большой для импорта в редактор (' + file.size + ' байт).', true);
        return;
      }
    } catch (e) {}

    const reader = new FileReader();
    reader.onerror = () => {
      setStatus('Ошибка чтения файла (см. консоль браузера).', true);
    };
    reader.onload = () => {
      try {
        const content = String(reader.result ?? '');
        const ok = setEditorText(content);
        const fname = sanitizeFilename(file.name || 'file.json');
        if (ok) {
          // Re-validate to update routing/fragment mode UI and markers.
          try { if (window.XKeen && XKeen.routing && typeof XKeen.routing.validate === 'function') XKeen.routing.validate(); } catch (e) {}
          setStatus('Загружено в редактор: ' + fname + ' (не сохранено).', false);
        } else {
          setStatus('Не удалось вставить содержимое в редактор.', true);
        }
      } catch (e) {
        console.error(e);
        setStatus('Ошибка импорта (см. консоль браузера).', true);
      }
    };

    try {
      reader.readAsText(file);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка импорта (см. консоль браузера).', true);
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
