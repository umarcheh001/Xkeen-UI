import { editorChangeOf, renderInstalled, renderAvailable, renderCatalogError, renderPlan, renderPlanError, renderOperationDialog, renderOperationStatus, hasOperationStatus, describeLifecycleFailure, renderPageAlert, TILE_REFUSAL_CODES } from './render.js';
import { lifecycleAvailable } from '../panel_summary.js';
import { clearModulesUpdateBadge, reconcileModulesUpdateBadge, reconcileModulesUpdateCheck, reconcileModulesUpdatePlan, reconcileModulesUpdateStatus } from './badge.js';

// The panel restarts at the end of every operation and after a restart
// request; while it is away the questions to it get rarer, not louder.
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 10000];
const RESTART_WAIT_LIMIT_MS = 90 * 1000;
// From these steps on the runner may be restarting the panel.
const RESTART_STEPS = ['applying', 'state', 'restarting', 'health', 'rolling_back'];
// The server keeps the catalog for a day. A screen opened on an older copy
// asks GitHub once more: a beta of this morning is seen without a button.
const KEPT_CHECK_MAX_AGE_S = 60 * 60;

// The operation the window was showing when the panel restarted: after the
// reload the window opens again and tells how it ended.
const DIALOG_OPERATION_KEY = 'xkeen.modules.operationDialog.v1';
// What the window was named after: a transition of the editor variant only.
const DIALOG_EDITOR_CHANGE_KEY = 'xkeen.modules.operationDialogEditor.v1';

function keepDialogOperation(operationId, editorChange = null) {
  try {
    window.sessionStorage.setItem(DIALOG_OPERATION_KEY, operationId);
    if (editorChange) window.sessionStorage.setItem(DIALOG_EDITOR_CHANGE_KEY, JSON.stringify(editorChange));
    else window.sessionStorage.removeItem(DIALOG_EDITOR_CHANGE_KEY);
  } catch (error) { /* no storage: the card on the page tells it */ }
}

// A failure the owner has read and closed. Files are back in place after
// either of these, so the report is only words; a failed undo stays.
const DISMISSED_OPERATION_KEY = 'xkeen.modules.dismissedOperation.v1';
const DISMISSIBLE_RESULTS = new Set(['rolled_back', 'interrupted']);

function dismissedOperation() {
  try { return window.localStorage.getItem(DISMISSED_OPERATION_KEY); } catch (error) { return null; }
}

function rememberDismissedOperation(operationId) {
  try { window.localStorage.setItem(DISMISSED_OPERATION_KEY, operationId); } catch (error) { /* closed until the page reloads */ }
}

