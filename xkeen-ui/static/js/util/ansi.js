(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  XKeen.util = XKeen.util || {};

  // ANSI -> HTML formatter.
  // Used by multiple parts of the UI (terminal output, restart log, etc.).
  //
  // Note: this is intentionally minimal: it handles basic colors/bold and resets.
  // It also strips non-SGR control sequences (e.g. ESC[H, ESC[J, OSC, etc.)
  // which otherwise show up as "мусор" in the browser.
  if (!XKeen.util.ansiToHtml) {
    XKeen.util.ansiToHtml = function ansiToHtml(text) {
      // Normalize: remove CR, OSC sequences, and CSI sequences except SGR (*m).
      // Keep \n intact (caller typically splits by lines).
      let raw = String(text || '');
      raw = raw.replace(/\r/g, '');

      // Some backends strip ESC (0x1b) leaving sequences like "[91m" in the output.
      // Re-hydrate common SGR sequences so we can render colors (like in terminal).
      function _looksLikeSgr(codeList) {
        try {
          const parts = String(codeList || '')
            .split(';')
            .map((v) => parseInt(v, 10))
            .filter((v) => Number.isFinite(v));
          if (!parts.length) return false;
          return parts.every((c) => {
            if (c === 0 || c === 1 || c === 2 || c === 3 || c === 4 || c === 22 || c === 24 || c === 27 || c === 39 || c === 49) return true;
            if ((c >= 30 && c <= 37) || (c >= 40 && c <= 47) || (c >= 90 && c <= 97) || (c >= 100 && c <= 107)) return true;
            return false;
          });
        } catch (e) {
          return false;
        }
      }

      // Convert bracket-only SGR tokens ("[91m") back into real ANSI ("\x1b[91m").
      raw = raw.replace(/\[([0-9]{1,3}(?:;[0-9]{1,3})*)m/g, (m, codes, off, str) => {
        try {
          if (off > 0 && str.charCodeAt(off - 1) === 0x1b) return m;
        } catch (e) {}
        try {
          if (!_looksLikeSgr(codes)) return m;
          return '\x1b[' + codes + 'm';
        } catch (e) {
          return m;
        }
      });

      // Drop other bracket-only CSI control sequences that turn into "мусор" when ESC is stripped
      // (e.g. "[?25l" cursor hide, "[2J" clear screen).
      raw = raw.replace(/\[(?:\?|\d)[0-9;?]*[@-~]/g, (m, off, str) => {
        try {
          if (off > 0 && str.charCodeAt(off - 1) === 0x1b) return m;
        } catch (e) {}
        return '';
      });
      // OSC: ESC ] ... BEL or ST
      raw = raw.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\\\)/g, '');
      // CSI: ESC [ ... <final>. Keep only SGR (*m)
      raw = raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (m) => (m.endsWith('m') ? m : ''));
      // Other stray ESC
      raw = raw.replace(/\x1b(?!\[)/g, '');
      // Remaining C0 controls (except \n, \t and ESC (\u001B) used by ANSI SGR)
      raw = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '');

      const esc = (typeof XKeen.util.escapeHtml === 'function')
        ? XKeen.util.escapeHtml(raw)
        : String(raw).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const ansiRegex = /\x1b\[([0-9;]*)m/g;
      const ANSI_COLOR_MAP = {
        30: '#000000',
        31: '#ff5555',
        32: '#50fa7b',
        33: '#f1fa8c',
        34: '#bd93f9',
        35: '#ff79c6',
        36: '#8be9fd',
        37: '#f8f8f2',
        90: '#4c566a',
        91: '#ff6e6e',
        92: '#69ff94',
        93: '#ffffa5',
        94: '#d6acff',
        95: '#ff92df',
        96: '#a4ffff',
        97: '#ffffff'
      };

      let result = '';
      let lastIndex = 0;
      let openSpan = false;
      let currentStyle = '';

      function closeSpan() {
        if (openSpan) {
          result += '</span>';
          openSpan = false;
        }
      }

      let match;
      while ((match = ansiRegex.exec(esc)) !== null) {
        if (match.index > lastIndex) {
          result += esc.slice(lastIndex, match.index);
        }
        lastIndex = ansiRegex.lastIndex;

        const codes = match[1].split(';').map((c) => parseInt(c, 10) || 0);
        let style = currentStyle;
        let reset = false;

        codes.forEach((code) => {
          if (code === 0) {
            style = '';
            reset = true;
          } else if (code === 1) {
            style = style.replace(/font-weight:[^;]+;?/g, '') + 'font-weight:bold;';
          } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            const color = ANSI_COLOR_MAP[code];
            if (color) style = style.replace(/color:[^;]+;?/g, '') + 'color:' + color + ';';
          }
        });

        if (reset || style !== currentStyle) {
          closeSpan();
          currentStyle = style;
          if (style) {
            result += '<span style="' + style + '">';
            openSpan = true;
          }
        }
      }

      if (lastIndex < esc.length) result += esc.slice(lastIndex);
      closeSpan();
      return result;
    };
  }
})();
