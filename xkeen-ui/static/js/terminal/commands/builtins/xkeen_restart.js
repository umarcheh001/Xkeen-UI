import { publishTerminalBuiltinCommandCompatApi } from '../../runtime.js';

// Builtin command: `xkeen -restart` (Stage 7)
(function () {
  'use strict';

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
    try { console.log('[terminal]', chunk); } catch (e2) {}
    return false;
  }

  function emitToast(ctx, msg, kind) {
    try {
      if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
        ctx.events.emit('ui:toast', { msg: String(msg || ''), kind: kind || 'info' });
      }
    } catch (e) {}
  }

  async function fetchRestartLog(ctx) {
    try {
      if (ctx && ctx.api && typeof ctx.api.apiFetch === 'function') {
        const r = await ctx.api.apiFetch('/api/restart-log', { cache: 'no-store' });
        const data = r && r.data ? r.data : {};
        const lines = Array.isArray(data.lines) ? data.lines : [];
        return { ok: true, lines };
      }
    } catch (e) {}

    try {
      const res = await fetch('/api/restart-log', { cache: 'no-store', credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      const lines = Array.isArray(data && data.lines) ? data.lines : [];
      return { ok: true, lines };
    } catch (e2) {
      return { ok: false, lines: ['РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РіСЂСѓР·РёС‚СЊ Р¶СѓСЂРЅР°Р» РїРµСЂРµР·Р°РїСѓСЃРєР°.'], error: e2 };
    }
  }

  async function run(ctx) {
    emitPrint(ctx, '');
    emitPrint(ctx, '[xkeen] РџРµСЂРµР·Р°РїСѓСЃРє...');

    try {
      if (ctx && ctx.api && typeof ctx.api.apiFetch === 'function') {
        await ctx.api.apiFetch('/api/restart', { method: 'POST' });
      } else {
        await fetch('/api/restart', { method: 'POST', credentials: 'same-origin' });
      }
    } catch (e) {
      emitToast(ctx, 'РћС€РёР±РєР° РїСЂРё РїРµСЂРµР·Р°РїСѓСЃРєРµ', 'error');
      emitPrint(ctx, '[РћС€РёР±РєР°] РќРµ СѓРґР°Р»РѕСЃСЊ РІС‹РїРѕР»РЅРёС‚СЊ /api/restart');
      return { ok: false, error: e };
    }

    const r = await fetchRestartLog(ctx);
    const lines = Array.isArray(r.lines) ? r.lines : [];

    emitPrint(ctx, '');
    if (!lines.length) {
      emitPrint(ctx, '(Р¶СѓСЂРЅР°Р» РїСѓСЃС‚)');
    } else {
      for (const ln of lines) emitPrint(ctx, String(ln || '').replace(/\r?\n$/, ''));
    }
    return { ok: true, lines };
  }

  const commandDef = {
    id: CMD_ID,
    matcher: CMD_RE,
    priority: 10,
    run,
  };

  function register(registryOrRouter) {
    const target = registryOrRouter;
    if (!target) return;
    if (typeof target.register === 'function' && typeof target.bindToRouter === 'function') {
      try { target.register(commandDef); } catch (e) {}
      return;
    }
    if (typeof target.register === 'function') {
      try {
        target.register(CMD_RE, async ({ ctx }) => run(ctx), { name: CMD_ID, priority: 10 });
      } catch (e) {}
    }
  }

  publishTerminalBuiltinCommandCompatApi('xkeen_restart', commandDef);
  publishTerminalBuiltinCommandCompatApi('registerXkeenRestart', register);
})();
