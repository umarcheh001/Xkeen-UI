(() => {
  'use strict';

  // File Manager selection helpers (visible selection, focus/anchor, mask)
  // attach to window.XKeen.features.fileManager.selection

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.features.fileManager = XKeen.features.fileManager || {};

  const FM = XKeen.features.fileManager;

  FM.selection = FM.selection || {};
  const SEL = FM.selection;

  const C = FM.common || {};

  function _S() {
    try { return (FM.state && FM.state.S) ? FM.state.S : null; } catch (e) { return null; }
  }

  function _panel(side) {
    try {
      const S = _S();
      if (!S || !S.panels) return null;
      return S.panels[side] || null;
    } catch (e) {
      return null;
    }
  }

  function safeName(s) {
    try { if (C && typeof C.safeName === 'function') return C.safeName(s); } catch (e) {}
    return String(s == null ? '' : s);
  }

  function visibleSortedItems(side) {
    try { if (FM.listModel && typeof FM.listModel.visibleSortedItems === 'function') return FM.listModel.visibleSortedItems(side); } catch (e) {}
    // minimal fallback
    const p = _panel(side);
    return p ? Array.from(p.items || []) : [];
  }

  function loadMaskPref() {
    try { if (FM.prefs && typeof FM.prefs.loadMaskPref === 'function') return FM.prefs.loadMaskPref() || ''; } catch (e) {}
    return '';
  }

  function saveMaskPref(v) {
    try { if (FM.prefs && typeof FM.prefs.saveMaskPref === 'function') FM.prefs.saveMaskPref(v); } catch (e) {}
  }


  function _updateFooterStatus() {
    try { if (FM.status && typeof FM.status.updateFooterStatus === 'function') FM.status.updateFooterStatus(); } catch (e) {}
  }

  function _syncSelectionUi(side) {
    // Prefer lightweight DOM sync when available; fallback to a full render.
    try {
      if (FM.render && typeof FM.render.applySelectionUi === 'function') {
        FM.render.applySelectionUi(side);
        return;
      }
    } catch (e) {}
    try {
      if (FM.render && typeof FM.render.renderPanel === 'function') {
        FM.render.renderPanel(side);
      }
    } catch (e2) {}
  }

  // -------------------------- visible selection --------------------------
  SEL.visibleNames = function visibleNames(side) {
    try {
      return visibleSortedItems(side).map((it) => safeName(it && it.name)).filter(Boolean);
    } catch (e) {
      return [];
    }
  };

  SEL.selectAllVisible = function selectAllVisible(side) {
    const p = _panel(side);
    if (!p) return 0;

    const names = SEL.visibleNames(side);
    try {
      if (!p.selected || typeof p.selected.add !== 'function') p.selected = new Set();
      if (typeof p.selected.clear === 'function') p.selected.clear();
    } catch (e) { p.selected = new Set(); }

    names.forEach((n) => p.selected.add(n));

    try {
      if (!p.focusName && names.length) p.focusName = names[0];
      p.anchorName = p.focusName || '';
    } catch (e) {}

    _updateFooterStatus();
    _syncSelectionUi(side);

    return names.length;
  };

  SEL.invertSelectionVisible = function invertSelectionVisible(side) {
    const p = _panel(side);
    if (!p) return 0;

    const names = SEL.visibleNames(side);
    if (!names.length) return 0;

    const next = new Set();
    try {
      const cur = p.selected ? Array.from(p.selected) : [];
      cur.forEach((x) => next.add(safeName(x)));
    } catch (e) {}

    names.forEach((n) => {
      if (next.has(n)) next.delete(n);
      else next.add(n);
    });

    p.selected = next;

    try {
      if (!p.focusName && names.length) p.focusName = names[0];
      p.anchorName = p.focusName || '';
    } catch (e) {}

    _updateFooterStatus();
    _syncSelectionUi(side);

    return next.size;
  };

  // -------------------------- focus / anchor helpers --------------------------
  SEL.getFocusedItem = function getFocusedItem(side) {
    const p = _panel(side);
    if (!p) return null;
    const name = p.focusName;
    if (!name) return null;
    try {
      return (p.items || []).find((it) => safeName(it && it.name) === name) || null;
    } catch (e) {
      return null;
    }
  };

  SEL.getSelectionNames = function getSelectionNames(side) {
    const p = _panel(side);
    if (!p) return [];
    try {
      const arr = Array.from(p.selected || []);
      if (arr.length) return arr.map((x) => safeName(x));
    } catch (e) {}
    const f = SEL.getFocusedItem(side);
    if (f && f.name) return [safeName(f.name)];
    return [];
  };

  SEL.clearSelectionExcept = function clearSelectionExcept(side, keepName) {
    const p = _panel(side);
    if (!p) return;

    try {
      if (!p.selected || typeof p.selected.clear !== 'function') p.selected = new Set();
      p.selected.clear();
      if (keepName) p.selected.add(safeName(keepName));
    } catch (e) {
      p.selected = new Set();
      if (keepName) p.selected.add(safeName(keepName));
    }

    try { p.anchorName = keepName ? safeName(keepName) : ''; } catch (e) {}

    _updateFooterStatus();
    _syncSelectionUi(side);
  };

  SEL.selectRange = function selectRange(side, fromName, toName, addToExisting) {
    const p = _panel(side);
    if (!p) return;

    const from = safeName(fromName || '');
    const to = safeName(toName || '');
    if (!from || !to) return;

    const items = visibleSortedItems(side);
    const names = items.map((it) => safeName(it && it.name));

    const a = names.indexOf(from);
    const b = names.indexOf(to);

    if (a < 0 || b < 0) {
      // Fallback: behave as a normal single selection.
      try {
        if (!addToExisting) {
          if (!p.selected || typeof p.selected.clear !== 'function') p.selected = new Set();
          p.selected.clear();
        }
        if (!p.selected || typeof p.selected.add !== 'function') p.selected = new Set();
        p.selected.add(to);
      } catch (e) {}
      _updateFooterStatus();
      _syncSelectionUi(side);
      return;
    }

    const i1 = Math.min(a, b);
    const i2 = Math.max(a, b);

    try {
      if (!addToExisting) {
        if (!p.selected || typeof p.selected.clear !== 'function') p.selected = new Set();
        p.selected.clear();
      }
      if (!p.selected || typeof p.selected.add !== 'function') p.selected = new Set();
      for (let i = i1; i <= i2; i++) {
        const nm = names[i];
        if (nm) p.selected.add(nm);
      }
    } catch (e) {}

    _updateFooterStatus();
    _syncSelectionUi(side);
  };

  SEL.setFocus = function setFocus(side, name) {
    const p = _panel(side);
    if (!p) return;
    try { p.focusName = safeName(name || ''); } catch (e) {}
  };

  SEL.focusNext = function focusNext(side, delta) {
    const p = _panel(side);
    if (!p || !p.items || !p.items.length) return false;

    const items = visibleSortedItems(side);
    if (!items.length) return false;

    let idx = -1;
    try { idx = items.findIndex((it) => safeName(it && it.name) === p.focusName); } catch (e) { idx = -1; }
    if (idx < 0) idx = 0;

    const nextIdx = Math.max(0, Math.min(items.length - 1, idx + Number(delta || 0)));
    const nextName = safeName(items[nextIdx] && items[nextIdx].name);
    if (!nextName) return false;

    p.focusName = nextName;
    return true;
  };

  // -------------------------- mask selection --------------------------
  function _globToRegExp(glob) {
    // Simple glob -> RegExp (supports *, ?). No path separators expected (names only).
    const g = String(glob || '').trim();
    if (!g) return null;
    const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    let rx = '';
    for (const ch of g) {
      if (ch === '*') rx += '.*';
      else if (ch === '?') rx += '.';
      else rx += esc(ch);
    }
    try { return new RegExp('^' + rx + '$', 'i'); } catch (e) { return null; }
  }

  function _splitMasks(text) {
    const s = String(text || '').trim();
    if (!s) return [];
    // Accept comma/semicolon/space separated masks (e.g. *.log,*.json)
    return s.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  }

  SEL.applySelectByMask = function applySelectByMask(side, maskText) {
    const p = _panel(side);
    if (!p) return { ok: false, error: 'no_panel' };

    const masks = _splitMasks(maskText);
    if (!masks.length) return { ok: false, error: 'empty_mask' };

    saveMaskPref(masks.join(' '));

    const regs = masks.map(_globToRegExp).filter(Boolean);
    if (!regs.length) return { ok: false, error: 'bad_mask' };

    const names = SEL.visibleNames(side);
    const matched = names.filter((n) => regs.some((r) => r.test(String(n))));

    try {
      if (!p.selected || typeof p.selected.clear !== 'function') p.selected = new Set();
      p.selected.clear();
      matched.forEach((n) => p.selected.add(n));
    } catch (e) {}

    if (matched.length) {
      try {
        // Keep focus on the first matched item for fast next actions.
        p.focusName = matched[0];
        p.anchorName = p.focusName || '';
      } catch (e) {}
    }

    _updateFooterStatus();
    _syncSelectionUi(side);
    return { ok: true, matched: matched.length, visible: names.length };
  };

  SEL.openMaskModal = function openMaskModal() {
    const S = _S();
    const side = (S && S.activeSide) ? S.activeSide : 'left';

    const modal = (C && typeof C.el === 'function') ? C.el('fm-mask-modal') : (document && document.getElementById ? document.getElementById('fm-mask-modal') : null);
    const inp = (C && typeof C.el === 'function') ? C.el('fm-mask-pattern') : (document && document.getElementById ? document.getElementById('fm-mask-pattern') : null);
    const err = (C && typeof C.el === 'function') ? C.el('fm-mask-error') : (document && document.getElementById ? document.getElementById('fm-mask-error') : null);

    if (!modal || !inp) {
      // Fallback (should rarely happen)
      const v = prompt('Выделить по маске (пример: *.log *.json):', loadMaskPref() || '*.log');
      if (v !== null) return { promptApplied: true, side, value: String(v) };
      return { promptApplied: false };
    }

    try { if (err) err.textContent = ''; } catch (e) {}
    try { inp.value = loadMaskPref() || '*.log'; } catch (e) {}
    try {
      if (C && typeof C.modalOpen === 'function') C.modalOpen(modal);
      else modal.classList.remove('hidden');
    } catch (e) {
      try { modal.classList.remove('hidden'); } catch (e2) {}
    }

    try { inp.focus(); inp.select(); } catch (e) {}
    return { opened: true };
  };

  // -------------------------- selection clipboard helpers --------------------------
  async function _copyText(text) {
    const t = String(text == null ? '' : text);
    try {
      if (FM.progress && typeof FM.progress.copyText === 'function') return await FM.progress.copyText(t);
    } catch (e) {}
    try {
      if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(t);
      }
    } catch (e) {}
  }

  SEL.copyFullPaths = function copyFullPaths(side) {
    const p = _panel(side);
    if (!p) return;

    const names = SEL.getSelectionNames(side);
    if (!names.length) {
      _copyText(String(p.cwd || ''));
      return;
    }

    const joinLocal = (C && typeof C.joinLocal === 'function') ? C.joinLocal : ((a, b) => String(a || '').replace(/\/+$/, '') + '/' + String(b || '').replace(/^\/+/, ''));
    const joinRemote = (C && typeof C.joinRemote === 'function') ? C.joinRemote : joinLocal;

    const full = names.map((nm) => (p.target === 'remote' ? joinRemote(p.cwd, nm) : joinLocal(p.cwd, nm)));
    _copyText(full.join('\n'));
  };

})();