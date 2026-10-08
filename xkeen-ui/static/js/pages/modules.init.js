import { wireTopLevelNavigation } from './top_level_nav.shared.js';

export function initModulesPage() {
  if (!document.getElementById('xk-modules-manager')) return;
  wireTopLevelNavigation(document);
}

export function bootModulesPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModulesPage, { once: true });
    return;
  }
  initModulesPage();
}
