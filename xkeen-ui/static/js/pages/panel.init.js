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
    let name = String(viewName || 'routing');

    const sections = {
      routing: document.getElementById('view-routing'),
      mihomo: document.getElementById('view-mihomo'),
      xkeen: document.getElementById('view-xkeen'),
      'xray-logs': document.getElementById('view-xray-logs'),
      commands: document.getElementById('view-commands'),
      files: document.getElementById('view-files'),
    };

    function isForceHidden(el) {
      try { return !!(el && el.dataset && el.dataset.xkForceHidden === '1'); } catch (e) { return false; }
    }

    // If the requested view is not available (e.g. hidden by env whitelist),
    // fall back to the first available one.
    try {
      const requestedEl = sections[name];
      if (!requestedEl || isForceHidden(requestedEl)) {
        const first = Object.keys(sections).find((k) => {
          const el = sections[k];
          return !!(el && !isForceHidden(el));
        });
        name = first || 'routing';
      }
    } catch (e) {}

    // hide/show sections
    Object.entries(sections).forEach(([key, el]) => {
      if (!el) return;
      if (isForceHidden(el)) {
        el.style.display = 'none';
        return;
      }
      el.style.display = key === name ? 'block' : 'none';
    });

    // active tab state (ignore hidden tabs)
    document.querySelectorAll('.top-tab-btn[data-view]').forEach((btn) => {
      const hidden = (btn.style.display === 'none') || (btn.dataset && btn.dataset.xkForceHidden === '1');
      btn.classList.toggle('active', !hidden && btn.dataset.view === name);
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

    // xray logs: always refresh snapshot when opening the tab.
    // If the user explicitly enabled the "Live" toggle (persisted preference),
    // resume streaming while the tab is visible.
    if (name === 'xray-logs') {
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs) {
        if (typeof XKeen.features.xrayLogs.viewOnce === 'function') safe(() => XKeen.features.xrayLogs.viewOnce());
        if (typeof XKeen.features.xrayLogs.refreshStatus === 'function') safe(() => XKeen.features.xrayLogs.refreshStatus());

        // If the user has the "Live" toggle enabled (persisted preference),
        // resume streaming when the tab becomes visible again.
        try {
          const liveEl = document.getElementById('xray-log-live');
          if (liveEl && liveEl.checked && typeof XKeen.features.xrayLogs.start === 'function') {
            safe(() => XKeen.features.xrayLogs.start());
          }
        } catch (e) {}
      } else {
        if (typeof window.fetchXrayLogsOnce === 'function') safe(() => window.fetchXrayLogsOnce('manual'));
        if (typeof window.refreshXrayLogStatus === 'function') safe(() => window.refreshXrayLogStatus());

        try {
          const liveEl = document.getElementById('xray-log-live');
          if (liveEl && liveEl.checked && typeof window.startXrayLogAuto === 'function') {
            safe(() => window.startXrayLogAuto());
          }
        } catch (e) {}
      }
    } else {
      // Leaving the tab stops any active stream.
      if (window.XKeen && XKeen.features && XKeen.features.xrayLogs && typeof XKeen.features.xrayLogs.stop === 'function') {
        safe(() => XKeen.features.xrayLogs.stop());
      } else if (typeof window.stopXrayLogAuto === 'function') {
        safe(() => window.stopXrayLogAuto());
      }
    }

    // file manager: refresh when tab becomes visible
    if (name === 'files') {
      try {
        if (window.XKeen && XKeen.features && XKeen.features.fileManager && typeof XKeen.features.fileManager.onShow === 'function') {
          safe(() => XKeen.features.fileManager.onShow());
        }
      } catch (e) {}
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
      if (window.XKeen && XKeen.features && XKeen.features.fileManager && typeof XKeen.features.fileManager.init === 'function') {
        XKeen.features.fileManager.init();
      }
    });

    safe(() => {
      if (window.XKeen && XKeen.terminal && typeof XKeen.terminal.init === 'function') XKeen.terminal.init();
    });

    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.donate && typeof XKeen.features.donate.init === 'function') {
        XKeen.features.donate.init();
      }
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
