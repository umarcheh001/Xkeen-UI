import { renderInstalled, renderAvailable, renderPlan, renderOperationStatus, describeLifecycleFailure } from './render.js';
import { reconcileModulesUpdateBadge, reconcileModulesUpdatePlan, reconcileModulesUpdateStatus } from './badge.js';

export function createModuleManagerController({ root, api, pollMs }) {
  const state = { installed: null, status: null, catalog: null, selectedTab: 'installed', plan: null };
  const host = root.querySelector('#modules-card-host');
  const statusHost = root.querySelector('#modules-operation-status');
  const errorHost = root.querySelector('#modules-error');
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
  let restartRequested = false;

  function recoveryRequired() { return ['interrupted', 'rollback_failed'].includes(state.status?.result); }
  function mutationsLocked() { return busy || state.status?.result === 'running' || recoveryRequired(); }
  function canRestart() {
    return state.status?.restart_required === true
      && ['committed', 'rolled_back'].includes(state.status.result)
      && !state.installed?.transition_required && !restartRequested;
  }

  function showError(error) {
    const message = describeLifecycleFailure(error);
    if (errorHost) errorHost.textContent = message;
    if (!state.installed && state.selectedTab === 'installed') host.textContent = message;
    if (!state.catalog && state.selectedTab === 'available') host.textContent = message;
  }

  function clearError() { if (errorHost) errorHost.textContent = ''; }

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
    const actionsDisabled = mutationsLocked();
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog, requestPlan, actionsDisabled);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled, requestPlan, actionsDisabled);
    } else {
      host.textContent = 'Загрузка модулей…';
    }
    if (state.status && state.status.result !== 'idle') renderOperationStatus(statusHost, state.status, {
      onCancel: requestCancel, onRecovery: requestRecovery, onRestart: requestRestart,
      canRestart: canRestart(), busy: busy || cancelPending,
    });
    else statusHost.replaceChildren();
    if (restartRequested) statusHost.append(document.createTextNode('Перезапуск запрошен'));
  }

  function closePlan({ restoreFocus = true, force = false } = {}) {
    if (busy && !force) return;
    state.plan = null;
    if (dialog?.open) dialog.close();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  async function requestPlan(operation, moduleId, trigger) {
    if (mutationsLocked() || !dialog) return;
    busy = true;
    state.plan = null;
    returnFocus = trigger || null;
    if (trigger) trigger.disabled = true;
    try {
      const plan = await api.plan(operation, moduleId);
      if (!active) return;
      state.plan = plan;
      clearError();
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
    state.selectedTab = 'installed';
    const [installedResult, statusResult] = await Promise.allSettled([api.loadInstalled(), api.loadStatus()]);
    if (installedResult.status === 'fulfilled') {
      state.installed = installedResult.value;
      reconcileModulesUpdateBadge(state.installed);
    } else showError(installedResult.reason);
    if (statusResult.status === 'fulfilled') {
      state.status = statusResult.value;
      reconcileModulesUpdateStatus(state.status);
    } else showError(statusResult.reason);
    if (active) render();
  }

  function observeStatus(status, operationId) {
    state.status = { ...status, operation_id: status.operation_id || operationId };
    restartRequested = false;
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
    if (!plan?.applicable || !plan.plan_id || mutationsLocked()) return;
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
    if (mutationsLocked()) return;
    input.disabled = true;
    try {
      await api.setModuleEnabled(moduleId, enabled);
      state.installed = await api.loadInstalled();
      reconcileModulesUpdateBadge(state.installed);
      clearError();
    } catch (error) {
      showError(error);
    } finally {
      if (active) render();
    }
  }

  async function requestRecovery() {
    if (state.status?.result !== 'interrupted' || busy) return;
    busy = true;
    render();
    try {
      const recovered = await api.recover();
      clearError();
      observeStatus(recovered, recovered.operation_id || state.status?.operation_id);
    } catch (error) { showError(error); }
    finally { busy = false; if (active) render(); }
  }

  async function requestRestart() {
    if (!canRestart() || busy) return;
    busy = true;
    render();
    try {
      const response = await api.restart();
      if (response.restart_requested) {
        restartRequested = true;
        clearError();
      }
    } catch (error) { showError(error); }
    finally { busy = false; if (active) render(); }
  }

  async function selectTab(name) {
    if (!tabs[name]) return;
    state.selectedTab = name;
    render();
    if (name === 'available' && !state.catalog) {
      if (!catalogLoad) catalogLoad = api.loadAvailable().then((catalog) => {
        state.catalog = catalog;
        clearError();
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
    initialLoad = Promise.allSettled([api.loadInstalled(), api.loadStatus()]).then(([installedResult, statusResult]) => {
      if (installedResult.status === 'fulfilled') {
        state.installed = installedResult.value;
        reconcileModulesUpdateBadge(state.installed);
      } else showError(installedResult.reason);
      if (statusResult.status === 'fulfilled') {
        state.status = statusResult.value;
        reconcileModulesUpdateStatus(state.status);
      } else showError(statusResult.reason);
      if (active) {
        render();
        if (state.status?.result === 'running') schedulePoll();
      }
      if (installedResult.status === 'rejected' || statusResult.status === 'rejected') initialLoad = null;
    });
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
