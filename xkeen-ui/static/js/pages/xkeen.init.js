(() => {
  // xkeen.html wiring: initialize only the modules needed by the XKeen settings page.

  function isXkeenPage() {
    return !!(
      document.getElementById('xkeen-body') ||
      document.getElementById('port-proxying-editor') ||
      document.getElementById('port-exclude-editor') ||
      document.getElementById('ip-exclude-editor')
    );
  }

  function safe(fn) {
    try { fn(); } catch (e) { console.error(e); }
  }

  function initModules() {
    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.serviceStatus && typeof XKeen.features.serviceStatus.init === 'function') {
        XKeen.features.serviceStatus.init();
      }
    });

    safe(() => {
      if (window.XKeen && XKeen.features && XKeen.features.xkeenTexts && typeof XKeen.features.xkeenTexts.init === 'function') {
        XKeen.features.xkeenTexts.init();
      }
    });
  }

  function init() {
    if (!isXkeenPage()) return;
    initModules();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
