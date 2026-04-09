import {
  getTerminalCommandJobApi,
  publishTerminalBuiltinCommandCompatApi,
} from '../../runtime.js';

// Builtin command: `sysmon` (xkeen-ui)
(function () {
  'use strict';

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
    const cmdText = String((args && args.cmdText) ? args.cmdText : 'sysmon').trim();

    let argv = [];
    try {
      let rest = cmdText.replace(/^\s*(?:xkeen\s+-sysmon|sysmon)\b/i, '').trim();
      if (rest) argv = rest.split(/\s+/g).filter(Boolean);
    } catch (e) {
      argv = [];
    }

    const ALLOWED = new Set(['--short', '--full', '--no-color', '--json', '--help', '-h']);
    const safeArgs = [];
    for (const a of argv) {
      if (ALLOWED.has(a)) safeArgs.push(a);
    }

    const mode = safeArgs.includes('--full') ? 'full' : (safeArgs.includes('--short') ? 'short' : 'default');
    emitPrint(ctx, `[sysmon] Р РµР¶РёРј: ${mode}`);
    emitPrint(ctx, '[sysmon] РЎР±РѕСЂ РјРµС‚СЂРёРє...');

    const CJ = getTerminalCommandJobApi();
    if (!CJ || typeof CJ.runShellCommand !== 'function') {
      emitToast(ctx, 'commandJob util РЅРµ РЅР°Р№РґРµРЅ (js/util/command_job.js)', 'error');
      emitPrint(ctx, '[РћС€РёР±РєР°] РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РїСѓСЃС‚РёС‚СЊ sysmon: РЅРµС‚ СѓС‚РёР»РёС‚С‹ commandJob');
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
    try {
      if (!seenAny && data && typeof data.output === 'string' && data.output) emitPrint(ctx, data.output);
    } catch (e) {}

    if (!data || data.ok === false) {
      const msg = (CJ && typeof CJ.describeRunCommandError === 'function')
        ? CJ.describeRunCommandError(data, r && r.res)
        : (data && data.error ? String(data.error) : 'sysmon failed');
      emitToast(ctx, 'sysmon: РѕС€РёР±РєР° РІС‹РїРѕР»РЅРµРЅРёСЏ', 'error');
      if (msg) emitPrint(ctx, '[РћС€РёР±РєР°] ' + msg);
      return { ok: false, data };
    }

    emitPrint(ctx, '');
    emitPrint(ctx, '[sysmon] Р“РѕС‚РѕРІРѕ.');
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
    if (typeof target.register === 'function' && typeof target.bindToRouter === 'function') {
      try { target.register(commandDef); } catch (e) {}
      return;
    }
    if (typeof target.register === 'function') {
      try {
        target.register(CMD_RE, async ({ ctx, cmdText }) => run(ctx, { cmdText: cmdText }), { name: CMD_ID, priority: 11 });
      } catch (e) {}
    }
  }

  publishTerminalBuiltinCommandCompatApi('sysmon', commandDef);
  publishTerminalBuiltinCommandCompatApi('registerSysmon', register);
})();
