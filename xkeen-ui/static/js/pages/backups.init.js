import '../features/compat/backups.js';
import { initBackups } from '../features/backups.js?v=20260317b';
import { wireTopLevelNavigation } from './top_level_nav.shared.js';

function isBackupsPage() {
  return !!(
    document.querySelector('.xk-backups-page') ||
    document.getElementById('backups-table') ||
    document.getElementById('backups-status')
  );
}

function safe(fn) {
  try {
    fn();
  } catch (error) {
    console.error(error);
  }
}

export function initBackupsPage() {
  if (!isBackupsPage()) return;

  safe(() => {
    wireTopLevelNavigation(document);
  });

  safe(() => {
    initBackups();
  });
}

export function bootBackupsPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBackupsPage, { once: true });
    return;
  }

  initBackupsPage();
}

export default initBackupsPage;
