// Terminal command registry (Stage 7)
//
// Goal:
//   - Keep builtins "clean": builtin.run(ctx, args) with no DOM/global access.
//   - Provide a single place to register/bind commands to the command router.
//
// Contract for a command definition:
//   {
//     id: 'string',
//     matcher: RegExp | string | function(cmdText, meta) => boolean|{match:any},
//     priority?: number,
//     run: async (ctx, args) => any
//   }
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.commands = window.XKeen.terminal.commands || {};

  function createCommandRegistry(ctx) {
    const list = [];

    function register(cmd) {
      if (!cmd || typeof cmd !== 'object') return false;
      const id = String(cmd.id || cmd.name || '').trim();
      const matcher = cmd.matcher;
      const run = cmd.run;
      if (!id || !matcher || typeof run !== 'function') return false;

      // Avoid duplicates by id (idempotent registration)
      try {
        if (list.some((c) => c && c.id === id)) return false;
      } catch (e) {}

      const priority = Number.isFinite(cmd.priority) ? Number(cmd.priority) : 100;
      list.push({ id, matcher, run, priority });
      return true;
    }

    function getAll() {
      return list.slice().sort((a, b) => (a.priority - b.priority));
    }

    function bindToRouter(router) {
      if (!router || typeof router.register !== 'function') return;
      router.__xkeenBoundCommands = router.__xkeenBoundCommands || {};
      for (const c of getAll()) {
        try { if (router.__xkeenBoundCommands[c.id]) continue; } catch (e0) {}
        try { router.__xkeenBoundCommands[c.id] = true; } catch (e1) {}
        router.register(
          c.matcher,
          async ({ ctx: rctx, cmdText, match, meta }) => {
            // Ensure builtins are called as run(ctx, args)
            const args = {
              cmdText: String(cmdText || ''),
              match: match,
              meta: meta || {},
            };
            return await c.run(rctx || ctx, args);
          },
          { name: c.id, priority: c.priority }
        );
      }
    }

    return { register, getAll, bindToRouter };
  }

  window.XKeen.terminal.commands.createCommandRegistry = createCommandRegistry;
})();
