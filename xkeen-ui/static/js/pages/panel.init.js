(() => {
  // panel.html wiring (Milestones 1-2): init modules + remove inline onclick dependencies.

  function isPanelPage() {
    return !!(document.getElementById('view-routing') || document.querySelector('.top-tab-btn[data-view]'));
  }

  function safe(fn) {
    try { fn(); } catch (e) { console.error(e); }
  }

  // Legacy initializers from main.js were removed. If you add a new module,
  // just extend initModules() below.

  function getEditor(name) {
    try {
      if (window.XKeen && XKeen.state && XKeen.state[name]) return XKeen.state[name];
    } catch (e) {}
    try {
      return window[name];
    } catch (e) {}
    return null;
  }

  function showView(viewName) {
    const name = String(viewName || 'routing');

    const sections = {
      routing: document.getElementById('view-routing'),
      mihomo: document.getElementById('view-mihomo'),
      xkeen: document.getElementById('view-xkeen'),
      'xray-logs': document.getElementById('view-xray-logs'),
      commands: document.getElementById('view-commands'),
    };

    // hide/show sections
    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      el.style.display = key === name ? 'block' : 'none';
    });

    // active tab state
    document.querySelectorAll('.top-tab-btn[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === name);
    });

    // refresh editors when tab becomes visible
    if (name === 'mihomo') {
      const ed = getEditor('mihomoEditor');
      if (ed && ed.refresh) safe(() => ed.refresh());
    }
    if (name === 'xkeen') {
      ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((k) => {
        const ed = getEditor(k);
        if (ed && ed.refresh) safe(() => ed.refresh());
      });
    }

    // xray logs auto start/stop
    if (name === 'xray-logs') {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs) {
        if (typeof XKeen.features.xrayLogs.start === 'function') safe(() => XKeen.features.xrayLogs.start());
        if (typeof XKeen.features.xrayLogs.refreshStatus === 'function') safe(() => XKeen.features.xrayLogs.refreshStatus());
      } else {
        if (typeof window.startXrayLogAuto === 'function') safe(() => window.startXrayLogAuto());
        if (typeof window.refreshXrayLogStatus === 'function') safe(() => window.refreshXrayLogStatus());
      }
    } else {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs && typeof XKeen.features.xrayLogs.stop === 'function') {
        safe(() => XKeen.features.xrayLogs.stop());
      } else if (typeof window.stopXrayLogAuto === 'function') {
        safe(() => window.stopXrayLogAuto());
      }
    }
  }

  function wireTabs() {
    const buttons = document.querySelectorAll('.top-tab-btn[data-view]');
    buttons.forEach((btn) => {
      if (btn.dataset && btn.dataset.xkeenWiredTabs === '1') return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        showView(btn.dataset.view);
      });
      if (btn.dataset) btn.dataset.xkeenWiredTabs = '1';
    });
  }

  function initModules() {
    // The list mirrors README milestones (safe to call even if module absent)
    safe(() => {
      if (window.XKeen && XKeen.routing && typeof XKeen.routing.init === 'function') XKeen.routing.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.inbounds && typeof XKeen.features.inbounds.init === 'function') XKeen.features.inbounds.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.outbounds && typeof XKeen.features.outbounds.init === 'function') XKeen.features.outbounds.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs && typeof XKeen.features.xrayLogs.init === 'function') XKeen.features.xrayLogs.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.init === 'function') XKeen.features.restartLog.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.mihomoPanel && typeof XKeen.features.mihomoPanel.init === 'function') XKeen.features.mihomoPanel.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.serviceStatus && typeof XKeen.features.serviceStatus.init === 'function') XKeen.features.serviceStatus.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.localIO && typeof XKeen.localIO.init === 'function') XKeen.localIO.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.github && typeof XKeen.github.init === 'function') XKeen.github.init({ repoUrl: window.XKEEN_GITHUB_REPO_URL || '' });
    });
    safe(() => {
      if (window.XKeen && XKeen.backups && typeof XKeen.backups.init === 'function') XKeen.backups.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.jsonEditor && typeof XKeen.jsonEditor.init === 'function') XKeen.jsonEditor.init();
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.xkeenTexts && typeof XKeen.features.xkeenTexts.init === 'function') {
        XKeen.features.xkeenTexts.init();
      }
    });
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.commandsList && typeof XKeen.features.commandsList.init === 'function') {
        XKeen.features.commandsList.init();
      }
    });

    safe(() => {
      if (window.XKeen && XKeen.terminal && typeof XKeen.terminal.init === 'function') XKeen.terminal.init();
    });
  }

  function init() {
    if (!isPanelPage()) return;

    // Initialize all modular features
    initModules();

    // Tabs (replaces inline onclick="showView(...)")
    wireTabs();

    // Expose the new API + legacy alias (for compatibility)
    window.XKeen = window.XKeen || {};
    XKeen.ui = XKeen.ui || {};
    XKeen.ui.tabs = XKeen.ui.tabs || {};
    XKeen.ui.tabs.show = showView;
    window.showView = showView;

    // Initial view: keep current .active or default to routing
    const activeBtn = document.querySelector('.top-tab-btn.active[data-view]') || document.querySelector('.top-tab-btn[data-view]');
    const initial = activeBtn && activeBtn.dataset && activeBtn.dataset.view ? activeBtn.dataset.view : 'routing';
    showView(initial);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
