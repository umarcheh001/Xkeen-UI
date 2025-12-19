// Theme toggle (moved out of main.js)
(() => {
  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};
  XKeen.state = XKeen.state || {};

  const THEME_KEY = 'xkeen-theme';

  function getEditorsForThemeSync() {
    const s = (XKeen && XKeen.state) ? XKeen.state : {};
    const editors = [
      s.routingEditor,
      s.portProxyingEditor,
      s.portExcludeEditor,
      s.ipExcludeEditor,
      s.mihomoEditor,
      s.jsonModalEditor,
    ];

    // Allow pages (e.g. Mihomo generator) to register extra editors
    try {
      if (window.__xkeenEditors && Array.isArray(window.__xkeenEditors)) {
        window.__xkeenEditors.forEach((cm) => editors.push(cm));
      }
    } catch (e) {}

    return editors.filter(Boolean);
  }

  function applyTheme(theme) {
    const html = document.documentElement;
    const next = theme === 'light' ? 'light' : 'dark';

    html.setAttribute('data-theme', next);

    // Sync CodeMirror theme with panel theme (light -> default, dark -> material-darker)
    const cmTheme = next === 'light' ? 'default' : 'material-darker';

    try {
      const uniq = Array.from(new Set(getEditorsForThemeSync()));
      uniq.forEach((cm) => {
        if (!cm || !cm.setOption) return;
        try {
          cm.setOption('theme', cmTheme);
          if (cm.refresh) cm.refresh();
        } catch (e) {
          // ignore CodeMirror errors
        }
      });
    } catch (e) {}

    // Notify other scripts about theme changes
    try {
      document.dispatchEvent(new CustomEvent('xkeen-theme-change', { detail: { theme: next, cmTheme } }));
    } catch (e) {}

    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    btn.dataset.theme = next;

    const isLight = next === 'light';
    const icon = isLight ? '☾' : '☀';
    const label = isLight ? 'Тёмная тема' : 'Светлая тема';

    btn.innerHTML = `
      <span class="theme-toggle-icon">${icon}</span>
      <span class="theme-toggle-text">${label}</span>
    `;
  }

  function getInitialTheme() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
    } catch (e) {
      // localStorage might be unavailable; ignore
    }

    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function initThemeToggle() {
    let current = getInitialTheme();

    // Important: run after other DOMContentLoaded listeners (main.js initializes editors there)
    setTimeout(() => applyTheme(current), 0);

    const btn = document.getElementById('theme-toggle-btn');
    if (!btn) return;

    btn.addEventListener('click', () => {
      current = current === 'light' ? 'dark' : 'light';
      try {
        localStorage.setItem(THEME_KEY, current);
      } catch (e) {}
      applyTheme(current);
    });

    // If editors are created later (panel init), re-apply theme.
    document.addEventListener('xkeen-editors-ready', () => {
      try { applyTheme(current); } catch (e) {}
    });
  }

  XKeen.ui.applyTheme = applyTheme;
  XKeen.ui.initThemeToggle = initThemeToggle;

  document.addEventListener('DOMContentLoaded', initThemeToggle);
})();
