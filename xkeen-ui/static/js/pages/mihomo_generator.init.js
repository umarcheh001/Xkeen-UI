(() => {
  function runGeneratorInit() {
    try {
      if (window.XKeen && XKeen.features && XKeen.features.mihomoGenerator && typeof XKeen.features.mihomoGenerator.init === 'function') {
        XKeen.features.mihomoGenerator.init();
      }
    } catch (e) {
      console.error(e);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runGeneratorInit, { once: true });
  } else {
    runGeneratorInit();
  }
})();
