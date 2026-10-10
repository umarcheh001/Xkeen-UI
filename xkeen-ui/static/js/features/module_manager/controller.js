import { renderInstalled, renderAvailable, renderPlan, renderOperationStatus, hasOperationStatus, describeLifecycleFailure } from './render.js';
import { clearModulesUpdateBadge, reconcileModulesUpdateBadge, reconcileModulesUpdateCheck, reconcileModulesUpdatePlan, reconcileModulesUpdateStatus } from './badge.js';

// The panel restarts at the end of every operation and after a restart
// request; while it is away the questions to it get rarer, not louder.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const RESTART_WAIT_LIMIT_MS = 90 * 1000;
// From these steps on the runner may be restarting the panel.
const RESTART_STEPS = ['applying', 'state', 'restarting', 'health', 'rolling_back'];

function retryDelay(attempt) { return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]; }

function terminalKey(status) { return status?.operation_id ? `${status.operation_id}:${status.result}` : null; }

function panelRestartedBy(status) {
  return ['committed', 'rolled_back'].includes(status?.result)
    && Array.isArray(status.log) && status.log.some((record) => record?.step === 'restarting');
}

export function createModuleManagerController({ root, api, pollMs, reload = () => window.location.reload() }) {
  const state = {
    installed: null,
    status: null,
    catalog: null,
    selectedTab: 'installed',
    plan: null,
    update: { checked: false, loading: false, error: null },
  };
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
  let restartWait = null;
  let restartTimedOut = false;
  let pollFailures = 0;
  let panelUnreachable = false;
  let statusFresh = false;
  let installedFresh = false;
  let statusChecked = false;
  let statusRefreshPending = false;
  let updateCheckFocusPending = false;

  // An interrupted operation is over: its record is gone and the server
  // has nothing to recover. Only a failed undo leaves the tree to be put back.
  function recoveryRequired() { return state.status?.result === 'rollback_failed'; }
  function mutationsLocked() { return !statusFresh || !installedFresh || busy || restartWait !== null || state.status?.result === 'running' || recoveryRequired(); }
  function canRestart() {
    const statusResult = state.status?.result ?? null;
    return statusFresh && installedFresh && (state.status?.restart_required === true || state.installed?.restart_required === true)
      && [null, 'idle', 'committed', 'rolled_back', 'interrupted'].includes(statusResult)
      && state.installed?.transition_required === false && !restartWait;
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

  // Silence of a panel that is expected to restart is not a failure.
  function markPanelUnreachable() {
    panelUnreachable = true;
    statusFresh = false;
    statusChecked = true;
    closePlan({ force: true });
    clearError();
    if (active) render();
  }

  function waitNotice() {
    if (restartWait) return 'Перезапуск запрошен. Ждём возвращения панели…';
    if (restartTimedOut) return 'Панель не перезапустилась за полторы минуты. Обновите состояние и попробуйте ещё раз.';
    if (!panelUnreachable) return '';
    return RESTART_STEPS.includes(state.status?.step)
      ? 'Панель перезапускается. Ждём её возвращения…'
      : 'Нет связи с панелью. Повторяем запрос…';
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
      refreshStatusButton.hidden = (statusFresh && installedFresh) || !statusChecked || panelUnreachable || restartWait !== null;
      refreshStatusButton.disabled = busy || statusRefreshPending;
    }
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog, requestPlan, actionsDisabled);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled, requestPlan, actionsDisabled, {
        onRestart: requestRestart,
        canRestart: canRestart(),
        onCheckUpdate: requestUpdateCheck,
        update: state.update,
      });
    } else {
      host.textContent = 'Загрузка модулей…';
    }
    if (hasOperationStatus(state.status)) renderOperationStatus(statusHost, state.status, {
      onCancel: requestCancel, onRecovery: requestRecovery,
      busy: !statusFresh || !installedFresh || busy || cancelPending,
    });
    else statusHost.replaceChildren();
    const notice = waitNotice();
    if (notice) {
      const line = document.createElement('p');
      line.className = 'modules-operation-wait';
      line.textContent = notice;
      statusHost.append(line);
    }
    if (updateCheckFocusPending) {
      const updateButton = host.querySelector('.modules-update-check-button:not(:disabled)');
      if (updateButton) {
        updateCheckFocusPending = false;
        updateButton.focus();
      }
    }
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
      if (plan.operation === 'panel-update' && plan.applicable !== true
        && plan.blockers?.some((blocker) => blocker?.code === 'panel_version_current')) {
        // A current panel is an answer to show, not a plan with nothing in it.
        reconcileModulesUpdatePlan(plan);
        clearError();
        returnFocus = null;
        state.update = {
          checked: true, loading: false, error: null, update_available: false, requires_installer: false,
          source_version: plan.source_version, target_version: plan.target_version,
        };
        return;
      }
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
      pollFailures = 0;
      panelUnreachable = false;
      reconcileModulesUpdateStatus(state.status);
      clearError();
    } else invalidateStatus(statusResult.reason);
    if (installedResult.status === 'fulfilled') {
      state.installed = installedResult.value;
      state.update = { checked: false, loading: false, error: null };
      installedFresh = true;
      reconcileModulesUpdateBadge(state.installed);
    } else showError(installedResult.reason);
    if (statusFresh && installedFresh) restartTimedOut = false;
    statusRefreshPending = false;
    if (statusFresh) {
      if (state.status.result === 'running') schedulePoll();
      else {
        cancelPending = false;
        terminalRefreshed = terminalKey(state.status);
      }
    }
    if (active) render();
  }

  function observeStatus(status, operationId) {
    const watched = state.status?.result === 'running' ? state.status.operation_id : null;
    state.status = { ...status, operation_id: status.operation_id || operationId };
    statusFresh = true;
    statusChecked = true;
    pollFailures = 0;
    panelUnreachable = false;
    if (state.status.result !== 'running') cancelPending = false;
    reconcileModulesUpdateStatus(state.status);
    if (active) render();
    if (state.status.result === 'running') {
      schedulePoll();
    } else {
      stopPolling();
      if (active && watched && watched === state.status.operation_id && panelRestartedBy(state.status)) {
        // The operation this page was watching restarted the panel: other
        // modules are active now and, after an update, other scripts.
        reload();
        return;
      }
      const terminal = terminalKey(state.status);
      if (active && terminal && terminalRefreshed !== terminal) {
        terminalRefreshed = terminal;
        void refreshInstalledAfterTerminal();
      }
    }
  }

  function schedulePoll() {
    if (!active || state.status?.result !== 'running' || pollTimer !== null) return;
    const generation = pollGeneration;
    const interval = pollMs > 0 ? pollMs : 1000;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!active || generation !== pollGeneration) return;
      try {
        const status = await api.loadStatus();
        if (active && generation === pollGeneration) observeStatus(status, state.status?.operation_id);
      } catch (error) {
        if (active && generation === pollGeneration) {
          pollFailures += 1;
          if (error?.code === 'network_error') markPanelUnreachable();
          else invalidateStatus(error);
          schedulePoll();
        }
      }
    }, pollFailures ? Math.max(interval, retryDelay(pollFailures)) : interval);
  }

  // A restart was asked for: the panel goes away and comes back with other
  // modules active, so the page is loaded anew once it answers again.
  function awaitRestartedPanel() {
    stopPolling();
    restartTimedOut = false;
    restartWait = { sawOutage: false, probes: 0, deadline: Date.now() + RESTART_WAIT_LIMIT_MS };
    scheduleRestartProbe();
  }

  function scheduleRestartProbe() {
    if (!active || !restartWait || pollTimer !== null) return;
    const generation = pollGeneration;
    const wait = restartWait;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      if (!active || generation !== pollGeneration || restartWait !== wait) return;
      wait.probes += 1;
      const [installedResult, statusResult] = await Promise.allSettled([api.loadInstalled(), api.loadStatus()]);
      if (!active || generation !== pollGeneration || restartWait !== wait) return;
      if (installedResult.status === 'rejected' || statusResult.status === 'rejected') wait.sawOutage = true;
      else if (wait.sawOutage || (installedResult.value.restart_required !== true && statusResult.value.restart_required !== true)) {
        reload();
        return;
      }
      if (Date.now() >= wait.deadline) {
        // Nothing restarted it. The switches come back once the state is read again.
        restartWait = null;
        restartTimedOut = true;
        statusFresh = false;
        installedFresh = false;
        statusChecked = true;
        render();
        return;
      }
      scheduleRestartProbe();
    }, retryDelay(wait.probes));
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
    if (!statusFresh || !installedFresh || !recoveryRequired() || busy) return;
    busy = true;
    render();
    try {
      await api.recover();
      clearError();
      // The same operation has another outcome now, and the polling may
      // have counted it as seen: what is installed is read anew.
      await refreshInstalledAfterTerminal();
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
        clearError();
        awaitRestartedPanel();
      }
    } catch (error) { showError(error); }
    finally { busy = false; if (active) render(); }
  }

  async function requestUpdateCheck(event) {
    if (!state.installed?.lifecycle?.available || busy || state.update.loading) return;
    const trigger = event?.currentTarget;
    state.update = { ...state.update, loading: true, error: null };
    render();
    try {
      const checked = await api.checkPanelUpdate(true);
      state.update = { ...checked, checked: true, loading: false, error: null };
      reconcileModulesUpdateCheck(checked);
      clearError();
    } catch (error) {
      clearModulesUpdateBadge();
      state.update = { ...state.update, checked: false, loading: false, error };
    } finally {
      if (trigger && active) updateCheckFocusPending = true;
      if (active) render();
    }
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
        state.update = { checked: false, loading: false, error: null };
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
      if (restartWait) {
        render();
        scheduleRestartProbe();
        return init();
      }
      if (reentering && initialLoad) {
        await initialLoad;
        await refreshInstalledAfterTerminal();
      }
      render();
      if (state.status?.result === 'running') schedulePoll();
      else if (statusFresh && terminalKey(state.status) && terminalRefreshed !== terminalKey(state.status)) {
        terminalRefreshed = terminalKey(state.status);
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
