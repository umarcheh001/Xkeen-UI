(() => {
  'use strict';

  // Routing templates (Xray): UI modal that loads presets from /opt/etc/xray/templates/routing
  // API:
  //   GET  /api/routing/templates
  //   GET  /api/routing/templates/<filename>

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const IDS = {
    btnOpen: 'routing-import-template-btn',
    modal: 'routing-template-modal',
    list: 'routing-template-list',
    count: 'routing-template-count',
    title: 'routing-template-title',
    desc: 'routing-template-desc',
    preview: 'routing-template-preview',
    status: 'routing-template-status',
    btnRefresh: 'routing-template-refresh-btn',
    btnSave: 'routing-template-save-btn',
    btnEdit: 'routing-template-edit-btn',
    btnDelete: 'routing-template-delete-btn',
    btnImport: 'routing-template-import-btn',
    btnCloseX: 'routing-template-close-btn',
    btnCancel: 'routing-template-cancel-btn',

    // Save user template modal
    saveModal: 'routing-template-save-modal',
    saveFilename: 'routing-template-save-filename',
    saveTitle: 'routing-template-save-title',
    saveDesc: 'routing-template-save-desc',
    saveStatus: 'routing-template-save-status',
    saveConfirm: 'routing-template-save-confirm-btn',
    saveCancel: 'routing-template-save-cancel-btn',
    saveCloseX: 'routing-template-save-close-btn',


// Edit user template modal
editModal: 'routing-template-edit-modal',
editFilename: 'routing-template-edit-filename',
editTitle: 'routing-template-edit-title',
editDesc: 'routing-template-edit-desc',
editContent: 'routing-template-edit-content',
editStatus: 'routing-template-edit-status',
editConfirm: 'routing-template-edit-confirm-btn',
editCancel: 'routing-template-edit-cancel-btn',
editCloseX: 'routing-template-edit-close-btn',
  };

  let _inited = false;
  let _templates = [];
  let _selected = null; // {filename,title,description,builtin?}
  let _selectedContent = '';

  let _editOriginalFilename = '';
  let _editCm = null;
  let _previewCm = null;

  function currentCmTheme() {
    try {
      return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'material-darker';
    } catch (e) {
      return 'material-darker';
    }
  }

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(msg, isError) {
    const s = el(IDS.status);
    if (s) {
      s.textContent = String(msg || '');
      s.classList.toggle('error', !!isError);
    }
  }

  function openModal() {
    const m = el(IDS.modal);
    if (!m) return;
    m.classList.remove('hidden');

    // Lazy-init preview editor (CodeMirror) and refresh after showing the modal
    try {
      ensurePreviewEditor();
      if (_previewCm && typeof _previewCm.refresh === 'function') {
        setTimeout(() => { try { _previewCm.refresh(); } catch (e2) {} }, 50);
      }
    } catch (e) {}

    // Make sure scroll lock is correct
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function closeModal() {
    const m = el(IDS.modal);
    if (!m) return;
    m.classList.add('hidden');

    // Make sure scroll lock is correct
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function openSaveModal() {
    const m = el(IDS.saveModal);
    if (!m) return;
    m.classList.remove('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function closeSaveModal() {
    const m = el(IDS.saveModal);
    if (!m) return;
    m.classList.add('hidden');
    try {
      if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
        XK.ui.modal.syncBodyScrollLock();
      }
    } catch (e) {}
  }

  function setSaveStatus(msg, isError) {
    const s = el(IDS.saveStatus);
    if (s) {
      s.textContent = String(msg || '');
      s.classList.toggle('error', !!isError);
    }
  }


function openEditModal() {
  const m = el(IDS.editModal);
  if (!m) return;
  m.classList.remove('hidden');
  try {
    if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
      XK.ui.modal.syncBodyScrollLock();
    }
  } catch (e) {}

  // Lazy-init CodeMirror for template editor
  try {
    ensureEditEditor();
    if (_editCm && typeof _editCm.refresh === 'function') {
      setTimeout(() => { try { _editCm.refresh(); } catch (e2) {} }, 50);
    }
  } catch (e) {}
}

function closeEditModal() {
  const m = el(IDS.editModal);
  if (!m) return;
  m.classList.add('hidden');
  try {
    if (XK.ui && XK.ui.modal && typeof XK.ui.modal.syncBodyScrollLock === 'function') {
      XK.ui.modal.syncBodyScrollLock();
    }
  } catch (e) {}
}

function setEditStatus(msg, isError) {
  const s = el(IDS.editStatus);
  if (s) {
    s.textContent = String(msg || '');
    s.classList.toggle('error', !!isError);
  }
}

function stripTemplateHeader(text) {
  // Remove the first-line meta header if present: // xkeen-template: {...}
  if (typeof text !== 'string') return '';
  return text.replace(/^\s*\/\/\s*xkeen-template:\s*\{[^\n]*\}\s*\n?/m, '');
}

function ensureEditEditor() {
  const ta = el(IDS.editContent);
  if (!ta) return null;
  if (_editCm) return _editCm;

  if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') {
    return null;
  }

  try {
    _editCm = window.CodeMirror.fromTextArea(ta, {
        mode: { name: 'jsonc' },
        theme: currentCmTheme(),
      lineNumbers: true,
      lineWrapping: true,
      styleActiveLine: true,
      matchBrackets: true,
      autoCloseBrackets: true,
      tabSize: 2,
      indentUnit: 2,
      indentWithTabs: false,
      viewportMargin: Infinity,
    });
    try {
      if (_editCm.getWrapperElement) {
        _editCm.getWrapperElement().classList.add('xkeen-cm');
        _editCm.getWrapperElement().classList.add('routing-template-edit-cm');
      }
    } catch (e2) {}

      // Register this editor for theme sync (light/dark)
      try {
        window.__xkeenEditors = window.__xkeenEditors || [];
        window.__xkeenEditors.push(_editCm);
      } catch (e3) {}
  } catch (e) {
    console.error(e);
    _editCm = null;
  }
  return _editCm;
}

  function ensurePreviewEditor() {
    const ta = el(IDS.preview);
    if (!ta) return null;
    if (_previewCm) return _previewCm;

    if (!window.CodeMirror || typeof window.CodeMirror.fromTextArea !== 'function') {
      return null;
    }

    try {
      _previewCm = window.CodeMirror.fromTextArea(ta, {
        mode: { name: 'jsonc' },
        theme: currentCmTheme(),
        readOnly: 'nocursor',
        lineNumbers: false,
        lineWrapping: true,
        styleActiveLine: false,
        matchBrackets: true,
        tabSize: 2,
        indentUnit: 2,
        indentWithTabs: false,
        viewportMargin: Infinity,
      });
      try {
        if (_previewCm.getWrapperElement) {
          _previewCm.getWrapperElement().classList.add('xkeen-cm');
          _previewCm.getWrapperElement().classList.add('routing-template-preview-cm');
        }
      } catch (e2) {}

      // Register this editor for theme sync (light/dark)
      try {
        window.__xkeenEditors = window.__xkeenEditors || [];
        window.__xkeenEditors.push(_previewCm);
      } catch (e3) {}

      try {
        _previewCm.setValue('// превью появится здесь');
        _previewCm.scrollTo(0, 0);
      } catch (e4) {}
    } catch (e) {
      console.error(e);
      _previewCm = null;
    }
    return _previewCm;
  }

  function setPreviewText(text) {
    const value = String(text || '');
    const cm = ensurePreviewEditor();
    if (cm && typeof cm.setValue === 'function') {
      cm.setValue(value);
      try { cm.scrollTo(0, 0); } catch (e) {}
      return;
    }
    const ta = el(IDS.preview);
    if (ta) {
      // textarea fallback
      ta.value = value;
    }
  }

function getEditEditorText() {
  if (_editCm && typeof _editCm.getValue === 'function') return String(_editCm.getValue() || '');
  const ta = el(IDS.editContent);
  if (ta) return String(ta.value || '');
  return '';
}

function setEditEditorText(text) {
  const value = String(text || '');
  if (_editCm && typeof _editCm.setValue === 'function') {
    _editCm.setValue(value);
    try { _editCm.scrollTo(0, 0); } catch (e) {}
    return;
  }
  const ta = el(IDS.editContent);
  if (ta) ta.value = value;
}

async function openEditForSelected() {
  if (!_selected || !_selected.filename) {
    setStatus('Сначала выбери шаблон.', true);
    return;
  }
  if (_selected.builtin) {
    setStatus('Встроенные шаблоны нельзя редактировать.', true);
    return;
  }

  setEditStatus('', false);

  // Make sure we have content
  let content = _selectedContent;
  if (!content) {
    content = await fetchTemplateContent(_selected.filename);
  }
  if (!content) {
    setStatus('Не удалось загрузить содержимое шаблона.', true);
    return;
  }

  _editOriginalFilename = _selected.filename;

  try {
    const inpName = el(IDS.editFilename);
    const inpTitle = el(IDS.editTitle);
    const inpDesc = el(IDS.editDesc);

    if (inpName) inpName.value = _selected.filename || '';
    if (inpTitle) inpTitle.value = _selected.title || '';
    if (inpDesc) inpDesc.value = _selected.description || '';
  } catch (e) {}

  // Edit body without meta header
  setEditEditorText(stripTemplateHeader(content));

  openEditModal();

  try {
    const inp = el(IDS.editFilename);
    if (inp) inp.focus();
  } catch (e2) {}
}

async function submitEditTemplate() {
  const filename = String((el(IDS.editFilename) && el(IDS.editFilename).value) || '').trim();
  const title = String((el(IDS.editTitle) && el(IDS.editTitle).value) || '').trim();
  const description = String((el(IDS.editDesc) && el(IDS.editDesc).value) || '').trim();
  const content = getEditEditorText();

  if (!filename) {
    setEditStatus('Укажи имя файла (например: my_template.jsonc).', true);
    return false;
  }
  if (!content.trim()) {
    setEditStatus('Шаблон пустой — нечего сохранять.', true);
    return false;
  }

  const original = String(_editOriginalFilename || '').trim();
  const isRename = !!(original && filename !== original);

  setEditStatus('Сохраняю изменения...', false);

  // For rename: "бережный" — сначала без overwrite, и только при конфликте спрашиваем.
  let overwrite = !isRename;

  let { res, data, error } = await saveTemplateRequest({
    filename,
    title,
    description,
    content,
    overwrite,
  });

  if (error || !res) {
    setEditStatus('Ошибка сети при сохранении.', true);
    return false;
  }

  if (res.status === 409 && isRename) {
    let ok = false;
    try {
      ok = await (XK.ui && typeof XK.ui.confirm === 'function'
        ? XK.ui.confirm({
            title: 'Файл уже существует',
            message: 'Шаблон с таким именем уже есть. Перезаписать его?',
            okText: 'Перезаписать',
            cancelText: 'Отмена',
            danger: true,
          })
        : Promise.resolve(window.confirm('Шаблон уже существует. Перезаписать?')));
    } catch (e) {
      ok = window.confirm('Шаблон уже существует. Перезаписать?');
    }
    if (!ok) {
      setEditStatus('Сохранение отменено.', false);
      return false;
    }

    ({ res, data } = await saveTemplateRequest({
      filename,
      title,
      description,
      content,
      overwrite: true,
    }));
  }

  if (!res || !res.ok || !data || !data.ok) {
    const msg = (data && data.error) ? data.error : (res ? (res.statusText || ('HTTP ' + res.status)) : 'network error');
    setEditStatus('Не удалось сохранить: ' + msg, true);
    return false;
  }

  // If renamed — delete old file (best-effort)
  if (isRename && original) {
    try {
      await fetch('/api/routing/templates/' + encodeURIComponent(original), { method: 'DELETE' });
    } catch (e) {}
  }

  try {
    if (typeof window.toast === 'function') {
      window.toast('Шаблон обновлён: ' + (data.filename || filename), false);
    }
  } catch (e) {}

  closeEditModal();

  // Refresh list and re-select edited template
  try {
    await fetchList();
    const savedName = String(data.filename || filename).trim();
    const found = (_templates || []).find((t) => t && t.filename === savedName);
    if (found) {
      await selectTemplate(found);
    }
  } catch (e) {}

  return true;
}

  function setCount(n) {
    const c = el(IDS.count);
    if (!c) return;
    const num = Number(n || 0);
    c.textContent = String(Math.max(0, Math.floor(num)));
  }

  function clearPreview() {
    _selected = null;
    _selectedContent = '';

    const t = el(IDS.title);
    const d = el(IDS.desc);
    ensurePreviewEditor();
    const b = el(IDS.btnImport);
    const del = el(IDS.btnDelete);
    const edit = el(IDS.btnEdit);

    if (t) t.textContent = '—';
    if (d) d.textContent = 'Выбери шаблон слева, чтобы увидеть описание и превью.';
    setPreviewText('// превью появится здесь');
    if (b) b.disabled = true;
    if (del) del.disabled = true;
    if (edit) edit.disabled = true;
  }

  function normalizePreview(text) {
    // Avoid rendering massive templates in preview; still import full content.
    if (typeof text !== 'string') return '';
    const max = 20000; // chars
    if (text.length <= max) return text;
    return text.slice(0, max) + '\n\n// ... (превью обрезано)';
  }

  function renderList() {
    const list = el(IDS.list);
    if (!list) return;

    list.innerHTML = '';

    if (!_templates || !_templates.length) {
      const empty = document.createElement('div');
      empty.className = 'routing-template-empty';
      empty.innerHTML = `
        <div class="routing-template-empty-title">Шаблоны не найдены</div>
        <div class="routing-template-empty-sub">
          Добавь <b>*.jsonc</b> в <code>/opt/etc/xray/templates/routing</code>
        </div>
      `;
      list.appendChild(empty);
      return;
    }

    _templates.forEach((tpl) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'routing-template-item';
      btn.dataset.filename = tpl.filename || '';

      const title = document.createElement('div');
      title.className = 'routing-template-item-title';
      title.textContent = tpl.title || tpl.filename || 'Шаблон';

      const desc = document.createElement('div');
      desc.className = 'routing-template-item-desc';
      desc.textContent = tpl.description || '';

      btn.appendChild(title);
      if (tpl.description) btn.appendChild(desc);

      btn.addEventListener('click', () => {
        selectTemplate(tpl);
      });

      list.appendChild(btn);
    });

    // Keep selection highlight if modal was reopened
    if (_selected && _selected.filename) {
      try {
        list.querySelectorAll('.routing-template-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.filename === _selected.filename);
        });
      } catch (e) {}
    }
  }

  async function fetchList() {
    setStatus('Загрузка списка шаблонов...', false);
    clearPreview();

    try {
      const res = await fetch('/api/routing/templates', { method: 'GET' });
      const data = await res.json().catch(() => null);

      if (!res.ok || !data || !data.ok) {
        const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
        setStatus('Ошибка: ' + msg, true);
        _templates = [];
        setCount(0);
        renderList();
        return;
      }

      // API compatibility:
      // - Current backend returns { ok:true, items:[...] }
      // - Older versions used { ok:true, templates:[...] }
      if (Array.isArray(data.items)) {
        _templates = data.items;
      } else {
        _templates = Array.isArray(data.templates) ? data.templates : [];
      }
      setCount(_templates.length);
      renderList();
      setStatus('Выбери шаблон слева и нажми «Импортировать».', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки шаблонов (см. консоль браузера).', true);
      _templates = [];
      setCount(0);
      renderList();
    }
  }

  async function fetchTemplateContent(filename) {
    if (!filename) return '';
    try {
      const res = await fetch('/api/routing/templates/' + encodeURIComponent(filename), { method: 'GET' });
      if (!res.ok) {
        return '';
      }
      return await res.text();
    } catch (e) {
      console.error(e);
      return '';
    }
  }

  async function selectTemplate(tpl) {
    if (!tpl || !tpl.filename) return;
    _selected = tpl;
    _selectedContent = '';

    ensurePreviewEditor();

    // highlight
    const list = el(IDS.list);
    if (list) {
      try {
        list.querySelectorAll('.routing-template-item').forEach((b) => {
          b.classList.toggle('active', b.dataset.filename === tpl.filename);
        });
      } catch (e) {}
    }

    const t = el(IDS.title);
    const d = el(IDS.desc);
    const edit = el(IDS.btnEdit);
    const b = el(IDS.btnImport);
    const del = el(IDS.btnDelete);

    if (t) t.textContent = tpl.title || tpl.filename;
    if (d) d.textContent = tpl.description || '';
    setPreviewText('// загрузка...');
    if (b) b.disabled = true;
    if (del) del.disabled = !!tpl.builtin;
    if (edit) edit.disabled = !!tpl.builtin;

    setStatus('Загрузка шаблона: ' + tpl.filename + ' ...', false);

    const content = await fetchTemplateContent(tpl.filename);
    if (!content) {
      setPreviewText('// не удалось загрузить шаблон');
      setStatus('Не удалось загрузить содержимое шаблона.', true);
      return;
    }

    _selectedContent = content;
    setPreviewText(normalizePreview(content));
    if (b) b.disabled = false;
    if (del) del.disabled = !!tpl.builtin;
    if (edit) edit.disabled = !!tpl.builtin;

    setStatus('Шаблон готов к импорту.', false);
  }

  async function confirmReplaceIfDirty() {
    // Detect unsaved changes
    const cm = (XK.state && XK.state.routingEditor) ? XK.state.routingEditor : null;
    const ta = el('routing-textarea');

    let current = '';
    if (cm && typeof cm.getValue === 'function') current = cm.getValue();
    else if (ta) current = ta.value || '';

    const saved = (typeof window.routingSavedContent === 'string') ? window.routingSavedContent : '';
    const isDirty = (typeof saved === 'string' && saved.length) ? (current !== saved) : (current.trim().length > 0);

    if (!isDirty) return true;

    // Use themed confirm modal if available
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') {
        const ok = await XK.ui.confirm({
          title: 'Заменить текущий текст?',
          message: 'В редакторе есть несохранённые изменения. Импорт шаблона заменит текущий текст. Продолжить?',
          okText: 'Да, заменить',
          cancelText: 'Отмена',
          danger: true,
        });
        return !!ok;
      }
    } catch (e) {}

    return window.confirm('В редакторе есть несохранённые изменения. Импорт шаблона заменит текст. Продолжить?');
  }

  function markDirty() {
    try {
      window.routingIsDirty = true;
    } catch (e) {}
    try {
      const saveBtn = document.getElementById('routing-save-btn');
      if (saveBtn) saveBtn.classList.add('dirty');
    } catch (e) {}
  }

  function getEditorText() {
    const cm = (XK.state && XK.state.routingEditor) ? XK.state.routingEditor : null;
    const ta = el('routing-textarea');
    if (cm && typeof cm.getValue === 'function') return String(cm.getValue() || '');
    if (ta) return String(ta.value || '');
    return '';
  }

  async function doImport() {
    if (!_selected || !_selected.filename || !_selectedContent) {
      setStatus('Сначала выбери шаблон.', true);
      return;
    }

    const ok = await confirmReplaceIfDirty();
    if (!ok) return;

    const cm = (XK.state && XK.state.routingEditor) ? XK.state.routingEditor : null;
    const ta = el('routing-textarea');

    if (cm && typeof cm.setValue === 'function') {
      cm.setValue(_selectedContent);
      try { cm.scrollTo(0, 0); } catch (e) {}
    } else if (ta) {
      ta.value = _selectedContent;
    }

    markDirty();

    try {
      if (typeof window.toast === 'function') {
        window.toast('Шаблон импортирован в редактор. Проверь и нажми «Сохранить».', false);
      }
    } catch (e) {}

    closeModal();
  }

  function prefillSaveModalFromSelection() {
    const inpName = el(IDS.saveFilename);
    const inpTitle = el(IDS.saveTitle);
    const inpDesc = el(IDS.saveDesc);
    if (inpName) inpName.value = '';
    if (inpTitle) inpTitle.value = '';
    if (inpDesc) inpDesc.value = '';
    setSaveStatus('', false);

    // If the user selected a non-builtin template, allow quick "save/overwrite" workflow.
    if (_selected && _selected.filename && !_selected.builtin) {
      if (inpName) inpName.value = _selected.filename;
      if (inpTitle) inpTitle.value = _selected.title || '';
      if (inpDesc) inpDesc.value = _selected.description || '';
    }
  }

  async function saveTemplateRequest(payload) {
    try {
      const res = await fetch('/api/routing/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    } catch (e) {
      console.error(e);
      return { res: null, data: null, error: e };
    }
  }

  async function submitSaveTemplate() {
    const filename = String((el(IDS.saveFilename) && el(IDS.saveFilename).value) || '').trim();
    const title = String((el(IDS.saveTitle) && el(IDS.saveTitle).value) || '').trim();
    const description = String((el(IDS.saveDesc) && el(IDS.saveDesc).value) || '').trim();

    if (!filename) {
      setSaveStatus('Укажи имя файла (например: my_template.jsonc).', true);
      return false;
    }

    const content = getEditorText();
    if (!content.trim()) {
      setSaveStatus('Редактор пустой — нечего сохранять в шаблон.', true);
      return false;
    }

    setSaveStatus('Сохраняю шаблон...', false);

    let { res, data, error } = await saveTemplateRequest({
      filename,
      title,
      description,
      content,
      overwrite: false,
    });

    if (error || !res) {
      setSaveStatus('Ошибка сети при сохранении шаблона.', true);
      return false;
    }

    // If already exists: ask overwrite
    if (res.status === 409) {
      let ok = false;
      try {
        ok = await (XK.ui && typeof XK.ui.confirm === 'function'
          ? XK.ui.confirm({
              title: 'Шаблон уже существует',
              message: 'Файл с таким именем уже есть. Перезаписать его?',
              okText: 'Перезаписать',
              cancelText: 'Отмена',
              danger: true,
            })
          : Promise.resolve(window.confirm('Шаблон уже существует. Перезаписать?')));
      } catch (e) {
        ok = window.confirm('Шаблон уже существует. Перезаписать?');
      }
      if (!ok) {
        setSaveStatus('Сохранение отменено.', false);
        return false;
      }

      ({ res, data } = await saveTemplateRequest({
        filename,
        title,
        description,
        content,
        overwrite: true,
      }));
    }

    if (!res || !res.ok || !data || !data.ok) {
      const msg = (data && data.error) ? data.error : (res ? (res.statusText || ('HTTP ' + res.status)) : 'network error');
      setSaveStatus('Не удалось сохранить: ' + msg, true);
      return false;
    }

    // Success
    try {
      if (typeof window.toast === 'function') {
        window.toast('Шаблон сохранён: ' + (data.filename || filename), false);
      }
    } catch (e) {}

    closeSaveModal();

    // Refresh list and re-select saved template if possible
    try {
      await fetchList();
      const savedName = String(data.filename || filename).trim();
      const found = (_templates || []).find((t) => t && t.filename === savedName);
      if (found) {
        await selectTemplate(found);
      }
    } catch (e) {}

    return true;
  }

  async function doDeleteSelected() {
    if (!_selected || !_selected.filename) {
      setStatus('Сначала выбери шаблон.', true);
      return;
    }
    if (_selected.builtin) {
      setStatus('Этот шаблон встроенный — удаление отключено.', true);
      return;
    }

    let ok = false;
    try {
      ok = await (XK.ui && typeof XK.ui.confirm === 'function'
        ? XK.ui.confirm({
            title: 'Удалить шаблон?',
            message: 'Удалить файл ' + _selected.filename + ' из /opt/etc/xray/templates/routing?',
            okText: 'Удалить',
            cancelText: 'Отмена',
            danger: true,
          })
        : Promise.resolve(window.confirm('Удалить шаблон ' + _selected.filename + '?')));
    } catch (e) {
      ok = window.confirm('Удалить шаблон ' + _selected.filename + '?');
    }
    if (!ok) return;

    setStatus('Удаляю шаблон ' + _selected.filename + ' ...', false);
    try {
      const res = await fetch('/api/routing/templates/' + encodeURIComponent(_selected.filename), {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.ok) {
        const msg = (data && data.error) ? data.error : (res.statusText || ('HTTP ' + res.status));
        setStatus('Не удалось удалить: ' + msg, true);
        return;
      }

      try {
        if (typeof window.toast === 'function') {
          window.toast('Удалено: ' + _selected.filename, false);
        }
      } catch (e) {}

      clearPreview();
      await fetchList();
      setStatus('Шаблон удалён.', false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сети при удалении шаблона.', true);
    }
  }

  function wireUI() {
    const openBtn = el(IDS.btnOpen);
    if (openBtn && !(openBtn.dataset && openBtn.dataset.xkWired === '1')) {
      openBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        openModal();
        await fetchList();
      });
      if (openBtn.dataset) openBtn.dataset.xkWired = '1';
    }

    const btnRefresh = el(IDS.btnRefresh);
    if (btnRefresh && !(btnRefresh.dataset && btnRefresh.dataset.xkWired === '1')) {
      btnRefresh.addEventListener('click', async (e) => {
        e.preventDefault();
        await fetchList();
      });
      if (btnRefresh.dataset) btnRefresh.dataset.xkWired = '1';
    }

    const btnImport = el(IDS.btnImport);
    if (btnImport && !(btnImport.dataset && btnImport.dataset.xkWired === '1')) {
      btnImport.addEventListener('click', async (e) => {
        e.preventDefault();
        await doImport();
      });
      if (btnImport.dataset) btnImport.dataset.xkWired = '1';
    }

    // Save as user template (open modal)
    const btnSave = el(IDS.btnSave);
    if (btnSave && !(btnSave.dataset && btnSave.dataset.xkWired === '1')) {
      btnSave.addEventListener('click', (e) => {
        e.preventDefault();
        prefillSaveModalFromSelection();
        openSaveModal();
        try {
          const inp = el(IDS.saveFilename);
          if (inp) inp.focus();
        } catch (e2) {}
      });
      if (btnSave.dataset) btnSave.dataset.xkWired = '1';
    }


// Edit selected user template
const btnEdit = el(IDS.btnEdit);
if (btnEdit && !(btnEdit.dataset && btnEdit.dataset.xkWired === '1')) {
  btnEdit.addEventListener('click', async (e) => {
    e.preventDefault();
    await openEditForSelected();
  });
  if (btnEdit.dataset) btnEdit.dataset.xkWired = '1';
}

// Delete selected user template
    const btnDelete = el(IDS.btnDelete);
    if (btnDelete && !(btnDelete.dataset && btnDelete.dataset.xkWired === '1')) {
      btnDelete.addEventListener('click', async (e) => {
        e.preventDefault();
        await doDeleteSelected();
      });
      if (btnDelete.dataset) btnDelete.dataset.xkWired = '1';
    }


// Edit modal actions
const editCloseButtons = [el(IDS.editCloseX), el(IDS.editCancel)];
editCloseButtons.forEach((b) => {
  if (!b) return;
  if (b.dataset && b.dataset.xkWired === '1') return;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    closeEditModal();
  });
  if (b.dataset) b.dataset.xkWired = '1';
});

