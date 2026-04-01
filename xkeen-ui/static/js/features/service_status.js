import { getRestartLogApi as getRestartLogFeatureApi } from './restart_log.js';
import {
  closeXkeenModal,
  dismissXkeenToast,
  getXkeenCommandJobApi,
  getXkeenUiShellApi,
  openXkeenModal,
  toastXkeen,
} from './xkeen_runtime.js';

let serviceStatusModuleApi = null;

(() => {
  // XKeen service status lamp + core selection modal
  // Public API:
  //   serviceStatusApi.init({ intervalMs?: number })
  //   serviceStatusApi.refresh({ silent?: boolean })
  //
  let _inited = false;
  let _pollTimer = null;
  let _coreModalLoading = false;
  let _shellUnsubscribe = null;
  let _activeControlPromise = null;
  let _controlRequestSeq = 0;


  function $(id) {
    return document.getElementById(id);
  }

  function getUiShellApi() {
    return getXkeenUiShellApi();
  }

  function getCommandJobApi() {
    try {
      const api = getXkeenCommandJobApi();
      return api && typeof api.waitForCommandJob === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function getRestartLogApi() {
    try {
      const api = getRestartLogFeatureApi();
      return api && typeof api.load === 'function' ? api : null;
    } catch (e) {}
    return null;
  }

  function showModal(modal, source) {
    if (!modal) return false;
    return openXkeenModal(modal, source || 'service_status', true);
  }

  function hideModal(modal, source) {
    if (!modal) return false;
    return closeXkeenModal(modal, source || 'service_status', false);
  }

  function normalizeCore(core) {
    const value = String(core || '').trim().toLowerCase();
    if (!value) return '';
    return value === 'mihomo' ? 'mihomo' : 'xray';
  }

  function readShellSnapshot() {
    const api = getUiShellApi();
    if (api) return api.getState();
    return {
      serviceStatus: '',
      currentCore: '',
      version: {
        currentLabel: '',
        currentCommit: '',
        currentBuiltAt: '',
        latestLabel: '',
        latestPublishedAt: '',
        channel: '',
      },
      control: { pending: false, action: '', requestId: 0 },
      loading: {
        serviceStatus: false,
        currentCore: true,
        update: true,
      },
      update: { visible: false, hasUpdate: false, label: '', title: '' },
    };
  }

  function patchShellSnapshot(patch, meta) {
    const api = getUiShellApi();
    if (!api) return readShellSnapshot();
    return api.patchState(patch, meta);
  }

  function normalizeAction(action) {
    const value = String(action || '').trim().toLowerCase();
    return value === 'start' || value === 'stop' || value === 'restart' ? value : '';
  }

  function readControlSnapshot(snapshot) {
    const shell = snapshot || readShellSnapshot();
    const control = shell && shell.control ? shell.control : {};
    const requestId = Number(control.requestId);

    return {
      pending: !!control.pending,
      action: normalizeAction(control.action),
      requestId: Number.isFinite(requestId) ? Math.max(0, Math.floor(requestId)) : 0,
    };
  }

  function isControlPending() {
    return !!readControlSnapshot().pending;
  }

  function isActiveControlRequest(requestId) {
    const current = readControlSnapshot();
    return !!requestId && current.pending && current.requestId === Number(requestId);
  }

  function nextControlRequestId() {
    _controlRequestSeq += 1;
    return _controlRequestSeq;
  }

  function expectedStateForAction(action) {
    const normalized = normalizeAction(action);
    return normalized === 'stop' ? 'stopped' : 'running';
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });
  }

  function applyServiceShellPatch(status, core, controlPatch, meta) {
    const metaOptions = meta && typeof meta === 'object' ? Object.assign({}, meta) : {};
    const patch = {};

    if (typeof status !== 'undefined') {
      patch.serviceStatus = String(status || '');
    }
    if (typeof core !== 'undefined') {
      patch.currentCore = normalizeCore(core);
    }
    if (controlPatch && typeof controlPatch === 'object' && !Array.isArray(controlPatch)) {
      patch.control = controlPatch;
    }

    if (metaOptions.loading && typeof metaOptions.loading === 'object') {
      patch.loading = metaOptions.loading;
    }

    try { delete metaOptions.loading; } catch (e) {}

    const snapshot = patchShellSnapshot(patch, metaOptions);
    if (!_shellUnsubscribe) {
      applyXkeenServiceShell(snapshot);
    }
    return snapshot;
  }

  function beginControlLifecycle(action) {
    const normalizedAction = normalizeAction(action);
    if (!normalizedAction) return null;

    const current = readShellSnapshot();
    const control = readControlSnapshot(current);
    if (control.pending) return null;

    const requestId = nextControlRequestId();
    applyServiceShellPatch('pending', current.currentCore, {
      pending: true,
      action: normalizedAction,
      requestId,
    }, {
      source: 'service_status_control_pending',
      action: normalizedAction,
      requestId,
      loading: { currentCore: true },
    });

    return {
      action: normalizedAction,
      requestId,
    };
  }

  async function fetchServiceStatusSnapshot() {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          try { controller.abort(); } catch (e) {}
        }, 2500)
      : null;

    let res;
    try {
      res = await fetch('/api/xkeen/status', {
        cache: 'no-store',
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!res.ok) throw new Error('status http error: ' + res.status);
    const data = await res.json().catch(() => ({}));

    return {
      serviceStatus: data && data.running ? 'running' : 'stopped',
      currentCore: normalizeCore(data && data.core ? data.core : null),
    };
  }

  async function clearRestartLogUi() {
    const restartLog = getRestartLogApi();
    if (!restartLog) return;
    try {
      if (typeof restartLog.clear === 'function') {
        restartLog.clear();
        return;
      }
    } catch (e) {}
    try {
      if (typeof restartLog.setRaw === 'function') restartLog.setRaw('');
    } catch (e2) {}
  }

  async function appendRestartLogUi(chunk) {
    if (!chunk) return;
    const restartLog = getRestartLogApi();
    if (!restartLog) return;
    try {
      if (typeof restartLog.append === 'function') {
        restartLog.append(String(chunk));
        return;
      }
    } catch (e) {}
    try {
      if (typeof restartLog.load === 'function') restartLog.load();
    } catch (e2) {}
  }

  async function waitForRestartJob(jobId, onChunk) {
    const CJ = getCommandJobApi();
    if (CJ && typeof CJ.waitForCommandJob === 'function') {
      return CJ.waitForCommandJob(String(jobId), {
        maxWaitMs: 5 * 60 * 1000,
        onChunk: (chunk) => {
          if (!chunk) return;
          try { onChunk(chunk); } catch (e) {}
        }
      });
    }

    let lastLen = 0;
    while (true) {
      const res = await fetch(`/api/run-command/${encodeURIComponent(String(jobId))}`);
      const data = await res.json().catch(() => ({}));
      const out = (data && typeof data.output === 'string') ? data.output : '';
      if (out.length > lastLen) {
        const chunk = out.slice(lastLen);
        lastLen = out.length;
        if (chunk) {
          try { onChunk(chunk); } catch (e) {}
        }
      }
      if (!res.ok || data.ok === false || data.status === 'finished' || data.status === 'error') {
        return data;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function resolveFinalServiceStatus(action, requestId) {
    const normalizedAction = normalizeAction(action);
    const expected = expectedStateForAction(normalizedAction);
    const attempts = normalizedAction === 'restart' ? 24 : 8;
    const delayMs = normalizedAction === 'restart' ? 800 : 700;
    let lastSnapshot = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!isActiveControlRequest(requestId)) return lastSnapshot;

      try {
        lastSnapshot = await fetchServiceStatusSnapshot();
        if (lastSnapshot && lastSnapshot.serviceStatus === expected) {
          return lastSnapshot;
        }
      } catch (e) {
        if (attempt === attempts - 1) throw e;
      }

      if (attempt < attempts - 1) {
        await sleep(delayMs);
      }
    }

    return lastSnapshot;
  }

  function toast(message, kindOrOptions) {
    return toastXkeen(message, kindOrOptions);
  }

  function notifyServiceActionPending(action) {
    const message = action === 'start'
      ? 'Запускаем xkeen...'
      : action === 'stop'
        ? 'Останавливаем xkeen...'
        : 'Перезапускаем xkeen...';

    return toast({
      id: 'xkeen-service-action',
      message,
      kind: 'info',
      sticky: false,
      durationMs: action === 'restart' ? 40000 : 20000,
      dedupeWindowMs: 0,
    });
  }

  function notifyServiceActionResult(message, ok) {
    try { dismissXkeenToast('xkeen-service-action'); } catch (e) {}

    return toast({
      id: 'xkeen-service-action',
      message: String(message || ''),
      kind: ok ? 'success' : 'error',
      sticky: false,
      durationMs: ok ? 3200 : 4200,
      dedupeWindowMs: 0,
    });
  }

  function isAbortLikeError(error) {
    try {
      return !!(error && String(error.name || '') === 'AbortError');
    } catch (e) {}
    return false;
  }

  function isTransientControlTransportError(error) {
    if (isAbortLikeError(error)) return true;

    const message = (() => {
      try {
        if (!error) return '';
        if (typeof error.message === 'string') return error.message;
        return String(error || '');
      } catch (e) {
        return '';
      }
    })();

    if (/fetch\s+is\s+aborted/i.test(message)) return true;
    if (/failed\s+to\s+fetch/i.test(message)) return true;
    if (/network\s*error/i.test(message)) return true;
    if (/network\s*request\s*failed/i.test(message)) return true;
    if (/load\s+failed/i.test(message)) return true;
    if (/the\s+network\s+connection\s+was\s+lost/i.test(message)) return true;
    if (/the\s+operation\s+could\s+not\s+be\s+completed/i.test(message)) return true;

    try {
      return typeof TypeError !== 'undefined' && error instanceof TypeError;
    } catch (e) {}
    return false;
  }

  function controlRequestTimeoutMs(action) {
    return normalizeAction(action) === 'restart' ? 25000 : 12000;
  }

  async function postControlRequest(url, action) {
    const timeoutMs = controlRequestTimeoutMs(action);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => {
          try { controller.abort(); } catch (e) {}
        }, timeoutMs)
      : null;

    try {
      return await fetch(url, {
        method: 'POST',
        signal: controller ? controller.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function readControlResponseData(res, action) {
    if (!res || typeof res.json !== 'function') return {};

    const timeoutMs = normalizeAction(action) === 'stop' ? 1200 : 1800;
    let timer = null;

    try {
      return await Promise.race([
        res.json().catch(() => ({})),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ __xkTimedOut: true }), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function controlActionTimeoutMessage(action) {
    return action === 'start'
      ? 'Истекло время ожидания запуска xkeen.'
      : action === 'stop'
        ? 'Истекло время ожидания остановки xkeen.'
        : 'Истекло время ожидания перезапуска xkeen.';
  }

  // ---------- Xkeen control (start/stop/restart) ----------

  function shouldAutoRestartAfterSave() {
    const cb = $('global-autorestart-xkeen');
    return !!(cb && cb.checked);
  }

  function getStatusElForControl() {
    // Prefer routing-status on panel; fall back to xkeen-status on xkeen.html.
    return $('routing-status') || $('xkeen-status') || null;
  }

  function controlStatusTextForState(state, action) {
    const normalizedState = String(state || '').trim().toLowerCase();
    const normalizedAction = normalizeAction(action);

    if (normalizedState === 'pending') {
      return normalizedAction === 'start'
        ? 'xkeen: запускаем...'
        : normalizedAction === 'stop'
          ? 'xkeen: останавливаем...'
          : normalizedAction === 'restart'
            ? 'xkeen: перезапускаем...'
            : 'xkeen: ожидаем...';
    }
    if (normalizedState === 'running') return 'xkeen: работает';
    if (normalizedState === 'stopped') return 'xkeen: остановлен';
    if (normalizedState === 'error') return 'xkeen: ошибка';
    return '';
  }

  function controlActionSuccessMessage(action) {
    return action === 'start'
      ? 'xkeen запущен.'
      : action === 'stop'
        ? 'xkeen остановлен.'
        : 'xkeen перезапущен.';
  }

  function controlActionErrorMessage(action) {
    return action === 'start'
      ? 'Не удалось запустить xkeen.'
      : action === 'stop'
        ? 'Не удалось остановить xkeen.'
        : 'Не удалось перезапустить xkeen.';
  }

  function controlActionMismatchMessage(action, finalState) {
    const state = String(finalState || 'неизвестно');
    return action === 'start'
      ? `Запросили запуск xkeen, но сервис сейчас: ${state}.`
      : action === 'stop'
        ? `Запросили остановку xkeen, но сервис сейчас: ${state}.`
        : `Запросили перезапуск xkeen, но сервис сейчас: ${state}.`;
  }

  async function finalizeControlLifecycle(action, requestId, outcome) {
    const details = outcome && typeof outcome === 'object' ? outcome : {};
    const requestAccepted = !!details.requestAccepted;
    const transportLost = !!details.transportLost;
    const fallbackMessage = details.fallbackMessage || '';
    let finalSnapshot = null;

    try {
      finalSnapshot = (requestAccepted || transportLost)
        ? await resolveFinalServiceStatus(action, requestId)
        : await fetchServiceStatusSnapshot().catch(() => null);
    } catch (e) {
      finalSnapshot = null;
    }

    if (!isActiveControlRequest(requestId)) return false;

    if (finalSnapshot && finalSnapshot.serviceStatus) {
      applyServiceShellPatch(finalSnapshot.serviceStatus, finalSnapshot.currentCore, {
        pending: false,
        action: '',
        requestId: 0,
      }, {
        source: 'service_status_control_resolved',
        action,
        requestId,
        loading: { currentCore: false },
      });

      if (requestAccepted || transportLost) {
        const matches = finalSnapshot.serviceStatus === expectedStateForAction(action);
        const message = matches
          ? controlActionSuccessMessage(action)
          : (fallbackMessage || controlActionMismatchMessage(action, finalSnapshot.serviceStatus));
        try { notifyServiceActionResult(message, matches); } catch (e) {}
        return matches;
      }

      try { notifyServiceActionResult(fallbackMessage || controlActionErrorMessage(action), false); } catch (e2) {}
      return false;
    }

    applyServiceShellPatch('error', undefined, {
      pending: false,
      action: '',
      requestId: 0,
    }, {
      source: 'service_status_control_error',
      action,
      requestId,
      loading: { currentCore: false },
    });
    try { notifyServiceActionResult(fallbackMessage || 'Ошибка управления xkeen.', false); } catch (e3) {}
    return false;
  }

  function controlXkeen(action) {
    const normalizedAction = normalizeAction(action);
    const map = {
      start: '/api/xkeen/start',
      stop: '/api/xkeen/stop',
      restart: '/api/restart',
    };
    const url = map[normalizedAction];
    if (!url) return Promise.resolve(false);
    if (isControlPending()) return _activeControlPromise || Promise.resolve(false);

    const lifecycle = beginControlLifecycle(normalizedAction);
    if (!lifecycle) return _activeControlPromise || Promise.resolve(false);

    const statusEl = getStatusElForControl();
    if (statusEl) statusEl.textContent = controlStatusTextForState('pending', normalizedAction);
    try { notifyServiceActionPending(normalizedAction); } catch (e) {}

    const requestPromise = (async () => {
      try {
        if (normalizedAction === 'start' || normalizedAction === 'restart') {
          const isRestartAction = normalizedAction === 'restart';
          const controlIntro = isRestartAction
            ? '⏳ Запуск xkeen -restart (job)…\n'
            : '⏳ Запуск xkeen -start (job)…\n';
          const controlFailureText = isRestartAction
            ? 'Ошибка перезапуска xkeen'
            : 'Ошибка запуска xkeen';

          try { await clearRestartLogUi(); } catch (e) {}
          try { await appendRestartLogUi(controlIntro); } catch (e2) {}

          const res = isRestartAction
            ? await fetch('/api/run-command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ flag: '-restart', pty: true }),
            })
            : await fetch('/api/run-command', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ flag: '-start', pty: true }),
            });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || !data.job_id) {
            const failureMessage = data && data.error
              ? String(data.error)
              : controlActionErrorMessage(normalizedAction);
            const settled = await finalizeControlLifecycle(normalizedAction, lifecycle.requestId, {
              requestAccepted: false,
              fallbackMessage: failureMessage,
            });
            if (statusEl) {
              const finalShell = readShellSnapshot();
              statusEl.textContent = controlStatusTextForState(finalShell.serviceStatus, normalizedAction)
                || failureMessage;
            }
            return settled;
          }

          const jobId = String(data.job_id || '');
          const result = await waitForRestartJob(jobId, (chunk) => {
            try { void appendRestartLogUi(chunk); } catch (e) {}
          });
          const ok = !!(result && result.ok);
          const jobError = result && (result.error || result.message)
            ? String(result.error || result.message)
            : '';
          const exitCode = result && typeof result.exit_code === 'number'
            ? result.exit_code
            : null;
          const failureMessage = ok
            ? ''
            : (jobError || (exitCode !== null
              ? `${controlFailureText} (exit_code=${exitCode}).`
              : controlActionErrorMessage(normalizedAction)));

          const settled = await finalizeControlLifecycle(normalizedAction, lifecycle.requestId, {
            requestAccepted: true,
            fallbackMessage: failureMessage,
          });
          if (statusEl) {
            const finalShell = readShellSnapshot();
            statusEl.textContent = controlStatusTextForState(finalShell.serviceStatus, normalizedAction)
              || (settled
                ? controlActionSuccessMessage(normalizedAction)
                : (failureMessage || controlActionErrorMessage(normalizedAction)));
          }
          return settled;
        }

        const res = await postControlRequest(url, normalizedAction);
        const data = await readControlResponseData(res, normalizedAction);
        const ok = !!res.ok && (!data || data.ok !== false);
        const failureMessage = ok
          ? ''
          : (data && data.error ? String(data.error) : controlActionErrorMessage(normalizedAction));


        const settled = await finalizeControlLifecycle(normalizedAction, lifecycle.requestId, {
          requestAccepted: ok,
          fallbackMessage: failureMessage,
        });
        if (statusEl) {
          const finalShell = readShellSnapshot();
          statusEl.textContent = controlStatusTextForState(finalShell.serviceStatus, normalizedAction)
            || (settled
              ? controlActionSuccessMessage(normalizedAction)
              : (failureMessage || controlActionErrorMessage(normalizedAction)));
        }
        return settled;
      } catch (e) {
        const abortLike = isAbortLikeError(e);
        const transportLost = isTransientControlTransportError(e);
        if (!transportLost) {
          console.error(e);
        }
        const message = abortLike
          ? controlActionTimeoutMessage(normalizedAction)
          : 'Ошибка управления xkeen.';
        const settled = await finalizeControlLifecycle(normalizedAction, lifecycle.requestId, {
          requestAccepted: false,
          transportLost,
          fallbackMessage: message,
        });
        if (statusEl) {
          const finalShell = readShellSnapshot();
          statusEl.textContent = controlStatusTextForState(finalShell.serviceStatus, normalizedAction) || message;
        }
        return settled;
      }
    })();

    const exposedPromise = requestPromise.finally(() => {
      if (_activeControlPromise === exposedPromise) {
        _activeControlPromise = null;
      }
    });

    _activeControlPromise = exposedPromise;
    return _activeControlPromise;
  }

  function bindControlButtons() {
    const startBtn = $('xkeen-start-btn');
    const stopBtn = $('xkeen-stop-btn');
    const restartBtn = $('xkeen-restart-btn');

    if (startBtn && (!startBtn.dataset || startBtn.dataset.xkeenBound !== '1')) {
      startBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (startBtn.disabled) return;
        void controlXkeen('start');
      });
      if (startBtn.dataset) startBtn.dataset.xkeenBound = '1';
    }

    if (stopBtn && (!stopBtn.dataset || stopBtn.dataset.xkeenBound !== '1')) {
      stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (stopBtn.disabled) return;
        void controlXkeen('stop');
      });
      if (stopBtn.dataset) stopBtn.dataset.xkeenBound = '1';
    }

    if (restartBtn && (!restartBtn.dataset || restartBtn.dataset.xkeenBound !== '1')) {
      restartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (restartBtn.disabled) return;
        void controlXkeen('restart');
      });
      if (restartBtn.dataset) restartBtn.dataset.xkeenBound = '1';
    }
  }

  function bindGlobalAutorestartCheckbox() {
    const cb = $('global-autorestart-xkeen');
    if (!cb) return;

    try {
      if (window.localStorage) {
        const stored = localStorage.getItem('xkeen_global_autorestart');
        if (stored === '1') cb.checked = true;
        else if (stored === '0') cb.checked = false;
      }
    } catch (e) {
      // ignore
    }

    if (cb.dataset && cb.dataset.xkeenBound === '1') return;
    cb.addEventListener('change', () => {
      try {
        if (!window.localStorage) return;
        localStorage.setItem('xkeen_global_autorestart', cb.checked ? '1' : '0');
      } catch (e) {
        // ignore
      }
    });
    if (cb.dataset) cb.dataset.xkeenBound = '1';
  }

  function renderXkeenServiceStatus(state, core, controlState) {
    const lamp = $('xkeen-service-lamp');
    const textEl = $('xkeen-service-text');
    const coreEl = $('xkeen-core-text');
    const startBtn = $('xkeen-start-btn');
    const stopBtn = $('xkeen-stop-btn');
    const restartBtn = $('xkeen-restart-btn');
    const control = readControlSnapshot({ control: controlState || {} });
    const pendingAction = control.pending ? control.action : '';

    if (startBtn) {
      const showStart = String(state || '').toLowerCase() === 'stopped';
      startBtn.hidden = !showStart;
      startBtn.setAttribute('aria-hidden', showStart ? 'false' : 'true');
      startBtn.disabled = control.pending;
      startBtn.classList.toggle('loading', control.pending && pendingAction === 'start');
    }

    if (stopBtn) {
      stopBtn.disabled = control.pending || String(state || '') === 'stopped' || String(state || '') === 'pending' || String(state || '') === 'error' || !String(state || '');
      stopBtn.classList.toggle('loading', control.pending && pendingAction === 'stop');
    }

    if (restartBtn) {
      restartBtn.disabled = control.pending || String(state || '') === 'pending' || String(state || '') === 'error' || !String(state || '');
      restartBtn.classList.toggle('loading', control.pending && pendingAction === 'restart');
    }

    if (!lamp || !textEl || !coreEl) return;

    const st = String(state || '');
    lamp.dataset.state = st;

    let text;
    switch (st) {
      case 'running':
        text = 'Сервис запущен';
        break;
      case 'stopped':
        text = 'Сервис остановлен';
        break;
      case 'pending':
        text = 'Проверка статуса...';
        break;
      case 'error':
        text = 'Ошибка статуса';
        break;
      default:
        text = 'Статус неизвестен';
    }

    if (st === 'pending') {
      text = pendingAction === 'start'
        ? '\u0417\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0441\u0435\u0440\u0432\u0438\u0441...'
        : pendingAction === 'stop'
          ? '\u041E\u0441\u0442\u0430\u043D\u0430\u0432\u043B\u0438\u0432\u0430\u0435\u043C \u0441\u0435\u0440\u0432\u0438\u0441...'
          : pendingAction === 'restart'
            ? '\u041F\u0435\u0440\u0435\u0437\u0430\u043F\u0443\u0441\u043A\u0430\u0435\u043C \u0441\u0435\u0440\u0432\u0438\u0441...'
            : text;
    }

    textEl.textContent = text;

    const hasCore = !!core;
    if (hasCore) {
      const label = normalizeCore(core);
      coreEl.textContent = `Ядро: ${label}`;
      coreEl.dataset.core = label;
      coreEl.classList.add('has-core');
      coreEl.disabled = false;
      lamp.title = `${text} (ядро: ${label})`;
    } else {
      // Keep the core button visible/clickable even when core is unknown
      coreEl.textContent = 'Ядро';
      coreEl.dataset.core = '';
      coreEl.classList.remove('has-core');
      coreEl.disabled = false;
      lamp.title = text;
    }
  }

  function applyXkeenServiceShell(snapshot) {
    const shell = snapshot || readShellSnapshot();
    if (!shell.serviceStatus && !shell.currentCore) return;
    renderXkeenServiceStatus(shell.serviceStatus, shell.currentCore, shell.control);
  }

  function ensureShellBinding() {
    if (_shellUnsubscribe) return;

    const api = getUiShellApi();
    if (!api || typeof api.subscribe !== 'function') {
      applyXkeenServiceShell();
      return;
    }

    _shellUnsubscribe = api.subscribe((next) => {
      applyXkeenServiceShell(next);
    }, { immediate: true });
  }

  function setXkeenServiceStatus(state, core, options) {
    const o = options || {};
    const current = readShellSnapshot();
    const currentControl = readControlSnapshot(current);
    const preserveControl = !!o.keepControl || (
      currentControl.pending &&
      String(state || '') === 'pending' &&
      !Object.prototype.hasOwnProperty.call(o, 'pending') &&
      !Object.prototype.hasOwnProperty.call(o, 'action') &&
      !Object.prototype.hasOwnProperty.call(o, 'requestId')
    );

    let nextControl;
    if (preserveControl) {
      nextControl = currentControl;
    } else {
      const nextPending = !!o.pending;
      const nextAction = nextPending ? normalizeAction(o.action) : '';
      const rawRequestId = nextPending
        ? (Object.prototype.hasOwnProperty.call(o, 'requestId') ? o.requestId : currentControl.requestId)
        : 0;
      const parsedRequestId = Number(rawRequestId);

      nextControl = {
        pending: nextPending,
        action: nextAction,
        requestId: nextPending && Number.isFinite(parsedRequestId) ? Math.max(0, Math.floor(parsedRequestId)) : 0,
      };
    }

    return applyServiceShellPatch(
      String(state || ''),
      typeof core === 'undefined' ? undefined : core,
      nextControl,
      {
        source: o.source || 'service_status',
        action: nextControl.action,
        requestId: nextControl.requestId,
        loading: o.loading,
      }
    );
  }

  async function refreshXkeenServiceStatus(opts) {
    const o = opts || {};
    const lamp = $('xkeen-service-lamp');
    if (!lamp) return readShellSnapshot();

    const control = readControlSnapshot();
    if (control.pending && !o.allowPending) {
      return readShellSnapshot();
    }

    // Avoid flicker on periodic polling: show "pending" only on first run or when state is unknown.
    const curState = String(lamp.dataset.state || '');
    if (!o.silent && !control.pending && (!curState || curState === 'pending')) {
      setXkeenServiceStatus('pending', undefined, {
        keepControl: true,
        source: 'service_status_refresh_pending',
      });
    }

    try {
      const snapshot = await fetchServiceStatusSnapshot();
      if (o.requestId && !isActiveControlRequest(o.requestId)) {
        return readShellSnapshot();
      }

      return setXkeenServiceStatus(snapshot.serviceStatus, snapshot.currentCore, {
        pending: false,
        source: 'service_status_refresh',
        loading: { currentCore: false },
      });
    } catch (e) {
      console.error('xkeen status error', e);
      if (o.requestId && !isActiveControlRequest(o.requestId)) {
        return readShellSnapshot();
      }

      return setXkeenServiceStatus('error', undefined, {
        pending: false,
        source: 'service_status_refresh_error',
        loading: { currentCore: false },
      });
    }
  }

  // ---------- Core selection modal ----------

  function openXkeenCoreModal() {
    const modal = $('core-modal');
    const statusEl = $('core-modal-status');
    const confirmBtn = $('core-modal-confirm-btn');
    const coreButtons = document.querySelectorAll('#core-modal .core-option');

    if (!modal || !statusEl || !confirmBtn || !coreButtons.length) return;

    showModal(modal, 'service_status_core_open');
    statusEl.textContent = 'Загрузка списка ядер...';
    confirmBtn.disabled = true;

    coreButtons.forEach((btn) => {
      btn.disabled = true;
      btn.classList.remove('active');
      btn.style.display = 'inline-block';
    });

    _coreModalLoading = true;

    fetch('/api/xkeen/core')
      .then((res) => {
        if (!res.ok) throw new Error('http ' + res.status);
        return res.json().catch(() => ({}));
      })
      .then((data) => {
        _coreModalLoading = false;

        const ok = data && data.ok !== false;
        if (!ok) {
          statusEl.textContent = data && data.error ? `Ошибка: ${data.error}` : 'Не удалось получить список ядер';
          return;
        }

        const cores = Array.isArray(data.cores) ? data.cores : [];
        const current = data.currentCore || null;

        if (cores.length < 2) {
          statusEl.textContent = cores.length
            ? 'Доступно только одно ядро — переключение не требуется'
            : 'Не найдено ни одного ядра';
          confirmBtn.disabled = true;
          coreButtons.forEach((btn) => {
            btn.disabled = true;
          });
          return;
        }

        statusEl.textContent = '';

        let anyVisible = false;
        coreButtons.forEach((btn) => {
          const value = btn.getAttribute('data-core');
          if (!value || !cores.includes(value)) {
            btn.style.display = 'none';
            return;
          }
          anyVisible = true;
          btn.disabled = false;
          if (value === current) btn.classList.add('active');
        });

        confirmBtn.disabled = !anyVisible;
      })
      .catch((err) => {
        console.error('core list error', err);
        _coreModalLoading = false;
        statusEl.textContent = 'Ошибка загрузки списка ядер';
        confirmBtn.disabled = true;
      });
  }

  function closeXkeenCoreModal() {
    const modal = $('core-modal');
    if (!modal) return;
    hideModal(modal, 'service_status_core_close');
  }

  async function confirmXkeenCoreChange() {
    if (_coreModalLoading) return;

    const statusEl = $('core-modal-status');
    const confirmBtn = $('core-modal-confirm-btn');
    const coreButtons = document.querySelectorAll('#core-modal .core-option');

    if (!statusEl || !confirmBtn || !coreButtons.length) return;

    let selectedCore = null;
    coreButtons.forEach((btn) => {
      if (btn.classList.contains('active') && !btn.disabled && btn.style.display !== 'none') {
        selectedCore = btn.getAttribute('data-core');
      }
    });

    if (!selectedCore) {
      statusEl.textContent = 'Пожалуйста, выберите ядро';
      return;
    }

    statusEl.textContent = `Смена ядра на ${selectedCore}...`;
    try {
      toast({
        id: 'xkeen-core-change',
        message: `Смена ядра на ${selectedCore}...`,
        kind: 'info',
        sticky: true,
        dedupeWindowMs: 0,
      });
    } catch (e) {}
    confirmBtn.disabled = true;
    coreButtons.forEach((btn) => {
      btn.disabled = true;
    });

    try {
      const res = await fetch('/api/xkeen/core', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ core: selectedCore }),
      });
      const data = await res.json().catch(() => ({}));
      const ok = data && data.ok !== false;

      if (!ok) {
        statusEl.textContent = data && data.error ? `Ошибка: ${data.error}` : 'Не удалось сменить ядро';
        confirmBtn.disabled = false;
        coreButtons.forEach((btn) => {
          btn.disabled = false;
        });
        toast({
          id: 'xkeen-core-change',
          message: 'Не удалось сменить ядро',
          kind: 'error',
          dedupeWindowMs: 0,
        });
        return;
      }

      toast({
        id: 'xkeen-core-change',
        message: `Ядро изменено на ${selectedCore}`,
        kind: 'success',
        dedupeWindowMs: 0,
      });
      closeXkeenCoreModal();
      try {
        refreshXkeenServiceStatus({ silent: true });
      } catch (e) {}
    } catch (err) {
      console.error('core change error', err);
      statusEl.textContent = 'Ошибка при смене ядра';
      confirmBtn.disabled = false;
      coreButtons.forEach((btn) => {
        btn.disabled = false;
      });
      toast({
        id: 'xkeen-core-change',
        message: 'Не удалось сменить ядро (ошибка сети)',
        kind: 'error',
        dedupeWindowMs: 0,
      });
    }
  }

  function bindCoreModalUI() {
    const coreTextEl = $('xkeen-core-text');
    const closeBtn = $('core-modal-close-btn');
    const cancelBtn = $('core-modal-cancel-btn');
    const confirmBtn = $('core-modal-confirm-btn');
    const coreOptionButtons = document.querySelectorAll('#core-modal .core-option');

    if (coreTextEl) {
      coreTextEl.addEventListener('click', (e) => {
        e.preventDefault();
        openXkeenCoreModal();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeXkeenCoreModal();
      });
    }
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeXkeenCoreModal();
      });
    }
    if (confirmBtn) {
      confirmBtn.addEventListener('click', (e) => {
        e.preventDefault();
        confirmXkeenCoreChange();
      });
    }

    if (coreOptionButtons && coreOptionButtons.length) {
      coreOptionButtons.forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          if (btn.disabled) return;
          coreOptionButtons.forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
        });
      });
    }

  }

  function startPolling(intervalMs) {
    const lamp = $('xkeen-service-lamp');
    if (!lamp) return;

    const ms = typeof intervalMs === 'number' && intervalMs > 1000 ? intervalMs : 15000;

    if (_pollTimer) return;

    // First refresh can show "pending" if state is unknown
    void refreshXkeenServiceStatus({ silent: false });

    _pollTimer = setInterval(() => {
      void refreshXkeenServiceStatus({ silent: true });
    }, ms);
  }

  function stopPolling() {
    if (_pollTimer) {
      try {
        clearInterval(_pollTimer);
      } catch (e) {}
      _pollTimer = null;
    }
  }

  function init(opts) {
    if (_inited) return;
    _inited = true;

    try { ensureShellBinding(); } catch (e) {}

    // Bind only if relevant elements exist; safe on pages without these blocks.
    try {
      bindCoreModalUI();
    } catch (e) {
      // ignore
    }

    try {
      const o = opts || {};
      startPolling(o.intervalMs);
    } catch (e) {
      // ignore
    }

    try { bindControlButtons(); } catch (e) {}
    try { bindGlobalAutorestartCheckbox(); } catch (e) {}
  }

  const api = {
    init,
    isInitialized() {
      return _inited;
    },
    refresh: refreshXkeenServiceStatus,
    set: setXkeenServiceStatus,
    startPolling,
    stopPolling,
    openCoreModal: openXkeenCoreModal,
    closeCoreModal: closeXkeenCoreModal,
    confirmCoreChange: confirmXkeenCoreChange,
  };

  serviceStatusModuleApi = api;
})();

export function getServiceStatusApi() {
  try {
    return serviceStatusModuleApi && typeof serviceStatusModuleApi.init === 'function' ? serviceStatusModuleApi : null;
  } catch (error) {
    return null;
  }
}

export function initServiceStatus(...args) {
  const api = getServiceStatusApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export function refreshServiceStatus(...args) {
  const api = getServiceStatusApi();
  if (!api || typeof api.refresh !== 'function') return null;
  return api.refresh(...args);
}

export const serviceStatusApi = Object.freeze({
  get: getServiceStatusApi,
  init: initServiceStatus,
  refresh: refreshServiceStatus,
});
