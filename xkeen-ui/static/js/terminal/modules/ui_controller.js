// Terminal UI controller: binds buttons/hotkeys/menus and maps session events to UI.
// Stage 6: move UI wiring out of terminal.js.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  function createModule(ctx) {
    const ui = (ctx && ctx.ui) ? ctx.ui : null;
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, emit: () => {} };
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal._core || null);

    // Actions are exported by terminal.js (Stage 6) so UI stays dumb.
    const actions = (window.XKeen && window.XKeen.terminal && window.XKeen.terminal.ui_actions)
      ? window.XKeen.terminal.ui_actions
      : {};

    const state = {
      inited: false,
      disposables: [],
      // Persistent disposables survive terminal close.
      // Open buttons live outside the overlay and must keep working after закрыть.
      persistentDisposables: [],
      // menu fit observers
      menuFitInited: false,
    };

    function byId(id) {
      try { return ui && typeof ui.byId === 'function' ? ui.byId(id) : document.getElementById(id); } catch (e) {}
      return null;
    }

    function on(el, ev, fn, opts) {
      if (!el || !el.addEventListener) return;
      el.addEventListener(ev, fn, opts);
      state.disposables.push(() => {
        try { el.removeEventListener(ev, fn, opts); } catch (e) {}
      });
    }

    function onPersistent(el, ev, fn, opts) {
      if (!el || !el.addEventListener) return;
      el.addEventListener(ev, fn, opts);
      state.persistentDisposables.push(() => {
        try { el.removeEventListener(ev, fn, opts); } catch (e) {}
      });
    }

    function bindClickById(id, handler) {
      const el = byId(id);
      if (!el) return;
      on(el, 'click', (e) => {
        try { e.preventDefault(); } catch (e2) {}
        try { handler(e); } catch (e3) {}
      });
    }

    // Bind a click handler that must survive terminal close.
    // Uses a dataset guard so we don't double-bind on repeated init() calls.
    function bindPersistentClickById(id, handler) {
      const el = byId(id);
      if (!el) return;
      try {
        if (el.dataset && el.dataset.xkeenBoundPersistentClick === '1') return;
      } catch (e) {}
      try {
        if (el.dataset) el.dataset.xkeenBoundPersistentClick = '1';
      } catch (e2) {}
      onPersistent(el, 'click', (e) => {
        try { e.preventDefault(); } catch (e3) {}
        try { handler(e); } catch (e4) {}
      });
    }



    // --------------------
    // XTerm prefs (font size + cursor blink)
    // Stage 8.3.3: move xterm prefs + fit/apply out of terminal.js into UI controller + core xterm_manager.
    // --------------------
    function clampFontSize(raw, def) {
      const d = (def == null) ? 12 : def;
      const v = parseInt(String(raw == null ? d : raw), 10);
      if (isNaN(v)) return d;
      return Math.max(8, Math.min(32, v));
    }

    function readXtermPrefs() {
      let fontSize = 12;
      let cursorBlink = false;
      try {
        if (ctx && ctx.config && typeof ctx.config.get === 'function') {
          fontSize = clampFontSize(ctx.config.get('fontSize', 12), 12);
          cursorBlink = !!ctx.config.get('cursorBlink', false);
        }
      } catch (e) {}
      return { fontSize, cursorBlink };
    }

    function applyXtermPrefsUi(prefs) {
      const p = prefs || readXtermPrefs();
      const btnBlink = byId('terminal-btn-cursorblink');
      if (btnBlink) {
        try { btnBlink.classList.toggle('is-active', !!p.cursorBlink); } catch (e) {}
        try { btnBlink.title = p.cursorBlink ? 'Мигание курсора: ВКЛ' : 'Мигание курсора: ВЫКЛ'; } catch (e2) {}
      }

      const btnDec = byId('terminal-btn-font-dec');
      const btnInc = byId('terminal-btn-font-inc');
      if (btnDec) {
        try { btnDec.title = 'Шрифт − (сейчас ' + (p.fontSize || 12) + ')'; } catch (e3) {}
      }
      if (btnInc) {
        try { btnInc.title = 'Шрифт + (сейчас ' + (p.fontSize || 12) + ')'; } catch (e4) {}
      }
    }

    function applyXtermPrefsToTerm(prefs) {
      const p = prefs || readXtermPrefs();
      try {
        const mgr = (ctx && ctx.xterm && typeof ctx.xterm.getManager === 'function') ? ctx.xterm.getManager() : null;
        if (mgr && typeof mgr.applyPrefs === 'function') {
          mgr.applyPrefs({ fontSize: p.fontSize, cursorBlink: !!p.cursorBlink });
          return;
        }
      } catch (e) {}
      try { if (ctx && ctx.xterm && typeof ctx.xterm.fit === 'function') ctx.xterm.fit(); } catch (e2) {}
    }

    function fontInc() {
      const cur = readXtermPrefs();
      const next = Math.min(32, (cur.fontSize || 12) + 1);
      try { if (ctx && ctx.config && typeof ctx.config.set === 'function') ctx.config.set('fontSize', next); } catch (e) {}
      const p = { fontSize: next, cursorBlink: !!cur.cursorBlink };
      try { applyXtermPrefsUi(p); } catch (e2) {}
      try { applyXtermPrefsToTerm(p); } catch (e3) {}
      try { events && typeof events.emit === 'function' && events.emit('prefs:changed', { name: 'fontSize', value: next, scope: 'xterm' }); } catch (e4) {}
    }

    function fontDec() {
      const cur = readXtermPrefs();
      const next = Math.max(8, (cur.fontSize || 12) - 1);
      try { if (ctx && ctx.config && typeof ctx.config.set === 'function') ctx.config.set('fontSize', next); } catch (e) {}
      const p = { fontSize: next, cursorBlink: !!cur.cursorBlink };
      try { applyXtermPrefsUi(p); } catch (e2) {}
      try { applyXtermPrefsToTerm(p); } catch (e3) {}
      try { events && typeof events.emit === 'function' && events.emit('prefs:changed', { name: 'fontSize', value: next, scope: 'xterm' }); } catch (e4) {}
    }

    function toggleCursorBlink() {
      const cur = readXtermPrefs();
      const next = !cur.cursorBlink;
      try { if (ctx && ctx.config && typeof ctx.config.set === 'function') ctx.config.set('cursorBlink', next); } catch (e) {}
      const p = { fontSize: cur.fontSize || 12, cursorBlink: !!next };
      try { applyXtermPrefsUi(p); } catch (e2) {}
      try { applyXtermPrefsToTerm(p); } catch (e3) {}
      try { events && typeof events.emit === 'function' && events.emit('prefs:changed', { name: 'cursorBlink', value: !!next, scope: 'xterm' }); } catch (e4) {}
    }

    // Called by terminal.js when overlay is restored from "minimize" without a full reopen.
    function onOverlayShow() {
      try {
        const p = readXtermPrefs();
        applyXtermPrefsUi(p);
        applyXtermPrefsToTerm(p);
      } catch (e) {}
      // Extra safety: some browsers don't fire ResizeObserver on display:none->flex.
      try {
        if (ctx && ctx.xterm && typeof ctx.xterm.fit === 'function') {
          requestAnimationFrame(() => { try { ctx.xterm.fit(); } catch (e2) {} });
        }
      } catch (e3) {}
    }

    // --------------------
    // Grouped menus (overflow/view/buffer)
    // --------------------
    function hideMenu(id) {
      const m = byId(id);
      if (m) m.classList.add('hidden');
      return m;
    }
    function hideOverflowMenu() { hideMenu('terminal-overflow-menu'); }
    function hideViewMenu() { hideMenu('terminal-view-menu'); }
    function hideBufferMenu() { hideMenu('terminal-buffer-menu'); }
    function hideAllGroupedMenus() {
      hideOverflowMenu();
      hideViewMenu();
      hideBufferMenu();
    }

    function getWindowEl() {
      // Terminal lives in a modal-like overlay.
      try { return document.querySelector('.terminal-window'); } catch (e) {}
      return null;
    }

    function fitGroupedMenu(menuEl) {
      try {
        if (!menuEl || menuEl.classList.contains('hidden')) return;
        const winEl = getWindowEl();
        if (!winEl) return;

        const winRect = winEl.getBoundingClientRect();
        const menuRect = menuEl.getBoundingClientRect();

        const cs = window.getComputedStyle(menuEl);
        const hasBottom = cs && cs.bottom && cs.bottom !== 'auto';
        const hasTop = cs && cs.top && cs.top !== 'auto';
        const gap = 12;

        let maxH;
        if (hasBottom && !hasTop) {
          maxH = (menuRect.bottom - winRect.top) - gap;
        } else {
          maxH = (winRect.bottom - menuRect.top) - gap;
        }

        const hardMax = Math.max(0, (winRect.height - gap * 2));
        if (Number.isFinite(hardMax)) maxH = Math.min(maxH, hardMax);
        if (!Number.isFinite(maxH) || maxH <= 0) return;
        maxH = Math.max(80, Math.floor(maxH));
        menuEl.style.maxHeight = `${maxH}px`;
      } catch (e) {}
    }

    function refitOpenGroupedMenus() {
      try {
        ['terminal-overflow-menu', 'terminal-view-menu', 'terminal-buffer-menu'].forEach((id) => {
          const m = byId(id);
          if (m && !m.classList.contains('hidden')) fitGroupedMenu(m);
        });
      } catch (e) {}
    }

    function initMenuFitObservers() {
      if (state.menuFitInited) return;
      state.menuFitInited = true;

      // Re-fit on viewport resize.
      try {
        const fn = () => requestAnimationFrame(refitOpenGroupedMenus);
        on(window, 'resize', fn);
      } catch (e) {}

      // Re-fit when the terminal window is resized (ResizeObserver works for CSS resize).
      try {
        const winEl = getWindowEl();
        if (winEl && typeof ResizeObserver !== 'undefined') {
          const ro = new ResizeObserver(() => requestAnimationFrame(refitOpenGroupedMenus));
          ro.observe(winEl);
          state.disposables.push(() => {
            try { ro.disconnect(); } catch (e) {}
          });
        }
      } catch (e) {}
    }

    function toggleMenu(menuId, ev) {
      try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e) {}
      const m = byId(menuId);
      if (!m) return;

      const wasHidden = m.classList.contains('hidden');

      // Close other grouped menus before toggling this one.
      if (menuId !== 'terminal-overflow-menu') hideOverflowMenu();
      if (menuId !== 'terminal-view-menu') hideViewMenu();
      if (menuId !== 'terminal-buffer-menu') hideBufferMenu();

      m.classList.toggle('hidden');

      if (wasHidden && !m.classList.contains('hidden')) {
        try { initMenuFitObservers(); } catch (e) {}
        try { requestAnimationFrame(() => fitGroupedMenu(m)); } catch (e) {}
      } else if (!wasHidden && m.classList.contains('hidden')) {
        try { m.style.maxHeight = ''; } catch (e) {}
      }
    }

    function initGroupedMenusAutoClose() {
      // Close menus on outside click or Escape.
      on(document, 'click', () => hideAllGroupedMenus());
      on(document, 'keydown', (e) => {
        if (e && e.key === 'Escape') hideAllGroupedMenus();
      });

      // Prevent inside clicks from bubbling to the outside click handler.
      ['terminal-overflow-menu', 'terminal-view-menu', 'terminal-buffer-menu'].forEach((id) => {
        const m = byId(id);
        if (!m) return;
        on(m, 'click', (e) => {
          try { e.stopPropagation(); } catch (e2) {}
        });
      });

      // Auto-close view/buffer menus after action click.
      const viewM = byId('terminal-view-menu');
      if (viewM) {
        on(viewM, 'click', (e) => {
          const t = e && e.target;
          if (t && t.tagName === 'BUTTON') hideViewMenu();
        }, false);
      }

      const bufM = byId('terminal-buffer-menu');
      if (bufM) {
        on(bufM, 'click', (e) => {
          const t = e && e.target;
          if (t && t.tagName === 'BUTTON') hideBufferMenu();
        }, false);
      }

      // Overflow menu: close after most actions, but keep open for the Xray submenu toggle.
      const ov = byId('terminal-overflow-menu');
      if (ov) {
        on(ov, 'click', (e) => {
          const t = e && e.target;
          if (!t || t.tagName !== 'BUTTON') return;
          if (t.id === 'terminal-btn-xraylogs') return;
          setTimeout(() => hideOverflowMenu(), 0);
        }, false);
      }
    }

    function initMenuWheelFix() {
      const menuIds = ['terminal-overflow-menu', 'terminal-view-menu', 'terminal-buffer-menu'];
      menuIds.forEach((id) => {
        const menu = byId(id);
        if (!menu) return;
        try { if (!menu.hasAttribute('tabindex')) menu.setAttribute('tabindex', '-1'); } catch (e) {}




        on(menu, 'wheel', (e) => {
          try {
            const t = e && e.target;
            if (t && (t.tagName === 'SELECT' || (t.closest && t.closest('select')))) return;
            const canScroll = (menu.scrollHeight - menu.clientHeight) > 2;
            if (!canScroll) return;
            if (e.preventDefault) e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            let dy = e.deltaY || 0;
            if (e.deltaMode === 1) dy = dy * 16;
            if (e.deltaMode === 2) dy = dy * menu.clientHeight;
            menu.scrollTop += dy;
          } catch (e2) {}
        }, { passive: false });
      });
    }


    // --------------------
    // Overflow menu: collapsible sections (Session / Signals / Tools)
    // --------------------
    function initOverflowMenuCollapsibles() {
      const menu = byId('terminal-overflow-menu');
      if (!menu) return;
    
      const secs = menu.querySelectorAll('.terminal-menu-section[data-collapsible="1"]');
      secs.forEach((sec) => {
        const title = sec.querySelector('.terminal-menu-title');
        if (!title) return;
    
        // Accessibility: treat title like a button.
        try { title.setAttribute('role', 'button'); } catch (e2) {}
        try { if (!title.hasAttribute('tabindex')) title.setAttribute('tabindex', '0'); } catch (e3) {}
    
        const key = (() => {
          try {
            const k = sec.getAttribute('data-section');
            if (k) return 'xkeen.term.menu.' + String(k);
          } catch (e4) {}
          try {
            const t = (title.textContent || '').trim();
            if (t) return 'xkeen.term.menu.' + t;
          } catch (e5) {}
          return null;
        })();
    
        // Restore persisted state.
        try {
          if (key && window.localStorage) {
            const v = localStorage.getItem(key);
            if (v === 'collapsed') sec.classList.add('collapsed');
            else if (v === 'expanded') sec.classList.remove('collapsed');
          }
        } catch (e6) {}
    
        function apply() {
          const collapsed = sec.classList.contains('collapsed');
    
          try { title.setAttribute('aria-expanded', String(!collapsed)); } catch (e7) {}
    
          // Persist state.
          try {
            if (key && window.localStorage) {
              localStorage.setItem(key, collapsed ? 'collapsed' : 'expanded');
            }
          } catch (e8) {}
    
          // If the Tools section is collapsed while a nested submenu is open — close it.
          if (collapsed) {
            try {
              const nested = sec.querySelectorAll('[role="menu"]');
              nested.forEach((el) => {
                try { if (el && !el.classList.contains('hidden')) el.classList.add('hidden'); } catch (e9) {}
              });
            } catch (e10) {}
          }
    
          // Menu max-height fit may need recalculation after expand/collapse.
          try { requestAnimationFrame(refitOpenGroupedMenus); } catch (e11) {}
        }
    
        function toggle(ev) {
          try { ev && ev.preventDefault && ev.preventDefault(); } catch (e12) {}
          try { ev && ev.stopPropagation && ev.stopPropagation(); } catch (e13) {}
          try { sec.classList.toggle('collapsed'); } catch (e14) {}
          apply();
        }
    
        // Init + bind
        apply();
        on(title, 'click', toggle);
        on(title, 'keydown', (e) => {
          const k = e && e.key;
          if (k === 'Enter' || k === ' ') toggle(e);
        });
      });
    }
    
    // --------------------
    // Retry UI (Stop auto-retry button)
    // --------------------
    function getMode() {
      try {
        if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell';
      } catch (e) {}
      try {
        if (core && typeof core.getMode === 'function') return core.getMode() || 'shell';
      } catch (e2) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          return ctx.state.mode || 'shell';
        }
      } catch (e3) {}
      return 'shell';
    }

    function readRetryState() {
      try {
        if (ctx && ctx.session && typeof ctx.session.getRetryState === 'function') {
          return ctx.session.getRetryState() || { active: false, attempt: 0, nextAt: 0 };
        }
      } catch (e) {}
      try {
        const P = window.XKeen && window.XKeen.terminal ? window.XKeen.terminal.pty : null;
        if (P && typeof P.getRetryState === 'function') return P.getRetryState() || { active: false, attempt: 0, nextAt: 0 };
      } catch (e2) {}
      return { active: false, attempt: 0, nextAt: 0 };
    }

    function updateRetryUi() {
      const btn = byId('terminal-btn-stop-retry');
      if (!btn) return;

      const mode = getMode();
      const isPty = (mode === 'pty');

      const rs = readRetryState();
      const active = !!rs.active;
      const attempt = Number(rs.attempt || 0);
      const nextAt = Number(rs.nextAt || 0);

      const show = isPty && active;
      btn.style.display = show ? '' : 'none';

      if (show) {
        try {
          const msLeft = Math.max(0, nextAt - Date.now());
          const sLeft = Math.ceil(msLeft / 1000);
          btn.title = (sLeft > 0)
            ? `Остановить автоподключение (следующая попытка через ${sLeft}с, попытка ${attempt || 1})`
            : `Остановить автоподключение (попытка ${attempt || 1})`;
        } catch (e) {
          btn.title = 'Остановить автоподключение';
        }
      } else {
        btn.title = 'Остановить автоподключение';
      }
    }

    // --------------------
    // Connection status (moved to modules/status_controller.js)
    // --------------------
    function setConnState(connState, detail) {
      // Preferred: delegate to status controller.
      try {
        const sc = (ctx && (ctx.statusCtrl || ctx.status)) ? (ctx.statusCtrl || ctx.status) : null;
        if (sc && typeof sc.setConnState === 'function') {
          sc.setConnState(String(connState || 'error'), detail);
          return;
        }
      } catch (e0) {}

      // Fallback: legacy core implementation.
      try {
        if (core && typeof core.setConnState === 'function') {
          core.setConnState(String(connState || 'error'), detail);
          return;
        }
      } catch (e) {}

      // Last resort: best-effort lamp update.
      try {
        const lamp = byId('terminal-conn-lamp');
        if (!lamp) return;
        const map = { connected: 'running', connecting: 'pending', disconnected: 'stopped', error: 'error' };
        lamp.setAttribute('data-state', map[String(connState || 'error')] || 'error');
        lamp.title = String(detail || 'Terminal');
      } catch (e2) {}
    }

    // Keep retry UI in sync with session/pty retry state.
    function bindRetryToEvents() {
      const off1 = events.on('session:retry', () => { try { updateRetryUi(); } catch (e) {} });
      const off2 = events.on('pty:retry', () => { try { updateRetryUi(); } catch (e) {} });
      const off3 = events.on('session:modeChanged', () => { try { updateRetryUi(); } catch (e) {} });
      [off1, off2, off3].forEach((off) => {
        if (typeof off === 'function') state.disposables.push(off);
      });
    }

    // --------------------
    // Hotkeys / inputs
    // --------------------
    function bindHotkeys() {
      const cmdEl = byId('terminal-command');
      if (cmdEl) {
        on(cmdEl, 'keydown', (e) => {
          if (!e) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            try {
              if (typeof actions.sendTerminalInput === 'function') { void actions.sendTerminalInput(); return; }
              if (ctx && ctx.input && typeof ctx.input.submitFromUi === 'function') { void ctx.input.submitFromUi(); return; }
            } catch (e2) {}
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            try {
              if (typeof actions.hideTerminal === 'function') actions.hideTerminal();
              else if (window.XKeen && window.XKeen.terminal && typeof window.XKeen.terminal.close === 'function') window.XKeen.terminal.close();
            } catch (e3) {}
            return;
          }
          if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
            e.preventDefault();
            try {
              if (typeof actions.hotkeyClear === 'function') actions.hotkeyClear();
              else if (typeof actions.terminalClear === 'function') actions.terminalClear();
            } catch (e4) {}
          }
        });
      }

      // Confirmation input: Enter sends stdin.
      const stdin = byId('terminal-input');
      if (stdin) {
        on(stdin, 'keydown', (e) => {
          if (e && e.key === 'Enter') {
            e.preventDefault();
            try {
              if (typeof actions.sendTerminalInput === 'function') { void actions.sendTerminalInput(); return; }
              if (ctx && ctx.input && typeof ctx.input.submitFromUi === 'function') { void ctx.input.submitFromUi(); return; }
            } catch (e2) {}
          }
        });
      }
    }

    // --------------------
    // Button bindings
    // --------------------
    function bindButtons() {
      // Open terminal from Commands view
      bindPersistentClickById('terminal-open-shell-btn', () => {
        if (typeof actions.openTerminal === 'function') actions.openTerminal('', 'shell');
        else if (window.XKeen && window.XKeen.terminal && typeof window.XKeen.terminal.open === 'function') window.XKeen.terminal.open(null, { mode: 'shell', cmd: '' });
      });
      bindPersistentClickById('terminal-open-pty-btn', () => {
        if (typeof actions.openTerminal === 'function') actions.openTerminal('', 'pty');
        else if (window.XKeen && window.XKeen.terminal && typeof window.XKeen.terminal.open === 'function') window.XKeen.terminal.open(null, { mode: 'pty', cmd: '' });
      });

      // Overlay chrome
      bindClickById('terminal-btn-close', () => {
        if (typeof actions.hideTerminal === 'function') actions.hideTerminal();
        else if (window.XKeen && window.XKeen.terminal && typeof window.XKeen.terminal.close === 'function') window.XKeen.terminal.close();
      });

      // Toolbar
      bindClickById('terminal-btn-fullscreen', () => { try { actions.terminalToggleFullscreen && actions.terminalToggleFullscreen(); } catch (e) {} });
      bindClickById('terminal-btn-overflow', (e) => { toggleMenu('terminal-overflow-menu', e); });
      bindClickById('terminal-btn-reconnect', () => { try { actions.terminalReconnect && actions.terminalReconnect(); } catch (e) {} });
      bindClickById('terminal-btn-stop-retry', () => { try { actions.terminalStopRetry && actions.terminalStopRetry(); } catch (e) {} });
      bindClickById('terminal-btn-new-session', () => { try { actions.terminalNewSession && actions.terminalNewSession(); } catch (e) {} });
      bindClickById('terminal-btn-ctrlc', () => { try { actions.terminalSendCtrlC && actions.terminalSendCtrlC(); } catch (e) {} });
      bindClickById('terminal-btn-ctrld', () => { try { actions.terminalSendCtrlD && actions.terminalSendCtrlD(); } catch (e) {} });
      bindClickById('terminal-btn-minimize', () => { try { actions.terminalMinimize && actions.terminalMinimize(); } catch (e) {} });
      bindClickById('terminal-btn-detach', () => { try { actions.terminalDetach && actions.terminalDetach(); } catch (e) {} });
      bindClickById('terminal-btn-kill', () => { try { actions.terminalKillSession && actions.terminalKillSession(); } catch (e) {} });
      bindClickById('terminal-btn-retry-now', () => { try { actions.terminalRetryNow && actions.terminalRetryNow(); } catch (e) {} });

      // Signals (SIG*) buttons (inside overflow menu)
      try {
        const ov = byId('terminal-overlay');
        if (ov) {
          ov.querySelectorAll('[data-terminal-signal]').forEach((btn) => {
            on(btn, 'click', (e) => {
              try { e.preventDefault(); } catch (e2) {}
              const sig = btn.getAttribute('data-terminal-signal');
              if (!sig) return;
              try { actions.terminalSendSignal && actions.terminalSendSignal(sig); } catch (e3) {}
            });
          });
        }
      } catch (e) {}

      // View/buffer menus
      bindClickById('terminal-btn-view-menu', (e) => { toggleMenu('terminal-view-menu', e); });
      bindClickById('terminal-btn-buffer-menu', (e) => { toggleMenu('terminal-buffer-menu', e); });

      // View settings
      bindClickById('terminal-btn-font-dec', () => { try { fontDec(); } catch (e) {} });
      bindClickById('terminal-btn-font-inc', () => { try { fontInc(); } catch (e) {} });
      bindClickById('terminal-btn-cursorblink', () => { try { toggleCursorBlink(); } catch (e) {} });
      bindClickById('terminal-btn-ansi', () => { try { actions.terminalToggleAnsiFilter && actions.terminalToggleAnsiFilter(); } catch (e) {} });
      bindClickById('terminal-btn-loghl', () => { try { actions.terminalToggleLogHighlight && actions.terminalToggleLogHighlight(); } catch (e) {} });
      bindClickById('terminal-btn-follow', () => { try { actions.terminalToggleFollow && actions.terminalToggleFollow(); } catch (e) {} });
      bindClickById('terminal-btn-bottom', () => { try { actions.terminalScrollToBottom && actions.terminalScrollToBottom(); } catch (e) {} });

      // Buffer actions
      bindClickById('terminal-btn-copy', () => { try { actions.terminalCopy && actions.terminalCopy(); } catch (e) {} });
      bindClickById('terminal-btn-copyall', () => { try { actions.terminalCopyAll && actions.terminalCopyAll(); } catch (e) {} });
      bindClickById('terminal-btn-download', () => { try { actions.terminalDownloadOutput && actions.terminalDownloadOutput(); } catch (e) {} });
      bindClickById('terminal-btn-download-html', () => { try { actions.terminalDownloadHtml && actions.terminalDownloadHtml(); } catch (e) {} });
      bindClickById('terminal-btn-snapshot-vt', () => { try { actions.terminalDownloadVtSnapshot && actions.terminalDownloadVtSnapshot(); } catch (e) {} });
      bindClickById('terminal-btn-paste', () => { try { actions.terminalPaste && actions.terminalPaste(); } catch (e) {} });
      bindClickById('terminal-btn-clear', () => { try { actions.terminalClear && actions.terminalClear(); } catch (e) {} });

      // Confirmation send
      bindClickById('terminal-send-btn', () => {
        try {
          if (typeof actions.sendTerminalInput === 'function') { void actions.sendTerminalInput(); return; }
          if (ctx && ctx.input && typeof ctx.input.submitFromUi === 'function') { void ctx.input.submitFromUi(); return; }
        } catch (e) {}
      });
    }

    function init() {
      if (state.inited) return;
      state.inited = true;

      // Stage 7: allow "clean" commands to show toast via ctx.events
      try {
        if (events && typeof events.on === 'function') {
          const off = events.on('ui:toast', (p) => {
            try {
              const msg = (p && typeof p === 'object') ? (p.msg || p.message || '') : String(p || '');
              const kind = (p && typeof p === 'object') ? (p.kind || p.type || 'info') : 'info';
              if (ui && typeof ui.toast === 'function') ui.toast(msg, kind);
            } catch (e) {}
          });
          if (typeof off === 'function') state.disposables.push(off);
        }
      } catch (e0) {}

      // Menus
      initGroupedMenusAutoClose();
      initMenuWheelFix();


      // Collapsible overflow sections (Session / Signals / Tools)
      initOverflowMenuCollapsibles();
      // Buttons and hotkeys
      bindButtons();
      bindHotkeys();

      // Retry UI bindings
      bindRetryToEvents();

      // XTerm prefs: reflect persisted settings in the view menu and apply them to the terminal
      try { const p = readXtermPrefs(); applyXtermPrefsUi(p); applyXtermPrefsToTerm(p); } catch (e) {}

      // XTerm fit on viewport resize (extra safety; core manager also has ResizeObserver)
      try {
        on(window, 'resize', () => {
          try { requestAnimationFrame(() => { try { ctx && ctx.xterm && typeof ctx.xterm.fit === 'function' && ctx.xterm.fit(); } catch (e2) {} }); } catch (e1) {}
        });
      } catch (e3) {}


      // Initial retry UI
      try { updateRetryUi(); } catch (e) {}
    }

    function dispose() {
      const arr = state.disposables.splice(0, state.disposables.length);
      arr.forEach((d) => { try { if (typeof d === 'function') d(); } catch (e) {} });
      state.inited = false;
    }

    const api = {
      init,
      dispose,
      // minimal API for terminal.js wrappers
      setConnState,
      updateRetryUi,
      hideAllGroupedMenus,
      toggleMenu,
      // Stage 8.3.3: xterm prefs actions
      fontInc,
      fontDec,
      toggleCursorBlink,
      applyXtermPrefsUi: () => { try { applyXtermPrefsUi(readXtermPrefs()); } catch (e) {} },
      onOverlayShow,
    };

    // Expose instance on ctx for legacy wrappers.
    try { if (ctx) ctx.uiCtrl = api; } catch (e) {}

    // Registry plugin wrapper: make sure we properly clean up listeners on close,
    // and re-bind them on the next open (terminal.js calls registry.onOpen()/onClose()).
    return {
      id: 'ui_controller',
      priority: 40,
      init: () => { try { api.init(); } catch (e) {} },
      onOpen: () => { try { api.init(); } catch (e) {} },
      onClose: () => { try { api.dispose(); } catch (e) {} },

      // Expose the UI API for terminal.js and other modules.
      setConnState: api.setConnState,
      updateRetryUi: api.updateRetryUi,
      hideAllGroupedMenus: api.hideAllGroupedMenus,
      toggleMenu: api.toggleMenu,

      // XTerm prefs
      fontInc: api.fontInc,
      fontDec: api.fontDec,
      toggleCursorBlink: api.toggleCursorBlink,
      applyXtermPrefsUi: api.applyXtermPrefsUi,
      onOverlayShow: api.onOverlayShow,
    };
  }

  window.XKeen.terminal.ui_controller = { createModule };
})();
