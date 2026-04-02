let githubModuleApi = null;

import { getRoutingApi } from './routing.js';
import { getInboundsApi } from './inbounds.js';
import { getXkeenTextsApi } from './xkeen_texts.js';
import {
  closeXkeenModal,
  getXkeenGithubRepoUrl,
  getXkeenPageConfigShellApi,
  openXkeenModal,
  toastXkeen,
} from './xkeen_runtime.js';

(() => {
  // GitHub / config-server integration (configs catalog + import/export)
  // Public API:
  //   XKeen.github.init({ repoUrl })
  //   XKeen.github.openExportModal(), closeExportModal()
  //   XKeen.github.openCatalogModal(), closeCatalogModal()
  //   XKeen.github.exportUserConfigsToGithub(), importUserConfigById(id)

  let _inited = false;
  let _repoUrl = '';
  let _catalogAbort = null;

  function el(id) {
    return document.getElementById(id);
  }

  function showModal(modal, source) {
    return openXkeenModal(modal, source || 'github', true);
  }

  function hideModal(modal, source) {
    return closeXkeenModal(modal, source || 'github', false);
  }

  function setCatalogMessage({ status = '', error = '', stale = false, loading = false } = {}) {
    const statusEl = el('github-catalog-status');
    const errorEl = el('github-catalog-error');
    const stalePill = el('github-catalog-stale-pill');
    const retryBtn = el('github-catalog-retry-btn');

    if (statusEl) statusEl.textContent = status || '';

    if (errorEl) {
      if (error) {
        errorEl.textContent = error;
        errorEl.style.display = '';
      } else {
        errorEl.textContent = '';
        errorEl.style.display = 'none';
      }
    }

    if (stalePill) {
      if (stale) stalePill.classList.remove('hidden');
      else stalePill.classList.add('hidden');
    }

    if (retryBtn) {
      retryBtn.disabled = !!loading;
      retryBtn.setAttribute('aria-busy', loading ? 'true' : 'false');
    }
  }


  function setStatus(msg, isError) {
    const statusEl = el('routing-status');
    if (statusEl) statusEl.textContent = String(msg ?? '');
    if (msg) toastXkeen(msg, !!isError);
  }

  function openExportModal() {
    const modal = el('github-export-modal');
    if (!modal) return;
    showModal(modal, 'github_export_open');
  }

  function closeExportModal() {
    const modal = el('github-export-modal');
    if (!modal) return;
    hideModal(modal, 'github_export_close');
  }

  function openCatalogModal() {
    const modal = el('github-catalog-modal');
    if (!modal) return;
    showModal(modal, 'github_catalog_open');
    loadCatalog();
  }

  function closeCatalogModal() {
    const modal = el('github-catalog-modal');
    if (!modal) return;
    hideModal(modal, 'github_catalog_close');
    try {
      if (_catalogAbort) _catalogAbort.abort();
    } catch (e) {}
  }

  function openRepository() {
    const url = _repoUrl || getXkeenGithubRepoUrl();
    if (url) {
      window.open(url, '_blank');
    } else {
      toastXkeen('URL репозитория не настроен на сервере.', true);
    }
  }

  function getConfigShellApi() {
    return getXkeenPageConfigShellApi();
  }

  async function refreshAfterImport() {
    const tasks = [
      async () => {
        const configShell = getConfigShellApi();
        if (configShell && typeof configShell.activateRoutingView === 'function') {
          await configShell.activateRoutingView({ reason: 'github-import', force: true });
        }
        const api = getRoutingApi();
        if (api && typeof api.load === 'function') await api.load();
      },
      async () => {
        const configShell = getConfigShellApi();
        if (configShell && typeof configShell.ensureInboundsReady === 'function') {
          await configShell.ensureInboundsReady();
        }
        const api = getInboundsApi();
        if (api && typeof api.load === 'function') await api.load();
      },
      async () => {
        const texts = getXkeenTextsApi();
        if (texts && typeof texts.reloadAll === 'function') await texts.reloadAll();
      },
    ];

    for (const run of tasks) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await run();
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);
      const res = await fetch('/api/github/export-configs', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      clearTimeout(timeoutId);
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);
      const res = await fetch('/api/github/import-configs', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cfg_id: cfgId }),
      });
      clearTimeout(timeoutId);
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

  function _humanizeCatalogError(res, data, err) {
    // Prefer a short and understandable message.
    const serverMsg = (data && (data.error || data.message)) ? String(data.error || data.message) : '';

    if (err && err.name === 'AbortError') {
      return 'Таймаут: GitHub не отвечает. Нажмите «Повторить».';
    }

    const status = res ? res.status : 0;
    if (status === 504) {
      return 'Таймаут: GitHub не отвечает, а локального кэша пока нет. Попробуйте позже или нажмите «Повторить».';
    }
    if (status === 404) {
      return 'Каталог не найден в репозитории (configs/index.json). Проверьте репозиторий/ветку.';
    }

    if (serverMsg) {
      // Keep server message but make it more friendly.
      if (/timeout/i.test(serverMsg)) return 'Таймаут: GitHub не отвечает. Нажмите «Повторить».';
      if (/not configured|configured/i.test(serverMsg)) return 'GitHub-репозиторий не настроен на сервере.';
      return 'Не удалось загрузить каталог: ' + serverMsg;
    }

    if (status) return 'Не удалось загрузить каталог (HTTP ' + status + '). Нажмите «Повторить».';
    return 'Не удалось загрузить каталог. Проверьте интернет/DNS на роутере и нажмите «Повторить».';
  }

  async function loadCatalog(opts) {
    const force = !!(opts && opts.force);
    const listEl = el('github-catalog-list');
    if (!listEl) return;
    listEl.textContent = 'Загрузка...';
    setCatalogMessage({ status: 'Загрузка каталога…', error: '', stale: false, loading: true });

    try {
      if (_catalogAbort) {
        try { _catalogAbort.abort(); } catch (e) {}
      }

      const controller = new AbortController();
      _catalogAbort = controller;
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const url = '/api/github/configs?limit=200&wait=2' + (force ? '&force=1' : '') + '&t=' + Date.now();
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => ({}));

      if (!res.ok || !data.ok) {
        const msg = _humanizeCatalogError(res, data, null);
        setCatalogMessage({ status: '', error: msg, stale: false, loading: false });
        listEl.textContent = '';
        return;
      }

      const items = data.items || [];
      const stale = !!data.stale;
      const total = Number(data.total || items.length || 0);

      if (stale) {
        setCatalogMessage({
          status:
            'Показаны данные из кэша' + (total ? ` • всего: ${total}` : '') + ' (GitHub сейчас недоступен/медленный).',
          error: '',
          stale: true,
          loading: false,
        });
      } else {
        setCatalogMessage({ status: total ? `Всего конфигураций: ${total}` : '', error: '', stale: false, loading: false });
      }

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

      const msg = _humanizeCatalogError(null, null, e);
      setCatalogMessage({ status: '', error: msg, stale: false, loading: false });
      listEl.textContent = '';
    }
  }

  function init(opts) {
    if (_inited) return;
    _inited = true;

    _repoUrl = (opts && opts.repoUrl) ? String(opts.repoUrl) : '';

    // Update repository link if present.
    const repoLink = el('github-repo-link');
    if (repoLink) {
      const url = _repoUrl || getXkeenGithubRepoUrl();
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

    const catalogRetryBtn = el('github-catalog-retry-btn');
    if (catalogRetryBtn) {
      catalogRetryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        loadCatalog({ force: true });
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

  }

  githubModuleApi = {
    init,
    openExportModal,
    closeExportModal,
    openCatalogModal,
    closeCatalogModal,
    openRepository,
    exportUserConfigsToGithub,
    loadCatalog,
    importUserConfigById,
  };
})();
export function getGithubApi() {
  try {
    if (githubModuleApi && typeof githubModuleApi.init === 'function') return githubModuleApi;
    return null;
  } catch (error) {
    return null;
  }
}

