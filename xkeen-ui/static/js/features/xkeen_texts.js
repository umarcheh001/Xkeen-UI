(() => {
  window.XKeen = window.XKeen || {};
  XKeen.state = XKeen.state || {};
  XKeen.features = XKeen.features || {};

  XKeen.features.xkeenTexts = (() => {
    let inited = false;

    function shouldRestartAfterSave() {
      const cb = document.getElementById('global-autorestart-xkeen');
      // On xkeen.html this checkbox is absent; default restart=true so changes apply immediately.
      if (!cb) return true;
      return !!cb.checked;
    }

    async function loadText(url, textareaId, statusId, label, stateKey) {
      const ta = document.getElementById(textareaId);
      const statusEl = document.getElementById(statusId);
      if (!ta) return;

      try {
        const res = await fetch(url);
        if (!res.ok) {
          if (statusEl) statusEl.textContent = `Не удалось загрузить ${label}.`;
          return;
        }
        const data = await res.json().catch(() => ({}));
        const text = (data && data.content) ? data.content : '';
        const len = text.length;

        const ed = (XKeen.state && XKeen.state[stateKey]) ? XKeen.state[stateKey] : null;
        if (ed && ed.setValue) ed.setValue(text);
        else ta.value = text;

        if (statusEl) statusEl.textContent = `${label} загружен (${len} байт).`;
      } catch (e) {
        console.error(e);
        if (statusEl) statusEl.textContent = `Ошибка загрузки ${label}.`;
      }
    }

        async function saveText(url, textareaId, statusId, label, stateKey) {
      const ta = document.getElementById(textareaId);
      const statusEl = document.getElementById(statusId);
      if (!ta) return;

      const ed = (XKeen.state && XKeen.state[stateKey]) ? XKeen.state[stateKey] : null;
      const content = (ed && ed.getValue) ? ed.getValue() : ta.value;

      const restart = shouldRestartAfterSave();

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, restart }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok) {
          const msg = `${label} сохранён.`;
          if (statusEl) statusEl.textContent = msg;

          // Если был рестарт — тост покажет spinner_fetch.js (единый тост "сохранено + перезапуск").
          if (!data.restarted) {
            try { toast(msg, false); } catch (e) {}
          }
        } else {
          const msg = 'Ошибка сохранения: ' + ((data && data.error) || res.status);
          if (statusEl) statusEl.textContent = msg;
          try { toast(msg, true); } catch (e) {}
        }
      } catch (e) {
        console.error(e);
        const msg = `Не удалось сохранить ${label}.`;
        if (statusEl) statusEl.textContent = msg;
        try { toast(msg, true); } catch (e2) {}
      }
    }

    function attachEditor(textareaId, stateKey) {
      const ta = document.getElementById(textareaId);
      if (!ta || !window.CodeMirror) return null;

      // Prevent double-init if main.js already created it.
      if (XKeen.state && XKeen.state[stateKey]) return XKeen.state[stateKey];

      const opts = {
        mode: 'shell',
        theme: 'material-darker',
        lineNumbers: true,
        styleActiveLine: true,
        showIndentGuides: true,
        matchBrackets: true,
        showTrailingSpace: true,
        lineWrapping: true,
        tabSize: 2,
        indentUnit: 2,
        indentWithTabs: false,
        viewportMargin: Infinity,
      };

      const ed = CodeMirror.fromTextArea(ta, opts);
      try { ed.getWrapperElement().classList.add('xkeen-cm'); } catch (e) {}
      XKeen.state[stateKey] = ed;
      return ed;
    }

    function wireButton(btnId, handler) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      if (btn.dataset && btn.dataset.xkeenWired === '1') return;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        handler();
      });
      if (btn.dataset) btn.dataset.xkeenWired = '1';
    }

    function init() {
      // Only run on pages where at least one of these editors exists.
      const hasAny =
        document.getElementById('port-proxying-editor') ||
        document.getElementById('port-exclude-editor') ||
        document.getElementById('ip-exclude-editor');

      if (!hasAny) return;
      if (inited) return;
      inited = true;

      // Editors
      const portProxyEd = attachEditor('port-proxying-editor', 'portProxyingEditor');
      const portExcludeEd = attachEditor('port-exclude-editor', 'portExcludeEditor');
      const ipExcludeEd = attachEditor('ip-exclude-editor', 'ipExcludeEditor');

      // Expose for other scripts that rely on main.js lexical vars.
      // main.js will copy from XKeen.state.* when it detects this feature.
      // Still expose as window.* for debugging/legacy.
      if (portProxyEd) window.portProxyingEditor = portProxyEd;
      if (portExcludeEd) window.portExcludeEditor = portExcludeEd;
      if (ipExcludeEd) window.ipExcludeEditor = ipExcludeEd;

      // Save buttons
      wireButton('port-proxying-save-btn', () => saveText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor'));
      wireButton('port-exclude-save-btn', () => saveText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor'));
      wireButton('ip-exclude-save-btn', () => saveText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor'));

      // Initial load
      loadText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor');
      loadText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor');
      loadText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor');

      // Let theme.js sync editors.
      try { document.dispatchEvent(new CustomEvent('xkeen-editors-ready')); } catch (e) {}
    }

    function ensureInited() {
      try { init(); } catch (e) {}
    }

    // Reload helpers (used by GitHub import / local import flows).
    function reloadPortProxying() {
      ensureInited();
      return loadText('/api/xkeen/port-proxying', 'port-proxying-editor', 'port-proxying-status', 'port_proxying.lst', 'portProxyingEditor');
    }

    function reloadPortExclude() {
      ensureInited();
      return loadText('/api/xkeen/port-exclude', 'port-exclude-editor', 'port-exclude-status', 'port_exclude.lst', 'portExcludeEditor');
    }

    function reloadIpExclude() {
      ensureInited();
      return loadText('/api/xkeen/ip-exclude', 'ip-exclude-editor', 'ip-exclude-status', 'ip_exclude.lst', 'ipExcludeEditor');
    }

    function reloadAll() {
      ensureInited();
      return Promise.all([
        reloadPortProxying(),
        reloadPortExclude(),
        reloadIpExclude(),
      ]);
    }

    // Back-compat: templates still call onclick="toggleXkeenSettings()".
    function toggleCard() {
      const body = document.getElementById('xkeen-body');
      const arrow = document.getElementById('xkeen-arrow');
      if (!body || !arrow) return;

      const willOpen = (body.style.display === '' || body.style.display === 'none');
      body.style.display = willOpen ? 'block' : 'none';
      arrow.textContent = willOpen ? '▲' : '▼';

      if (willOpen) {
        ['portProxyingEditor', 'portExcludeEditor', 'ipExcludeEditor'].forEach((k) => {
          try {
            const ed = (window.XKeen && XKeen.state) ? XKeen.state[k] : null;
            if (ed && ed.refresh) ed.refresh();
          } catch (e) {}
        });
      }
    }

    window.toggleXkeenSettings = window.toggleXkeenSettings || toggleCard;

    return {
      init,
      toggleCard,
      reloadPortProxying,
      reloadPortExclude,
      reloadIpExclude,
      reloadAll,
    };
  })();
})();
