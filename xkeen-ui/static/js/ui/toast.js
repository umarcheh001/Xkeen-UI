(() => {
  window.XKeen = window.XKeen || {};
  XKeen.ui = XKeen.ui || {};

  // Toast UI (moved out of main.js). Keeps backwards compatibility via window.showToast.
  //
  // Back-compat:
  // - legacy code often calls showToast(msg, true/false)
  // - some newer code calls showToast(msg, 'info'|'success'|'error')
  function showToast(message, kind = false) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    let isError = false;
    let iconText = '✅';
    if (typeof kind === 'boolean') {
      isError = kind;
      iconText = isError ? '⚠️' : '✅';
    } else if (typeof kind === 'string') {
      const k = kind.toLowerCase();
      isError = (k === 'error' || k === 'danger' || k === 'fail' || k === 'failed');
      iconText = isError ? '⚠️' : (k === 'info' ? 'ℹ️' : '✅');
    } else {
      // truthy = error (best-effort)
      isError = !!kind;
      iconText = isError ? '⚠️' : '✅';
    }

    const toast = document.createElement('div');
    toast.className = 'toast' + (isError ? ' toast-error' : '');
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = iconText;
    const text = document.createElement('div');
    text.className = 'toast-message';
    text.textContent = String(message ?? '');

    toast.appendChild(icon);
    toast.appendChild(text);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(4px)';
      setTimeout(() => {
        try { toast.remove(); } catch (e) {}
      }, 200);
    }, 3200);
  }

  XKeen.ui.showToast = showToast;
  window.showToast = showToast;

  // Convenience alias for modules: global `toast(msg, kind)`.
  // Kind: boolean or 'info'|'success'|'error'.
  XKeen.ui.toast = showToast;
  window.toast = showToast;
})();