function callGithubApi(method, ...args) {
  const api = getGithubApi();
  if (!api || typeof api[method] !== 'function') return null;
  return api[method](...args);
}

export function initGithub(...args) {
  return callGithubApi('init', ...args);
}

export function openGithubExportModal(...args) {
  return callGithubApi('openExportModal', ...args);
}

export function closeGithubExportModal(...args) {
  return callGithubApi('closeExportModal', ...args);
}

export function openGithubCatalogModal(...args) {
  return callGithubApi('openCatalogModal', ...args);
}

export function closeGithubCatalogModal(...args) {
  return callGithubApi('closeCatalogModal', ...args);
}

export function openGithubRepository(...args) {
  return callGithubApi('openRepository', ...args);
}

export function exportGithubUserConfigs(...args) {
  return callGithubApi('exportUserConfigsToGithub', ...args);
}

export function loadGithubCatalog(...args) {
  return callGithubApi('loadCatalog', ...args);
}

export function importGithubUserConfigById(...args) {
  return callGithubApi('importUserConfigById', ...args);
}

export const githubApi = Object.freeze({
  get: getGithubApi,
  init: initGithub,
  openExportModal: openGithubExportModal,
  closeExportModal: closeGithubExportModal,
  openCatalogModal: openGithubCatalogModal,
  closeCatalogModal: closeGithubCatalogModal,
  openRepository: openGithubRepository,
  exportUserConfigsToGithub: exportGithubUserConfigs,
  loadCatalog: loadGithubCatalog,
  importUserConfigById: importGithubUserConfigById,
});
