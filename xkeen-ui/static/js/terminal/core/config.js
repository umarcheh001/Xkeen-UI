// Terminal core: config/prefs wrapper (localStorage)
//
// Centralizes preference keys so modules don't duplicate parsing logic.
(function () {
  'use strict';

  window.XKeen = window.XKeen || {};
  window.XKeen.terminal = window.XKeen.terminal || {};
  window.XKeen.terminal.core = window.XKeen.terminal.core || {};

  // Backward-compatible keys already used by modules.
  const KEYS = {
    follow: 'xkeen_term_follow_v1',
    ansiFilter: 'xkeen_term_ansi_filter_v1',
    logHl: 'xkeen_term_log_hl_v1',
    fontSize: 'xkeen_term_font_size_v1',
    cursorBlink: 'xkeen_term_cursor_blink_v1',
  };

  const DEFAULTS = {
    follow: true,
    ansiFilter: false,
    logHl: true,
    fontSize: 12,
    cursorBlink: false,
  };

  function parseBool(raw, def) {
    if (raw == null) return !!def;
    const s = String(raw);
    if (s === '1' || s === 'true') return true;
    if (s === '0' || s === 'false') return false;
    return !!def;
  }

  function parseIntClamped(raw, def, min, max) {
    if (raw == null) return def;
    const v = parseInt(String(raw), 10);
    if (isNaN(v)) return def;
    return Math.max(min, Math.min(max, v));
  }

  function getValue(name) {
    const key = KEYS[name];
    if (!key) return undefined;
    try {
      const raw = localStorage.getItem(key);
      if (name === 'fontSize') return parseIntClamped(raw, DEFAULTS.fontSize, 8, 32);
      if (name === 'follow') return parseBool(raw, DEFAULTS.follow);
      if (name === 'ansiFilter') return parseBool(raw, DEFAULTS.ansiFilter);
      if (name === 'logHl') {
        // Historical semantics: missing => true; '0'/'false' => false
        return parseBool(raw, DEFAULTS.logHl);
      }
      if (name === 'cursorBlink') return parseBool(raw, DEFAULTS.cursorBlink);
      return raw;
    } catch (e) {}
    return DEFAULTS[name];
  }

  function setValue(name, value) {
    const key = KEYS[name];
    if (!key) return false;
    try {
      if (typeof value === 'boolean') {
        localStorage.setItem(key, value ? '1' : '0');
        return true;
      }
      if (typeof value === 'number') {
        localStorage.setItem(key, String(value));
        return true;
      }
      localStorage.setItem(key, String(value == null ? '' : value));
      return true;
    } catch (e) {}
    return false;
  }

  function createConfig() {
    function get(name, fallback) {
      const v = getValue(name);
      return (v === undefined) ? fallback : v;
    }

    function set(name, value) {
      return setValue(name, value);
    }

    function defaults() {
      return Object.assign({}, DEFAULTS);
    }

    function keys() {
      return Object.assign({}, KEYS);
    }

    return { get, set, defaults, keys };
  }

  window.XKeen.terminal.core.createConfig = createConfig;
})();
