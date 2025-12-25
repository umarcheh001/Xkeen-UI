// Terminal module: SSH profiles helper (client-side only)
// Extracted from terminal.js to reduce orchestrator size (DoD).
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function createModule(ctx) {
    const id = 'ssh_profiles';
    const KEY = 'xkeen_ssh_profiles_v1';

    let selectedIndex = -1;
    let editState = null;     // { mode: 'add'|'edit', idx: number }
    let confirmState = null;  // { onOk: function }

    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const byId = (id) => {
      try { return ui && typeof ui.byId === 'function' ? ui.byId(id) : document.getElementById(id); } catch (e) { return null; }
    };

    function toast(msg, kind) {
      try { if (ui && typeof ui.toast === 'function') return ui.toast(msg, kind); } catch (e) {}
      try { if (typeof window.showToast === 'function') return window.showToast(String(msg || ''), kind || 'info'); } catch (e2) {}
    }

    function bindClickById(id, handler) {
      const el = byId(id);
      if (!el) return;
      el.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try { handler(e); } catch (e3) {}
      });
    }

    function loadProfiles() {
      try {
        const s = localStorage.getItem(KEY);
        const j = s ? JSON.parse(s) : [];
        return Array.isArray(j) ? j : [];
      } catch (e) { return []; }
    }

    function saveProfiles(list) {
      try { localStorage.setItem(KEY, JSON.stringify(list || [])); } catch (e) {}
    }

    function buildCmd(p) {
      const host = (p.host || '').trim();
      const user = (p.user || '').trim();
      const port = String(p.port || '').trim();
      const key  = (p.key || '').trim();
      const jump = (p.jump || '').trim();

      if (!host) return '';
      const target = user ? `${user}@${host}` : host;

      let cmd = `ssh ${target}`;
      if (port) cmd += ` -p ${port}`;
      if (key)  cmd += ` -i ${key}`;
      if (jump) cmd += ` -J ${jump}`;
      return cmd;
    }

    function openModal() {
      const m = byId('ssh-modal');
      if (!m) return;
      m.classList.remove('hidden');
      document.body.classList.add('modal-open');
      renderProfiles();
    }

    function closeModal() {
      const m = byId('ssh-modal');
      if (!m) return;
      m.classList.add('hidden');
      document.body.classList.remove('modal-open');
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
        empty.textContent = 'Профилей нет. Нажми “Добавить”.';
        listEl.appendChild(empty);
      }

      profiles.forEach((p, idx) => {
        const row = document.createElement('div');
        row.className = 'github-config-row';
        row.style.alignItems = 'stretch';
        if (idx === selectedIndex) row.classList.add('is-selected');
        row.onclick = (ev) => {
          const t = ev && ev.target ? ev.target : null;
          if (t && (t.tagName === 'BUTTON' || t.closest('button'))) return;
          selectProfile(idx);
        };

        const left = document.createElement('div');
        left.style.display = 'flex';
        left.style.flexDirection = 'column';
        left.style.gap = '4px';

        const title = document.createElement('div');
        title.style.fontWeight = '700';
        title.textContent = p.name || `${p.user || ''}@${p.host || ''}`.replace(/^@/, '');
        left.appendChild(title);

        const meta = document.createElement('div');
        meta.style.opacity = '.8';
        meta.style.fontSize = '12px';
        meta.textContent = buildCmd(p);
        left.appendChild(meta);

        const right = document.createElement('div');
        right.style.display = 'flex';
        right.style.gap = '6px';
        right.style.alignItems = 'center';

        const btnUse = document.createElement('button');
        btnUse.type = 'button';
        btnUse.textContent = 'Use';
        btnUse.onclick = () => {
          selectProfile(idx);
        };

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
        const sel = profiles[selectedIndex];
        preview.value = sel ? buildCmd(sel) : '';
      }
    }

    function addProfile() { editOpen('add', -1); }

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
      const original = (mode === 'edit' && profiles[idx]) ? profiles[idx] : { name:'', host:'', user:'', port:'22', key:'', jump:'' };
      editState = { mode, idx };

      const title = byId('ssh-edit-title');
      if (title) title.textContent = (mode === 'add') ? 'Добавить SSH профиль' : 'Редактировать SSH профиль';

      const del = byId('ssh-edit-delete-btn');
      if (del) del.style.display = (mode === 'edit') ? '' : 'none';

      const err = byId('ssh-edit-error');
      if (err) err.textContent = '';

      const set = (id, v) => { const el = byId(id); if (el) el.value = (v ?? ''); };
      set('ssh-edit-name', original.name || '');
      set('ssh-edit-host', original.host || '');
      set('ssh-edit-user', original.user || '');
      set('ssh-edit-port', String(original.port || '22'));
      set('ssh-edit-key',  original.key  || '');
      set('ssh-edit-jump', original.jump || '');

      modal.classList.remove('hidden');
      document.body.classList.add('modal-open');
      try { const host = byId('ssh-edit-host'); host && host.focus && host.focus(); } catch (e) {}
    }

    function editClose() {
      const modal = byId('ssh-edit-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      editState = null;
      const parent = byId('ssh-modal');
      const sshVisible = parent && !parent.classList.contains('hidden');
      if (!sshVisible) document.body.classList.remove('modal-open');
    }

    function editGetDraft() {
      const get = (id) => {
        const el = byId(id);
        return el ? String(el.value || '') : '';
      };
      return {
        name: get('ssh-edit-name').trim(),
        host: get('ssh-edit-host').trim(),
        user: get('ssh-edit-user').trim(),
        port: get('ssh-edit-port').trim(),
        key:  get('ssh-edit-key').trim(),
        jump: get('ssh-edit-jump').trim(),
      };
    }

    function editValidate(d) {
      if (!d.host) return { ok: false, error: 'Поле Host обязательно.' };
      const portStr = d.port || '22';
      if (portStr) {
        const portNum = Number(portStr);
        if (!Number.isFinite(portNum) || !/^[0-9]+$/.test(portStr) || portNum < 1 || portNum > 65535) {
          return { ok: false, error: 'Port должен быть числом от 1 до 65535.' };
        }
      }
      const cleaned = {
        name: d.name,
        host: d.host,
        user: d.user,
        port: portStr || '22',
        key: d.key,
        jump: d.jump,
      };
      return { ok: true, cleaned };
    }

    function editSave() {
      if (!editState) return;
      const err = byId('ssh-edit-error');

      const draft = editGetDraft();
      const v = editValidate(draft);
      if (!v.ok) {
        if (err) err.textContent = v.error || 'Проверь данные профиля.';
        return;
      }

      const profiles = loadProfiles();
      if (editState.mode === 'add') {
        profiles.unshift(v.cleaned);
        saveProfiles(profiles);
        selectedIndex = 0;
      } else {
        const idx = editState.idx;
        if (idx >= 0 && idx < profiles.length) {
          profiles[idx] = v.cleaned;
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
      const profiles2 = loadProfiles();
      if (idx < 0 || idx >= profiles2.length) return;
      profiles2.splice(idx, 1);
      saveProfiles(profiles2);
      if (selectedIndex === idx) selectedIndex = Math.min(idx, profiles2.length - 1);
      if (selectedIndex > idx) selectedIndex -= 1;
      renderProfiles();
    }

    function deleteProfile(idx) {
      const profiles = loadProfiles();
      const p = profiles[idx];
      if (!p) return;
      const name = p.name || `${p.user || ''}@${p.host || ''}`.replace(/^@/, '');
      confirmOpen(`Удалить профиль “${name}”?`, () => {
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
      const txt = byId('ssh-confirm-text');
      const ok = byId('ssh-confirm-ok');
      if (!modal || !txt || !ok) return;
      confirmState = { onOk };
      txt.textContent = String(text || '');
      ok.onclick = () => {
        const fn = confirmState && confirmState.onOk;
        confirmClose();
        try { fn && fn(); } catch (e) {}
      };
      modal.classList.remove('hidden');
      document.body.classList.add('modal-open');
    }

    function confirmClose() {
      const modal = byId('ssh-confirm-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      confirmState = null;
      const sshVisible = (byId('ssh-modal') && !byId('ssh-modal').classList.contains('hidden'));
      const editorVisible = (byId('ssh-edit-modal') && !byId('ssh-edit-modal').classList.contains('hidden'));
      if (!sshVisible && !editorVisible) document.body.classList.remove('modal-open');
    }

    function copyPreview() {
      const preview = byId('ssh-command-preview');
      if (!preview) return;
      const text = (preview.value || '').trim();
      if (!text) return;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          toast('SSH команда скопирована', 'success');
        }).catch(()=>{});
      } else {
        try { preview.focus(); preview.select(); } catch (e) {}
      }
    }

    function isPtyConnected() {
      try {
        if (ctx && ctx.transport) {
          if (typeof ctx.transport.isConnected === 'function') return !!ctx.transport.isConnected();
          // Some managers expose state differently
          if (typeof ctx.transport.getState === 'function') {
            const st = ctx.transport.getState();
            return !!(st && st.connected);
          }
        }
      } catch (e) {}
      try {
        const st = ctx && ctx.core && ctx.core.state ? ctx.core.state : null;
        const ws = st ? st.ptyWs : null;
        return !!(ws && ws.readyState === WebSocket.OPEN);
      } catch (e2) {}
      return false;
    }

    function runPreview() {
      const preview = byId('ssh-command-preview');
      const cmd = (preview && preview.value ? preview.value : '').trim();
      if (!cmd) return;

      if (!isPtyConnected()) {
        toast('PTY не подключён', 'info');
        return;
      }

      try {
        if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
          // Use CR to mimic Enter in PTY shell.
          ctx.transport.send(cmd + '\r', { prefer: 'pty' });
        }
      } catch (e) {}

      closeModal();

      // Focus xterm if present
      try {
        const term = (ctx && ctx.core && typeof ctx.core.getXtermRef === 'function') ? (ctx.core.getXtermRef('term') || ctx.core.getXtermRef('xterm')) : null;
        if (term && typeof term.focus === 'function') term.focus();
      } catch (e) {}
    }

    function exportProfiles() {
      const s = JSON.stringify(loadProfiles(), null, 2);
      prompt('Скопируй JSON профилей:', s);
    }

    function importProfiles() {
      const s = prompt('Вставь JSON профилей:');
      if (!s) return;
      try {
        const j = JSON.parse(s);
        if (!Array.isArray(j)) throw new Error('not array');
        saveProfiles(j);
        renderProfiles();
      } catch (e) {
        toast('Импорт не удался: неверный JSON', 'error');
      }
    }

    function wireUi() {
      // Entry button (toolbar)
      bindClickById('terminal-btn-ssh', () => openModal());

      // Modal backdrop closes
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

      const em = byId('ssh-edit-modal');
      if (em) {
        em.addEventListener('mousedown', (e) => {
          try { if (e.target === em) editClose(); } catch (e2) {}
        });
      }
      bindClickById('ssh-edit-close-btn', () => editClose());
      bindClickById('ssh-edit-cancel-btn', () => editClose());
      bindClickById('ssh-edit-delete-btn', () => editDelete());
      bindClickById('ssh-edit-save-btn', () => editSave());

      const cm = byId('ssh-confirm-modal');
      if (cm) {
        cm.addEventListener('mousedown', (e) => {
          try { if (e.target === cm) confirmClose(); } catch (e2) {}
        });
      }
      bindClickById('ssh-confirm-close-btn', () => confirmClose());
      bindClickById('ssh-confirm-cancel-btn', () => confirmClose());
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
