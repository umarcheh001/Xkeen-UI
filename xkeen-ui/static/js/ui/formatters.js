(() => {
  'use strict';

  // Browser-side format helpers (Prettier).
  // No behavior changes by default; consumers call these explicitly.

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  XK.ui.formatters = XK.ui.formatters || {};
  const F = XK.ui.formatters;

  function normalizeText(s) {
    return (typeof s === 'string') ? s : String(s ?? '');
  }

  // Best-effort: load server UI settings on first formatter use (still lazy; no auto-fetch on page load).
  async function ensureSettingsLoaded() {
    try {
      if (XK && XK.ui && XK.ui.settings && typeof XK.ui.settings.fetchOnce === 'function') {
        await XK.ui.settings.fetchOnce();
      }
    } catch (e) {}
  }

  function getSettingsFormatPrefs() {
    try {
      if (XK && XK.ui && XK.ui.settings && typeof XK.ui.settings.get === 'function') {
        const st = XK.ui.settings.get();
        const f = (st && st.format && typeof st.format === 'object') ? st.format : {};
        // Only pass a safe subset to Prettier.
        const out = {};
        if (Number.isFinite(f.tabWidth)) out.tabWidth = Number(f.tabWidth);
        if (Number.isFinite(f.printWidth)) out.printWidth = Number(f.printWidth);
        return out;
      }
    } catch (e) {}
    return {};
  }

  function buildOptions(parser, user) {
    const u = (user && typeof user === 'object') ? user : {};

    // JSON/JSONC are consumed by strict parsers on the router side (Xray configs).
    // Trailing commas break JSON.parse / Go json decoder, so default to 'none'.
    const isJsonFamily = (parser === 'json' || parser === 'jsonc');

    const o = {
      parser,
      // Prettier defaults are OK; keep minimal but predictable.
      tabWidth: Number.isFinite(u.tabWidth) ? Number(u.tabWidth) : 2,
      printWidth: Number.isFinite(u.printWidth) ? Number(u.printWidth) : 80,
      useTabs: !!u.useTabs,
      singleQuote: !!u.singleQuote,
      trailingComma: (typeof u.trailingComma === 'string') ? u.trailingComma : (isJsonFamily ? 'none' : 'es5'),
      proseWrap: (typeof u.proseWrap === 'string') ? u.proseWrap : 'preserve',
    };

    // Pass-through extras (but don't allow overriding parser/plugins unsafely).
    for (const k of ['endOfLine', 'bracketSpacing', 'semi']) {
      if (k in u) o[k] = u[k];
    }

    return o;
  }

  async function ensure(required) {
    try {
      if (!XK.prettierLoader || typeof XK.prettierLoader.ensurePrettier !== 'function') return null;
      return await XK.prettierLoader.ensurePrettier(required);
    } catch (e) {
      return null;
    }
  }

  // formatJson(text, opts) -> { ok, text, used, error? }
  F.formatJson = async function formatJson(text, opts) {
    const input = normalizeText(text);
    const o = (opts && typeof opts === 'object') ? opts : {};
    const parser = (typeof o.parser === 'string' && o.parser.trim()) ? o.parser.trim() : 'json';

    await ensureSettingsLoaded();
    const mergedPrefs = Object.assign({}, getSettingsFormatPrefs(), o);

    const env = await ensure({ json: true, yaml: false });
    if (!env || !env.prettier) {
      return { ok: false, text: input, used: 'noop', error: 'prettier_not_available' };
    }

    try {
      // Prettier v3+ returns a Promise in many builds (including standalone).
      // Always await to avoid "[object Promise]" ending up in editors.
      const out = await env.prettier.format(input, {
        ...buildOptions(parser, mergedPrefs),
        plugins: env.plugins,
      });
      return { ok: true, text: String(out), used: 'prettier' };
    } catch (e) {
      return { ok: false, text: input, used: 'noop', error: String(e && e.message ? e.message : e) };
    }
  };

  // formatYaml(text, opts) -> { ok, text, used, error? }
  F.formatYaml = async function formatYaml(text, opts) {
    const input = normalizeText(text);
    const o = (opts && typeof opts === 'object') ? opts : {};
    const parser = 'yaml';

    await ensureSettingsLoaded();
    const mergedPrefs2 = Object.assign({}, getSettingsFormatPrefs(), o);

    const env = await ensure({ json: false, yaml: true });
    if (!env || !env.prettier) {
      return { ok: false, text: input, used: 'noop', error: 'prettier_not_available' };
    }

    try {
      // Prettier v3+ returns a Promise in many builds (including standalone).
      // Always await to avoid "[object Promise]" ending up in editors.
      const out = await env.prettier.format(input, {
        ...buildOptions(parser, mergedPrefs2),
        plugins: env.plugins,
      });
      return { ok: true, text: String(out), used: 'prettier' };
    } catch (e) {
      return { ok: false, text: input, used: 'noop', error: String(e && e.message ? e.message : e) };
    }
  };

  // Small console helper:
  //   await XKeen.ui.formatters.selfTest()
  F.selfTest = async function selfTest() {
    const r1 = await F.formatJson('{"b":1,"a":2}\n');
    const r2 = await F.formatYaml('b: 1\na: 2\n');
    return { json: r1, yaml: r2 };
  };
})();