const editConfirm = el(IDS.editConfirm);
if (editConfirm && !(editConfirm.dataset && editConfirm.dataset.xkWired === '1')) {
  editConfirm.addEventListener('click', async (e) => {
    e.preventDefault();
    const btn = editConfirm;
    try { btn.disabled = true; } catch (e2) {}
    try {
      await submitEditTemplate();
    } finally {
      try { btn.disabled = false; } catch (e3) {}
    }
  });
  if (editConfirm.dataset) editConfirm.dataset.xkWired = '1';
}

// Save modal actions
    const saveCloseButtons = [el(IDS.saveCloseX), el(IDS.saveCancel)];
    saveCloseButtons.forEach((b) => {
      if (!b) return;
      if (b.dataset && b.dataset.xkWired === '1') return;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closeSaveModal();
      });
      if (b.dataset) b.dataset.xkWired = '1';
    });

    const saveConfirm = el(IDS.saveConfirm);
    if (saveConfirm && !(saveConfirm.dataset && saveConfirm.dataset.xkWired === '1')) {
      saveConfirm.addEventListener('click', async (e) => {
        e.preventDefault();
        const btn = saveConfirm;
        try { btn.disabled = true; } catch (e2) {}
        try {
          await submitSaveTemplate();
        } finally {
          try { btn.disabled = false; } catch (e3) {}
        }
      });
      if (saveConfirm.dataset) saveConfirm.dataset.xkWired = '1';
    }

    const closeButtons = [el(IDS.btnCloseX), el(IDS.btnCancel)];
    closeButtons.forEach((b) => {
      if (!b) return;
      if (b.dataset && b.dataset.xkWired === '1') return;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        closeModal();
      });
      if (b.dataset) b.dataset.xkWired = '1';
    });

    // Close on backdrop click
    const modal = el(IDS.modal);
    if (modal && !(modal.dataset && modal.dataset.xkBackdrop === '1')) {
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) closeModal();
      });
      if (modal.dataset) modal.dataset.xkBackdrop = '1';
    }


