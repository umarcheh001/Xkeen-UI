import { initServiceStatus } from '../features/service_status.js';
import { initXkeenTexts } from '../features/xkeen_texts.js';

function isXkeenPage() {
  return !!(
    document.getElementById('xkeen-body') ||
    document.getElementById('port-proxying-editor') ||
    document.getElementById('port-exclude-editor') ||
    document.getElementById('ip-exclude-editor')
  );
}

function safe(fn) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}

export function initXkeenPage() {
  if (!isXkeenPage()) return;

  safe(() => {
    initServiceStatus();
  });

  safe(() => {
    initXkeenTexts();
  });
}

export function bootXkeenPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initXkeenPage, { once: true });
    return;
  }

  initXkeenPage();
}

export default initXkeenPage;
