(() => {
  // XKeen service status lamp + core selection modal
  // Public API:
  //   XKeen.features.serviceStatus.init({ intervalMs?: number })
  //   XKeen.features.serviceStatus.refresh({ silent?: boolean })
  //
  // Backwards-compat:
  //   window.refreshXkeenServiceStatus / openXkeenCoreModal / closeXkeenCoreModal / confirmXkeenCoreChange

  window.XKeen = window.XKeen || {};
  XKeen.features = XKeen.features || {};
  XKeen.ui = XKeen.ui || {};

  let _inited = false;
  let _pollTimer = null;
  let _coreModalLoading = false;


  function $(id) {
    return document.getElementById(id);
  }

  // ---------- Xkeen control (start/stop/restart) ----------

  function shouldAutoRestartAfterSave() {
    const cb = $('global-autorestart-xkeen');
    return !!(cb && cb.checked);
  }

  // Back-compat: `window.shouldAutoRestartAfterSave()` was defined in main.js.
  if (typeof window.shouldAutoRestartAfterSave !== 'function') {
    window.shouldAutoRestartAfterSave = shouldAutoRestartAfterSave;
  }

  function getStatusElForControl() {
    // Prefer routing-status on panel; fall back to xkeen-status on xkeen.html.
    return $('routing-status') || $('xkeen-status') || null;
  }

  function controlXkeen(action) {
    const map = {
      start: '/api/xkeen/start',
      stop: '/api/xkeen/stop',
      restart: '/api/restart',
    };
    const url = map[action];
    if (!url) return Promise.resolve(false);

    const statusEl = getStatusElForControl();
    if (statusEl) statusEl.textContent = 'xkeen: ' + action + '...';

    return fetch(url, { method: 'POST' })
      .then((res) => res.json().catch(() => ({})))
      .then((data) => {
        const ok = !data || data.ok !== false;

        const base = action === 'start'
          ? 'xkeen started.'
          : action === 'stop'
            ? 'xkeen stopped.'
            : 'xkeen restarted.';

        const err = action === 'start'
          ? 'Failed to start xkeen.'
          : action === 'stop'
            ? 'Failed to stop xkeen.'
            : 'Failed to restart xkeen.';

        const msg = ok ? base : err;
        if (statusEl) statusEl.textContent = msg;

        try { refreshXkeenServiceStatus({ silent: true }); } catch (e) {}

        // Avoid double toasts on restart success; but always show errors.
        if (!ok || action !== 'restart') {
          try { toast(msg, !ok); } catch (e) {}
        }
        if (action === 'restart') {
          try {
            if (window.XKeen && XKeen.features && XKeen.features.restartLog && typeof XKeen.features.restartLog.load === 'function') {
              XKeen.features.restartLog.load();
            } else if (typeof window.loadRestartLog === 'function') {
              window.loadRestartLog();
            }
          } catch (e) {}
        }

        return ok;
      })
      .catch((e) => {
        console.error(e);
        const msg = 'xkeen control error.';
        if (statusEl) statusEl.textContent = msg;
        try { toast(msg, true); } catch (e2) {}
        try { refreshXkeenServiceStatus({ silent: true }); } catch (e3) {}
        return false;
      });
  }

  // Expose for terminal.js and old code.
  window.XKeen = window.XKeen || {};
  XKeen.api = XKeen.api || {};
  XKeen.api.controlXkeen = XKeen.api.controlXkeen || controlXkeen;
  if (typeof window.controlXkeen !== 'function') {
    window.controlXkeen = controlXkeen;
  }

  function bindControlButtons() {
    const startBtn = $('xkeen-start-btn');
    const stopBtn = $('xkeen-stop-btn');
    const restartBtn = $('xkeen-restart-btn');

    if (startBtn && (!startBtn.dataset || startBtn.dataset.xkeenBound !== '1')) {
      startBtn.addEventListener('click', (e) => {
        e.preventDefault();
        controlXkeen('start');
      });
      if (startBtn.dataset) startBtn.dataset.xkeenBound = '1';
    }

    if (stopBtn && (!stopBtn.dataset || stopBtn.dataset.xkeenBound !== '1')) {
      stopBtn.addEventListener('click', (e) => {
        e.preventDefault();
        controlXkeen('stop');
      });
      if (stopBtn.dataset) stopBtn.dataset.xkeenBound = '1';
    }

    if (restartBtn && (!restartBtn.dataset || restartBtn.dataset.xkeenBound !== '1')) {
      restartBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (restartBtn.disabled) return;
        restartBtn.disabled = true;
        restartBtn.classList.add('loading');
        const p = controlXkeen('restart');
        Promise.resolve(p)
          .catch(() => {})
          .finally(() => {
            restartBtn.disabled = false;
            restartBtn.classList.remove('loading');
          });
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

  function setXkeenServiceStatus(state, core) {
    const lamp = $('xkeen-service-lamp');
    const textEl = $('xkeen-service-text');
    const coreEl = $('xkeen-core-text');

    if (!lamp || !textEl || !coreEl) return;

    lamp.dataset.state = String(state || '');

    let text;
    switch (state) {
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

    textEl.textContent = text;

    const hasCore = !!core;
    if (hasCore) {
      const label = core === 'mihomo' ? 'mihomo' : 'xray';
      coreEl.textContent = `Ядро: ${label}`;
      coreEl.dataset.core = label;
      coreEl.classList.add('has-core');
      coreEl.disabled = false;
      lamp.title = `${text} (ядро: ${label})`;
    } else {
      // Keep the core button visible/clickable even when core is unknown
      coreEl.textContent = '';
      coreEl.dataset.core = '';
      coreEl.classList.remove('has-core');
      coreEl.disabled = false;
      lamp.title = text;
    }
  }

  async function refreshXkeenServiceStatus(opts) {
    const o = opts || {};
    const lamp = $('xkeen-service-lamp');
    if (!lamp) return;

    // Avoid flicker on periodic polling: show "pending" only on first run or when state is unknown.
    const curState = String(lamp.dataset.state || '');
    if (!o.silent && (!curState || curState === 'pending')) {
      setXkeenServiceStatus('pending');
    }

    try {
      const res = await fetch('/api/xkeen/status');
      if (!res.ok) throw new Error('status http error: ' + res.status);
      const data = await res.json().catch(() => ({}));

      const running = !!data.running;
      const core = data.core || null;

      setXkeenServiceStatus(running ? 'running' : 'stopped', core);
    } catch (e) {
      console.error('xkeen status error', e);
      setXkeenServiceStatus('error');
    }
  }

  // ---------- Core selection modal ----------

  function openXkeenCoreModal() {
    const modal = $('core-modal');
    const statusEl = $('core-modal-status');
    const confirmBtn = $('core-modal-confirm-btn');
    const coreButtons = document.querySelectorAll('#core-modal .core-option');

    if (!modal || !statusEl || !confirmBtn || !coreButtons.length) return;

    modal.classList.remove('hidden');
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

        statusEl.textContent = 'Выберите ядро XKeen:';

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
    modal.classList.add('hidden');
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
        toast('Не удалось сменить ядро', true);
        return;
      }

      toast(`Ядро изменено на ${selectedCore}`, false);
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
      toast('Не удалось сменить ядро (ошибка сети)', true);
    }
  }

  function bindCoreModalUI() {
    const coreTextEl = $('xkeen-core-text');
    const modal = $('core-modal');
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

    if (modal) {
      modal.addEventListener('click', (e) => {
        // click outside modal-content closes
        if (e.target === modal) closeXkeenCoreModal();
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

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape') {
          const m = $('core-modal');
          if (m && !m.classList.contains('hidden')) {
            e.preventDefault();
            closeXkeenCoreModal();
          }
        }
      },
      { passive: false }
    );
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
    refresh: refreshXkeenServiceStatus,
    set: setXkeenServiceStatus,
    startPolling,
    stopPolling,
    openCoreModal: openXkeenCoreModal,
    closeCoreModal: closeXkeenCoreModal,
    confirmCoreChange: confirmXkeenCoreChange,
  };

  XKeen.features.serviceStatus = api;

  // Backwards compatibility for code still in main.js
  window.refreshXkeenServiceStatus = refreshXkeenServiceStatus;
  window.setXkeenServiceStatus = setXkeenServiceStatus;
  window.openXkeenCoreModal = openXkeenCoreModal;
  window.closeXkeenCoreModal = closeXkeenCoreModal;
  window.confirmXkeenCoreChange = confirmXkeenCoreChange;
})();