import { publishTerminalCommandsCompatApi } from '../runtime.js';

// Terminal command router (Stage C)
(function () {
  'use strict';

  function norm(s) {
    return String(s == null ? '' : s).trim();
  }

  function createCommandRouter(ctx) {
    const rules = [];

    function register(matcher, handler, opts) {
      const o = opts || {};
      rules.push({
        name: String(o.name || ''),
        priority: Number.isFinite(o.priority) ? Number(o.priority) : 100,
        matcher,
        handler,
      });
      rules.sort((a, b) => (a.priority - b.priority));
    }

    function testMatch(rule, cmdText, meta) {
      const txt = norm(cmdText);
      const m = rule.matcher;
      try {
        if (typeof m === 'function') {
          const r = m(txt, meta || {});
          if (!r) return null;
          if (typeof r === 'object' && r && Object.prototype.hasOwnProperty.call(r, 'match')) {
            return r.match;
          }
          return true;
        }
        if (m && typeof m.test === 'function') {
          const mm = txt.match(m);
          return mm ? mm : null;
        }
        if (typeof m === 'string') {
          return txt.startsWith(m) ? true : null;
        }
      } catch (e) {}
      return null;
    }

    async function route(cmdText, meta) {
      const txt = norm(cmdText);
      if (!txt) return { handled: false };

      for (const rule of rules) {
        const match = testMatch(rule, txt, meta || {});
        if (!match) continue;
        try {
          const res = await rule.handler({
            cmdText: txt,
            match,
            meta: meta || {},
            ctx,
          });
          return { handled: true, result: res };
        } catch (e) {
          try { console.error('[terminal.router] handler error', rule.name || '', e); } catch (_) {}
          return { handled: true, result: { ok: false, error: e } };
        }
      }
      return { handled: false };
    }

    async function execute(cmdText, meta) {
      try {
        if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
          ctx.events.emit('command:run', { cmdText: norm(cmdText), meta: meta || {} });
        }
      } catch (e) {}

      const r = await route(cmdText, meta);
      if (r && r.handled) {
        try {
          if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
            ctx.events.emit('command:handled', { cmdText: norm(cmdText), via: 'router', meta: meta || {}, result: r.result });
          }
        } catch (e) {}
        return r;
      }

      try {
        if (ctx && ctx.transport && typeof ctx.transport.send === 'function') {
          const payload = String(cmdText || '');
          const hasNewline = /\r|\n/.test(payload);
          const ok = !!ctx.transport.send(hasNewline ? payload : (payload + '\n'), { source: (meta && meta.source) || 'router' });
          if (!ok) {
            try {
              if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
                ctx.events.emit('command:error', { cmdText: norm(cmdText), error: 'transport send failed', meta: meta || {} });
              }
            } catch (e1) {}
            return { handled: false, result: { ok: false, error: 'transport send failed' } };
          }
          try {
            if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
              ctx.events.emit('command:handled', { cmdText: norm(cmdText), via: 'transport', meta: meta || {} });
            }
          } catch (e2) {}
          return { handled: true, result: { ok: true, via: 'transport' } };
        }
      } catch (e) {
        try { console.error('[terminal.router] transport send failed', e); } catch (_) {}
        try {
          if (ctx && ctx.events && typeof ctx.events.emit === 'function') {
            ctx.events.emit('command:error', { cmdText: norm(cmdText), error: e, meta: meta || {} });
          }
        } catch (e2) {}
      }
      return { handled: false, result: { ok: false, error: 'no transport' } };
    }

    return { register, route, execute };
  }

  publishTerminalCommandsCompatApi('createCommandRouter', createCommandRouter);
})();