function takeDialogOperation() {
  try {
    const operationId = window.sessionStorage.getItem(DIALOG_OPERATION_KEY);
    const rawChange = window.sessionStorage.getItem(DIALOG_EDITOR_CHANGE_KEY);
    window.sessionStorage.removeItem(DIALOG_OPERATION_KEY);
    window.sessionStorage.removeItem(DIALOG_EDITOR_CHANGE_KEY);
    let editorChange = null;
    try {
      const parsed = rawChange ? JSON.parse(rawChange) : null;
      if (parsed && typeof parsed.from === 'string' && typeof parsed.to === 'string') editorChange = { from: parsed.from, to: parsed.to };
    } catch (error) { /* a broken record names the window in general words */ }
    return { operationId, editorChange };
  } catch (error) { return { operationId: null, editorChange: null }; }
}

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
    catalogError: null,
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
  // The window shows a plan, or the operation started from it.
  let dialogMode = null;
  let dialogOperationId = null;
  // Closed in this page even when the browser keeps no storage.
  let dismissedId = null;
  let dialogEditorChange = null;
  let terminalRefreshed = null;
  let restartWait = null;
  let restartTimedOut = false;
  let pollFailures = 0;
  let panelUnreachable = false;
  let statusFresh = false;
  let installedFresh = false;
  let statusChecked = false;
  let statusRefreshPending = false;
  let channelBusy = false;
  let updateCheckFocusPending = false;
  let refreshGeneration = 0;
  let drawnCards = null;
  let drawnStatus = null;
  // The manager refreshes its snapshot after switches and lifecycle actions.
  // A tile menu left open stays open across those redraws; nothing of it is
  // stored on the router.
  const openMenus = new Set();
  // A switch the server refused: said in its tile until dismissed or tried again.
  const refusals = new Map();

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
    if (errorHost) {
      renderPageAlert(errorHost, error, { onRetry: () => { void refreshStatus(); }, onDismiss: clearError });
      syncRefreshControls();
    }
    if (!state.installed && state.selectedTab === 'installed') host.textContent = message;
    if (!state.catalog && state.selectedTab === 'available') host.textContent = message;
  }

  function clearError() {
    if (errorHost) errorHost.replaceChildren();
    syncRefreshControls();
  }

  // A stale screen is refreshed by one button: inside the alert when there is
  // one, on its own otherwise.
  function syncRefreshControls() {
    const canRefresh = !((statusFresh && installedFresh) || !statusChecked || panelUnreachable || restartWait !== null);
    const retry = errorHost?.querySelector('.modules-page-alert-retry');
    if (retry) {
      retry.hidden = !canRefresh;
      retry.disabled = busy || statusRefreshPending;
    }
    if (refreshStatusButton) {
      refreshStatusButton.hidden = !canRefresh || !!retry;
      refreshStatusButton.disabled = busy || statusRefreshPending;
    }
  }

  function dismissRefusal(moduleId) {
    if (!refusals.delete(moduleId)) return;
    if (active) render();
  }

  // Names for the ids the server speaks in: every module the panel knows,
  // then what the catalog offers and what is installed.
  function moduleNames() {
    const names = new Map();
    const known = state.installed?.module_names;
    for (const [id, name] of Object.entries(known && typeof known === 'object' ? known : {})) {
      if (typeof name === 'string' && name) names.set(id, name);
    }
    for (const item of [...(state.catalog?.modules || []), ...(state.installed?.modules || [])]) {
      if (item && typeof item.id === 'string' && item.name) names.set(item.id, String(item.name));
    }
    return names;
  }

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
    if (active) renderAfterStatus();
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

  // What of the state the cards depend on besides the data they show.
  function cardsState() {
    return [state.selectedTab, mutationsLocked(), canRestart(), statusFresh, installedFresh, statusChecked,
      panelUnreachable, restartWait !== null, busy, statusRefreshPending].join('|');
  }

  function render() {
    renderCards();
    renderStatus();
  }

  // The polling brings a status every second. The cards are drawn anew only
  // when it changes what they allow: a redraw takes the focus away.
  function renderAfterStatus() {
    if (cardsState() === drawnCards) renderStatus();
    else render();
  }

  function renderCards() {
    // A local build opens the catalog to look at it; the server gives it no actions.
    const catalogAvailable = lifecycleAvailable(state.installed);
    for (const [name, tab] of Object.entries(tabs)) {
      tab.setAttribute('aria-selected', String(state.selectedTab === name));
      tab.classList.toggle('active', state.selectedTab === name);
      tab.disabled = name === 'available' && !catalogAvailable;
    }
    host.setAttribute('aria-labelledby', tabs[state.selectedTab].id);
    const actionsDisabled = mutationsLocked();
    syncRefreshControls();
    if (state.selectedTab === 'available') {
      if (state.catalog) renderAvailable(host, state.catalog, requestPlan, actionsDisabled, { names: moduleNames(), onRefresh: reloadCatalog });
      // The refusal stays until the next attempt: a redraw must not turn it into "loading".
      else if (state.catalogError) renderCatalogError(host, state.catalogError, reloadCatalog);
      else host.textContent = 'Загрузка каталога…';
    } else if (state.installed) {
      renderInstalled(host, state.installed, toggleEnabled, requestPlan, actionsDisabled, {
        onRestart: requestRestart,
        canRestart: canRestart(),
        onCheckUpdate: requestUpdateCheck,
        update: state.update,
        onEditorVariant: changeEditorVariant,
        onUpdateChannel: requestUpdateChannel,
        channelBusy,
        openMenus,
        refusals,
        onDismissRefusal: dismissRefusal,
      });
    } else {
      host.textContent = 'Загрузка модулей…';
    }
    if (updateCheckFocusPending) {
      const updateButton = host.querySelector('.modules-update-check-button:not(:disabled)');
      if (updateButton) {
        updateCheckFocusPending = false;
        updateButton.focus();
      }
    }
    drawnCards = cardsState();
  }

  function dismissOperation(operationId) {
    dismissedId = operationId;
    rememberDismissedOperation(operationId);
    drawnStatus = null;
    renderStatus();
  }

  function renderStatus() {
    const shown = hasOperationStatus(state.status) ? state.status : null;
    const locked = !statusFresh || !installedFresh || busy || cancelPending;
    const notice = waitNotice();
    const names = moduleNames();
    // The block is a live region: the same words drawn again are read aloud again.
    const drawing = JSON.stringify([shown, locked, notice, shown?.module_id ? names.get(shown.module_id) || null : null, dialogMode, dialogOperationId]);
    if (drawing === drawnStatus) return;
    drawnStatus = drawing;
    if (dialogMode === 'operation' && shown && shown.operation_id === dialogOperationId) {
      renderOperationDialog(dialog, shown, { notice, busy: locked, names, cancelPending, editorChange: dialogEditorChange });
    }
    const focused = statusHost.contains(document.activeElement) ? document.activeElement.textContent : null;
    // The window tells how an operation ended; the page keeps only what the
    // window does not: one still running or one that went wrong and is not closed.
    const dismissible = Boolean(shown?.operation_id) && DISMISSIBLE_RESULTS.has(shown.result);
    const closed = dismissible && (shown.operation_id === dismissedId || shown.operation_id === dismissedOperation());
    if (shown && shown.result !== 'committed' && !closed) renderOperationStatus(statusHost, shown, {
      onCancel: requestCancel, onRecovery: requestRecovery, busy: locked, names,
      onDismiss: dismissible ? () => dismissOperation(shown.operation_id) : null,
    });
    else statusHost.replaceChildren();
    if (notice) {
      const line = document.createElement('p');
      line.className = 'modules-operation-wait';
      line.textContent = notice;
      statusHost.append(line);
    }
    if (focused !== null) {
      Array.from(statusHost.querySelectorAll('button:not(:disabled)')).find((button) => button.textContent === focused)?.focus();
    }
  }

  // The page drops a plan it can no longer trust; an operation stays in its
  // window until the owner closes it or leaves the screen.
  function closePlan({ restoreFocus = true, force = false, operation = false } = {}) {
    if (busy && !force) return;
    if (dialogMode === 'operation' && !operation) return;
    state.plan = null;
    dialogMode = null;
    dialogOperationId = null;
    dialogEditorChange = null;
    drawnStatus = null;
    if (dialog?.open) dialog.close();
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = null;
  }

  function closeDialog() { closePlan({ operation: true }); }

  function openOperationDialog(operationId) {
    if (!dialog || !operationId) return;
    state.plan = null;
    dialogMode = 'operation';
    dialogOperationId = operationId;
    drawnStatus = null;
    if (!dialog.open) dialog.showModal();
    // The button that started it is disabled now: the window keeps the focus.
    dialog.querySelector('#modules-plan-title')?.focus();
  }

  async function requestPlan(operation, moduleId, trigger) {
    if (mutationsLocked() || !dialog) return;
    busy = true;
    state.plan = null;
    if (trigger) returnFocus = trigger;
    if (trigger) trigger.disabled = true;
    try {
      const plan = await api.plan(operation, moduleId);
      if (!active) return;
      if (plan.operation === 'panel-update' && plan.applicable !== true
        && plan.blockers?.some((blocker) => blocker?.code === 'panel_version_current')) {
        // A current panel is an answer to show, not a plan with nothing in it.
        reconcileModulesUpdatePlan(plan, state.installed?.update_channel);
        clearError();
        returnFocus = null;
        state.update = {
          checked: true, loading: false, error: null, update_available: false, requires_installer: false,
          source_version: plan.source_version, target_version: plan.target_version,
          stable_unreleased: plan.blockers.some((blocker) => blocker?.stable_unreleased === true),
        };
        return;
      }
      state.plan = plan;
      dialogMode = 'plan';
      clearError();
      reconcileModulesUpdatePlan(plan, state.installed?.update_channel);
      dialogEditorChange = editorChangeOf(plan, state.installed);
      renderPlan(dialog, plan, moduleNames(), { editorChange: dialogEditorChange });
      if (!dialog.open) dialog.showModal();
      dialog.querySelector('#modules-plan-title').focus();
    } catch (error) {
      if (error?.code === 'operation_in_progress') await refreshInstalledAfterTerminal();
      else showError(error);
    } finally {
      busy = false;
      if (trigger?.isConnected) trigger.disabled = mutationsLocked();
      // A plan asked for again that did not come: the old one is gone with it.
      if (!state.plan && dialogMode === 'plan') closePlan({ force: true });
      if (active && !state.plan) render();
    }
  }

  // A plan that cannot be applied is asked for again from its own window.
  function recheckPlan() {
    const plan = state.plan;
    if (!plan || dialogMode !== 'plan') return;
    void requestPlan(plan.operation, plan.module_id || null, null);
  }

  async function refreshInstalledAfterTerminal({ keepTab = false } = {}) {
    refreshGeneration += 1;
    const generation = refreshGeneration;
    stopPolling();
    closePlan({ restoreFocus: false, force: true });
    // Coming back to the screen is not an operation ending: the tab the owner left is theirs.
    const returnTo = keepTab ? state.selectedTab : 'installed';
    state.catalog = null;
    state.catalogError = null;
    catalogGeneration += 1;
    catalogLoad = null;
    state.selectedTab = 'installed';
    statusFresh = false;
    installedFresh = false;
    statusRefreshPending = true;
    if (active) render();
    const [installedResult, statusResult] = await Promise.allSettled([api.loadInstalled(), api.loadStatus()]);
    // A later reading was started meanwhile: the screen is its to fill.
    if (generation !== refreshGeneration) return;
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
    void loadKeptUpdateCheck();
    if (active && returnTo === 'available' && lifecycleAvailable(state.installed)) await selectTab('available');
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
    if (active) renderAfterStatus();
    if (state.status.result === 'running') {
      schedulePoll();
    } else {
      stopPolling();
      if (active && watched && watched === state.status.operation_id && panelRestartedBy(state.status)) {
        // The operation this page was watching restarted the panel: other
        // modules are active now and, after an update, other scripts.
        if (dialogMode === 'operation' && dialogOperationId === watched) keepDialogOperation(watched, dialogEditorChange);
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
      // The screen was left meanwhile: the operation is told by its card on return.
      if (active) openOperationDialog(applied.operation_id || applied.status?.operation_id);
      observeStatus(applied.status, applied.operation_id);
    } catch (error) {
      if (error?.code === 'operation_in_progress') await refreshInstalledAfterTerminal();
      else {
        if (['module_plan_stale', 'operation_plan_stale'].includes(error?.code)) {
          closePlan({ force: true });
          showError(error);
        } else {
          dialog.querySelector('#modules-plan-apply').disabled = false;
          dialog.querySelector('#modules-plan-cancel').disabled = false;
          // The plan is still open and covers the page: the refusal is said inside it.
          renderPlanError(dialog, error);
        }
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
    const focused = document.activeElement === input;
    // One change at a time: a plan asked for meanwhile would be built on the old set.
    busy = true;
    refusals.delete(moduleId);
    render();
    try {
      await api.setModuleEnabled(moduleId, enabled);
      state.installed = await api.loadInstalled();
      reconcileModulesUpdateBadge(state.installed);
      clearError();
    } catch (error) {
      if (TILE_REFUSAL_CODES.has(error?.code)) {
        refusals.set(moduleId, { code: error.code, message: error.message, enabled });
      } else {
        showError(error);
      }
    } finally {
      busy = false;
      if (active) {
        render();
        // The row is drawn anew: the focus goes back to its switch.
        if (focused) {
          Array.from(host.querySelectorAll('input[role="switch"]')).find((control) => control.dataset.moduleId === moduleId)?.focus();
        }
      }
    }
  }

  async function changeEditorVariant(variant, button) {
    if (mutationsLocked()) return;
    const focused = document.activeElement === button;
    busy = true;
    render();
    try {
      await api.setEditorVariant(variant);
      state.installed = await api.loadInstalled();
      reconcileModulesUpdateBadge(state.installed);
      clearError();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      if (active) {
        render();
        // The row is drawn anew: the focus goes to the variant in force.
        if (focused) host.querySelector('.modules-variant-option[aria-pressed="true"]')?.focus();
      }
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
      reconcileModulesUpdateCheck({ ...checked, channel: state.installed?.update_channel });
      clearError();
    } catch (error) {
      clearModulesUpdateBadge();
      state.update = { ...state.update, checked: false, loading: false, error };
    } finally {
      if (trigger && active) updateCheckFocusPending = true;
      if (active) render();
    }
  }

  // The counter of the summary is filled from the catalog the server keeps for
  // a day. Opening the screen goes to GitHub only when that copy is older than
  // an hour. Silence on failure — the owner checks by the button.
  async function loadKeptUpdateCheck() {
    if (!state.installed?.lifecycle?.available || state.update.loading || state.update.checked) return;
    const installed = state.installed;
    let checked;
    try {
      checked = await api.checkPanelUpdate(false);
      if (state.installed !== installed || state.update.loading || state.update.checked) return;
      state.update = { ...checked, checked: true, loading: false, error: null };
      reconcileModulesUpdateCheck({ ...checked, channel: state.installed?.update_channel });
    } catch (error) {
      return;
    }
    if (active) render();
    const fetchedAt = Number(checked?.fetched_at);
    if (Number.isFinite(fetchedAt) && Date.now() / 1000 - fetchedAt <= KEPT_CHECK_MAX_AGE_S) return;
    const kept = state.update;
    try {
      const fresh = await api.checkPanelUpdate(true);
      // A press of the button or another screen state wins over this answer.
      if (state.installed !== installed || state.update !== kept) return;
      state.update = { ...fresh, checked: true, loading: false, error: null };
      reconcileModulesUpdateCheck({ ...fresh, channel: state.installed?.update_channel });
    } catch (error) {
      return;
    }
    if (active) render();
  }

  async function requestUpdateChannel(channel) {
    if (busy || channelBusy) return null;
    channelBusy = true;
    if (active) render();
    try {
      const result = await api.setUpdateChannel(channel);
      state.installed = await api.loadInstalled();
      // Another channel has its own catalog and its own answer.
      state.update = { checked: false, loading: false, error: null };
      clearModulesUpdateBadge();
      try { window.dispatchEvent(new CustomEvent('xkeen:notification-channel-changed')); } catch (error) {}
      clearError();
      return result;
    } catch (error) {
      showError(error);
      throw error;
    } finally {
      channelBusy = false;
      if (active) render();
      void loadKeptUpdateCheck();
    }
  }

  async function selectTab(name) {
    if (!tabs[name]) return;
    if (name === 'available' && !lifecycleAvailable(state.installed)) return;
    state.selectedTab = name;
    render();
    if (name === 'available' && !state.catalog) {
      if (!catalogLoad) {
        const generation = catalogGeneration;
        state.catalogError = null;
        render();
        catalogLoad = api.loadAvailable().then((catalog) => {
          if (generation !== catalogGeneration) return;
          state.catalog = catalog;
          clearError();
          if (active && state.selectedTab === 'available') render();
        }).catch((error) => {
          if (generation !== catalogGeneration) return;
          state.catalogError = error;
          if (active && state.selectedTab === 'available') render();
        }).finally(() => {
          if (generation === catalogGeneration) catalogLoad = null;
        });
      }
      await catalogLoad;
    }
  }

  function reloadCatalog() {
    if (catalogLoad) return;
    state.catalog = null;
    state.catalogError = null;
    catalogGeneration += 1;
    void selectTab('available');
  }

  function init() {
    if (initialLoad) return initialLoad;
    if (!tabsWired) {
      tabs.installed.addEventListener('click', () => { void selectTab('installed'); });
      tabs.available.addEventListener('click', () => { void selectTab('available'); });
      dialog?.querySelector('#modules-plan-cancel').addEventListener('click', closeDialog);
      dialog?.querySelector('#modules-plan-close')?.addEventListener('click', closeDialog);
      dialog?.querySelector('#modules-plan-recheck')?.addEventListener('click', recheckPlan);
      dialog?.querySelector('#modules-plan-abort')?.addEventListener('click', () => { void requestCancel(); });
      dialog?.querySelector('#modules-plan-apply').addEventListener('click', () => {
        if (dialogMode === 'operation') closeDialog();
        else void applyReviewedPlan();
      });
      dialog?.addEventListener('cancel', (event) => { event.preventDefault(); closeDialog(); });
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
      const { operationId: reopened, editorChange: reopenedChange } = takeDialogOperation();
      if (active && statusFresh && reopened && reopened === state.status?.operation_id && hasOperationStatus(state.status)) {
        dialogEditorChange = reopenedChange;
        openOperationDialog(reopened);
      }
      if (active) {
        render();
        if (statusFresh && state.status?.result === 'running') schedulePoll();
      }
      void loadKeptUpdateCheck();
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
        await refreshInstalledAfterTerminal({ keepTab: true });
      }
      render();
      if (state.status?.result === 'running') schedulePoll();
      else if (statusFresh && terminalKey(state.status) && terminalRefreshed !== terminalKey(state.status)) {
        terminalRefreshed = terminalKey(state.status);
        await refreshInstalledAfterTerminal();
      }
      return init();
    },
    deactivate() { active = false; stopPolling(); closePlan({ restoreFocus: false, force: true, operation: true }); },
    serializeState() { return { selectedTab: state.selectedTab }; },
    restoreState(saved) {
      closePlan({ restoreFocus: false, force: true, operation: true });
      if (saved?.selectedTab === 'available') return selectTab('available');
      return selectTab('installed');
    },
  };
}
