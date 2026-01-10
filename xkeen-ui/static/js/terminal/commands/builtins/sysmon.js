// Builtin command: `sysmon` (xkeen-ui)
// Runs a router-friendly monitor script via /api/run-command and streams output into terminal.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.commands = window.XKeen.terminal.commands || {};
  window.XKeen.terminal.commands.builtins = window.XKeen.terminal.commands.builtins || {};

  const CMD_ID = 'sysmon';
  const CMD_RE = /^(sysmon|xkeen\s+-sysmon)(\s|$)/i;

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
        return;
      }
    } catch (e) {}
  }

  function hasWs(ctx) {
    try {
      if (ctx && ctx.caps && typeof ctx.caps.hasWs === 'function') return !!ctx.caps.hasWs();
    } catch (e) {}
    try {
      const st = ctx && ctx.core && ctx.core.state ? ctx.core.state : (ctx && ctx.state ? ctx.state : null);
      return !!(st && st.hasWs);
    } catch (e2) {}
    return true;
  }

  async function run(ctx, args) {
    emitPrint(ctx, '');

    // Parse args from full command text.
    const cmdText = String((args && args.cmdText) ? args.cmdText : 'sysmon').trim();

    // Accept: sysmon [--short|--full] [--no-color] [--json]
    // Reject unknown flags (keeps builtin safe from accidental shell injections).
    let argv = [];
    try {
      // Remove leading command name: `sysmon` or `xkeen -sysmon`.
      let rest = cmdText.replace(/^\s*(?:xkeen\s+-sysmon|sysmon)\b/i, '').trim();
      if (rest) {
        // Tokenize by whitespace (quotes are not supported intentionally).
        argv = rest.split(/\s+/g).filter(Boolean);
      }
    } catch (e) {
      argv = [];
    }

    const ALLOWED = new Set(['--short', '--full', '--no-color', '--json', '--help', '-h']);
    const safeArgs = [];
    for (const a of argv) {
      if (ALLOWED.has(a)) safeArgs.push(a);
    }

    const mode = safeArgs.includes('--full') ? 'full' : (safeArgs.includes('--short') ? 'short' : 'default');
    emitPrint(ctx, `[sysmon] Режим: ${mode}`);
    emitPrint(ctx, '[sysmon] Сбор метрик...');

    const CJ = (window.XKeen && window.XKeen.util) ? window.XKeen.util.commandJob : null;
    if (!CJ || typeof CJ.runShellCommand !== 'function') {
      emitToast(ctx, 'commandJob util не найден (js/util/command_job.js)', 'error');
      emitPrint(ctx, '[Ошибка] Не удалось запустить sysmon: нет утилиты commandJob');
      return { ok: false, error: 'no commandJob util' };
    }

    const cmd = 'sh /opt/etc/xkeen-ui/tools/sysmon_keenetic.sh' + (safeArgs.length ? (' ' + safeArgs.join(' ')) : '');

    let seenAny = false;
    const r = await CJ.runShellCommand(cmd, null, {
      hasWs: hasWs(ctx),
      onChunk: (chunk) => {
        seenAny = true;
        emitPrint(ctx, String(chunk || ''));
      }
    });

    const data = r && r.data ? r.data : {};

    // If streaming did not show anything (rare), print final output.
    try {
      if (!seenAny && data && typeof data.output === 'string' && data.output) {
        emitPrint(ctx, data.output);
      }
    } catch (e) {}

    if (!data || data.ok === false) {
      emitToast(ctx, 'sysmon: ошибка выполнения', 'error');
      if (data && data.error) emitPrint(ctx, '[Ошибка] ' + String(data.error));
      return { ok: false, data };
    }

    emitPrint(ctx, '');
    emitPrint(ctx, '[sysmon] Готово.');
    return { ok: true, data };
  }


  const commandDef = {
    id: CMD_ID,
    matcher: CMD_RE,
    priority: 11,
    run,
  };

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
        target.register(CMD_RE, async ({ ctx, cmdText }) => run(ctx, { cmdText: cmdText }), { name: CMD_ID, priority: 11 });
      } catch (e) {}
    }
  }

  window.XKeen.terminal.commands.builtins.sysmon = commandDef;
  window.XKeen.terminal.commands.builtins.registerSysmon = register;
})();
