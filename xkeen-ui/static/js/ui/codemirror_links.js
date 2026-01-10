// CodeMirror: clickable URL helper (Ctrl/Cmd + click)
//
// Features:
//  - Detects URLs (http/https/ftp/file/mailto/magnet) inside any mode via an overlay.
//  - Styles URLs as links (uses existing .cm-link theme token + extra .cm-xk-url class).
//  - Показывает подсказку при наведении: "Перейти по ссылке (Ctrl + клик)".
//  - Opens the URL in a new tab when Ctrl (or Cmd on macOS) is held while clicking.
//
// Safe-by-default:
//  - Works even if other scripts create editors later (we patch CodeMirror.fromTextArea once).
//  - Does nothing if CodeMirror is missing.

(() => {
  'use strict';

  // UI locale: RU (requested). Keep wording close to common editor UX.
  // Note: opens on Ctrl (Win/Linux) or Cmd (macOS) – logic supports both.
  const TOOLTIP_TEXT = 'Перейти по ссылке (Ctrl + клик)';

  // Only schemes that make sense to open directly in a browser.
  const URL_START_RE = /(https?:\/\/|ftp:\/\/|file:\/\/|mailto:|magnet:)/;
  const URL_FULL_RE = /^(https?:\/\/|ftp:\/\/|file:\/\/|mailto:|magnet:)[^\s<>"'`\)\]\}]+/;

  function ensureTooltipEl() {
    let el = document.getElementById('xkeen-cm-linktip');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'xkeen-cm-linktip';
    el.className = 'xkeen-cm-linktip';
    el.style.display = 'none';
    el.textContent = TOOLTIP_TEXT;
    document.body.appendChild(el);
    return el;
  }

  function hideTooltip() {
    try {
      const el = document.getElementById('xkeen-cm-linktip');
      if (el) el.style.display = 'none';
    } catch (e) {}
  }

  function isCtrlLike(ev) {
    // Ctrl on Windows/Linux, Cmd on macOS.
    return !!(ev && (ev.ctrlKey || ev.metaKey));
  }

  function buildUrlOverlay() {
    // Overlay is stateless; CodeMirror reuses it per editor.
    return {
      token: function (stream) {
        try {
          const s = stream.string || '';
          const pos = stream.pos || 0;
          if (pos >= s.length) return null;

          const tail = s.slice(pos);
          const idx = tail.search(URL_START_RE);
          if (idx < 0) {
            stream.skipToEnd();
            return null;
          }

          // Jump to URL start.
          if (idx > 0) {
            stream.pos = pos + idx;
            return null;
          }

          const m = tail.match(URL_FULL_RE);
          if (!m) {
            // Defensive: consume one char to avoid infinite loops.
            stream.next();
            return null;
          }
          stream.pos = pos + m[0].length;
          // Add both the built-in token (.cm-link) and our marker (.cm-xk-url).
          return 'link xk-url';
        } catch (e) {
          try { stream.next(); } catch (e2) {}
          return null;
        }
      },
    };
  }

  // NOTE:
  // getTokenAt() is not reliable for overlays across all CM5 builds/modes (some setups
  // return base-mode token types without overlay bits). So we detect URLs by scanning
  // the line text around the mouse position.
  const URL_IN_LINE_RE = /(https?:\/\/|ftp:\/\/|file:\/\/|mailto:|magnet:)[^\s<>"'`\)\]\}]+/g;

  function findUrlAt(lineText, ch) {
    if (!lineText) return null;
    URL_IN_LINE_RE.lastIndex = 0;
    let m;
    while ((m = URL_IN_LINE_RE.exec(lineText))) {
      let url = m[0];
      let start = m.index;
      let end = start + url.length;

      // Trim common trailing punctuation.
      const trimmed = url.replace(/[\.,;:]+$/, '');
      if (trimmed !== url) {
        url = trimmed;
        end = start + url.length;
      }

      if (ch >= start && ch < end) {
        return { url, start, end };
      }
    }
    return null;
  }

  function getHoveredUrlToken(cm, ev) {
    try {
      if (!cm || !cm.coordsChar || !cm.getLine) return null;

      // Use window coords (clientX/Y) because events provide viewport coordinates.
      const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }, 'window');
      if (!pos || pos.line == null || pos.ch == null) return null;

      const lineText = cm.getLine(pos.line);
      const found = findUrlAt(lineText, pos.ch);
      if (!found || !found.url || !URL_START_RE.test(found.url)) return null;

      return {
        url: found.url,
        line: pos.line,
        start: found.start,
        end: found.end,
      };
    } catch (e) {
      return null;
    }
  }

  function placeTooltip(cm, token) {
    const tip = ensureTooltipEl();
    if (!tip) return;

    try {
      tip.textContent = TOOLTIP_TEXT;
      tip.style.display = 'block';

      // Anchor to token start.
      const startCoords = cm.charCoords({ line: token.line, ch: token.start }, 'page');
      const endCoords = cm.charCoords({ line: token.line, ch: token.end }, 'page');
      const pad = 8;

      // Measure.
      const w = tip.offsetWidth || 160;
      const h = tip.offsetHeight || 24;

      const pageX = window.pageXOffset || document.documentElement.scrollLeft || 0;
      const pageY = window.pageYOffset || document.documentElement.scrollTop || 0;
      const vw = document.documentElement.clientWidth || window.innerWidth || 1024;
      const vh = document.documentElement.clientHeight || window.innerHeight || 768;

      // Prefer above the link, fallback below.
      let left = startCoords.left;
      let top = startCoords.top - h - 6;

      const maxLeft = pageX + vw - w - pad;
      if (left > maxLeft) left = maxLeft;
      if (left < pageX + pad) left = pageX + pad;

      const minTop = pageY + pad;
      if (top < minTop) {
        top = (endCoords.bottom || startCoords.bottom || (startCoords.top + 16)) + 6;
        const maxTop = pageY + vh - h - pad;
        if (top > maxTop) top = maxTop;
      }

      tip.style.left = left + 'px';
      tip.style.top = top + 'px';
    } catch (e) {
      // Best-effort; hide on any unexpected layout errors.
      hideTooltip();
    }
  }

  function attachToEditor(cm) {
    try {
      if (!cm || !cm.addOverlay) return;
      if (cm.state && cm.state.__xkeenLinksAttached) return;
      cm.state = cm.state || {};
      cm.state.__xkeenLinksAttached = true;

      // Overlay for URL highlighting.
      cm.addOverlay(buildUrlOverlay());

      const wrap = cm.getWrapperElement ? cm.getWrapperElement() : null;
      if (wrap) wrap.classList.add('xkeen-cm-links');

      // Hover + click handlers.
      let lastKey = '';
      function onMove(ev) {
        const t = getHoveredUrlToken(cm, ev);
        if (!t) {
          if (wrap) wrap.classList.remove('xkeen-cm-link-hover', 'xkeen-cm-link-armed');
          hideTooltip();
          lastKey = '';
          return;
        }

        const k = t.line + ':' + t.start + ':' + t.end;
        if (k !== lastKey) {
          placeTooltip(cm, t);
          lastKey = k;
        }
        if (wrap) {
          wrap.classList.add('xkeen-cm-link-hover');
          if (isCtrlLike(ev)) wrap.classList.add('xkeen-cm-link-armed');
          else wrap.classList.remove('xkeen-cm-link-armed');
        }
      }

      function onOut() {
        if (wrap) wrap.classList.remove('xkeen-cm-link-hover', 'xkeen-cm-link-armed');
        hideTooltip();
        lastKey = '';
      }

      function onDown(ev) {
        const t = getHoveredUrlToken(cm, ev);
        if (!t) return;
        if (!isCtrlLike(ev)) return;

        // Prevent CM from moving cursor/selection on ctrl-click.
        try { ev.preventDefault(); } catch (e) {}
        try { ev.stopPropagation(); } catch (e) {}

        try {
          window.open(t.url, '_blank', 'noopener');
        } catch (e) {
          // Fallback: attempt to navigate.
          try { window.location.href = t.url; } catch (e2) {}
        }
      }

      if (wrap && !(wrap.dataset && wrap.dataset.xkeenLinksWired === '1')) {
        wrap.addEventListener('mousemove', onMove);
        wrap.addEventListener('mouseleave', onOut);
        wrap.addEventListener('mousedown', onDown);
        // Hide tooltip while scrolling to avoid "floating".
        cm.on('scroll', onOut);
        cm.on('blur', onOut);
        if (wrap.dataset) wrap.dataset.xkeenLinksWired = '1';
      }

      // Also hide tooltip on window scroll/resize (wire once globally).
      try {
        if (!window.__xkeenLinksGlobalWired) {
          window.__xkeenLinksGlobalWired = true;
          window.addEventListener('scroll', hideTooltip, { passive: true });
          window.addEventListener('resize', hideTooltip, { passive: true });
        }
      } catch (e) {}
    } catch (e) {}
  }

  function patchCodeMirrorFromTextArea() {
    try {
      const CM = window.CodeMirror;
      if (!CM || typeof CM.fromTextArea !== 'function') return;
      if (CM.__xkeenLinksPatched) return;
      CM.__xkeenLinksPatched = true;

      const orig = CM.fromTextArea;
      CM.fromTextArea = function patchedFromTextArea() {
        const cm = orig.apply(this, arguments);
        try { attachToEditor(cm); } catch (e) {}
        return cm;
      };

      // Also attach to already-created editors in window.__xkeenEditors (theme sync list).
      try {
        const list = window.__xkeenEditors;
        if (Array.isArray(list)) list.forEach((ed) => { try { attachToEditor(ed); } catch (e) {} });
      } catch (e) {}

      // Attach to editors announced via event.
      try {
        document.addEventListener('xkeen-editors-ready', () => {
          try {
            const list2 = window.__xkeenEditors;
            if (Array.isArray(list2)) list2.forEach((ed) => { try { attachToEditor(ed); } catch (e) {} });
          } catch (e) {}

          // Known state holders.
          try {
            const st = (window.XKeen && window.XKeen.state) ? window.XKeen.state : null;
            if (st) {
              ['routingEditor', 'mihomoEditor', 'portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((k) => {
                try { if (st[k]) attachToEditor(st[k]); } catch (e) {}
              });
            }
          } catch (e) {}
        });
      } catch (e) {}
    } catch (e) {}
  }

  // Init as soon as possible.
  function init() {
    patchCodeMirrorFromTextArea();
    // If CodeMirror loads after this script, retry a few times.
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      patchCodeMirrorFromTextArea();
      if ((window.CodeMirror && window.CodeMirror.__xkeenLinksPatched) || tries >= 25) {
        try { clearInterval(t); } catch (e) {}
      }
    }, 200);
  }

  init();
})();
