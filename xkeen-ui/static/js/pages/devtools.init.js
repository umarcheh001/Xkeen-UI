import { initDevtools } from '../features/devtools.js?v=20260219a';
import { initDonate } from '../features/donate.js';

function isDevtoolsPage() {
  return !!(
    document.body?.classList.contains('devtools-page') ||
    document.getElementById('dt-tab-tools') ||
    document.getElementById('dt-tab-logs')
  );
}

function safe(fn) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}


export function initDevtoolsPage() {
  if (!isDevtoolsPage()) return;

  safe(() => {
    initDevtools();
  });

  safe(() => {
    initDonate();
  });
}

export function bootDevtoolsPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDevtoolsPage, { once: true });
    return;
  }

  initDevtoolsPage();
}

export default initDevtoolsPage;
