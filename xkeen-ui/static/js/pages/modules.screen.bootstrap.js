import './shell.shared.js';
import '../ui/theme.js?v=20260324b';
import '../ui/tooltips_auto.js?v=20260805g';
import '../ui/spinner_fetch.js';
import { initModulesPage, getModulesController } from './modules.init.js';

let modulesTopLevelApi = null;

function scrollState() {
  return { scrollX: window.scrollX || 0, scrollY: window.scrollY || 0 };
}

function adapt(controller) {
  return {
    activate: () => controller.activate(),
    deactivate: () => controller.deactivate(),
    serializeState: () => ({ ...controller.serializeState(), ...scrollState() }),
    restoreState: async (state) => {
      await controller.restoreState(state);
      if (state) window.scrollTo(Number(state.scrollX) || 0, Number(state.scrollY) || 0);
    },
  };
}

export async function bootModulesScreen() {
  const controller = initModulesPage();
  if (controller && !modulesTopLevelApi) modulesTopLevelApi = adapt(controller);
  return modulesTopLevelApi;
}

export function getModulesTopLevelApi() {
  if (!modulesTopLevelApi && getModulesController()) modulesTopLevelApi = adapt(getModulesController());
  return modulesTopLevelApi;
}
