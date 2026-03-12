// Terminal module: SSH profiles helper (client-side only)
// Extracted from terminal.js to reduce orchestrator size (DoD).
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function createModule(ctx) {
    const id = 'ssh_profiles';
    const KEY = 'xkeen_ssh_profiles_v1';
    const MODAL_IDS = ['ssh-modal', 'ssh-edit-modal', 'ssh-confirm-modal', 'ssh-transfer-modal'];

    let selectedIndex = -1;
    let editState = null;     // { mode: 'add'|'edit', idx: number }
    let confirmState = null;  // { onOk: function }
    let transferState = null; // { mode: 'import'|'export' }

    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const byId = (elementId) => {
      try {
        return ui && typeof ui.byId === 'function' ? ui.byId(elementId) : document.getElementById(elementId);
      } catch (e) {
        return null;
      }
    };

    function toast(msg, kind) {
      try {
        if (ui && typeof ui.toast === 'function') return ui.toast(msg, kind);
      } catch (e) {}
      try {
        if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info');
      } catch (e2) {}
    }

    function bindClickById(elementId, handler) {
      const el = byId(elementId);
      if (!el) return;
      el.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try { handler(e); } catch (e3) {}
      });
    }

    function isModalVisible(elementId) {
      const modal = byId(elementId);
      return !!(modal && !modal.classList.contains('hidden'));
    }

    function syncModalOpenClass() {
      try {
        if (!document.body) return;
        const hasVisibleModal = MODAL_IDS.some((modalId) => isModalVisible(modalId));
        if (hasVisibleModal) document.body.classList.add('modal-open');
        else document.body.classList.remove('modal-open');
      } catch (e) {}
    }

    function showModalById(elementId) {
      const modal = byId(elementId);
      if (!modal) return null;
      modal.classList.remove('hidden');
      syncModalOpenClass();
      return modal;
    }

    function hideModalById(elementId) {
      const modal = byId(elementId);
      if (!modal) return null;
      modal.classList.add('hidden');
      syncModalOpenClass();
      return modal;
    }

    function loadProfiles() {
      try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed : [];
      } catch (e) {
        return [];
      }
    }

    function saveProfiles(list) {
      try {
        localStorage.setItem(KEY, JSON.stringify(list || []));
      } catch (e) {}
    }

    function buildCmd(profile) {
      const host = String(profile && profile.host || '').trim();
      const user = String(profile && profile.user || '').trim();
      const port = String(profile && profile.port || '').trim();
      const key = String(profile && profile.key || '').trim();
      const jump = String(profile && profile.jump || '').trim();

      if (!host) return '';

      const target = user ? `${user}@${host}` : host;
      let cmd = `ssh ${target}`;
      if (port) cmd += ` -p ${port}`;
      if (key) cmd += ` -i ${key}`;
      if (jump) cmd += ` -J ${jump}`;
      return cmd;
    }

    function openModal() {
      const modal = showModalById('ssh-modal');
      if (!modal) return;
      renderProfiles();
    }

    function closeModal() {
      hideModalById('ssh-modal');
    }

    function renderProfiles() {
      const listEl = byId('ssh-profiles-list');
      const preview = byId('ssh-command-preview');
      const delBtn = byId('ssh-delete-selected-btn');
      if (!listEl) return;

      const profiles = loadProfiles();
      if (selectedIndex >= profiles.length) selectedIndex = profiles.length - 1;
      if (selectedIndex < 0 && profiles.length) selectedIndex = 0;
      listEl.innerHTML = '';

      if (!profiles.length) {
        const empty = document.createElement('div');
        empty.style.opacity = '.8';
        empty.textContent = 'Профилей нет. Нажми "Добавить".';
        listEl.appendChild(empty);
      }

      profiles.forEach((profile, idx) => {
        const row = document.createElement('div');
        row.className = 'github-config-row';
        row.style.alignItems = 'stretch';
        if (idx === selectedIndex) row.classList.add('is-selected');
        row.onclick = (ev) => {
          const target = ev && ev.target ? ev.target : null;
          if (target && (target.tagName === 'BUTTON' || (typeof target.closest === 'function' && target.closest('button')))) return;
          selectProfile(idx);
        };

        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.flexDirection = 'column';
        left.style.gap = '4px';

        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.textContent = profile.name || `${profile.user || ''}@${profile.host || ''}`.replace(/^@/, '');
        left.appendChild(title);

        const meta = document.createElement('div');
        meta.style.opacity = '.8';
        meta.style.fontSize = '12px';
        meta.textContent = buildCmd(profile);
        left.appendChild(meta);

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '6px';
        right.style.alignItems = 'center';

        const btnUse = document.createElement('button');
        btnUse.type = 'button';
        btnUse.textContent = 'Use';
        btnUse.onclick = () => selectProfile(idx);

        const btnEdit = document.createElement('button');
        btnEdit.type = 'button';
        btnEdit.textContent = 'Edit';
        btnEdit.onclick = () => editOpen('edit', idx);

        const btnDel = document.createElement('button');
        btnDel.type = 'button';
        btnDel.textContent = 'Del';
        btnDel.onclick = () => deleteProfile(idx);

        right.appendChild(btnUse);
        right.appendChild(btnEdit);
        right.appendChild(btnDel);

        row.appendChild(left);
        row.appendChild(right);
        listEl.appendChild(row);
      });

      if (delBtn) delBtn.disabled = !(profiles.length && selectedIndex >= 0);
      if (preview) {
        const selected = profiles[selectedIndex];
        preview.value = selected ? buildCmd(selected) : '';
      }
    }

    function addProfile() {
      editOpen('add', -1);
    }

    function selectProfile(idx) {
      const profiles = loadProfiles();
      if (!profiles.length) {
        selectedIndex = -1;
        renderProfiles();
        return;
      }

      const clamped = Math.max(0, Math.min(idx, profiles.length - 1));
      selectedIndex = clamped;

      const preview = byId('ssh-command-preview');
      if (preview) preview.value = buildCmd(profiles[selectedIndex]);
      renderProfiles();
    }

    function editOpen(mode, idx) {
      const modal = byId('ssh-edit-modal');
      if (!modal) return;

      const profiles = loadProfiles();
      const original = (mode === 'edit' && profiles[idx])
        ? profiles[idx]
        : { name: '', host: '', user: '', port: '22', key: '', jump: '' };

      editState = { mode, idx };

      const title = byId('ssh-edit-title');
      if (title) title.textContent = mode === 'add' ? 'Добавить SSH профиль' : 'Редактировать SSH профиль';

      const delBtn = byId('ssh-edit-delete-btn');
      if (delBtn) delBtn.style.display = mode === 'edit' ? '' : 'none';

      const errorEl = byId('ssh-edit-error');
      if (errorEl) errorEl.textContent = '';

      const setValue = (elementId, value) => {
        const el = byId(elementId);
        if (el) el.value = value == null ? '' : value;
      };

      setValue('ssh-edit-name', original.name || '');
      setValue('ssh-edit-host', original.host || '');
      setValue('ssh-edit-user', original.user || '');
      setValue('ssh-edit-port', String(original.port || '22'));
      setValue('ssh-edit-key', original.key || '');
      setValue('ssh-edit-jump', original.jump || '');

      showModalById('ssh-edit-modal');
      try {
        const hostInput = byId('ssh-edit-host');
        if (hostInput && typeof hostInput.focus === 'function') hostInput.focus();
      } catch (e) {}
    }

    function editClose() {
      const modal = hideModalById('ssh-edit-modal');
      if (!modal) return;
      editState = null;
    }

    function editGetDraft() {
      const getValue = (elementId) => {
        const el = byId(elementId);
        return el ? String(el.value || '') : '';
      };

      return {
        name: getValue('ssh-edit-name').trim(),
        host: getValue('ssh-edit-host').trim(),
        user: getValue('ssh-edit-user').trim(),
        port: getValue('ssh-edit-port').trim(),
        key: getValue('ssh-edit-key').trim(),
        jump: getValue('ssh-edit-jump').trim(),
      };
    }

    function editValidate(draft) {
      if (!draft.host) return { ok: false, error: 'Поле Host обязательно.' };

      const portStr = draft.port || '22';
      if (portStr) {
        const portNum = Number(portStr);
        if (!Number.isFinite(portNum) || !/^[0-9]+$/.test(portStr) || portNum < 1 || portNum > 65535) {
          return { ok: false, error: 'Port должен быть числом от 1 до 65535.' };
        }
      }

      return {
        ok: true,
        cleaned: {
          name: draft.name,
          host: draft.host,
          user: draft.user,
          port: portStr || '22',
          key: draft.key,
          jump: draft.jump,
        },
      };
    }

    function normalizeImportedProfiles(items) {
      if (!Array.isArray(items)) return { ok: false, error: 'Ожидался JSON-массив профилей.' };

      const toStringField = (value) => value == null ? '' : String(value).trim();
      const profiles = [];

      for (let i = 0; i < items.length; i += 1) {
        const raw = items[i];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          return { ok: false, error: `Профиль #${i + 1} имеет неверный формат.` };
        }

        const draft = {
          name: toStringField(raw.name),
          host: toStringField(raw.host),
          user: toStringField(raw.user),
          port: toStringField(raw.port),
          key: toStringField(raw.key),
          jump: toStringField(raw.jump),
        };

        const validation = editValidate(draft);
        if (!validation.ok) {
          return { ok: false, error: `Профиль #${i + 1}: ${validation.error || 'проверьте данные.'}` };
        }

        profiles.push(validation.cleaned);
      }

      return { ok: true, profiles };
    }

    function editSave() {
      if (!editState) return;

      const errorEl = byId('ssh-edit-error');
      const draft = editGetDraft();
      const validation = editValidate(draft);
      if (!validation.ok) {
        if (errorEl) errorEl.textContent = validation.error || 'Проверьте данные профиля.';
        return;
      }

      const profiles = loadProfiles();
      if (editState.mode === 'add') {
        profiles.unshift(validation.cleaned);
        saveProfiles(profiles);
        selectedIndex = 0;
      } else {
        const idx = editState.idx;
        if (idx >= 0 && idx < profiles.length) {
          profiles[idx] = validation.cleaned;
          saveProfiles(profiles);
          selectedIndex = idx;
        }
      }

      editClose();
      renderProfiles();
    }

    function deleteSelectedProfile() {
      if (selectedIndex < 0) return;
      deleteProfile(selectedIndex);
    }

    function deleteProfileNow(idx) {
      const profiles = loadProfiles();
      if (idx < 0 || idx >= profiles.length) return;

      profiles.splice(idx, 1);
      saveProfiles(profiles);

      if (selectedIndex === idx) selectedIndex = Math.min(idx, profiles.length - 1);
      if (selectedIndex > idx) selectedIndex -= 1;

      renderProfiles();
    }

    function deleteProfile(idx) {
      const profiles = loadProfiles();
      const profile = profiles[idx];
      if (!profile) return;

      const name = profile.name || `${profile.user || ''}@${profile.host || ''}`.replace(/^@/, '');
      confirmOpen(`Удалить профиль "${name}"?`, () => {
        deleteProfileNow(idx);
      });
    }

    function editDelete() {
      if (!editState || editState.mode !== 'edit') return;
      const idx = editState.idx;
      confirmOpen('Удалить этот профиль?', () => {
        editClose();
        deleteProfileNow(idx);
      });
    }

    function confirmOpen(text, onOk) {
      const modal = byId('ssh-confirm-modal');
      const textEl = byId('ssh-confirm-text');
      const okBtn = byId('ssh-confirm-ok');
      if (!modal || !textEl || !okBtn) return;

      confirmState = { onOk };
      textEl.textContent = String(text || '');
      okBtn.onclick = () => {
        const fn = confirmState && confirmState.onOk;
        confirmClose();
        try { if (fn) fn(); } catch (e) {}
      };

      showModalById('ssh-confirm-modal');
    }

    function confirmClose() {
      const modal = hideModalById('ssh-confirm-modal');
      if (!modal) return;
      confirmState = null;
    }

    function copyPreview() {
      const preview = byId('ssh-command-preview');
      if (!preview) return;

      const text = String(preview.value || '').trim();
      if (!text) return;

      const fallbackCopy = () => {
        try {
          preview.focus();
          preview.select();
          const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
          if (copied) toast('SSH команда скопирована', 'success');
          else toast('Команда выделена, если копирование не сработало - нажмите Ctrl+C', 'info');
        } catch (e) {}
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          toast('SSH команда скопирована', 'success');
        }).catch(() => fallbackCopy());
        return;
      }

      fallbackCopy();
    }

    function transferOpen(mode) {
      const modal = byId('ssh-transfer-modal');
      const titleEl = byId('ssh-transfer-title');
      const helpEl = byId('ssh-transfer-help');
      const textEl = byId('ssh-transfer-text');
      const errorEl = byId('ssh-transfer-error');
      const copyBtn = byId('ssh-transfer-copy-btn');
      const submitBtn = byId('ssh-transfer-submit-btn');
      const cancelBtn = byId('ssh-transfer-cancel-btn');
      if (!modal || !titleEl || !helpEl || !textEl || !errorEl || !copyBtn || !submitBtn || !cancelBtn) {
        toast('Окно импорта/экспорта недоступно', 'error');
        return;
      }

      transferState = { mode: mode === 'import' ? 'import' : 'export' };
      errorEl.textContent = '';

      if (transferState.mode === 'export') {
        titleEl.textContent = 'Экспорт SSH профилей';
        helpEl.textContent = 'Скопируйте JSON и сохраните его там, где вам удобно.';
        textEl.value = JSON.stringify(loadProfiles(), null, 2);
        textEl.readOnly = true;
        copyBtn.style.display = '';
        submitBtn.style.display = 'none';
        cancelBtn.textContent = 'Закрыть';
      } else {
        titleEl.textContent = 'Импорт SSH профилей';
        helpEl.textContent = 'Вставьте JSON-массив профилей. Текущий список будет заменен.';
        textEl.value = '';
        textEl.readOnly = false;
        copyBtn.style.display = 'none';
        submitBtn.style.display = '';
        submitBtn.textContent = 'Импортировать';
        cancelBtn.textContent = 'Отмена';
      }

      showModalById('ssh-transfer-modal');
      try {
        textEl.focus();
        if (transferState.mode === 'export') textEl.select();
      } catch (e) {}
    }

    function transferClose() {
      const errorEl = byId('ssh-transfer-error');
      const textEl = byId('ssh-transfer-text');

      hideModalById('ssh-transfer-modal');
      transferState = null;

      if (errorEl) errorEl.textContent = '';
      if (textEl && !textEl.readOnly) textEl.value = '';
    }

    function transferCopy() {
      const textEl = byId('ssh-transfer-text');
      if (!textEl) return;

      const text = String(textEl.value || '');
      if (!text) return;

      const fallbackCopy = () => {
        try {
          textEl.focus();
          textEl.select();
          const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
          if (copied) toast('JSON профилей скопирован', 'success');
          else toast('JSON выделен, если копирование не сработало - нажмите Ctrl+C', 'info');
        } catch (e) {
          toast('Не удалось скопировать JSON автоматически', 'error');
        }
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          toast('JSON профилей скопирован', 'success');
        }).catch(() => fallbackCopy());
        return;
      }

      fallbackCopy();
    }

    function transferSubmit() {
      if (!transferState || transferState.mode !== 'import') {
        transferClose();
        return;
      }

      const textEl = byId('ssh-transfer-text');
      const errorEl = byId('ssh-transfer-error');
      const raw = textEl ? String(textEl.value || '').trim() : '';

      if (errorEl) errorEl.textContent = '';
      if (!raw) {
        if (errorEl) errorEl.textContent = 'Вставьте JSON с профилями.';
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        if (errorEl) errorEl.textContent = 'Не удалось разобрать JSON.';
        return;
      }

      const normalized = normalizeImportedProfiles(parsed);
      if (!normalized.ok) {
        if (errorEl) errorEl.textContent = normalized.error || 'Импорт не удался.';
        return;
      }

      saveProfiles(normalized.profiles);
      selectedIndex = normalized.profiles.length ? 0 : -1;
      transferClose();
      renderProfiles();
      toast('SSH профили импортированы', 'success');
    }

    function isPtyConnected() {
      try {
        if (ctx && ctx.transport) {
          if (typeof ctx.transport.isConnected === 'function') return !!ctx.transport.isConnected();
          if (typeof ctx.transport.getState === 'function') {
            const state = ctx.transport.getState();
            return !!(state && state.connected);
          }
        }
      } catch (e) {}

      try {
        const state = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
        const ws = state ? state.ptyWs : null;
        return !!(ws && ws.readyState === WebSocket.OPEN);
      } catch (e2) {}

      return false;
    }

    function runPreview() {
      const preview = byId('ssh-command-preview');
      const cmd = preview && preview.value ? String(preview.value).trim() : '';
      if (!cmd) return;

      if (!isPtyConnected()) {
        toast('PTY не подключен', 'info');
        return;
      }

      try {
        if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
          // Use CR to mimic Enter in PTY shell.
          ctx.transport.send(cmd + '\r', { prefer: 'pty' });
        }
      } catch (e) {}

      closeModal();

      try {
        const term = (ctx && ctx.core && typeof ctx.core.getXtermRef === 'function')
          ? (ctx.core.getXtermRef('term') || ctx.core.getXtermRef('xterm'))
          : null;
        if (term && typeof term.focus === 'function') term.focus();
      } catch (e2) {}
    }

    function exportProfiles() {
      transferOpen('export');
    }

    function importProfiles() {
      transferOpen('import');
    }

    function wireUi() {
      bindClickById('terminal-btn-ssh', () => openModal());

      const modal = byId('ssh-modal');
      if (modal) {
        modal.addEventListener('mousedown', (e) => {
          try { if (e.target === modal) closeModal(); } catch (e2) {}
        });
      }

      bindClickById('ssh-modal-close-btn', () => closeModal());
      bindClickById('ssh-add-btn', () => addProfile());
      bindClickById('ssh-delete-selected-btn', () => deleteSelectedProfile());
      bindClickById('ssh-export-btn', () => exportProfiles());
      bindClickById('ssh-import-btn', () => importProfiles());
      bindClickById('ssh-copy-preview-btn', () => copyPreview());
      bindClickById('ssh-run-preview-btn', () => runPreview());

      const editModal = byId('ssh-edit-modal');
      if (editModal) {
        editModal.addEventListener('mousedown', (e) => {
          try { if (e.target === editModal) editClose(); } catch (e2) {}
        });
      }

      bindClickById('ssh-edit-close-btn', () => editClose());
      bindClickById('ssh-edit-cancel-btn', () => editClose());
      bindClickById('ssh-edit-delete-btn', () => editDelete());
      bindClickById('ssh-edit-save-btn', () => editSave());

      const confirmModal = byId('ssh-confirm-modal');
      if (confirmModal) {
        confirmModal.addEventListener('mousedown', (e) => {
          try { if (e.target === confirmModal) confirmClose(); } catch (e2) {}
        });
      }

      bindClickById('ssh-confirm-close-btn', () => confirmClose());
      bindClickById('ssh-confirm-cancel-btn', () => confirmClose());

      const transferModal = byId('ssh-transfer-modal');
      if (transferModal) {
        transferModal.addEventListener('mousedown', (e) => {
          try { if (e.target === transferModal) transferClose(); } catch (e2) {}
        });
      }

      bindClickById('ssh-transfer-close-btn', () => transferClose());
      bindClickById('ssh-transfer-cancel-btn', () => transferClose());
      bindClickById('ssh-transfer-copy-btn', () => transferCopy());
      bindClickById('ssh-transfer-submit-btn', () => transferSubmit());
    }

    return {
      id,
      priority: 120,
      init: () => {
        try { wireUi(); } catch (e) {}
      },
    };
  }

  window.XKeen.terminal.ssh_profiles = { createModule };
})();
