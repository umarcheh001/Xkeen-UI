// Builtin command: `xkeen -restart` (Stage 7)
//
// Requirements:
//   - run(ctx, args) only (no DOM, no direct globals)
//   - UI interactions go through ctx.events (term:print / ui:toast)
//
// Backend endpoints:
//   POST /api/restart
//   GET  /api/restart-log
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.commands = window.XKeen.terminal.commands || {};
  window.XKeen.terminal.commands.builtins = window.XKeen.terminal.commands.builtins || {};

  const CMD_ID = 'xkeen_restart';
  const CMD_RE = /^xkeen\s+-restart(\s|$)/;

  function emitPrint(ctx, text) {
    const chunk = String(text == null ? '' : text);
    try {
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit('term:print', { chunk: chunk, source: 'builtin' });
        return true;
      }
    } catch (e) {}
    // Best-effort fallback (do not touch DOM)
    try { console.log('[terminal]', chunk); } catch (e2) {}
    return false;
  }

  function emitToast(ctx, msg, kind) {
    try {
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit('ui:toast', { msg: String(msg || ''), kind: kind || 'info' });
        return;
      }
    } catch (e) {}
  }

  async function fetchRestartLog(ctx) {
    // Prefer ctx.api when present (single place for fetch wrappers)
    try {
      if (ctx && ctx.api && typeof ctx.api.apiFetch === 'function') {
        const r = await ctx.api.apiFetch('/api/restart-log', { cache: 'no-store' });
        const data = r && r.data ? r.data : {};
        const lines = Array.isArray(data.lines) ? data.lines : [];
        return { ok: true, lines };
      }
    } catch (e) {}

    // Fallback to direct fetch (still not DOM-related)
    try {
      const res = await fetch('/api/restart-log', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const lines = Array.isArray(data && data.lines) ? data.lines : [];
      return { ok: true, lines };
    } catch (e2) {
      return { ok: false, lines: ['Не удалось загрузить журнал перезапуска.'], error: e2 };
    }
  }

  async function run(ctx /*, args */) {
    emitPrint(ctx, '');
    emitPrint(ctx, '[xkeen] Перезапуск...');

    try {
      // Prefer ctx.api wrapper
      if (ctx && ctx.api && typeof ctx.api.apiFetch === 'function') {
        await ctx.api.apiFetch('/api/restart', { method: 'POST' });
      } else {
        await fetch('/api/restart', { method: 'POST', credentials: 'same-origin' });
      }
    } catch (e) {
      emitToast(ctx, 'Ошибка при перезапуске', 'error');
      emitPrint(ctx, '[Ошибка] Не удалось выполнить /api/restart');
      return { ok: false, error: e };
    }

    const r = await fetchRestartLog(ctx);
    const lines = Array.isArray(r.lines) ? r.lines : [];

    emitPrint(ctx, '');
    if (!lines.length) {
      emitPrint(ctx, '(журнал пуст)');
    } else {
      for (const ln of lines) emitPrint(ctx, String(ln || '').replace(/\r?\n$/, ''));
    }
    return { ok: true, lines };
  }

  // Stage 7 command definition (for commands/registry.js)
  const commandDef = {
    id: CMD_ID,
    matcher: CMD_RE,
    priority: 10,
    run,
  };

  // Registration helpers
  function register(registryOrRouter) {
    const target = registryOrRouter;
    if (!target) return;

    // Preferred: registry.register(commandDef)
    if (typeof target.register === 'function' && typeof target.bindToRouter === 'function') {
      try { target.register(commandDef); } catch (e) {}
      return;
    }

    // Backward compatibility: direct router.register(...)
    if (typeof target.register === 'function') {
      try {
        target.register(CMD_RE, async ({ ctx }) => run(ctx, {}), { name: CMD_ID, priority: 10 });
      } catch (e) {}
    }
  }

  window.XKeen.terminal.commands.builtins.xkeen_restart = commandDef;
  window.XKeen.terminal.commands.builtins.registerXkeenRestart = register;
})();
