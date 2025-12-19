(() => {
  // backups.html wiring only
  function init() {
    try {
      if (window.XKeen && XKeen.backups && typeof XKeen.backups.init === 'function') {
        XKeen.backups.init();
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
