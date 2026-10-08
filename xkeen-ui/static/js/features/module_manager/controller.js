import { renderInstalled, renderAvailable, renderPlan, renderOperationStatus } from './render.js';
import { reconcileModulesUpdateBadge, reconcileModulesUpdatePlan, reconcileModulesUpdateStatus } from './badge.js';

export function createModuleManagerController({ root, api, pollMs }) {
  const state = { installed: null, status: null, catalog: null, selectedTab: 'installed', plan: null };
  const host = root.querySelector('#modules-card-host');
  const statusHost = root.querySelector('#modules-operation-status');
  const dialog = root.querySelector('#modules-plan-confirm');
  const tabs = {
    installed: root.querySelector('#modules-tab-installed'),
    available: root.querySelector('#modules-tab-available'),
  };
  let initialLoad = null;
  let catalogLoad = null;
  let tabsWired = false;
  let active = true;
  let busy = false;
  let cancelPending = false;
  let pollTimer = null;
  let pollGeneration = 0;
  let returnFocus = null;
  let terminalRefreshed = null;

  function showError(error) {
    const message = error?.message || 'Не удалось загрузить модули.';
    statusHost.textContent = message;
    if (!state.installed && state.selectedTab === 'installed') host.textContent = message;
    if (!state.catalog && state.selectedTab === 'available') host.textContent = message;
  }

  function stopPolling() {
    pollGeneration += 1;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function render() {
    for (const [name, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(state.selectedTab === name));
      tab.classList.toggle('active', state.selectedTab === name);
    }
    host.setAttribute('aria-labelledby', tabs[state.selectedTab].id);
    const actionsDisabled = busy || state.status?.result === 'running';
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog, requestPlan, actionsDisabled);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled, requestPlan, actionsDisabled);
    } else {
      host.textContent = 'Загрузка модулей…';
    }
    if (state.status && state.status.result !== 'idle') renderOperationStatus(statusHost, state.status, requestCancel, cancelPending);
  }

  function closePlan({ restoreFocus = true, force = false } = {}) {
    if (busy && !force) return;
    state.plan = null;
    if (dialog?.open) dialog.close();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  async function requestPlan(operation, moduleId, trigger) {
    if (busy || state.status?.result === 'running' || !dialog) return;
    busy = true;
    state.plan = null;
    returnFocus = trigger || null;
    if (trigger) trigger.disabled = true;
    try {
      const plan = await api.plan(operation, moduleId);
      if (!active) return;
      state.plan = plan;
      reconcileModulesUpdatePlan(plan);
      renderPlan(dialog, plan);
      dialog.showModal();
      dialog.querySelector('#modules-plan-title').focus();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (trigger?.isConnected) trigger.disabled = false;
    }
  }

  async function refreshInstalledAfterTerminal() {
    state.plan = null;
    state.catalog = null;
    state.selectedTab = 'installed';
    try {
      const [installed, status] = await Promise.all([api.loadInstalled(), api.loadStatus()]);
      state.installed = installed;
      state.status = status;
      reconcileModulesUpdateBadge(installed);
      reconcileModulesUpdateStatus(status);
      if (active) render();
    } catch (error) {
      showError(error);
    }
  }

  function observeStatus(status, operationId) {
    state.status = { ...status, operation_id: status.operation_id || operationId };
    if (state.status.result !== 'running') cancelPending = false;
    reconcileModulesUpdateStatus(state.status);
    if (active) render();
    if (state.status.result === 'running') {
      schedulePoll();
    } else {
      stopPolling();
      const terminalId = state.status.operation_id;
      if (active && terminalId && terminalRefreshed !== terminalId) {
        terminalRefreshed = terminalId;
        void refreshInstalledAfterTerminal();
      }
    }
  }

  function schedulePoll() {
    if (!active || state.status?.result !== 'running' || pollTimer !== null) return;
    const generation = pollGeneration;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!active || generation !== pollGeneration) return;
      try {
        const status = await api.loadStatus();
        if (active && generation === pollGeneration) observeStatus(status, state.status?.operation_id);
      } catch (error) {
        if (active && generation === pollGeneration) {
          showError(error);
          schedulePoll();
        }
      }
    }, pollMs > 0 ? pollMs : 1000);
  }

  async function applyReviewedPlan() {
    const plan = state.plan;
    if (!plan?.applicable || !plan.plan_id || busy || state.status?.result === 'running') return;
    busy = true;
    dialog.querySelector('#modules-plan-apply').disabled = true;
    dialog.querySelector('#modules-plan-cancel').disabled = true;
    try {
      const applied = await api.apply(plan.operation, plan.module_id, plan.plan_id);
      closePlan({ restoreFocus: false, force: true });
      observeStatus(applied.status, applied.operation_id);
    } catch (error) {
      if (['module_plan_stale', 'operation_plan_stale'].includes(error?.code)) closePlan({ force: true });
      else {
        dialog.querySelector('#modules-plan-apply').disabled = false;
        dialog.querySelector('#modules-plan-cancel').disabled = false;
      }
      showError(error);
    } finally {
      busy = false;
      if (active) render();
    }
  }

  async function requestCancel() {
    const operationId = state.status?.operation_id;
    if (!operationId || state.status?.result !== 'running' || cancelPending) return;
    cancelPending = true;
    render();
    try {
      await api.cancel(operationId);
    } catch (error) {
      cancelPending = false;
      showError(error);
    } finally {
      if (active && state.status?.result === 'running') render();
    }
  }

  async function toggleEnabled(moduleId, enabled, input) {
    if (busy || state.status?.result === 'running') return;
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
      dialog?.querySelector('#modules-plan-cancel').addEventListener('click', () => closePlan());
      dialog?.querySelector('#modules-plan-apply').addEventListener('click', () => { void applyReviewedPlan(); });
      dialog?.addEventListener('cancel', (event) => { event.preventDefault(); closePlan(); });
      tabsWired = true;
    }
    render();
    initialLoad = Promise.all([api.loadInstalled(), api.loadStatus()]).then(([installed, status]) => {
      state.installed = installed;
      state.status = status;
      reconcileModulesUpdateBadge(installed);
      reconcileModulesUpdateStatus(status);
      statusHost.textContent = '';
      if (active) {
        render();
        if (status.result === 'running') schedulePoll();
      }
    }).catch((error) => { showError(error); initialLoad = null; });
    return initialLoad;
  }

  return {
    init, requestPlan, applyReviewedPlan, refreshInstalledAfterTerminal,
    activate() {
      active = true;
      render();
      if (state.status?.result === 'running') schedulePoll();
      else if (state.status?.operation_id && terminalRefreshed !== state.status.operation_id) {
        terminalRefreshed = state.status.operation_id;
        void refreshInstalledAfterTerminal();
      }
      return init();
    },
    deactivate() { active = false; stopPolling(); closePlan({ restoreFocus: false, force: true }); },
    serializeState() { return { selectedTab: state.selectedTab }; },
    restoreState(saved) {
      closePlan({ restoreFocus: false, force: true });
      if (saved?.selectedTab === 'available') return selectTab('available');
      return selectTab('installed');
    },
  };
}
