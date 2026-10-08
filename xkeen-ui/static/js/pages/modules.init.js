import { wireTopLevelNavigation } from './top_level_nav.shared.js';
import { createModuleLifecycleClient } from '../features/module_manager/api.js';
import { createModuleManagerController } from '../features/module_manager/controller.js';

let controller = null;

export function initModulesPage() {
  const root = document.getElementById('xk-modules-manager');
  if (!root) return null;
  wireTopLevelNavigation(document);
  if (!controller) controller = createModuleManagerController({ root, api: createModuleLifecycleClient(), pollMs: 0 });
  void controller.init();
  return controller;
}

export function getModulesController() { return controller; }

export function bootModulesPage() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initModulesPage, { once: true });
    return;
  }
  initModulesPage();
}
