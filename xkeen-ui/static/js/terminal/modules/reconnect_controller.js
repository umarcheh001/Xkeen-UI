// Terminal module: reconnect controller (auto-retry/backoff)
// Stage 8.3.1: move reconnect policy/timers out of terminal.js / pty.js
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};

  const DEFAULT_CFG = {
    baseMs: 800,
    factor: 1.8,
    maxMs: 20000,
    jitter: 0.15,
    // 0 = unlimited
    maxAttempts: 0,
  };

  function clamp(n, lo, hi) {
    const x = Number(n);
    if (!Number.isFinite(x)) return lo;
    return Math.min(hi, Math.max(lo, x));
  }

  function safeEmit(events, name, payload) {
    try { if (events && typeof events.emit === 'function') events.emit(String(name || ''), payload); } catch (e) {}
  }

  function safeOn(events, name, fn) {
    try { return events && typeof events.on === 'function' ? events.on(String(name || ''), fn) : (() => {}); } catch (e) { return () => {}; }
  }

  function computeDelay(cfg, attempt) {
    const base = Math.max(100, Number(cfg.baseMs || DEFAULT_CFG.baseMs) || DEFAULT_CFG.baseMs);
    const factor = Math.max(1.1, Number(cfg.factor || DEFAULT_CFG.factor) || DEFAULT_CFG.factor);
    const cap = Math.max(base, Number(cfg.maxMs || DEFAULT_CFG.maxMs) || DEFAULT_CFG.maxMs);
    const jitter = clamp(cfg.jitter != null ? cfg.jitter : DEFAULT_CFG.jitter, 0, 0.5);

    let delay = Math.floor(base * (factor ** Math.max(0, (attempt || 1) - 1)));
    delay = Math.min(cap, Math.max(100, delay));
    if (jitter > 0) {
      const r = (Math.random() * 2 - 1) * jitter;
      delay = Math.max(100, Math.floor(delay * (1 + r)));
    }
    return delay;
  }

  function createController(ctx) {
    const events = (ctx && ctx.events) ? ctx.events : { on: () => () => {}, emit: () => {} };
    const core = (ctx && ctx.core) ? ctx.core : (window.XKeen.terminal ? window.XKeen.terminal._core : null);

    const cfg = Object.assign({}, DEFAULT_CFG);

    const st = {
      active: false,
      blocked: false,
      attempt: 0,
      nextAt: 0,
      lastReason: '',
      timer: null,
      // teardown
      disposables: [],
    };

    function getMode() {
      try { if (ctx && ctx.session && typeof ctx.session.getMode === 'function') return ctx.session.getMode() || 'shell'; } catch (e) {}
      try { if (core && typeof core.getMode === 'function') return core.getMode() || 'shell'; } catch (e2) {}
      try {
        if (ctx && ctx.state) {
          if (typeof ctx.state.get === 'function') return ctx.state.get('mode') || 'shell';
          return ctx.state.mode || 'shell';
        }
      } catch (e3) {}
      return 'shell';
    }

    function isOverlayOpen() {
      try {
        // Stage 8.3.4: prefer overlay_controller (ctx.overlay)
        const oc = ctx ? (ctx.overlay || ctx.overlayCtrl) : null;
        if (oc && typeof oc.isOpen === 'function') return !!oc.isOpen();
      } catch (e) {}
      try {
        const oc2 = (window.XKeen && window.XKeen.terminal) ? window.XKeen.terminal.overlay : null;
        if (oc2 && typeof oc2.isOpen === 'function') return !!oc2.isOpen();
      } catch (e0) {}
      try {
        if (core && typeof core.terminalIsOverlayOpen === 'function') return !!core.terminalIsOverlayOpen();
      } catch (e1) {}
      try {
        const el = ctx && ctx.dom ? (ctx.dom.overlay || null) : null;
        if (!el) return true;
        const cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        if (!cs) return true;
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        return true;
      } catch (e2) {}
      return true;
    }

    function isConnected() {
      try { return !!(ctx && ctx.session && typeof ctx.session.isConnected === 'function' && ctx.session.isConnected()); } catch (e) {}
      return false;
    }

    function clearTimer() {
      if (st.timer) {
        try { clearTimeout(st.timer); } catch (e) {}
        st.timer = null;
      }
      st.nextAt = 0;
    }

    function publish(extra) {
      const payload = Object.assign({
        active: !!st.active,
        blocked: !!st.blocked,
        attempt: Number(st.attempt || 0),
        nextAt: Number(st.nextAt || 0),
        reason: String(st.lastReason || ''),
      }, extra || {});

      // Keep legacy listeners working: emit pty:retry (context.js will mirror to session:retry)
      safeEmit(events, 'pty:retry', payload);
    }

    function getRetryState() {
      return {
        active: !!st.active,
        blocked: !!st.blocked,
        attempt: Number(st.attempt || 0),
        nextAt: Number(st.nextAt || 0),
        reason: String(st.lastReason || ''),
      };
    }

    function resetRetry(opts) {
      const o = opts || {};
      clearTimer();
      st.active = false;
      st.attempt = 0;
      st.lastReason = '';
      if (o && o.unblock) st.blocked = false;
      publish({ reason: 'reset' });
    }

    function stopRetry(opts) {
      const o = opts || {};
      clearTimer();
      st.active = false;
      st.lastReason = String(o.reason || st.lastReason || 'stopped');
      // Stop means user requested: keep it blocked until manual trigger.
      st.blocked = true;
      publish({ reason: st.lastReason || 'stopped' });

      if (!o.silent) {
        try {
          const refs = (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') ? (ctx.xterm.getRefs() || {}) : {};
          const term = refs.term || refs.xterm || null;
          if (term && typeof term.writeln === 'function') term.writeln('\r\n[PTY] Auto-retry stopped.');
        } catch (e) {}
      }
    }

    function canAutoRetry(reason) {
      if (st.blocked) return false;
      if (!isOverlayOpen()) return false;
      if (getMode() !== 'pty') return false;
      // If already connected, no retry.
      if (isConnected()) return false;

      // Ignore known intentional disconnect reasons.
      const r = String(reason || '').toLowerCase();
      const ignore = {
        disconnect: true,
        modechange: true,
        lite: true,
        exit: true,
        disconnect_fallback: true,
        connectprep: true,
      };
      if (ignore[r]) return false;
      return true;
    }

    function triggerReconnect(opts) {
      const o = opts || {};
      if (!ctx || !ctx.session) return;
      // Ensure PTY mode and try reconnect.
      try {
        if (typeof ctx.session.reconnect === 'function') {
          ctx.session.reconnect({ preserveScreen: true });
          return;
        }
      } catch (e) {}
      try {
        if (typeof ctx.session.connect === 'function') {
          ctx.session.connect({ mode: 'pty', preserveScreen: true });
        }
      } catch (e2) {}

      // Mark as manual when requested.
      if (o && o.manual) publish({ manual: true });
    }

    function scheduleRetry(reason, opts) {
      const o = opts || {};
      const r = String(reason || o.reason || '');

      if (!o.force && !canAutoRetry(r)) return;

      if (st.timer) {
        // Already scheduled.
        st.active = true;
        st.lastReason = r;
        publish({ reason: r });
        return;
      }

      const maxAttempts = (o.maxAttempts != null) ? Number(o.maxAttempts) : Number(cfg.maxAttempts || 0);
      if (Number.isFinite(maxAttempts) && maxAttempts > 0 && (st.attempt || 0) >= maxAttempts) {
        st.active = false;
        st.lastReason = 'maxAttempts';
        publish({ reason: 'maxAttempts' });
        return;
      }

      st.active = true;
      st.lastReason = r;
      st.attempt = (st.attempt || 0) + 1;

      const delay = computeDelay(Object.assign({}, cfg, o.cfg || {}), st.attempt);
      st.nextAt = Date.now() + delay;

      publish({
        reason: r,
        delayMs: Number(delay || 0),
        nextAt: Number(st.nextAt || 0),
      });

      // Optional: print to xterm (legacy behavior)
      if (!o.silent) {
        try {
          const refs = (ctx && ctx.xterm && typeof ctx.xterm.getRefs === 'function') ? (ctx.xterm.getRefs() || {}) : {};
          const term = refs.term || refs.xterm || null;
          if (term) {
            const sec = (delay / 1000).toFixed(1);
            const msg = `\r\n[PTY] Auto-retry in ${sec}s (attempt ${st.attempt})${r ? ' — ' + r : ''}`;
            if (typeof term.writeln === 'function') term.writeln(msg);
            else if (typeof term.write === 'function') term.write(msg + '\r\n');
          }
        } catch (e) {}
      }

      st.timer = setTimeout(() => {
        st.timer = null;
        st.nextAt = 0;
        publish({ reason: r, nextAt: 0 });

        if (st.blocked) return;
        if (!o.force && !canAutoRetry(r)) return;
        triggerReconnect({ manual: false });
      }, delay);
    }

    function retryNow() {
      // Manual trigger: unblocks and reconnects immediately.
      st.blocked = false;
      clearTimer();
      st.active = true;
      publish({ manual: true, reason: 'manual' });
      triggerReconnect({ manual: true });
    }

    function applyCfg(nextCfg) {
      if (!nextCfg || typeof nextCfg !== 'object') return;
      try {
        if (nextCfg.baseMs != null) cfg.baseMs = Number(nextCfg.baseMs);
        if (nextCfg.factor != null) cfg.factor = Number(nextCfg.factor);
        if (nextCfg.maxMs != null) cfg.maxMs = Number(nextCfg.maxMs);
        if (nextCfg.jitter != null) cfg.jitter = Number(nextCfg.jitter);
        if (nextCfg.maxAttempts != null) cfg.maxAttempts = Number(nextCfg.maxAttempts);
      } catch (e) {}
    }

    // --------------------
    // Event wiring
    // --------------------
    function onSessionConnected() {
      // Successful connect resets attempts and unblocks.
      resetRetry({ unblock: true });
    }

    function onSessionDisconnected(p) {
      const reason = p && p.reason ? String(p.reason) : 'disconnected';

      // Always clear pending timers on any disconnect event.
      const r0 = String(reason || '').toLowerCase();

      // Server-side exit: stop retry and keep it blocked until manual action.
      if (r0 === 'exit') {
        stopRetry({ silent: true, reason: 'exit' });
        return;
      }

      // Intentional disconnects: never schedule auto-retry.
      const intentional = {
        disconnect: true,
        modechange: true,
        lite: true,
        disconnect_fallback: true,
        connectprep: true,
      };
      if (intentional[r0]) {
        clearTimer();
        st.active = false;
        st.lastReason = reason;
        publish({ reason: r0 });
        return;
      }

      // If overlay is closed or mode changed, pause without scheduling.
      if (!isOverlayOpen() || getMode() !== 'pty') {
        clearTimer();
        st.active = false;
        st.lastReason = 'paused';
        publish({ reason: 'paused' });
        return;
      }

      scheduleRetry(reason, { silent: false });
    }

    function onSessionError(p) {
      const msg = p && (p.message || p.detail) ? String(p.message || p.detail) : 'error';
      const m = String(msg || '').toLowerCase();
      // Don't retry on clearly permanent errors.
      if (m.indexOf('unsupported') >= 0) return;
      if (m.indexOf('xterm missing') >= 0) return;
      if (m.indexOf('pty.js missing') >= 0) return;
      scheduleRetry(msg, { silent: false });
    }

    function onModeChanged(p) {
      const mode = p && p.mode ? String(p.mode) : (p && p.to ? String(p.to) : '');
      if (mode && mode !== 'pty') {
        // Leaving PTY: stop timers but do not permanently block.
        clearTimer();
        st.active = false;
        st.lastReason = 'modeChange';
        publish({ reason: 'modeChange' });
      }
    }

    // Subscriptions
    st.disposables.push(safeOn(events, 'session:connected', onSessionConnected));
    st.disposables.push(safeOn(events, 'session:disconnected', onSessionDisconnected));
    st.disposables.push(safeOn(events, 'session:error', onSessionError));
    st.disposables.push(safeOn(events, 'session:modeChanged', onModeChanged));

    // Commands via event bus
    st.disposables.push(safeOn(events, 'reconnect:trigger', () => { retryNow(); }));
    st.disposables.push(safeOn(events, 'reconnect:stop', () => { stopRetry({}); }));

    const api = {
      id: 'reconnect_controller',
      // state/config
      getRetryState,
      applyCfg,
      // actions
      resetRetry,
      stopRetry,
      scheduleRetry,
      retryNow,
      // internal
      _clearTimer: clearTimer,
    };

    return api;
  }

  function createModule(ctx) {
    const id = 'reconnect_controller';

    // Singleton per ctx.
    if (ctx && ctx.reconnect && typeof ctx.reconnect.getRetryState === 'function') {
      return {
        id,
        priority: 35,
        init: () => {},
        onClose: () => { try { ctx.reconnect._clearTimer && ctx.reconnect._clearTimer(); } catch (e) {} },
      };
    }

    const controller = createController(ctx);
    try { if (ctx) ctx.reconnect = controller; } catch (e) {}
    try { window.XKeen.terminal.reconnect = controller; } catch (e2) {}

    return {
      id,
      priority: 35,
      init: () => {
        // no-op; controller is created eagerly
      },
      onClose: () => {
        // When overlay closes, drop pending timers.
        try { controller._clearTimer && controller._clearTimer(); } catch (e) {}
      },
    };
  }

  window.XKeen.terminal.reconnect_controller = {
    createModule,
    createController,
  };
})();
