import './shell.shared.js';
import '../ui/theme.js?v=20260324b';
import '../ui/spinner_fetch.js';
import { bootModulesPage } from './modules.init.js';

const modulesTopLevelApi = {
  activate() {},
  deactivate() {},
  serializeState() { return {}; },
  restoreState() {},
};

export async function bootModulesScreen() {
  bootModulesPage();
  return modulesTopLevelApi;
}

export function getModulesTopLevelApi() {
  return modulesTopLevelApi;
}
