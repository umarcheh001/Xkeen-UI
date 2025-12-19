(() => {
  window.XKeen = window.XKeen || {};
  XKeen.util = XKeen.util || {};

  // Common helpers moved out of main.js (step 3).
  // Keep backward compatibility via global aliases where useful.

  if (!XKeen.util.escapeHtml) {
    XKeen.util.escapeHtml = function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    };
  }

  // Backward-compatible global alias (main.js historically calls escapeHtml(...)).
  if (typeof window.escapeHtml !== 'function') {
    window.escapeHtml = XKeen.util.escapeHtml;
  }
})();
