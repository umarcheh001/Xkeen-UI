(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.features = XK.features || {};

  const SH = (XK.features && XK.features.devtoolsShared) ? XK.features.devtoolsShared : {};
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
    const out = byId('dt-ui-status');
    if (out) out.textContent = 'Загрузка…';
    try {
      const data = await getJSON('/api/devtools/ui/status');

      // Dev/desktop: UI often isn't managed via init.d, so show that explicitly.
      const managed = data && data.managed ? String(data.managed) : '';
      const runningVal = (data && Object.prototype.hasOwnProperty.call(data, 'running')) ? data.running : undefined;

      if (managed === 'external' || runningVal === null) {
        if (out) {
          out.textContent = 'UI: managed externally (dev)';
          out.className = 'status warn';
        }
        return;
      }

      const running = !!(data && data.running);
      if (out) {
        out.textContent = running ? 'UI: running' : 'UI: stopped';
        out.className = 'status ' + (running ? 'ok' : 'warn');
      }
    } catch (e) {
      if (out) {
        out.textContent = 'Ошибка: ' + (e && e.message ? e.message : String(e));
        out.className = 'status bad';
      }
    }
  }

  async function runUiAction(action) {
    try {
      const data = await postJSON('/api/devtools/ui/' + encodeURIComponent(action), {});
      if (data && data.ok) {
        toast('UI: ' + action + ' OK');
      } else {
        toast('UI: ' + action + ' error', true);
      }
    } catch (e) {
      toast('UI: ' + action + ' — ' + (e && e.message ? e.message : String(e)), true);
    }
    // status may change quickly
    setTimeout(loadUiStatus, 600);
  }

  function init() {
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
            out.textContent = 'UI: managed externally (dev)';
            out.className = 'status warn';
          }
          const card = byId('dt-service-card');
          if (card && !byId('dt-ui-dev-note')) {
            const note = document.createElement('div');
            note.id = 'dt-ui-dev-note';
            note.className = 'small';
            note.style.marginTop = '8px';
            note.style.opacity = '0.85';
            note.textContent = 'Dev mode: управление сервисом UI недоступно (запуск/остановка делается из вашей среды запуска).';
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

  XK.features.devtoolsService = { init, loadUiStatus };
})();
