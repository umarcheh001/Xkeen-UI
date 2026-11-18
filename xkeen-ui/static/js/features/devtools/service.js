import { getDevtoolsNamespace, getDevtoolsSharedApi, setDevtoolsNamespaceApi } from '../devtools_namespace.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  const DT = getDevtoolsNamespace();

  const SH = getDevtoolsSharedApi() || {};
  let _inited = false;
  let actionPending = false;
  let statusGeneration = 0;
  const toast = SH.toast || function (m) { try { console.log(m); } catch (e) {} };
  const getJSON = SH.getJSON || (async (u) => {
    const r = await fetch(u, { cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const postJSON = SH.postJSON || (async (u, b) => {
    const r = await fetch(u, { cache: 'no-store', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((d && d.error) ? String(d.error) : ('HTTP ' + r.status));
    return d;
  });
  const byId = SH.byId || ((id) => { try { return document.getElementById(id); } catch (e) { return null; } });

  async function loadUiStatus() {
    if (actionPending) return;
    const generation = ++statusGeneration;
    const out = byId('dt-ui-status');
    if (out) out.textContent = 'Загрузка…';
    try {
      const data = await getJSON('/api/devtools/ui/status');
      if (generation !== statusGeneration) return;

      // Dev/desktop: UI often isn't managed via init.d, so show that explicitly.
      const managed = data && data.managed ? String(data.managed) : '';
      const runningVal = (data && Object.prototype.hasOwnProperty.call(data, 'running')) ? data.running : undefined;

      if (managed === 'external' || runningVal === null) {
        if (out) {
          out.textContent = 'Панель управляется извне (режим разработки)';
          out.className = 'status warn';
        }
        return;
      }

      const running = !!(data && data.running);
      if (out) {
        out.textContent = running ? 'Панель работает' : 'Панель остановлена';
        out.className = 'status ' + (running ? 'ok' : 'warn');
      }
    } catch (e) {
      if (generation !== statusGeneration) return;
      if (out) {
        out.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        out.className = 'status bad';
      }
    }
  }

  // Действия сервиса панели называем так же, как подписаны кнопки.
  const ACTION_LABELS = {
    start: 'Запуск панели',
    stop: 'Остановка панели',
    restart: 'Перезапуск панели',
  };

  async function runUiAction(action) {
    if (actionPending) return;
    actionPending = true;
    statusGeneration += 1;
    const label = ACTION_LABELS[action] || action;
    const out = byId('dt-ui-status');
    try {
      const data = await postJSON('/api/devtools/ui/' + encodeURIComponent(action), {});
      if (!data?.ok) {
        toast(label + ': не удалось', true);
      } else if (data.scheduled) {
        toast(label + ': команда принята');
        if (action === 'restart' && data.mode === 'initd') {
          if (out) {
            out.textContent = 'Ожидаем перезапуска панели…';
            out.className = 'status warn';
          }
          const deadline = Date.now() + 30_000;
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 750));
            const status = await getJSON('/api/devtools/ui/status').catch(() => null);
            if (!status?.running || !status.pid || status.pid === data.previous_pid) continue;
            if (out) {
              out.textContent = 'Панель работает';
              out.className = 'status ok';
            }
            return;
          }
          if (out) {
            out.textContent = 'Не удалось подтвердить перезапуск панели';
            out.className = 'status warn';
          }
          return;
        }
        if (action === 'stop') {
          if (out) {
            out.textContent = 'Команда остановки принята';
            out.className = 'status warn';
          }
          return;
        }
      } else {
        toast(label + ': готово');
      }
    } catch (e) {
      toast(label + ': ' + (e && e.message ? e.message : String(e)), true);
    } finally {
      actionPending = false;
    }
    setTimeout(loadUiStatus, 600);
  }

  function init() {
    if (_inited) return;
    _inited = true;

    const btnStart = byId('dt-ui-start');
    const btnStop = byId('dt-ui-stop');
    const btnRestart = byId('dt-ui-restart');
    const btnRefresh = byId('dt-ui-refresh');

    // In dev/desktop runtime the UI process is typically managed externally.
    try {
      getJSON('/api/capabilities').then((cap) => {
        const mode = cap && cap.runtime && cap.runtime.mode ? String(cap.runtime.mode) : '';
        if (mode && mode !== 'router') {
          try { if (btnStart) btnStart.disabled = true; } catch (e) {}
          try { if (btnStop) btnStop.disabled = true; } catch (e) {}
          try { if (btnRestart) btnRestart.disabled = true; } catch (e) {}
          const out = byId('dt-ui-status');
          if (out) {
            out.textContent = 'Панель управляется извне (режим разработки)';
            out.className = 'status warn';
          }
          const card = byId('dt-service-card');
          if (card && !byId('dt-ui-dev-note')) {
            const note = document.createElement('div');
            note.id = 'dt-ui-dev-note';
            note.className = 'small';
            note.style.marginTop = '8px';
            note.style.opacity = '0.85';
            note.textContent = 'Режим разработки: управление сервисом панели недоступно — запуск и остановка делаются из вашей среды запуска.';
            card.appendChild(note);
          }
        }
      }).catch(() => {});
    } catch (e) {}

    if (btnStart) btnStart.addEventListener('click', () => runUiAction('start'));
    if (btnStop) btnStop.addEventListener('click', () => runUiAction('stop'));
    if (btnRestart) btnRestart.addEventListener('click', () => runUiAction('restart'));
    if (btnRefresh) btnRefresh.addEventListener('click', loadUiStatus);

    loadUiStatus();
  }

  setDevtoolsNamespaceApi('devtoolsService', { init, loadUiStatus });
})();
