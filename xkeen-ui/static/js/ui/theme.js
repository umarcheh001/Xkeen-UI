// Theme toggle (moved out of main.js)
(() => {
  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.ui = XKeen.ui || {};
  XKeen.state = XKeen.state || {};

  const THEME_KEY = 'xkeen-theme';
  const TOP_LEVEL_ROUTE_CHANGE_EVENT = 'xkeen:top-level-route-change';

  let _currentTheme = '';
  let _themeToggleInitialized = false;
  let _themeToggleDelegated = false;
  let _themeToggleLifecycleBound = false;

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

  function applyTheme(theme, opts) {
    const html = document.documentElement;
    const next = theme === 'light' ? 'light' : 'dark';
    const syncEditors = !opts || opts.syncEditors !== false;
    const notify = !opts || opts.notify !== false;
    _currentTheme = next;

    html.setAttribute('data-theme', next);
    html.style.colorScheme = next;

    // Sync CodeMirror theme with panel theme (light -> default, dark -> material-darker)
    const cmTheme = next === 'light' ? 'default' : 'material-darker';

    if (syncEditors) {
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
    }

    // Notify other scripts about theme changes
    if (notify) {
      try {
        document.dispatchEvent(new CustomEvent('xkeen-theme-change', { detail: { theme: next, cmTheme } }));
      } catch (e) {}
    }

    syncThemeToggleButtons(next);
  }

  function getThemeToggleButtons() {
    try {
      return Array.from(document.querySelectorAll('#theme-toggle-btn'));
    } catch (e) {
      return [];
    }
  }

  function renderThemeToggleButton(btn, theme) {
    if (!btn) return false;

    const next = theme === 'light' ? 'light' : 'dark';
    const isLight = next === 'light';
    const icon = isLight ? '☾' : '☀';
    const label = isLight ? 'Тёмная тема' : 'Светлая тема';

    btn.dataset.theme = next;
    btn.innerHTML = `
      <span class="theme-toggle-icon">${icon}</span>
      <span class="theme-toggle-text">${label}</span>
    `;
    return true;
  }

  function syncThemeToggleButtons(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    getThemeToggleButtons().forEach((btn) => {
      try { renderThemeToggleButton(btn, next); } catch (e) {}
    });
  }

  function getInitialTheme() {
    try {
      const attr = document.documentElement.getAttribute('data-theme');
      if (attr === 'light' || attr === 'dark') {
        return attr;
      }
    } catch (e) {}

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

  function toggleTheme() {
    _currentTheme = (_currentTheme || getInitialTheme()) === 'light' ? 'dark' : 'light';
    try {
      localStorage.setItem(THEME_KEY, _currentTheme);
    } catch (e) {}
    applyTheme(_currentTheme);
  }

  function handleThemeToggleClick(event) {
    const target = event && event.target && typeof event.target.closest === 'function'
      ? event.target.closest('#theme-toggle-btn')
      : null;
    if (!target || target.disabled) return;

    try { event.preventDefault(); } catch (e) {}
    toggleTheme();
  }

  function bindThemeToggleDelegation() {
    if (_themeToggleDelegated) return;
    _themeToggleDelegated = true;
    document.addEventListener('click', handleThemeToggleClick);
  }

  function bindThemeToggleLifecycle() {
    if (_themeToggleLifecycleBound) return;
    _themeToggleLifecycleBound = true;

    // If editors are created later (panel init), re-apply theme.
    document.addEventListener('xkeen-editors-ready', () => {
      try { applyTheme(_currentTheme || getInitialTheme()); } catch (e) {}
    });

    window.addEventListener('pageshow', () => {
      try {
        applyTheme(getInitialTheme(), { syncEditors: false, notify: false });
      } catch (e) {}
    });

    // Top-level keep-alive navigation swaps the visible header button without reloading the document.
    window.addEventListener(TOP_LEVEL_ROUTE_CHANGE_EVENT, () => {
      try {
        applyTheme(_currentTheme || getInitialTheme(), { syncEditors: false, notify: false });
      } catch (e) {}
    });
  }

  function initThemeToggle() {
    _currentTheme = getInitialTheme();

    // Prime the page theme early; heavy editor refresh happens later via xkeen-editors-ready.
    applyTheme(_currentTheme, { syncEditors: false, notify: false });

    bindThemeToggleDelegation();
    bindThemeToggleLifecycle();

    if (_themeToggleInitialized) return;
    _themeToggleInitialized = true;
  }

  XKeen.ui.applyTheme = applyTheme;
  XKeen.ui.initThemeToggle = initThemeToggle;
  XKeen.ui.syncThemeToggleButtons = syncThemeToggleButtons;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeToggle, { once: true });
  } else {
    initThemeToggle();
  }
})();
