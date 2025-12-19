(() => {
  // GitHub / config-server integration (configs catalog + import/export)
  // Public API:
  //   XKeen.github.init({ repoUrl })
  //   XKeen.github.openExportModal(), closeExportModal()
  //   XKeen.github.openCatalogModal(), closeCatalogModal()
  //   XKeen.github.exportUserConfigsToGithub(), importUserConfigById(id)

  window.XKeen = window.XKeen || {};
  XKeen.github = XKeen.github || {};

  let _inited = false;
  let _repoUrl = '';

  function el(id) {
    return document.getElementById(id);
  }


  function setStatus(msg, isError) {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = String(msg ?? '');
    if (msg) toast(msg, !!isError);
  }

  function openExportModal() {
    const modal = el('github-export-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
  }

  function closeExportModal() {
    const modal = el('github-export-modal');
    if (!modal) return;
    modal.classList.add('hidden');
  }

  function openCatalogModal() {
    const modal = el('github-catalog-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    loadCatalog();
  }

  function closeCatalogModal() {
    const modal = el('github-catalog-modal');
    if (!modal) return;
    modal.classList.add('hidden');
  }

  function openRepository() {
    const url = _repoUrl || window.XKEEN_GITHUB_REPO_URL;
    if (url) {
      window.open(url, '_blank');
    } else {
      toast('URL репозитария не настроен на сервере (XKEEN_GITHUB_REPO_URL).', true);
    }
  }

  async function refreshAfterImport() {
    // Keep compatibility with current monolithic main.js.
    const fns = [
      'loadRouting',
      'loadInboundsMode',
      'loadPortProxying',
      'loadPortExclude',
      'loadIpExclude',
    ];

    for (const fn of fns) {
      try {
        const f = window[fn];
        if (typeof f === 'function') {
          // eslint-disable-next-line no-await-in-loop
          await f();
        }
      } catch (e) {
        console.error(e);
      }
    }

    try {
      document.dispatchEvent(new CustomEvent('xkeen-github-imported'));
    } catch (e) {}
  }

  async function exportUserConfigsToGithub() {
    const tagInput = el('github-export-tag-input');
    const descInput = el('github-export-desc-input');

    const tag = tagInput ? tagInput.value.trim() : '';
    const desc = descInput ? descInput.value.trim() : '';

    const payload = {
      title: 'XKeen config ' + new Date().toLocaleString(),
      description: desc,
      tags: tag ? [tag] : [],
    };

    setStatus('Выгрузка конфигураций на сервер...', false);

    try {
      const res = await fetch('/api/github/export-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        const id = data.id || (data.server_response && data.server_response.id);
        const okMsg = 'Конфигурация выгружена. ID: ' + (id || 'неизвестно');
        setStatus(okMsg, false);

        if (tagInput) tagInput.value = '';
        if (descInput) descInput.value = '';
        closeExportModal();
      } else {
        const errMsg = 'Ошибка выгрузки: ' + ((data && data.error) || 'неизвестная ошибка');
        setStatus(errMsg, true);
      }
    } catch (e) {
      console.error(e);
      setStatus('Ошибка выгрузки (см. консоль браузера).', true);
    }
  }

  async function importUserConfigById(cfgId) {
    if (!cfgId) return;
    setStatus('Загрузка конфигурации ' + cfgId + '...', false);

    try {
      const res = await fetch('/api/github/import-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cfg_id: cfgId }),
      });
      const data = await res.json();

      if (res.ok && data.ok) {
        const msg =
          'Конфигурация ' +
          (data.cfg_id || cfgId) +
          ' загружена. Не забудьте перезапустить xkeen после проверки.';
        setStatus(msg, false);
        await refreshAfterImport();
        closeCatalogModal();
      } else {
        const errMsg = 'Ошибка загрузки: ' + ((data && data.error) || 'неизвестная ошибка');
        setStatus(errMsg, true);
      }
    } catch (e) {
      console.error(e);
      setStatus('Ошибка загрузки (см. консоль).', true);
    }
  }

  async function loadCatalog() {
    const listEl = el('github-catalog-list');
    if (!listEl) return;
    listEl.textContent = 'Загрузка...';

    try {
      const res = await fetch('/api/github/configs');
      const data = await res.json();

      if (!res.ok || !data.ok) {
        listEl.textContent =
          'Ошибка загрузки каталога: ' + ((data && data.error) || 'неизвестная ошибка');
        return;
      }

      const items = data.items || [];
      if (!items.length) {
        listEl.textContent = 'Конфигураций пока нет.';
        return;
      }

      const container = document.createElement('div');
      container.className = 'github-config-list';

      items
        .slice()
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
        .forEach((item) => {
          const row = document.createElement('div');
          row.className = 'github-config-row';

          const title = document.createElement('div');
          title.className = 'github-config-title';
          title.textContent = item.title || item.id;

          const meta = document.createElement('div');
          meta.className = 'github-config-meta';
          const dt = item.created_at ? new Date(item.created_at * 1000) : null;
          const tags = (item.tags || []).join(', ');
          meta.textContent = (dt ? dt.toLocaleString() : '') + (tags ? ' • ' + tags : '');

          const btn = document.createElement('button');
          btn.textContent = 'Загрузить';
          btn.addEventListener('click', () => {
            importUserConfigById(item.id);
          });

          row.appendChild(title);
          row.appendChild(meta);
          row.appendChild(btn);
          container.appendChild(row);
        });

      listEl.innerHTML = '';
      listEl.appendChild(container);
    } catch (e) {
      console.error(e);
      listEl.textContent = 'Ошибка загрузки каталога (см. консоль).';
    }
  }

  function init(opts) {
    if (_inited) return;
    _inited = true;

    _repoUrl = (opts && opts.repoUrl) ? String(opts.repoUrl) : '';

    // Update repository link if present.
    const repoLink = el('github-repo-link');
    if (repoLink) {
      const url = _repoUrl || window.XKEEN_GITHUB_REPO_URL;
      if (url) {
        repoLink.href = url;
        // Prefer opening via normal <a>, but also keep a fallback.
        repoLink.addEventListener('click', (e) => {
          // Let the browser handle it if possible.
          if (!repoLink.href) {
            e.preventDefault();
            openRepository();
          }
        });
      } else {
        repoLink.removeAttribute('href');
      }
    }

    const exportBtn = el('github-export-btn');
    const openCatalogBtn = el('github-open-catalog-btn');

    if (exportBtn) {
      exportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openExportModal();
      });
    }

    if (openCatalogBtn) {
      openCatalogBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openCatalogModal();
      });
    }

    const catalogCloseBtn = el('github-catalog-close-btn');
    if (catalogCloseBtn) {
      catalogCloseBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeCatalogModal();
      });
    }

    const catalogCloseBtnHeader = el('github-catalog-close-btn-header');
    if (catalogCloseBtnHeader) {
      catalogCloseBtnHeader.addEventListener('click', (e) => {
        e.preventDefault();
        closeCatalogModal();
      });
    }

    const exportCancelBtnHeader = el('github-export-cancel-btn-header');
    if (exportCancelBtnHeader) {
      exportCancelBtnHeader.addEventListener('click', (e) => {
        e.preventDefault();
        closeExportModal();
      });
    }

    const exportCancelBtn = el('github-export-cancel-btn');
    if (exportCancelBtn) {
      exportCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        closeExportModal();
      });
    }

    const exportConfirmBtn = el('github-export-confirm-btn');
    if (exportConfirmBtn) {
      exportConfirmBtn.addEventListener('click', (e) => {
        e.preventDefault();
        exportUserConfigsToGithub();
      });
    }

    // Close modals on Escape.
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        const exportModal = el('github-export-modal');
        const catalogModal = el('github-catalog-modal');
        if (exportModal && !exportModal.classList.contains('hidden')) {
          e.preventDefault();
          closeExportModal();
        } else if (catalogModal && !catalogModal.classList.contains('hidden')) {
          e.preventDefault();
          closeCatalogModal();
        }
      },
      { passive: false }
    );
  }

  XKeen.github.init = init;

  // Export the rest of the API for future pages/features.
  XKeen.github.openExportModal = openExportModal;
  XKeen.github.closeExportModal = closeExportModal;
  XKeen.github.openCatalogModal = openCatalogModal;
  XKeen.github.closeCatalogModal = closeCatalogModal;
  XKeen.github.openRepository = openRepository;
  XKeen.github.exportUserConfigsToGithub = exportUserConfigsToGithub;
  XKeen.github.loadCatalog = loadCatalog;
  XKeen.github.importUserConfigById = importUserConfigById;
})();
