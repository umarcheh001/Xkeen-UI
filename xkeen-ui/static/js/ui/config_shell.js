import { setXkeenPageConfigValue } from '../features/xkeen_runtime.js';

(() => {
  window.XKeen = window.XKeen || {};
  const XKeen = window.XKeen;
  XKeen.state = XKeen.state || {};
  XKeen.ui = XKeen.ui || {};

  const tabs = (XKeen.state.configShellTabs && typeof XKeen.state.configShellTabs === 'object')
    ? XKeen.state.configShellTabs
    : Object.create(null);
  XKeen.state.configShellTabs = tabs;

  const lifecycles = (XKeen.state.configFeatureLifecycles && typeof XKeen.state.configFeatureLifecycles === 'object')
    ? XKeen.state.configFeatureLifecycles
    : Object.create(null);
  XKeen.state.configFeatureLifecycles = lifecycles;

  const SENSITIVE_NAME_RE = /(?:^|[_\-.])(secret|secrets|token|tokens|password|passwd|private|credential|credentials|auth)(?:[_\-.]|$)/i;

  const ACTION_PRESETS = {
    openEditor: {
      dirty: true,
      sensitive: true,
      tooltip: (file) => file ? ('Открыть JSON-редактор файла: ' + file) : 'Открыть JSON-редактор',
      dirtyMessage: (tab) => 'Во вкладке ' + tab.label + ' есть несохраненные изменения. Открыть raw-редактор и потерять их?',
      sensitiveMessage: (file) => 'Файл ' + file + ' помечен как чувствительный. Открыть raw-редактор и показать его содержимое?',
    },
    backup: {
      dirty: false,
      sensitive: false,
      tooltip: (file) => file ? ('Создать бэкап файла: ' + file) : 'Создать бэкап активного файла',
    },
    restoreAuto: {
      dirty: true,
      sensitive: false,
      tooltip: (file) => file ? ('Восстановить авто-бэкап файла: ' + file) : 'Восстановить авто-бэкап',
      dirtyMessage: (tab) => 'Во вкладке ' + tab.label + ' есть несохраненные изменения. Восстановить auto-backup и потерять их?',
      confirm: true,
      confirmTitle: 'Восстановить из авто-бэкапа',
      confirmMessage: (file) => file
        ? ('Восстановить файл ' + file + ' из авто-бэкапа?')
        : 'Восстановить текущий файл из авто-бэкапа?',
      confirmDetails: 'Текущий текст в редакторе будет заменён восстановленной версией.',
      confirmOkText: 'Восстановить',
      confirmCancelText: 'Отменить',
    },
    localExport: {
      dirty: false,
      sensitive: true,
      tooltip: (file) => file ? ('Экспортировать файл на локальный диск: ' + file) : 'Экспортировать текущий файл',
      sensitiveMessage: (file) => 'Файл ' + file + ' помечен как чувствительный. Экспортировать его на локальный диск?',
    },
    localImport: {
      dirty: true,
      sensitive: true,
      tooltip: (file) => file ? ('Импортировать локальный файл в: ' + file) : 'Импортировать локальный файл',
      dirtyMessage: (tab) => 'Во вкладке ' + tab.label + ' есть несохраненные изменения. Импортировать локальный файл и потерять их?',
      sensitiveMessage: (file) => 'Файл ' + file + ' помечен как чувствительный. Импортировать поверх него локальный файл?',
    },
  };

  function normalizeName(value, fallback) {
    const out = String(value || '').trim();
    return out || String(fallback || '');
  }

  function el(id) {
    if (!id) return null;
    return document.getElementById(String(id));
  }

  function basename(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    const parts = raw.split(/[\\/]/);
    return String(parts[parts.length - 1] || '');
  }

  function joinPath(dir, file) {
    const d = String(dir || '').trim();
    const f = String(file || '').trim();
    if (!d) return f;
    if (!f) return d;
    return d.replace(/[\\/]+$/, '') + '/' + f;
  }

  function notify(message, isError) {
    const text = String(message || '').trim();
    if (!text) return;
    try {
      if (typeof window.toast === 'function') {
        window.toast(text, isError ? 'error' : 'info');
        return;
      }
    } catch (e) {}
    try {
      if (typeof window.showToast === 'function') {
        window.showToast(text, !!isError);
      }
    } catch (e2) {}
  }

  function getConfirmApi() {
    try {
      if (window.XKeen && XKeen.ui && typeof XKeen.ui.confirm === 'function') return XKeen.ui.confirm;
    } catch (e) {}
    return null;
  }

  function getDirtyApi() {
    try {
      if (window.XKeen && XKeen.ui && XKeen.ui.configDirty) return XKeen.ui.configDirty;
    } catch (e) {}
    return null;
  }

  function getActionPreset(opts) {
    const kind = normalizeName(opts && opts.kind, '');
    return ACTION_PRESETS[kind] || null;
  }

  function setTooltip(btn, text) {
    if (!btn) return;
    const tip = String(text || '').trim();
    if (!tip) return;
    try { btn.setAttribute('data-tooltip', tip); } catch (e) {}
    try { btn.setAttribute('title', tip); } catch (e2) {}
  }

  function cloneItem(item) {
    return Object.assign({}, item || {});
  }

  function cloneItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => cloneItem(item));
  }

  function ensureLifecycle(name, opts) {
    const key = normalizeName(name, 'default');
    if (!lifecycles[key]) {
      lifecycles[key] = {
        name: key,
        label: key,
        fileCodeId: '',
        dirtySourceName: 'default',
        initialized: false,
        loading: false,
        saving: false,
        dirty: false,
        currentValue: '',
        savedValue: '',
        activeFragment: '',
        activeFilePath: '',
        items: [],
        sensitive: false,
        updatedAt: 0,
      };
    }

    const lifecycle = lifecycles[key];
    const patch = opts && typeof opts === 'object' ? opts : null;
    if (patch) {
      if (patch.label != null) lifecycle.label = String(patch.label || key);
      if (patch.fileCodeId != null) lifecycle.fileCodeId = String(patch.fileCodeId || '');
      if (patch.dirtySourceName != null) lifecycle.dirtySourceName = normalizeName(patch.dirtySourceName, 'default');
    }
    return lifecycle;
  }

  function snapshotLifecycle(lifecycle) {
    if (!lifecycle) return null;
    return {
      name: String(lifecycle.name || ''),
      label: String(lifecycle.label || lifecycle.name || ''),
      fileCodeId: String(lifecycle.fileCodeId || ''),
      dirtySourceName: String(lifecycle.dirtySourceName || 'default'),
      initialized: !!lifecycle.initialized,
      loading: !!lifecycle.loading,
      saving: !!lifecycle.saving,
      dirty: !!lifecycle.dirty,
      currentValue: String(lifecycle.currentValue || ''),
      savedValue: String(lifecycle.savedValue || ''),
      activeFragment: String(lifecycle.activeFragment || ''),
      activeFilePath: String(lifecycle.activeFilePath || ''),
      items: cloneItems(lifecycle.items),
      sensitive: !!lifecycle.sensitive,
      updatedAt: typeof lifecycle.updatedAt === 'number' ? lifecycle.updatedAt : 0,
    };
  }

  function emitLifecycleChange(lifecycle, reason) {
    if (!lifecycle) return;
    lifecycle.updatedAt = Date.now();
    try {
      document.dispatchEvent(new CustomEvent('xkeen:config-lifecycle-change', {
        detail: {
          reason: String(reason || 'update'),
          lifecycle: snapshotLifecycle(lifecycle),
          name: String(lifecycle.name || ''),
          dirty: !!lifecycle.dirty,
          loading: !!lifecycle.loading,
          saving: !!lifecycle.saving,
          initialized: !!lifecycle.initialized,
        },
      }));
    } catch (e) {}
  }

  function syncLifecycleFromTab(tab, reason) {
    if (!tab) return null;
    const lifecycle = ensureLifecycle(tab.name, {
      label: tab.label,
      fileCodeId: tab.fileCodeId,
    });
    lifecycle.activeFragment = String(tab.activeFragment || '');
    lifecycle.activeFilePath = String(tab.activeFilePath || '');
    lifecycle.items = cloneItems(tab.items);
    lifecycle.sensitive = !!isSensitive(tab.name);
    lifecycle.updatedAt = Date.now();
    emitLifecycleChange(lifecycle, reason || 'tab-sync');
    return lifecycle;
  }

  function publishLifecycle(name, patch, reason) {
    const lifecycle = ensureLifecycle(name, patch);
    const update = patch && typeof patch === 'object' ? patch : {};
    if (update.label != null) lifecycle.label = String(update.label || lifecycle.name);
    if (update.fileCodeId != null) lifecycle.fileCodeId = String(update.fileCodeId || '');
    if (update.dirtySourceName != null) lifecycle.dirtySourceName = normalizeName(update.dirtySourceName, lifecycle.dirtySourceName || 'default');
    if (update.initialized != null) lifecycle.initialized = !!update.initialized;
    if (update.loading != null) lifecycle.loading = !!update.loading;
    if (update.saving != null) lifecycle.saving = !!update.saving;
    if (update.dirty != null) lifecycle.dirty = !!update.dirty;
    if (update.currentValue != null) lifecycle.currentValue = String(update.currentValue || '');
    if (update.savedValue != null) lifecycle.savedValue = String(update.savedValue || '');
    if (update.activeFragment != null) lifecycle.activeFragment = String(update.activeFragment || '');
    if (update.activeFilePath != null) lifecycle.activeFilePath = String(update.activeFilePath || '');
    if (Array.isArray(update.items)) lifecycle.items = cloneItems(update.items);
    if (update.sensitive != null) lifecycle.sensitive = !!update.sensitive;
    lifecycle.updatedAt = Date.now();
    emitLifecycleChange(lifecycle, reason || 'publish');
    return lifecycle;
  }

  function getLifecycleState(name) {
    return snapshotLifecycle(lifecycles[normalizeName(name, 'default')] || ensureLifecycle(name));
  }

  function createFeatureLifecycle(name, opts) {
    const key = normalizeName(name, 'default');
    const defaults = Object.assign({}, opts || {});
    const dirtySourceName = normalizeName(defaults.dirtySourceName, 'default');
    ensureLifecycle(key, defaults);

    return {
      name: key,
      getState: function () {
        return getLifecycleState(key);
      },
      publish: function (patch, reason) {
        return publishLifecycle(key, Object.assign({}, defaults, patch || {}), reason || 'feature-publish');
      },
      syncTab: function (patch) {
        return syncTab(key, Object.assign({}, defaults, patch || {}));
      },
      setInitialized: function (value) {
        return publishLifecycle(key, Object.assign({}, defaults, { initialized: value !== false }), 'initialized');
      },
      setLoading: function (value) {
        return publishLifecycle(key, Object.assign({}, defaults, { loading: !!value }), 'loading');
      },
      setSaving: function (value) {
        return publishLifecycle(key, Object.assign({}, defaults, { saving: !!value }), 'saving');
      },
      setCurrentValue: function (value) {
        return publishLifecycle(key, Object.assign({}, defaults, { currentValue: value }), 'current-value');
      },
      setSavedValue: function (value) {
        return publishLifecycle(key, Object.assign({}, defaults, { savedValue: value }), 'saved-value');
      },
      setDirty: function (dirty, dirtyOpts) {
        const patch = dirtyOpts && typeof dirtyOpts === 'object' ? dirtyOpts : {};
        const dirtyApi = getDirtyApi();
        const sourceName = normalizeName(patch.sourceName, patch.dirtySourceName || dirtySourceName);
        if (dirtyApi && typeof dirtyApi.setDirty === 'function') {
          try {
            dirtyApi.setDirty(key, sourceName, !!dirty, {
              scopeLabel: patch.scopeLabel || defaults.label || key,
              confirmTitle: patch.confirmTitle,
              confirmMessage: patch.confirmMessage,
              okText: patch.okText,
              cancelText: patch.cancelText,
              label: patch.label,
              summary: patch.summary,
              forceEvent: patch.forceEvent === true,
            });
          } catch (e) {}
        }
        return publishLifecycle(key, Object.assign({}, defaults, {
          dirty: !!dirty,
          currentValue: patch.currentValue != null ? patch.currentValue : undefined,
          savedValue: patch.savedValue != null ? patch.savedValue : undefined,
          dirtySourceName: sourceName,
        }), 'dirty');
      },
      guardSwitch: function (switchOpts) {
        return guardSwitch(key, switchOpts || {});
      },
      bindAction: function (btnId, handler, actionOpts) {
        return bindAction(key, btnId, handler, actionOpts || {});
      },
      runAction: function (handler, actionOpts) {
        return runAction(key, handler, actionOpts || {});
      },
    };
  }

  function ensureTab(name, opts) {
    const key = normalizeName(name, 'default');
    if (!tabs[key]) {
      tabs[key] = {
        name: key,
        label: key,
        fileCodeId: '',
        dir: '',
        current: '',
        activeFragment: '',
        activeFilePath: '',
        items: [],
        itemMap: Object.create(null),
        activeMeta: null,
        actions: Object.create(null),
      };
    }

    const tab = tabs[key];
    const patch = opts && typeof opts === 'object' ? opts : null;
    if (patch) {
      if (patch.label != null) tab.label = String(patch.label || key);
      if (patch.fileCodeId != null) tab.fileCodeId = String(patch.fileCodeId || '');
      if (patch.dir != null) tab.dir = String(patch.dir || '');
      if (patch.current != null) tab.current = String(patch.current || '');
    }
    return tab;
  }

  function itemIsSensitive(item) {
    if (!item || typeof item !== 'object') return false;
    if (item.sensitive === true || item.is_sensitive === true) return true;
    return false;
  }

  function inferSensitiveFromName(name) {
    const raw = basename(name).toLowerCase();
    if (!raw) return false;
    if (/_hys2\.json$/i.test(raw)) return true;
    return SENSITIVE_NAME_RE.test(raw);
  }

  function computeActiveMeta(tab) {
    const activeName = normalizeName(tab && tab.activeFragment, '');
    if (!tab) return null;
    let meta = null;
    if (activeName && tab.itemMap && tab.itemMap[activeName]) meta = cloneItem(tab.itemMap[activeName]);
    else if (activeName) meta = { name: activeName };
    if (!meta) return null;
    if (meta.sensitive !== true && meta.is_sensitive !== true) {
      const inferred = inferSensitiveFromName(meta.name || activeName);
      if (inferred) meta.sensitive = true;
    }
    return meta;
  }

  function buildFileTooltip(tab) {
    const file = basename(tab && tab.activeFilePath) || basename(tab && tab.activeFragment);
    if (!file) return '';
    if (isSensitive(tab && tab.name)) {
      return 'Активный файл: ' + file + ' (sensitive)';
    }
    return 'Активный файл: ' + file;
  }

  function refreshFileUi(tab) {
    if (!tab || !tab.fileCodeId) return;
    const codeEl = el(tab.fileCodeId);
    if (!codeEl) return;
    const filePath = String(tab.activeFilePath || '').trim();
    const fileText = filePath || String(tab.activeFragment || tab.current || '').trim();
    if (fileText) {
      try { codeEl.textContent = fileText; } catch (e) {}
    }
    const sensitive = isSensitive(tab.name);
    const tooltip = buildFileTooltip(tab);
    try { codeEl.setAttribute('data-sensitive', sensitive ? '1' : '0'); } catch (e) {}
    try { codeEl.classList.toggle('is-sensitive', sensitive); } catch (e2) {}
    if (tooltip) {
      try { codeEl.setAttribute('data-tooltip', tooltip); } catch (e3) {}
      try { codeEl.setAttribute('title', tooltip); } catch (e4) {}
    }
  }

  function refreshActionTooltips(tab) {
    if (!tab || !tab.actions) return;
    const file = basename(tab.activeFilePath) || basename(tab.activeFragment) || basename(tab.current);
    const sensitive = isSensitive(tab.name);
    Object.keys(tab.actions).forEach((btnId) => {
      const action = tab.actions[btnId];
      const btn = el(btnId);
      if (!btn || !action) return;
      const preset = getActionPreset(action.opts);
      const tooltipFactory = (action.opts && typeof action.opts.tooltip === 'function')
        ? action.opts.tooltip
        : (preset && typeof preset.tooltip === 'function' ? preset.tooltip : null);
      const baseTooltip = tooltipFactory ? tooltipFactory(file, tab, action.opts || {}) : '';
      const tip = sensitive && shouldConfirmSensitive(tab.name, action.opts)
        ? (baseTooltip ? (baseTooltip + ' [sensitive file]') : 'Sensitive file action')
        : baseTooltip;
      setTooltip(btn, tip);
    });
  }

  function syncLegacyState(tab) {
    if (!tab) return;
    const name = normalizeName(tab.name, '');
    const activeFragment = normalizeName(tab.activeFragment, '');
    const activeFilePath = normalizeName(tab.activeFilePath, '');

    try {
      window.XKeen = window.XKeen || {};
      window.XKeen.state = window.XKeen.state || {};
      window.XKeen.state.fragments = window.XKeen.state.fragments || {};
      if (name) window.XKeen.state.fragments[name] = activeFragment;
    } catch (e) {}

    try {
      const nextPath = activeFilePath || activeFragment;
      if (name) setXkeenPageConfigValue('files.' + name, nextPath);
    } catch (e2) {}
  }

  function emitTabChange(tab) {
    if (!tab) return;
    try {
      document.dispatchEvent(new CustomEvent('xkeen:config-shell-change', {
        detail: {
          name: tab.name,
          label: tab.label,
          activeFragment: tab.activeFragment,
          activeFilePath: tab.activeFilePath,
          activeMeta: tab.activeMeta ? cloneItem(tab.activeMeta) : null,
          sensitive: isSensitive(tab.name),
        },
      }));
    } catch (e) {}
  }

  function syncTab(name, opts) {
    const tab = ensureTab(name, opts);
    const patch = opts && typeof opts === 'object' ? opts : {};

    if (Array.isArray(patch.items)) {
      tab.items = patch.items.map((item) => cloneItem(item));
      tab.itemMap = Object.create(null);
      tab.items.forEach((item) => {
        const itemName = normalizeName(item && item.name, '');
        if (!itemName) return;
        tab.itemMap[itemName] = cloneItem(item);
      });
    }

    if (patch.activeFragment != null) tab.activeFragment = String(patch.activeFragment || '');
    if (patch.current != null) tab.current = String(patch.current || '');

    const activeName = normalizeName(tab.activeFragment || tab.current, '');
    if (patch.activeFilePath != null) tab.activeFilePath = String(patch.activeFilePath || '');
    else tab.activeFilePath = joinPath(tab.dir, activeName);

    tab.activeMeta = computeActiveMeta(tab);
    syncLegacyState(tab);
    refreshFileUi(tab);
    refreshActionTooltips(tab);
    syncLifecycleFromTab(tab, 'tab-sync');
    emitTabChange(tab);
    return tab;
  }

  function getTabState(name) {
    return tabs[normalizeName(name, 'default')] || ensureTab(name);
  }

  function getActiveMeta(name) {
    const tab = getTabState(name);
    return tab && tab.activeMeta ? cloneItem(tab.activeMeta) : null;
  }

  function getActiveFragment(name) {
    const tab = getTabState(name);
    return String((tab && tab.activeFragment) || '');
  }

  function getActiveFilePath(name) {
    const tab = getTabState(name);
    return String((tab && tab.activeFilePath) || '');
  }

  function isSensitive(name) {
    const tab = getTabState(name);
    if (!tab || !tab.activeMeta) return false;
    return itemIsSensitive(tab.activeMeta) || inferSensitiveFromName(tab.activeMeta.name || tab.activeFragment);
  }

  function shouldConfirmDirty(name, opts) {
    const preset = getActionPreset(opts);
    if (opts && typeof opts.confirmDirty === 'boolean') return !!opts.confirmDirty;
    return !!(preset && preset.dirty);
  }

  function shouldConfirmSensitive(name, opts) {
    const preset = getActionPreset(opts);
    if (opts && typeof opts.confirmSensitive === 'boolean') return !!opts.confirmSensitive;
    return !!(preset && preset.sensitive);
  }

  function shouldConfirmAction(name, opts) {
    const preset = getActionPreset(opts);
    if (opts && typeof opts.confirmAction === 'boolean') return !!opts.confirmAction;
    return !!(preset && preset.confirm);
  }

  async function confirmWithUi(payload) {
    const config = payload && typeof payload === 'object' ? payload : {};
    const confirmApi = getConfirmApi();
    if (confirmApi) {
      try {
        return await confirmApi({
          title: String(config.title || 'Подтверждение'),
          message: String(config.message || ''),
          okText: String(config.okText || 'Продолжить'),
          cancelText: String(config.cancelText || 'Отмена'),
          danger: config.danger !== false,
        });
      } catch (e) {}
    }
    try {
      return !!window.confirm(String(config.message || config.title || 'Продолжить?'));
    } catch (e2) {}
    return false;
  }

  async function confirmDirtyForAction(name, opts) {
    if (!shouldConfirmDirty(name, opts)) return true;
    const dirtyApi = getDirtyApi();
    if (!dirtyApi || typeof dirtyApi.isDirty !== 'function' || !dirtyApi.isDirty(name)) return true;
    const tab = getTabState(name);
    const preset = getActionPreset(opts);
    const title = String((opts && opts.title) || 'Несохраненные изменения');
    const okText = String((opts && opts.okText) || 'Продолжить');
    const cancelText = String((opts && opts.cancelText) || 'Остаться');
    const message = (opts && opts.dirtyMessage)
      || (preset && typeof preset.dirtyMessage === 'function' ? preset.dirtyMessage(tab, opts || {}) : '')
      || ('Во вкладке ' + tab.label + ' есть несохраненные изменения. Продолжить?');
    try {
      if (typeof dirtyApi.confirmDiscard === 'function') {
        return await dirtyApi.confirmDiscard(name, {
          title,
          message,
          okText,
          cancelText,
        });
      }
    } catch (e) {}
    return confirmWithUi({
      title,
      message,
      okText,
      cancelText,
      danger: true,
    });
  }

  async function confirmDirty(name, opts) {
    return confirmDirtyForAction(name, Object.assign({ confirmDirty: true }, opts || {}));
  }

  async function confirmSensitiveForAction(name, opts) {
    if (!shouldConfirmSensitive(name, opts) || !isSensitive(name)) return true;
    const tab = getTabState(name);
    const preset = getActionPreset(opts);
    const file = basename(tab.activeFilePath) || basename(tab.activeFragment) || 'selected file';
    const message = (opts && opts.sensitiveMessage)
      || (preset && typeof preset.sensitiveMessage === 'function' ? preset.sensitiveMessage(file, tab, opts || {}) : '')
      || ('Файл ' + file + ' помечен как чувствительный. Продолжить?');
    return confirmWithUi({
      title: 'Sensitive file',
      message,
      okText: 'Продолжить',
      cancelText: 'Отмена',
      danger: true,
    });
  }

  function buildConfirmMessage(message, details) {
    const text = String(message || '').trim();
    const extra = Array.isArray(details)
      ? details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : String(details || '').trim();
    if (!extra) return text;
    if (!text) return extra;
    return text + '\n\n' + extra;
  }

  async function confirmActionForAction(name, opts) {
    if (!shouldConfirmAction(name, opts)) return true;
    const tab = getTabState(name);
    const preset = getActionPreset(opts);
    const file = basename(tab.activeFilePath) || basename(tab.activeFragment) || 'selected file';
    const title = String(
      (opts && opts.confirmTitle)
      || (preset && preset.confirmTitle)
      || 'Подтверждение действия'
    );
    const message = (opts && opts.confirmMessage)
      || (preset && typeof preset.confirmMessage === 'function' ? preset.confirmMessage(file, tab, opts || {}) : '')
      || 'Продолжить?';
    const details = (opts && opts.confirmDetails)
      || (preset && typeof preset.confirmDetails !== 'undefined'
        ? (typeof preset.confirmDetails === 'function' ? preset.confirmDetails(file, tab, opts || {}) : preset.confirmDetails)
        : '');
    const okText = String(
      (opts && opts.confirmOkText)
      || (preset && preset.confirmOkText)
      || 'Продолжить'
    );
    const cancelText = String(
      (opts && opts.confirmCancelText)
      || (preset && preset.confirmCancelText)
      || 'Отмена'
    );

    return confirmWithUi({
      title,
      message: buildConfirmMessage(message, details),
      okText,
      cancelText,
      danger: !(opts && opts.confirmDanger === false),
    });
  }

  async function runAction(name, handler, opts) {
    const tab = ensureTab(name);
    if (!tab) return false;
    if (!(await confirmDirtyForAction(name, opts || {}))) return false;
    if (!(await confirmSensitiveForAction(name, opts || {}))) return false;
    if (!(await confirmActionForAction(name, opts || {}))) return false;
    return Promise.resolve(handler());
  }

  async function guardSwitch(name, opts) {
    const config = (opts && typeof opts === 'object') ? opts : {};
    const currentValue = normalizeName(config.currentValue, '');
    const nextValue = normalizeName(config.nextValue, '');

    if (!nextValue) return false;
    if (currentValue && nextValue === currentValue && config.allowSame !== true) return true;

    const ok = await confirmDirty(name, {
      confirmDirty: config.confirmDirty !== false,
      title: config.title || 'Несохраненные изменения',
      dirtyMessage: config.message || config.dirtyMessage || '',
      okText: config.okText || 'Переключить',
      cancelText: config.cancelText || 'Остаться',
    });

    if (!ok) {
      if (typeof config.onCancel === 'function') {
        await Promise.resolve(config.onCancel());
      }
      return false;
    }

    if (typeof config.beforeSwitch === 'function') {
      await Promise.resolve(config.beforeSwitch());
    }
    if (typeof config.commit === 'function') {
      await Promise.resolve(config.commit());
    }
    return true;
  }

  function bindAction(name, btnId, handler, opts) {
    const tab = ensureTab(name, opts && opts.scope ? opts.scope : null);
    const id = normalizeName(btnId, '');
    if (!id || typeof handler !== 'function') return false;

    tab.actions[id] = { handler, opts: Object.assign({}, opts || {}) };

    const btn = el(id);
    if (!btn) return false;
    if (btn.dataset && btn.dataset.xkConfigShellBound === '1') {
      refreshActionTooltips(tab);
      return true;
    }

    btn.addEventListener('click', (event) => {
      try { if (event) event.preventDefault(); } catch (e) {}
      Promise.resolve(runAction(name, handler, opts || {})).catch((error) => {
        try { console.error(error); } catch (e2) {}
        notify('Не удалось выполнить действие.', true);
      });
    });

    if (btn.dataset) btn.dataset.xkConfigShellBound = '1';
    refreshActionTooltips(tab);
    return true;
  }

  XKeen.ui.configShell = {
    CONTRACT_VERSION: 2,
    ensureTab,
    syncTab,
    getTabState,
    getActiveMeta,
    getActiveFragment,
    getActiveFilePath,
    getLifecycleState,
    createFeatureLifecycle,
    getFeatureLifecycle: createFeatureLifecycle,
    isSensitive,
    confirmDirty,
    confirmAction: confirmActionForAction,
    bindAction,
    runAction,
    guardSwitch,
  };
})();
