import { renderInstalled, renderAvailable, renderPlan, renderOperationStatus, describeLifecycleFailure } from './render.js';
import { reconcileModulesUpdateBadge, reconcileModulesUpdatePlan, reconcileModulesUpdateStatus } from './badge.js';

export function createModuleManagerController({ root, api, pollMs }) {
  const state = { installed: null, status: null, catalog: null, selectedTab: 'installed', plan: null };
  const host = root.querySelector('#modules-card-host');
  const statusHost = root.querySelector('#modules-operation-status');
  const errorHost = root.querySelector('#modules-error');
  const refreshStatusButton = root.querySelector('#modules-refresh-status');
  const dialog = root.querySelector('#modules-plan-confirm');
  const tabs = {
    installed: root.querySelector('#modules-tab-installed'),
    available: root.querySelector('#modules-tab-available'),
  };
  let initialLoad = null;
  let catalogLoad = null;
  let catalogGeneration = 0;
  let tabsWired = false;
  let active = true;
  let busy = false;
  let cancelPending = false;
  let pollTimer = null;
  let pollGeneration = 0;
  let returnFocus = null;
  let terminalRefreshed = null;
  let restartRequested = false;
  let statusFresh = false;
  let installedFresh = false;
  let statusChecked = false;
  let statusRefreshPending = false;

  function recoveryRequired() { return ['interrupted', 'rollback_failed'].includes(state.status?.result); }
  function mutationsLocked() { return !statusFresh || !installedFresh || busy || state.status?.result === 'running' || recoveryRequired(); }
  function canRestart() {
    const statusResult = state.status?.result ?? null;
    return statusFresh && installedFresh && (state.status?.restart_required === true || state.installed?.restart_required === true)
      && [null, 'idle', 'committed', 'rolled_back'].includes(statusResult)
      && state.installed?.transition_required === false && !restartRequested;
  }

  function showError(error) {
    const message = describeLifecycleFailure(error);
    if (errorHost) errorHost.textContent = message;
    if (!state.installed && state.selectedTab === 'installed') host.textContent = message;
    if (!state.catalog && state.selectedTab === 'available') host.textContent = message;
  }

  function clearError() { if (errorHost) errorHost.textContent = ''; }

  function invalidateStatus(error) {
    statusFresh = false;
    statusChecked = true;
    closePlan({ force: true });
    showError(error);
    if (active) render();
  }

  async function refreshStatus() {
    if ((statusFresh && installedFresh) || busy || statusRefreshPending) return;
    busy = true;
    if (refreshStatusButton) refreshStatusButton.disabled = true;
    try {
      await refreshInstalledAfterTerminal();
    } catch (error) { invalidateStatus(error); }
    finally { busy = false; if (active) render(); }
  }

  function stopPolling() {
    pollGeneration += 1;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function render() {
    const catalogAvailable = state.installed?.lifecycle?.available === true;
    for (const [name, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(state.selectedTab === name));
      tab.classList.toggle('active', state.selectedTab === name);
      tab.disabled = name === 'available' && !catalogAvailable;
    }
    host.setAttribute('aria-labelledby', tabs[state.selectedTab].id);
    const actionsDisabled = mutationsLocked();
    if (refreshStatusButton) {
      refreshStatusButton.hidden = (statusFresh && installedFresh) || !statusChecked;
      refreshStatusButton.disabled = busy || statusRefreshPending;
    }
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog, requestPlan, actionsDisabled);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled, requestPlan, actionsDisabled, {
        onRestart: requestRestart,
        canRestart: canRestart(),
      });
    } else {
      host.textContent = 'Загрузка модулей…';
    }
    if (state.status && state.status.result !== 'idle') renderOperationStatus(statusHost, state.status, {
      onCancel: requestCancel, onRecovery: requestRecovery,
      busy: !statusFresh || !installedFresh || busy || cancelPending,
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
      if (error?.code === 'operation_in_progress') await refreshInstalledAfterTerminal();
      else showError(error);
    } finally {
      busy = false;
      if (trigger?.isConnected) trigger.disabled = mutationsLocked();
      if (active && !state.plan) render();
    }
  }

  async function refreshInstalledAfterTerminal() {
    stopPolling();
    closePlan({ restoreFocus: false, force: true });
    state.catalog = null;
    catalogGeneration += 1;
    catalogLoad = null;
    state.selectedTab = 'installed';
    statusFresh = false;
    installedFresh = false;
    statusRefreshPending = true;
    if (active) render();
    const [installedResult, statusResult] = await Promise.allSettled([api.loadInstalled(), api.loadStatus()]);
    if (statusResult.status === 'fulfilled') {
      state.status = statusResult.value;
      statusFresh = true;
      statusChecked = true;
      reconcileModulesUpdateStatus(state.status);
      clearError();
    } else invalidateStatus(statusResult.reason);
    if (installedResult.status === 'fulfilled') {
      state.installed = installedResult.value;
      installedFresh = true;
      reconcileModulesUpdateBadge(state.installed);
    } else showError(installedResult.reason);
    statusRefreshPending = false;
    if (statusFresh) {
      if (state.status.result === 'running') schedulePoll();
      else {
        cancelPending = false;
        terminalRefreshed = state.status.operation_id || null;
      }
    }
    if (active) render();
  }

  function observeStatus(status, operationId) {
    state.status = { ...status, operation_id: status.operation_id || operationId };
    statusFresh = true;
    statusChecked = true;
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
          invalidateStatus(error);
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
      if (error?.code === 'operation_in_progress') await refreshInstalledAfterTerminal();
      else {
        if (['module_plan_stale', 'operation_plan_stale'].includes(error?.code)) closePlan({ force: true });
        else {
          dialog.querySelector('#modules-plan-apply').disabled = false;
          dialog.querySelector('#modules-plan-cancel').disabled = false;
        }
        showError(error);
      }
    } finally {
      busy = false;
      if (active) render();
    }
  }

  async function requestCancel() {
    const operationId = state.status?.operation_id;
    if (!statusFresh || !installedFresh || !operationId || state.status?.result !== 'running' || cancelPending) return;
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
    if (!statusFresh || !installedFresh || state.status?.result !== 'interrupted' || busy) return;
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
    if (name === 'available' && state.installed?.lifecycle?.available !== true) return;
    state.selectedTab = name;
    render();
    if (name === 'available' && !state.catalog) {
      if (!catalogLoad) {
        const generation = catalogGeneration;
        catalogLoad = api.loadAvailable().then((catalog) => {
          if (generation !== catalogGeneration) return;
          state.catalog = catalog;
          clearError();
          if (active && state.selectedTab === 'available') render();
        }).catch((error) => {
          if (generation === catalogGeneration) showError(error);
        }).finally(() => {
          if (generation === catalogGeneration) catalogLoad = null;
        });
      }
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
      refreshStatusButton?.addEventListener('click', () => { void refreshStatus(); });
      tabsWired = true;
    }
    render();
    initialLoad = Promise.allSettled([api.loadInstalled(), api.loadStatus()]).then(([installedResult, statusResult]) => {
      if (statusResult.status === 'fulfilled') {
        state.status = statusResult.value;
        statusFresh = true;
        statusChecked = true;
        reconcileModulesUpdateStatus(state.status);
        clearError();
      } else invalidateStatus(statusResult.reason);
      if (installedResult.status === 'fulfilled') {
        state.installed = installedResult.value;
        installedFresh = true;
        reconcileModulesUpdateBadge(state.installed);
      } else showError(installedResult.reason);
      if (active) {
        render();
        if (statusFresh && state.status?.result === 'running') schedulePoll();
      }
      if (installedResult.status === 'rejected' || statusResult.status === 'rejected') initialLoad = null;
    });
    return initialLoad;
  }

  return {
    init, requestPlan, applyReviewedPlan, refreshInstalledAfterTerminal,
    async activate() {
      const reentering = !active;
      active = true;
      if (reentering && initialLoad) {
        await initialLoad;
        await refreshInstalledAfterTerminal();
      }
      render();
      if (state.status?.result === 'running') schedulePoll();
      else if (statusFresh && state.status?.operation_id && terminalRefreshed !== state.status.operation_id) {
        terminalRefreshed = state.status.operation_id;
        await refreshInstalledAfterTerminal();
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