const editModal = el(IDS.editModal);
if (editModal && !(editModal.dataset && editModal.dataset.xkBackdrop === '1')) {
  editModal.addEventListener('mousedown', (e) => {
    if (e.target === editModal) closeEditModal();
  });
  if (editModal.dataset) editModal.dataset.xkBackdrop = '1';
}

const saveModal = el(IDS.saveModal);
    if (saveModal && !(saveModal.dataset && saveModal.dataset.xkBackdrop === '1')) {
      saveModal.addEventListener('mousedown', (e) => {
        if (e.target === saveModal) closeSaveModal();
      });
      if (saveModal.dataset) saveModal.dataset.xkBackdrop = '1';
    }

    // ESC to close
    if (!(document.body && document.body.dataset && document.body.dataset.xkRoutingTplEsc === '1')) {
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const em = el(IDS.editModal);
        if (em && !em.classList.contains('hidden')) {
          closeEditModal();
          return;
        }
        const sm = el(IDS.saveModal);
        if (sm && !sm.classList.contains('hidden')) {
          closeSaveModal();
          return;
        }
        const m = el(IDS.modal);
        if (!m || m.classList.contains('hidden')) return;
        closeModal();
      });
      if (document.body && document.body.dataset) document.body.dataset.xkRoutingTplEsc = '1';
    }
  }

  function init() {
    if (_inited) return;
    _inited = true;

    wireUI();
  }

  XK.features.routingTemplates = {
    init,
    fetchList,
    open: () => {
      openModal();
      fetchList();
    },
    close: closeModal,
  };
})();
