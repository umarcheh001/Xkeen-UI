(() => {
  'use strict';

  // File Manager wiring (DOM events): panel handlers + global hotkeys/modals/header actions.
  // No ES modules / bundler.

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  FM.wire = FM.wire || {};
  const W = FM.wire;

  // --- getters (avoid capturing modules too early)
  function C() { try { return (FM && FM.common) ? FM.common : {}; } catch (e) { return {}; } }
  function ST() { try { return (FM && FM.state) ? FM.state : {}; } catch (e) { return {}; } }
  function LM() { try { return (FM && FM.listModel) ? FM.listModel : {}; } catch (e) { return {}; } }
  function SEL() { try { return (FM && FM.selection) ? FM.selection : {}; } catch (e) { return {}; } }
  function NAV() { try { return (FM && FM.nav) ? FM.nav : {}; } catch (e) { return {}; } }
  function LISTING() { try { return (FM && FM.listing) ? FM.listing : {}; } catch (e) { return {}; } }
  function RENDER() { try { return (FM && FM.render) ? FM.render : {}; } catch (e) { return {}; } }
  function REMOTE() { try { return (FM && FM.remote) ? FM.remote : {}; } catch (e) { return {}; } }
  function CHROME() { try { return (FM && FM.chrome) ? FM.chrome : {}; } catch (e) { return {}; } }
  function OPS() { try { return (FM && FM.ops) ? FM.ops : {}; } catch (e) { return {}; } }
  function ACT() { try { return (FM && FM.actions) ? FM.actions : {}; } catch (e) { return {}; } }
  function TRANS() { try { return (FM && FM.transfers) ? FM.transfers : {}; } catch (e) { return {}; } }
  function PROG() { try { return (FM && FM.progress) ? FM.progress : {}; } catch (e) { return {}; } }
  function ED() { try { return (FM && FM.editor) ? FM.editor : {}; } catch (e) { return {}; } }

  function getS() {
    try {
      const st = ST();
      return (st && st.S) ? st.S : null;
    } catch (e) {
      return null;
    }
  }

  // --- tiny DOM helpers
  function el(id) {
    const c = C();
    try { if (c && typeof c.el === 'function') return c.el(id); } catch (e) {}
    try { return document.getElementById(id); } catch (e2) { return null; }
  }

  function qs(sel, root) {
    const c = C();
    try { if (c && typeof c.qs === 'function') return c.qs(sel, root); } catch (e) {}
    try { return (root || document).querySelector(sel); } catch (e2) { return null; }
  }

  function modalOpen(modal) {
    const c = C();
    try { if (c && typeof c.modalOpen === 'function') return c.modalOpen(modal); } catch (e) {}
    try { if (modal) modal.classList.remove('hidden'); } catch (e2) {}
  }

  function modalClose(modal) {
    const c = C();
    try { if (c && typeof c.modalClose === 'function') return c.modalClose(modal); } catch (e) {}
    try { if (modal) modal.classList.add('hidden'); } catch (e2) {}
  }

  function toast(msg, level) {
    try { if (C && typeof C.toast === 'function') return C.toast(msg, level); } catch (e) {}
  }

  function safeName(s) {
    const c = C();
    try { if (c && typeof c.safeName === 'function') return c.safeName(s); } catch (e) {}
    return String(s == null ? '' : s);
  }

  function isTextInputActive() {
    const a = document.activeElement;
    if (!a) return false;
    const tag = (a.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (a.isContentEditable) return true;
    return false;
  }

  function isFilesViewVisible() {
    const view = el('view-files');
    if (!view) return false;
    try {
      const cs = window.getComputedStyle(view);
      return !!cs && cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) {
      return true;
    }
  }

  function isHiddenName(name) {
    const lm = LM();
    try { if (lm && typeof lm.isHiddenName === 'function') return lm.isHiddenName(name); } catch (e) {}
    const n = String(name || '');
    if (n === '.' || n === '..') return false;
    return n.startsWith('.');
  }

  function visibleSortedItems(side) {
    const lm = LM();
    try { if (lm && typeof lm.visibleSortedItems === 'function') return lm.visibleSortedItems(side); } catch (e) {}
    return [];
  }

  function setShowHidden(on) {
    const S = getS();
    if (!S) return;

    const v = !!on;
    try { S.prefs.showHidden = v; } catch (e) {}

    // persist pref
    try {
      if (FM.prefs && typeof FM.prefs.saveShowHiddenPref === 'function') FM.prefs.saveShowHiddenPref(v);
    } catch (e) {}

    // If we hide dotfiles, drop them from selection/focus to avoid acting on invisible items.
    if (!v) {
      ['left', 'right'].forEach((side) => {
        const p = S.panels[side];
        if (!p) return;
        let changed = false;

        try {
          for (const nm of Array.from(p.selected || [])) {
            if (isHiddenName(nm)) { p.selected.delete(nm); changed = true; }
          }
        } catch (e) {}

        try {
          if (p.focusName && isHiddenName(p.focusName)) {
            const vis = visibleSortedItems(side);
            p.focusName = vis.length ? safeName(vis[0] && vis[0].name) : '';
            changed = true;
          }
        } catch (e) {}

        if (changed) {
          try { p.anchorName = p.focusName || ''; } catch (e) {}
        }
      });
    }

    const r = RENDER();
    try { if (r && typeof r.renderPanel === 'function') r.renderPanel('left'); } catch (e) {}
    try { if (r && typeof r.renderPanel === 'function') r.renderPanel('right'); } catch (e) {}
  }

  let _globalWired = false;

  function wireGlobalOnce() {
    if (_globalWired) return;
    _globalWired = true;

    // Card resize handles + geometry persistence
    try {
      const ch = CHROME();
      if (ch && typeof ch.wireLeftResizeHandle === 'function') ch.wireLeftResizeHandle();
    } catch (e) {}
    try {
      const ch = CHROME();
      if (ch && typeof ch.wireGeomPersistence === 'function') ch.wireGeomPersistence();
    } catch (e) {}

    wireModals();
    wireHeaderActions();
    wireHotkeys();
  }

  function wireModals() {
    // Editor modal
    try {
      const ed = ED();
      if (ed && typeof ed.wire === 'function') ed.wire();
    } catch (e) {}

    // Remote connect / profiles / known_hosts
    try { if (FM.remote && typeof FM.remote.wireModals === 'function') FM.remote.wireModals(); } catch (e) {}

    // Actions modals (create/rename/archive/chmod/chown/pickers)
    try { if (FM.actions && typeof FM.actions.wireModals === 'function') FM.actions.wireModals(); } catch (e) {}

    // Select by mask modal
    const maskOk = el('fm-mask-ok-btn');
    const maskCancel = el('fm-mask-cancel-btn');
    const maskClose = el('fm-mask-close-btn');
    const maskInp = el('fm-mask-pattern');

    const closeMask = () => {
      try { modalClose(el('fm-mask-modal')); } catch (e) {}
    };

    const doMask = () => {
      const S = getS();
      const side = (S && S.activeSide) ? S.activeSide : 'left';
      const v = String((maskInp && maskInp.value) || '').trim();
      if (!v) {
        try {
          const err = el('fm-mask-error');
          if (err) err.textContent = 'Введите маску (например: *.log)';
        } catch (e) {}
        return;
      }
      try {
        const sel = SEL();
        if (sel && typeof sel.applySelectByMask === 'function') sel.applySelectByMask(side, v);
      } catch (e) {}
      closeMask();
    };

    if (maskOk) maskOk.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} doMask(); });
    if (maskCancel) maskCancel.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeMask(); });
    if (maskClose) maskClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeMask(); });
    if (maskInp) maskInp.addEventListener('keydown', (e) => { if (e && e.key === 'Enter') { try { e.preventDefault(); } catch (e2) {} doMask(); } });

    const msm = el('fm-mask-modal');
    if (msm) msm.addEventListener('click', (e) => { if (e && e.target === msm) closeMask(); });

    // Drag&Drop: choose Move or Copy modal
    try { if (FM.dragdrop && typeof FM.dragdrop.wireDropOpModal === 'function') FM.dragdrop.wireDropOpModal(); } catch (e) {}

    // Properties modal
    const propsClose = el('fm-props-close-btn');
    const propsClose2 = el('fm-props-close-btn2');
    const closeProps = () => { try { modalClose(el('fm-props-modal')); } catch (e) {} };

    if (propsClose) propsClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeProps(); });
    if (propsClose2) propsClose2.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeProps(); });

    const prm = el('fm-props-modal');
    if (prm) prm.addEventListener('click', (e) => { if (e && e.target === prm) closeProps(); });

    const propsBody = el('fm-props-modal-body');
    if (propsBody) propsBody.addEventListener('click', (e) => {
      try {
        const btn = (e && e.target && e.target.closest) ? e.target.closest('.fm-props-recalc-btn') : null;
        if (!btn) return;
        e.preventDefault();
        const s = String(btn.getAttribute('data-side') || ((getS() && getS().activeSide) || 'left'));
        const pth = String(btn.getAttribute('data-path') || '');
        if (!pth) return;
        if (FM.props && typeof FM.props.recalcDirSize === 'function') FM.props.recalcDirSize(s, pth);
      } catch (e2) {}
    });

    // Checksum modal
    const hashClose = el('fm-hash-close-btn');
    const hashClose2 = el('fm-hash-close-btn2');
    const hashCopyMd5 = el('fm-hash-copy-md5');
    const hashCopySha = el('fm-hash-copy-sha256');
    const hashCopyAll = el('fm-hash-copy-all');
    const closeHash = () => { try { modalClose(el('fm-hash-modal')); } catch (e) {} };

    if (hashClose) hashClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeHash(); });
    if (hashClose2) hashClose2.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} closeHash(); });
    const hashm = el('fm-hash-modal');
    if (hashm) hashm.addEventListener('click', (e) => { if (e && e.target === hashm) closeHash(); });

    const copyText = async (t) => {
      try {
        const p = PROG();
        if (p && typeof p.copyText === 'function') return await p.copyText(t);
      } catch (e) {}
    };

    if (hashCopyMd5) hashCopyMd5.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}
      const v = String((el('fm-hash-md5') && el('fm-hash-md5').value) || '').trim();
      if (v) await copyText(v);
      toast(v ? 'MD5 скопирован' : 'Нет данных', v ? 'success' : 'info');
    });

    if (hashCopySha) hashCopySha.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}
      const v = String((el('fm-hash-sha256') && el('fm-hash-sha256').value) || '').trim();
      if (v) await copyText(v);
      toast(v ? 'SHA256 скопирован' : 'Нет данных', v ? 'success' : 'info');
    });

    if (hashCopyAll) hashCopyAll.addEventListener('click', async (e) => {
      try { e.preventDefault(); } catch (e2) {}
      const meta = String((el('fm-hash-meta') && el('fm-hash-meta').textContent) || '').trim();
      const md5 = String((el('fm-hash-md5') && el('fm-hash-md5').value) || '').trim();
      const sha = String((el('fm-hash-sha256') && el('fm-hash-sha256').value) || '').trim();
      const size = String((el('fm-hash-size') && el('fm-hash-size').value) || '').trim();
      const out = [meta, md5 && ('MD5: ' + md5), sha && ('SHA256: ' + sha), size && ('Size: ' + size)].filter(Boolean).join('\n');
      if (out) await copyText(out);
      toast(out ? 'Checksum скопирован' : 'Нет данных', out ? 'success' : 'info');
    });

    // Refresh all
    const refreshAllBtn = el('fm-refresh-all-btn');
    if (refreshAllBtn) refreshAllBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      try {
        const l = LISTING();
        if (l && typeof l.refreshAll === 'function') l.refreshAll();
      } catch (e3) {}
    });

    // Help modal
    const helpBtn = el('fm-help-btn');
    const helpClose = el('fm-help-close-btn');
    const helpOk = el('fm-help-ok-btn');

    if (helpBtn) helpBtn.addEventListener('click', (e) => {
      try { e.preventDefault(); } catch (e2) {}
      modalOpen(el('fm-help-modal'));
    });
    if (helpClose) helpClose.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} modalClose(el('fm-help-modal')); });
    if (helpOk) helpOk.addEventListener('click', (e) => { try { e.preventDefault(); } catch (e2) {} modalClose(el('fm-help-modal')); });

    const hm = el('fm-help-modal');
    if (hm) hm.addEventListener('click', (e) => { if (e && e.target === hm) modalClose(hm); });

    // ESC closes our modals (best-effort)
    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape') return;

      let closedAny = false;

      // Editor modal has its own unsaved-changes logic.
      const em = el('fm-editor-modal');
      if (em && !em.classList.contains('hidden')) {
        try {
          const ed = ED();
          // If the editor is currently in fullscreen, ESC should first exit fullscreen
          // (and keep the modal open), not close the modal.
          if (ed && typeof ed.exitFullscreenIfAny === 'function' && ed.exitFullscreenIfAny()) {
            try { e.preventDefault(); } catch (e1) {}
            try { e.stopPropagation(); } catch (e1) {}
            try { e.stopImmediatePropagation(); } catch (e1) {}
            closedAny = true;
            return;
          }
          if (ed && typeof ed.requestClose === 'function') ed.requestClose();
        } catch (e0) {}
        closedAny = true;
      }

      // Drop operation modal must resolve the pending promise.
      const dm = el('fm-dropop-modal');
      if (dm && !dm.classList.contains('hidden')) {
        try { if (FM.dragdrop && typeof FM.dragdrop.closeDropOpModal === 'function') FM.dragdrop.closeDropOpModal(null); } catch (e2) {}
        closedAny = true;
      }

      [
        'fm-help-modal',
        'fm-ops-modal',
        'fm-progress-modal',
        'fm-conflicts-modal',
        'fm-props-modal',
        'fm-hash-modal',
        'fm-rename-modal',
        'fm-create-modal',
        'fm-archive-modal',
        'fm-extract-modal',
        'fm-folder-picker-modal',
        'fm-archive-list-modal',
        'fm-connect-modal',
        'fm-chmod-modal',
        'fm-chown-modal',
      ].forEach((id) => {
        const m = el(id);
        if (m && !m.classList.contains('hidden')) {
          modalClose(m);
          closedAny = true;
        }
      });

      // If no modal was closed, treat ESC as "exit fullscreen".
      try {
        const ch = CHROME();
        if (!closedAny && ch && typeof ch.isFullscreen === 'function' && ch.isFullscreen()
            && isFilesViewVisible() && !isTextInputActive() && !document.querySelector('.modal:not(.hidden)')) {
          if (typeof ch.setFullscreen === 'function') ch.setFullscreen(false);
        }
      } catch (e2) {}
    });
  }

  function wireHeaderActions() {
    const S = getS();
    const view = el('view-files');
    const actions = view ? qs('.fm-header-actions', view) : null;
    if (!actions || !S) return;

    // Buttons for file operations should be located at the bottom-right of the card.
    const footerActions = view ? qs('.fm-footer-actions', view) : null;
    const fileActions = footerActions || actions;

    // Fullscreen toggle
    if (!el('fm-fullscreen-btn')) {
      const fsBtn = document.createElement('button');
      fsBtn.type = 'button';
      fsBtn.className = 'btn-secondary';
      fsBtn.id = 'fm-fullscreen-btn';
      fsBtn.textContent = '⛶';
      fsBtn.title = 'Полный экран';
      fsBtn.setAttribute('aria-label', 'Полный экран');
      fsBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const ch = CHROME();
          if (ch && typeof ch.toggleFullscreen === 'function') ch.toggleFullscreen();
        } catch (e3) {}
      });

      try { actions.insertBefore(fsBtn, actions.firstChild); } catch (e) { try { actions.appendChild(fsBtn); } catch (e2) {} }
    }

    // Show hidden files toggle
    if (!el('fm-dotfiles-toggle')) {
      const wrap = document.createElement('label');
      wrap.className = 'fm-toggle';
      wrap.id = 'fm-dotfiles-wrap';
      wrap.title = 'Показать/скрыть файлы, начинающиеся с точки (.)';
      wrap.innerHTML = [
        '<input type="checkbox" id="fm-dotfiles-toggle" />',
        '<span class="fm-toggle-slider" aria-hidden="true"></span>',
        '<span class="fm-toggle-label">Скрытые</span>',
      ].join('');

      try {
        const cb = qs('#fm-dotfiles-toggle', wrap);
        if (cb) {
          cb.checked = !!(S && S.prefs && S.prefs.showHidden);
          cb.addEventListener('change', () => setShowHidden(!!cb.checked));
        }
      } catch (e) {}

      try {
        const fsBtn = el('fm-fullscreen-btn');
        if (fsBtn && fsBtn.parentElement) fsBtn.parentElement.insertBefore(wrap, fsBtn.nextSibling);
        else actions.insertBefore(wrap, actions.firstChild);
      } catch (e) {
        try { actions.appendChild(wrap); } catch (e2) {}
      }
    } else {
      try {
        const cb = el('fm-dotfiles-toggle');
        if (cb) cb.checked = !!(S && S.prefs && S.prefs.showHidden);
      } catch (e) {}
    }

    // Terminal here
    if (!el('fm-terminal-here-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-terminal-here-btn';
      b.textContent = '⌨ Terminal here';
      b.title = 'Открыть терминал в текущей папке (PTY)';
      b.setAttribute('aria-label', 'Открыть терминал в текущей папке');
      b.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          if (FM.terminal && typeof FM.terminal.openHere === 'function') await FM.terminal.openHere(S.activeSide, {});
        } catch (e3) {}
      });

      try {
        const fsBtn = el('fm-fullscreen-btn');
        if (fsBtn && fsBtn.parentElement) fsBtn.parentElement.insertBefore(b, fsBtn.nextSibling);
        else actions.appendChild(b);
      } catch (e) {
        try { actions.appendChild(b); } catch (e2) {}
      }
    }

    // Sync fullscreen state from DOM (best effort)
    try {
      const ch = CHROME();
      if (ch && typeof ch.syncFromDom === 'function') ch.syncFromDom();
    } catch (e) {}

    // Active panel: clear trash
    if (!el('fm-clear-trash-active-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary hidden';
      b.id = 'fm-clear-trash-active-btn';
      b.textContent = '🧹 Очистить корзину';
      b.title = 'Очистить корзину (активная панель)';
      b.setAttribute('aria-label', 'Очистить корзину');
      b.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const o = OPS();
          if (o && typeof o.runClearTrash === 'function') await o.runClearTrash(S.activeSide);
        } catch (e3) {}
      });

      try { fileActions.insertBefore(b, fileActions.firstChild); } catch (e) { try { fileActions.appendChild(b); } catch (e2) {} }
    }

    // Initial state for footer nav buttons
    try {
      const st = ST();
      if (st && typeof st.updateFmFooterNavButtons === 'function') st.updateFmFooterNavButtons();
    } catch (e) {}

    // Create folder
    if (!el('fm-mkdir-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-mkdir-btn';
      b.textContent = '➕ Папка';
      b.title = 'Создать папку в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const a = ACT();
          if (a && typeof a.openCreateModal === 'function') a.openCreateModal('dir');
        } catch (e3) {}
      });
      try { fileActions.appendChild(b); } catch (e2) {}
    }

    // Create empty file
    if (!el('fm-touch-btn')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary';
      b.id = 'fm-touch-btn';
      b.textContent = '➕ Файл';
      b.title = 'Создать пустой файл в активной панели';
      b.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const a = ACT();
          if (a && typeof a.openCreateModal === 'function') a.openCreateModal('file');
        } catch (e3) {}
      });
      try { fileActions.appendChild(b); } catch (e2) {}
    }

    // Upload / download buttons are injected at runtime.
    if (el('fm-upload-btn')) return; // already wired

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'btn-secondary';
    upBtn.id = 'fm-upload-btn';
    upBtn.textContent = '⬆ Upload';
    upBtn.title = 'Загрузить файлы в активную панель';

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'btn-secondary';
    downBtn.id = 'fm-download-btn';
    downBtn.textContent = '⬇ Download';
    downBtn.title = 'Скачать выбранные файлы/папки (ZIP)';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.style.display = 'none';
    fileInput.id = 'fm-upload-input';

    upBtn.onclick = () => {
      try { fileInput.value = ''; } catch (e) {}
      fileInput.click();
    };

    fileInput.onchange = () => {
      const files = Array.from(fileInput.files || []);
      if (!files.length) return;
      try {
        const t = TRANS();
        if (t && typeof t.xhrUploadFiles === 'function') t.xhrUploadFiles({ side: S.activeSide, files });
      } catch (e) {}
    };

    downBtn.onclick = () => {
      try {
        const o = OPS();
        if (o && typeof o.downloadSelection === 'function') o.downloadSelection(S.activeSide);
      } catch (e) {}
    };

    fileActions.appendChild(downBtn);
    fileActions.appendChild(upBtn);
    fileActions.appendChild(fileInput);

    // Place navigation buttons at the far right of the footer actions.
    try {
      const trashNav = el('fm-clear-trash-active-btn');
      if (trashNav && trashNav.parentElement === fileActions) fileActions.appendChild(trashNav);
    } catch (e) {}
  }

  function wireHotkeys() {
    document.addEventListener('keydown', async (e) => {
      if (!isFilesViewVisible()) return;
      if (!e) return;

      // Avoid interfering when typing in inputs and when modals are open
      if (isTextInputActive()) return;
      if (document.querySelector('.modal:not(.hidden)')) return;

      const S = getS();
      if (!S) return;

      const k = e.key;

      // Exit FM fullscreen quickly
      try {
        const ch = CHROME();
        if (k === 'Escape' && ch && typeof ch.isFullscreen === 'function' && ch.isFullscreen()) {
          e.preventDefault();
          if (typeof ch.setFullscreen === 'function') ch.setFullscreen(false);
          return;
        }
      } catch (e0) {}

      // While a remote file is being opened for the editor, block hotkeys
      try {
        if (S.openBusy) {
          e.preventDefault();
          return;
        }
      } catch (e0) {}

      const ctrl = !!(e.ctrlKey || e.metaKey);

      if (ctrl && (k === 'a' || k === 'A')) {
        e.preventDefault();
        try { const sel = SEL(); if (sel && typeof sel.selectAllVisible === 'function') sel.selectAllVisible(S.activeSide); } catch (e2) {}
        return;
      }

      if (ctrl && (k === 'i' || k === 'I')) {
        e.preventDefault();
        try { const sel = SEL(); if (sel && typeof sel.invertSelectionVisible === 'function') sel.invertSelectionVisible(S.activeSide); } catch (e2) {}
        return;
      }

      if (ctrl && (k === 'm' || k === 'M')) {
        e.preventDefault();
        try { const sel = SEL(); if (sel && typeof sel.openMaskModal === 'function') sel.openMaskModal(); } catch (e2) {}
        return;
      }

      if (ctrl && e.shiftKey && (k === 'c' || k === 'C')) {
        e.preventDefault();
        try { const sel = SEL(); if (sel && typeof sel.copyFullPaths === 'function') sel.copyFullPaths(S.activeSide); } catch (e2) {}
        return;
      }

      if (k === 'F1') {
        e.preventDefault();
        modalOpen(el('fm-help-modal'));
        return;
      }

      if (k === 'Tab') {
        e.preventDefault();
        try {
          const st = ST();
          if (st && typeof st.otherSide === 'function' && typeof st.setActiveSide === 'function') {
            st.setActiveSide(st.otherSide(S.activeSide));
          }
          const pd = st && typeof st.panelDom === 'function' ? st.panelDom(S.activeSide) : null;
          if (pd && pd.list) { try { pd.list.focus(); } catch (e2) {} }
        } catch (e2) {}
        return;
      }

      if (k === 'Enter') {
        e.preventDefault();
        try {
          const nav = NAV();
          if (nav && typeof nav.openFocused === 'function') await nav.openFocused(S.activeSide);
        } catch (e2) {}
        return;
      }

      if (k === 'Backspace') {
        e.preventDefault();
        try {
          const nav = NAV();
          if (nav && typeof nav.goUp === 'function') await nav.goUp(S.activeSide);
        } catch (e2) {}
        return;
      }

      if (k === 'F2') {
        e.preventDefault();
        try {
          const a = ACT();
          if (a && typeof a.openRenameModal === 'function') a.openRenameModal();
        } catch (e2) {}
        return;
      }

      if (k === 'F5') {
        e.preventDefault();
        try { const o = OPS(); if (o && typeof o.runCopyMove === 'function') await o.runCopyMove('copy'); } catch (e2) {}
        return;
      }

      if (k === 'F6') {
        e.preventDefault();
        try { const o = OPS(); if (o && typeof o.runCopyMove === 'function') await o.runCopyMove('move'); } catch (e2) {}
        return;
      }

      if (k === 'F7') {
        e.preventDefault();
        try {
          const a = ACT();
          if (a && typeof a.openCreateModal === 'function') a.openCreateModal(e.shiftKey ? 'file' : 'dir');
        } catch (e2) {}
        return;
      }

      if (k === 'F8') {
        e.preventDefault();
        try { const o = OPS(); if (o && typeof o.runDelete === 'function') await o.runDelete(); } catch (e2) {}
        return;
      }
    }, true);
  }

  // -------------------------- panel wiring --------------------------
  W.wirePanel = function wirePanel(side) {
    wireGlobalOnce();

    const S = getS();
    const st = ST();
    if (!S || !st || typeof st.panelDom !== 'function') return;

    const pd = st.panelDom(side);
    const p = S.panels ? S.panels[side] : null;
    if (!pd || !p) return;

    try { pd.root.addEventListener('click', () => { try { if (st.setActiveSide) st.setActiveSide(side); } catch (e) {} }); } catch (e) {}

    if (pd.targetSelect) {
      pd.targetSelect.addEventListener('change', async () => {
        const v = String(pd.targetSelect.value || 'local');
        if (v === 'remote') {
          p.target = 'remote';
          // no session => show connect
          try { const r = RENDER(); if (r && typeof r.renderPanel === 'function') r.renderPanel(side); } catch (e) {}
          if (!p.sid) {
            try {
              const rr = REMOTE();
              if (rr && typeof rr.connectRemoteToSide === 'function') await rr.connectRemoteToSide(side);
            } catch (e) {}
          } else {
            try {
              const l = LISTING();
              if (l && typeof l.listPanel === 'function') await l.listPanel(side, { fromInput: true });
            } catch (e) {}
          }
          return;
        }

        p.target = 'local';
        p.sid = '';
        if (!p.cwd) p.cwd = '/opt/var';

        try {
          const l = LISTING();
          if (l && typeof l.listPanel === 'function') await l.listPanel(side, { fromInput: true });
        } catch (e) {}
      });
    }

    if (pd.connectBtn) {
      pd.connectBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const rr = REMOTE();
          if (rr && typeof rr.connectRemoteToSide === 'function') await rr.connectRemoteToSide(side);
        } catch (e3) {}
      });
    }

    if (pd.disconnectBtn) {
      pd.disconnectBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const rr = REMOTE();
          if (rr && typeof rr.disconnectSide === 'function') await rr.disconnectSide(side);
        } catch (e3) {}
      });
    }

    if (pd.upBtn) {
      pd.upBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const nav = NAV();
          if (nav && typeof nav.goUp === 'function') await nav.goUp(side);
        } catch (e3) {}
      });
    }

    if (pd.rootBtn) {
      pd.rootBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        const pp = S.panels[side];
        if (!pp) return;
        if (pp.target !== 'remote') return;

        // If not connected yet, behave like "Connect"
        if (!pp.sid) {
          try {
            const rr = REMOTE();
            if (rr && typeof rr.connectRemoteToSide === 'function') await rr.connectRemoteToSide(side);
          } catch (e3) {}
          return;
        }

        const rp = String(pp.rproto || '').toLowerCase();
        const isFtp = (rp === 'ftp' || rp === 'ftps');
        const dest = isFtp ? '/' : '.';
        pp.cwd = dest;

        try {
          const l = LISTING();
          if (l && typeof l.listPanel === 'function') await l.listPanel(side, { fromInput: false });
        } catch (e3) {}
      });
    }

    if (pd.refreshBtn) {
      pd.refreshBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const l = LISTING();
          if (l && typeof l.listPanel === 'function') await l.listPanel(side, { fromInput: true });
        } catch (e3) {}
      });
    }

    if (pd.clearTrashBtn) {
      pd.clearTrashBtn.addEventListener('click', async (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try {
          const o = OPS();
          if (o && typeof o.runClearTrash === 'function') await o.runClearTrash(side);
        } catch (e3) {}
      });
    }

    if (pd.pathInput) {
      pd.pathInput.addEventListener('keydown', async (e) => {
        if (e && e.key === 'Enter') {
          try { e.preventDefault(); } catch (e2) {}
          try {
            const l = LISTING();
            if (l && typeof l.listPanel === 'function') await l.listPanel(side, { fromInput: true });
          } catch (e3) {}
        }
      });
    }

    // Quick filter input (client-side, current folder only)
    let _fltTimer = null;

    const _applyFilter = () => {
      try {
        const v = String((pd.filterInput && pd.filterInput.value) || '');
        p.filter = v;
      } catch (e) {
        p.filter = '';
      }

      // Keep focus on a visible item
      try {
        const vis = visibleSortedItems(side);
        const focus = String(p.focusName || '');
        if (focus && !vis.some((it) => safeName(it && it.name) === focus)) {
          p.focusName = vis.length ? safeName(vis[0] && vis[0].name) : '';
          p.anchorName = p.focusName || '';
        }
      } catch (e) {}

      try {
        const r = RENDER();
        if (r && typeof r.renderPanel === 'function') r.renderPanel(side);
      } catch (e) {}
    };

    if (pd.filterInput) {
      pd.filterInput.addEventListener('input', () => {
        try { if (_fltTimer) clearTimeout(_fltTimer); } catch (e) {}
        _fltTimer = setTimeout(_applyFilter, 60);
      });

      pd.filterInput.addEventListener('keydown', (e) => {
        if (!e) return;

        if (e.key === 'Escape') {
          try { e.preventDefault(); } catch (e2) {}
          try { pd.filterInput.value = ''; } catch (e3) {}
          p.filter = '';
          _applyFilter();
        }

        if (e.key === 'Enter') {
          try { e.preventDefault(); } catch (e2) {}
          try { if (pd.list) pd.list.focus(); } catch (e3) {}
        }
      });
    }

    if (pd.filterClearBtn) {
      pd.filterClearBtn.addEventListener('click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try { if (pd.filterInput) pd.filterInput.value = ''; } catch (e3) {}
        p.filter = '';
        _applyFilter();
        try { if (pd.filterInput) pd.filterInput.focus(); } catch (e4) {}
      });
    }

    if (pd.list) {
      pd.list.addEventListener('click', async (e) => {
        const row = e && e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        if (!row) return;

        const name = String(row.dataset.name || '');
        try { if (st.setActiveSide) st.setActiveSide(side); } catch (e2) {}

        const pp = S.panels[side];
        if (!pp) return;

        const clickCheckbox = !!(e.target && e.target.closest && (e.target.closest('input.fm-check-input') || e.target.closest('.fm-cell.fm-check')));
        const isMulti = !!(e.ctrlKey || e.metaKey || clickCheckbox);
        const isShift = !!e.shiftKey;

        if (isShift) {
          if (!pp.anchorName) pp.anchorName = pp.focusName || name;
          const anchor = pp.anchorName || name;
          try {
            const sel = SEL();
            if (sel && typeof sel.selectRange === 'function') sel.selectRange(side, anchor, name, isMulti);
          } catch (e2) {}
        } else {
          if (!isMulti) {
            try {
              const sel = SEL();
              if (sel && typeof sel.clearSelectionExcept === 'function') sel.clearSelectionExcept(side, name);
              else {
                try { pp.selected.clear(); } catch (e3) {}
                try { pp.selected.add(name); } catch (e3) {}
              }
            } catch (e2) {}
          } else {
            try {
              if (pp.selected.has(name)) pp.selected.delete(name); else pp.selected.add(name);
            } catch (e2) {}
          }
          pp.anchorName = name;
        }

        pp.focusName = name;
        try {
          const r = RENDER();
          if (r && typeof r.renderPanel === 'function') r.renderPanel(side);
        } catch (e2) {}

        try { if (pd.list) pd.list.focus(); } catch (e2) {}

        // Double click => open
        if (!isMulti && !isShift && !clickCheckbox && Number(e.detail || 0) >= 2) {
          try {
            const nav = NAV();
            if (nav && typeof nav.openFocused === 'function') await nav.openFocused(side);
          } catch (e2) {}
        }
      });

      // Context menu (ПКМ)
      pd.list.addEventListener('contextmenu', (e) => {
        if (!e) return;
        if (!isFilesViewVisible()) return;

        try { if (FM.contextMenu && typeof FM.contextMenu.wireGlobal === 'function') FM.contextMenu.wireGlobal(); } catch (e0) {}

        const row = e.target && e.target.closest ? e.target.closest('.fm-row[data-name]') : null;
        const isHeader = !!(row && row.classList && row.classList.contains('fm-row-header'));
        const name = (!row || isHeader) ? '' : String(row.dataset.name || '');
        const isDir = !!(row && row.classList && row.classList.contains('is-dir'));

        try { if (st.setActiveSide) st.setActiveSide(side); } catch (e2) {}

        // When right-clicking an item: focus it; if it's not selected, make it the only selection.
        try {
          if (name) {
            if (!p.selected.has(name)) {
              const sel = SEL();
              if (sel && typeof sel.clearSelectionExcept === 'function') sel.clearSelectionExcept(side, name);
              try { p.selected.add(name); } catch (e4) {}
            }
            p.focusName = name;
            p.anchorName = name;
            const r = RENDER();
            if (r && typeof r.renderPanel === 'function') r.renderPanel(side);
          }
        } catch (e2) {}

        try { e.preventDefault(); e.stopPropagation(); } catch (e3) {}

        try {
          if (FM.contextMenu && typeof FM.contextMenu.show === 'function') {
            FM.contextMenu.show({
              side,
              hasRow: !!name,
              name,
              isDir,
              x: e.clientX,
              y: e.clientY,
            });
          }
        } catch (e4) {}
      }, true);

      pd.list.addEventListener('keydown', async (e) => {
        if (!e) return;
        if (e.key === 'ArrowDown') {
          try { e.preventDefault(); } catch (e2) {}
          try {
            const sel = SEL();
            const ok = sel && typeof sel.focusNext === 'function' ? !!sel.focusNext(side, +1) : false;
            if (ok) {
              const r = RENDER();
              if (r && typeof r.renderPanel === 'function') r.renderPanel(side);
            }
          } catch (e2) {}
        } else if (e.key === 'ArrowUp') {
          try { e.preventDefault(); } catch (e2) {}
          try {
            const sel = SEL();
            const ok = sel && typeof sel.focusNext === 'function' ? !!sel.focusNext(side, -1) : false;
            if (ok) {
              const r = RENDER();
              if (r && typeof r.renderPanel === 'function') r.renderPanel(side);
            }
          } catch (e2) {}
        } else if (e.key === 'Enter') {
          try { e.preventDefault(); } catch (e2) {}
          try {
            const nav = NAV();
            if (nav && typeof nav.openFocused === 'function') await nav.openFocused(side);
          } catch (e2) {}
        }
      });

      // Drag & Drop (moved to dragdrop.js)
      try {
        if (FM.dragdrop && typeof FM.dragdrop.attachDragDrop === 'function') {
          FM.dragdrop.attachDragDrop({ side, panelDom: pd });
        }
      } catch (e) {}
    }
  };
})();
