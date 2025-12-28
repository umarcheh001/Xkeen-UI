(() => {
  function init() {
    try {
      if (window.XKeen && XKeen.features && XKeen.features.devtools && typeof XKeen.features.devtools.init === 'function') {
        XKeen.features.devtools.init();
      }
    } catch (e) {
      console.error(e);
    }

    try {
      if (window.XKeen && XKeen.features && XKeen.features.donate && typeof XKeen.features.donate.init === 'function') {
        XKeen.features.donate.init();
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
