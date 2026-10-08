import { renderInstalled, renderAvailable } from './render.js';
import { reconcileModulesUpdateBadge, reconcileModulesUpdateStatus } from './badge.js';

export function createModuleManagerController({ root, api, pollMs }) {
  const state = { installed: null, status: null, catalog: null, selectedTab: 'installed', plan: null };
  const host = root.querySelector('#modules-card-host');
  const statusHost = root.querySelector('#modules-operation-status');
  const tabs = {
    installed: root.querySelector('#modules-tab-installed'),
    available: root.querySelector('#modules-tab-available'),
  };
  let initialLoad = null;
  let catalogLoad = null;
  let tabsWired = false;
  let active = true;

  function showError(error) {
    const message = error?.message || 'Не удалось загрузить модули.';
    statusHost.textContent = message;
    if (!state.installed && state.selectedTab === 'installed') host.textContent = message;
    if (!state.catalog && state.selectedTab === 'available') host.textContent = message;
  }

  function render() {
    for (const [name, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(state.selectedTab === name));
      tab.classList.toggle('active', state.selectedTab === name);
    }
    host.setAttribute('aria-labelledby', tabs[state.selectedTab].id);
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled);
    } else {
      host.textContent = 'Загрузка модулей…';
    }
  }

  async function toggleEnabled(moduleId, enabled, input) {
    input.disabled = true;
    try {
      await api.setModuleEnabled(moduleId, enabled);
      state.installed = await api.loadInstalled();
      reconcileModulesUpdateBadge(state.installed);
      statusHost.textContent = '';
    } catch (error) {
      showError(error);
    } finally {
      if (active) render();
    }
  }

  async function selectTab(name) {
    if (!tabs[name]) return;
    state.selectedTab = name;
    render();
    if (name === 'available' && !state.catalog) {
      if (!catalogLoad) catalogLoad = api.loadAvailable().then((catalog) => {
        state.catalog = catalog;
        if (active && state.selectedTab === 'available') render();
      }).catch(showError).finally(() => { catalogLoad = null; });
      await catalogLoad;
    }
  }

  function init() {
    if (initialLoad) return initialLoad;
    if (!tabsWired) {
      tabs.installed.addEventListener('click', () => { void selectTab('installed'); });
      tabs.available.addEventListener('click', () => { void selectTab('available'); });
      tabsWired = true;
    }
    render();
    initialLoad = Promise.all([api.loadInstalled(), api.loadStatus()]).then(([installed, status]) => {
      state.installed = installed;
      state.status = status;
      reconcileModulesUpdateBadge(installed);
      reconcileModulesUpdateStatus(status);
      statusHost.textContent = '';
      if (active) render();
    }).catch((error) => { showError(error); initialLoad = null; });
    return initialLoad;
  }

  return {
    init,
    activate() { active = true; render(); return init(); },
    deactivate() { active = false; state.plan = null; },
    serializeState() { return { selectedTab: state.selectedTab }; },
    restoreState(saved) {
      state.plan = null;
      if (saved?.selectedTab === 'available') return selectTab('available');
      return selectTab('installed');
    },
  };
}
