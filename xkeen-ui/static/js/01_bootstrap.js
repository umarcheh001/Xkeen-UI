(() => {
  "use strict";

  // Bootstrap: utilities and tiny polyfills that other modules may rely on.
  // IMPORTANT: keep this file DOM-free (belongs to XKeen.util).

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.util = XK.util || {};

  // JSONC (//, #, /* */) comment stripper used by routing editor.
  // NOTE: kept as a util + global alias for backward compatibility.
  if (!XK.util.stripJsonComments) {
    XK.util.stripJsonComments = function stripJsonComments(s) {
      if (typeof s !== 'string') return '';
      let res = [];
      let inString = false;
      let escape = false;
      let i = 0;
      const length = s.length;

      while (i < length) {
        const ch = s[i];

        // Inside string literal
        if (inString) {
          res.push(ch);
          if (escape) {
            escape = false;
          } else if (ch === '\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          i++;
          continue;
        }

        // Start of string literal
        if (ch === '"') {
          inString = true;
          res.push(ch);
          i++;
          continue;
        }

        // Single-line comment //
        if (ch === '/' && i + 1 < length && s[i + 1] === '/') {
          i += 2;
          while (i < length && s[i] !== '\n') i++;
          continue;
        }

        // Single-line comment starting with #
        if (ch === '#') {
          i++;
          while (i < length && s[i] !== '\n') i++;
          continue;
        }

        // Multi-line comment /* ... */
        if (ch === '/' && i + 1 < length && s[i + 1] === '*') {
          i += 2;
          while (i + 1 < length && !(s[i] === '*' && s[i + 1] === '/')) i++;
          i += 2;
          continue;
        }

        // Regular character
        res.push(ch);
        i++;
      }

      return res.join('');
    };
  }

  // Backward-compatible global alias (main.js historically calls stripJsonComments(...)).
  if (typeof window.stripJsonComments !== 'function') {
    window.stripJsonComments = XK.util.stripJsonComments;
  }
})();
