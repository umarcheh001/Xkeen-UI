/*
  routing_cards/rules/detect.js
  Utility helpers to analyze routing rules (deep walk) and detect used geo tags.

  RC-11a (extract PR5)

  Public API:
    RC.rules.detect._walkDeep(val, fn, depth)
    RC.rules.detect._basenameLower(path)
    RC.rules.detect.getUsedDatTags(kind, datFileOrPath)
*/
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const RC = XK.features.routingCards = XK.features.routingCards || {};
  RC.rules = RC.rules || {};

  const S = RC.rules.state = RC.rules.state || {};
  const RM = RC.rules.model = RC.rules.model || {};

  RC.rules.detect = RC.rules.detect || {};
  const D = RC.rules.detect;

  function _walkDeep(val, fn, depth) {
    const d = depth || 0;
    if (d > 10) return;
    if (val == null) return;
    if (typeof val === 'string') { fn(val); return; }
    if (typeof val === 'number' || typeof val === 'boolean') return;
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) _walkDeep(val[i], fn, d + 1);
      return;
    }
    if (typeof val === 'object') {
      try {
        for (const k in val) {
          if (!Object.prototype.hasOwnProperty.call(val, k)) continue;
          _walkDeep(val[k], fn, d + 1);
        }
      } catch (e) {}
    }
  }

  function _basenameLower(s) {
    const v = String(s || '').trim();
    if (!v) return '';
    const parts = v.split(/[\/]/);
    return String(parts[parts.length - 1] || '').toLowerCase();
  }

  function getUsedDatTags(kind, datFileOrPath) {
    const k = (kind === 'geoip') ? 'geoip' : 'geosite';
    const base = _basenameLower(datFileOrPath);

    // Build base aliases to tolerate common naming variants:
    // zkeen.dat <-> geosite_zkeen.dat, zkeenip.dat <-> geoip_zkeenip.dat, etc.
    const aliases = new Set();
    function addAlias(v) {
      const s = String(v || '').trim().toLowerCase();
      if (s) aliases.add(s);
    }
    if (base) {
      addAlias(base);

      // Strip kind prefix (geosite_*, geoip_*)
      if (base.startsWith(k + '_')) addAlias(base.slice(k.length + 1));
      if (base.startsWith(k + '-')) addAlias(base.slice(k.length + 1));

      // Add kind-prefixed variants
      addAlias(k + '_' + base);
      addAlias(k + '-' + base);

      // zkeen special pairs (historical naming)
      if (k === 'geosite' && (base === 'zkeen.dat' || base === 'geosite_zkeen.dat')) {
        addAlias('zkeen.dat');
        addAlias('geosite_zkeen.dat');
      }
      if (k === 'geoip' && (base === 'zkeenip.dat' || base === 'geoip_zkeenip.dat')) {
        addAlias('zkeenip.dat');
        addAlias('geoip_zkeenip.dat');
      }
    }

    function baseMatches(fileLc) {
      const fbase = _basenameLower(fileLc);
      if (!fbase) return false;
      if (!base) return true;

      if (aliases.has(fbase)) return true;

      // Also tolerate suffix matches: geosite_<base>, geoip-<base>, etc.
      for (const a of aliases) {
        if (!a) continue;
        if (fbase === a) return true;
        if (fbase.endsWith('_' + a) || fbase.endsWith('-' + a) || fbase.endsWith(a) || a.endsWith(fbase)) return true;
      }
      return false;
    }

    // Match current editor/model (including unsaved changes).
    if (!S._root && !S._dirty) {
      try { if (RM && typeof RM.loadFromEditor === 'function') RM.loadFromEditor(); } catch (e) {}
    }
    const m = (RM && typeof RM.ensureModel === 'function') ? RM.ensureModel() : (S._model || { rules: [] });
    const rules = Array.isArray(m.rules) ? m.rules : [];

    const p = (k === 'geoip') ? 'geoip:' : 'geosite:';
    const used = new Set();

    rules.forEach((r) => {
      _walkDeep(r, (s) => {
        const raw = String(s || '').trim();
        if (!raw) return;
        const lc = raw.toLowerCase();

        // Built-in selectors: geoip:TAG / geosite:TAG
        if (lc.startsWith(p)) {
          const tag = raw.slice(p.length).trim();
          if (tag) used.add(tag.toLowerCase());
          return;
        }

        // External selectors: ext:<file>:TAG (also accept legacy ext:geoip:TAG / ext:geosite:TAG)
        if (!lc.startsWith('ext:')) return;

        const restLc = lc.slice(4);
        const restRaw = raw.slice(4);
        const j = restLc.indexOf(':');
        if (j < 0) return;

        const fileLc = restLc.slice(0, j).trim();
        const tagRaw = restRaw.slice(j + 1).trim();
        if (!tagRaw) return;

        // Legacy: ext:geoip:TAG / ext:geosite:TAG
        if (fileLc === 'geoip' || fileLc === 'geosite') {
          if (fileLc === k) used.add(tagRaw.toLowerCase());
          return;
        }

        if (base) {
          // When a specific DAT file is provided, match by basename with aliases.
          if (!baseMatches(fileLc)) return;
          used.add(tagRaw.toLowerCase());
          return;
        }

        // No file filter: try to infer kind from "geoip"/"geosite" in file part.
        const isGeoip = (fileLc === 'geoip') || fileLc.includes('geoip');
        const isGeosite = (fileLc === 'geosite') || fileLc.includes('geosite');

        if (isGeoip || isGeosite) {
          if (k === 'geoip' && !isGeoip) return;
          if (k === 'geosite' && !isGeosite) return;
        }
        // If kind can't be inferred, still count it (better a hint than a miss).
        used.add(tagRaw.toLowerCase());
      }, 0);
    });

    return { ok: true, kind: k, file: base || null, tags: Array.from(used) };
  }

  // Public API
  D._walkDeep = _walkDeep;
  D._basenameLower = _basenameLower;
  D.getUsedDatTags = getUsedDatTags;
})();
