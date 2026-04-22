import { getFeatureApi } from '../features/feature_access.js';
(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  let _settingsUnsubscribe = null;
  let _shellUnsubscribe = null;
  let _rendered = false;

  const _dom = {
    nav: null,
    sections: null,
    status: null,
  };

  const _sectionButtons = new Map();
  const _sectionEls = new Map();
  const _itemRefs = new Map();

  const _state = {
    loading: false,
    busy: false,
    activeSection: 'editor',
    settingsError: '',
    settings: null,
    uiShell: null,
    updateSettings: null,
    auth: {
      loading: false,
      configured: false,
      loggedIn: false,
      user: '',
      error: '',
    },
  };

  function $(id) {
    return document.getElementById(id);
  }

  function toast(message, kindOrOptions) {
    try {
      if (typeof window.toast === 'function') return window.toast(message, kindOrOptions);
      if (XK.ui && typeof XK.ui.toast === 'function') return XK.ui.toast(message, kindOrOptions);
      if (typeof window.showToast === 'function') return window.showToast(message, kindOrOptions);
    } catch (e) {}
    return null;
  }

  function buildConfirmText(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    const message = String(opts.message || opts.text || opts.body || 'Продолжить?').trim() || 'Продолжить?';
    const details = Array.isArray(opts.details)
      ? opts.details.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : String(opts.details || '').trim();
    return details ? (message + '\n\n' + details) : message;
  }

  async function confirmAction(options) {
    const opts = (options && typeof options === 'object') ? options : {};
    try {
      if (XK.ui && typeof XK.ui.confirm === 'function') return !!(await XK.ui.confirm(opts));
    } catch (e) {}

    const ok = window.confirm(buildConfirmText(opts));
    if (!ok && opts.cancelMessage) {
      toast({ id: 'ui-settings-confirm-cancel', message: String(opts.cancelMessage), kind: String(opts.cancelKind || 'info') });
    }
    return !!ok;
  }

  function getModalApi() {
    try {
      if (XK.ui && XK.ui.modal) return XK.ui.modal;
    } catch (e) {}
    return null;
  }

  function getSettingsApi() {
    try {
      if (XK.ui && XK.ui.settings) return XK.ui.settings;
    } catch (e) {}
    return null;
  }

  function getUiShellApi() {
    try {
      const api = XK.core && XK.core.uiShell;
      if (api && typeof api.getState === 'function') return api;
    } catch (e) {}
    return null;
  }

  function getUpdateNotifierApi() {
    try {
      const api = getFeatureApi('updateNotifier');
      if (api) return api;
    } catch (e) {}
    return null;
  }

  function syncScrollLock() {
    const api = getModalApi();
    try {
      if (api && typeof api.syncBodyScrollLock === 'function') return api.syncBodyScrollLock();
    } catch (e) {}
    try {
      const anyModal = !!document.querySelector('.modal:not(.hidden)');
      document.body.classList.toggle('modal-open', anyModal);
    } catch (e2) {}
  }

  function focusModalFallback(modal) {
    if (!modal) return;
    try {
      let focusEl = null;
      const selector = modal.dataset && modal.dataset.modalFocus ? String(modal.dataset.modalFocus || '').trim() : '';
      if (selector) {
        try { focusEl = modal.querySelector(selector); } catch (e0) {}
      }
      if (!focusEl) {
        focusEl = modal.querySelector(
          '[autofocus], input:not([type="hidden"]):not([disabled]), ' +
          'button:not([disabled]), [href], select:not([disabled]), ' +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        );
      }
      if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
    } catch (e) {}
  }

  function ensureModalBinding(modal) {
    if (!modal) return;
    if (modal.dataset && modal.dataset.xkModalBound === '1') return;
    const api = getModalApi();
    try {
      if (api && typeof api.bindState === 'function') api.bindState(modal);
    } catch (e) {}
    if (modal.dataset) modal.dataset.xkModalBound = '1';
  }

  function showModal(modal) {
    if (!modal) return;
    ensureModalBinding(modal);
    const api = getModalApi();
    try {
      if (api && typeof api.open === 'function') return api.open(modal, { source: 'settings_panel' });
    } catch (e) {}
    modal.classList.remove('hidden');
    syncScrollLock();
    focusModalFallback(modal);
  }

  function hideModal(modal) {
    if (!modal) return;
    ensureModalBinding(modal);
    const api = getModalApi();
    try {
      if (api && typeof api.close === 'function') return api.close(modal, { source: 'settings_panel' });
    } catch (e) {}
    modal.classList.add('hidden');
    syncScrollLock();
  }

  function csrfToken() {
    try {
      const el = document.querySelector('meta[name="csrf-token"]');
      const value = el ? (el.getAttribute('content') || '') : '';
      return value ? String(value) : '';
    } catch (e) {
      return '';
    }
  }

  function readUiShellState() {
    const api = getUiShellApi();
    if (!api) {
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
        update: {
          visible: false,
          hasUpdate: false,
          label: '',
          title: '',
        },
      };
    }
    return api.getState();
  }

  function readSettingsSnapshot() {
    try {
      const api = getSettingsApi();
      if (api && typeof api.get === 'function') return api.get();
    } catch (e) {}
    return {};
  }

  function readUpdateNotifierSettings() {
    try {
      const api = getUpdateNotifierApi();
      if (api && typeof api.getSettings === 'function') return api.getSettings();
    } catch (e) {}
    return {
      enabled: true,
      intervalHours: 6,
      intervalMs: 6 * 60 * 60 * 1000,
    };
  }

  function refreshLocalSnapshots() {
    _state.settings = readSettingsSnapshot();
    _state.uiShell = readUiShellState();
    _state.updateSettings = readUpdateNotifierSettings();
  }

  function isServerSettingsReady() {
    try {
      const api = getSettingsApi();
      if (!api || typeof api.isLoadedFromServer !== 'function') return false;
      return !!api.isLoadedFromServer();
    } catch (e) {
      return false;
    }
  }

  function setStatus(text, isError) {
    const el = _dom.status || $('ui-settings-status');
    if (!el) return;
    const value = String(text || '').trim();
    el.textContent = value;
    el.classList.toggle('error', !!isError);
    el.classList.toggle('is-empty', !value);
  }

  function setBusy(nextBusy) {
    _state.busy = !!nextBusy;
    renderState();
  }

  function getPath(obj, path) {
    if (!obj || typeof obj !== 'object') return undefined;
    const parts = String(path || '').split('.').filter(Boolean);
    let cur = obj;
    for (let i = 0; i < parts.length; i += 1) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function buildPatch(path, value) {
    const parts = String(path || '').split('.').filter(Boolean);
    if (!parts.length) return {};
    const root = {};
    let cur = root;
    for (let i = 0; i < parts.length; i += 1) {
      const key = parts[i];
      if (i === parts.length - 1) {
        cur[key] = value;
      } else {
        cur[key] = {};
        cur = cur[key];
      }
    }
    return root;
  }

  function clampInt(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
  }

  function shortCommit(value) {
    const raw = String(value || '').trim();
    return raw ? raw.slice(0, 7) : '';
  }

  function formatDateTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) return raw;
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date);
    } catch (e) {
      return raw;
    }
  }

  function describeLogsView(settings) {
    const view = getPath(settings, 'logs.view');
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      return {
        value: 'Сохраненный вид логов пока не создан',
        meta: 'Общий снимок появится после того, как панель логов впервые сохранит свое состояние.',
      };
    }

    const keys = Object.keys(view);
    if (!keys.length) {
      return {
        value: 'Сохраненный вид логов пока не создан',
        meta: 'Снимок уже доступен, но панель логов еще не записала в него свои настройки.',
      };
    }

    const parts = [];
    if (view.file) parts.push('файл ' + String(view.file));
    if (typeof view.filter === 'string' && view.filter.trim()) parts.push('фильтр активен');
    if (typeof view.live === 'boolean') parts.push(view.live ? 'live-режим включен' : 'live-режим выключен');
    if (typeof view.follow === 'boolean') parts.push(view.follow ? 'автопрокрутка включена' : 'автопрокрутка на паузе');
    if (typeof view.maxLines === 'number') parts.push('строк ' + String(view.maxLines));

    return {
      value: 'Сохранено настроек логов: ' + keys.length,
      meta: parts.length ? parts.join(' · ') : 'Панель логов читает эти значения из того же снимка /api/ui-settings.',
    };
  }

  function getDevtoolsBaseHref() {
    try {
      const link = document.querySelector('.xk-header-btn-devtools[href]');
      if (link && link.href) return String(link.href);
    } catch (e) {}
    return '/devtools';
  }

  function buildDevtoolsHref(hash) {
    const rawHash = String(hash || '').replace(/^#/, '');
    const base = getDevtoolsBaseHref();
    try {
      const url = new URL(base, window.location.href);
      url.hash = rawHash;
      return url.toString();
    } catch (e) {
      return rawHash ? (base.replace(/#.*$/, '') + '#' + rawHash) : base;
    }
  }

  function getLogoutRedirectHref() {
    return '/login';
  }

  async function saveServerPatch(patch, successMessage) {
    const api = getSettingsApi();
    if (!api || typeof api.patch !== 'function') {
      const msg = 'Серверные настройки интерфейса недоступны.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-save', message: msg, kind: 'error' });
      throw new Error(msg);
    }

    setBusy(true);
    setStatus('Сохраняю настройки интерфейса...', false);

    try {
      await api.patch(patch);
      refreshLocalSnapshots();
      setStatus('Сохранено.', false);
      if (successMessage) {
        toast({ id: 'ui-settings-save', message: successMessage, kind: 'success' });
      }
      renderState();
      return readSettingsSnapshot();
    } catch (e) {
      refreshLocalSnapshots();
      renderState();
      const msg = (e && e.message) ? String(e.message) : 'Не удалось сохранить настройки интерфейса.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-save', message: msg, kind: 'error' });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function saveUpdateNotifierSettings(patch, successMessage) {
    const api = getUpdateNotifierApi();
    if (!api || typeof api.setSettings !== 'function') {
      const msg = 'Настройки проверки обновлений недоступны.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-update-save', message: msg, kind: 'error' });
      throw new Error(msg);
    }

    setBusy(true);
    setStatus('Сохраняю настройки обновлений...', false);

    try {
      const current = readUpdateNotifierSettings();
      api.setSettings(Object.assign({}, current, patch || {}));
      refreshLocalSnapshots();
      renderState();
      setStatus('Сохранено.', false);
      if (successMessage) {
        toast({ id: 'ui-settings-update-save', message: successMessage, kind: 'success' });
      }
      return readUpdateNotifierSettings();
    } catch (e) {
      refreshLocalSnapshots();
      renderState();
      const msg = (e && e.message) ? String(e.message) : 'Не удалось сохранить настройки обновлений.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-update-save', message: msg, kind: 'error' });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function runUpdateCheckNow() {
    const api = getUpdateNotifierApi();
    if (!api || typeof api.checkNow !== 'function') {
      const msg = 'Проверка обновлений недоступна на этой странице.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-update-check', message: msg, kind: 'error' });
      throw new Error(msg);
    }

    setBusy(true);
    setStatus('Проверяю обновления...', false);

    try {
      await api.checkNow({ silent: false });
      refreshLocalSnapshots();
      renderState();
      setStatus('Проверка обновлений завершена.', false);
      return readUiShellState();
    } catch (e) {
      refreshLocalSnapshots();
      renderState();
      const msg = (e && e.message) ? String(e.message) : 'Проверка обновлений завершилась ошибкой.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-update-check', message: msg, kind: 'error' });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  async function refreshVersionInfo() {
    const api = getUpdateNotifierApi();
    if (!api || typeof api.refreshVersionInfo !== 'function') return readUiShellState();
    try {
      await api.refreshVersionInfo({ force: true });
    } catch (e) {}
    refreshLocalSnapshots();
    renderState();
    return readUiShellState();
  }

  async function resetUpdateBadge() {
    const api = getUpdateNotifierApi();
    if (!api || typeof api.resetCache !== 'function') {
      const msg = 'Сброс бейджа обновлений недоступен.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-update-reset', message: msg, kind: 'error' });
      throw new Error(msg);
    }

    setBusy(true);
    setStatus('Очищаю кэш состояния обновлений...', false);

    try {
      api.resetCache();
      refreshLocalSnapshots();
      renderState();
      setStatus('Кэш бейджа очищен.', false);
      toast({ id: 'ui-settings-update-reset', message: 'Кэш бейджа обновлений очищен.', kind: 'success' });
    } finally {
      setBusy(false);
    }
  }

  async function fetchAuthStatus(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    _state.auth.loading = true;
    _state.auth.error = '';
    renderState();

    try {
      const res = await fetch('/api/auth/status', {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true) {
        throw new Error('Не удалось получить /api/auth/status');
      }

      _state.auth = {
        loading: false,
        configured: !!data.configured,
        loggedIn: !!data.logged_in,
        user: String(data.user || ''),
        error: '',
      };

      renderState();
      if (!o.silent) setStatus('Статус сессии обновлен.', false);
      return _state.auth;
    } catch (e) {
      _state.auth = Object.assign({}, _state.auth, {
        loading: false,
        error: (e && e.message) ? String(e.message) : 'Не удалось загрузить статус сессии.',
      });
      renderState();
      if (!o.silent) {
        setStatus(_state.auth.error, true);
        toast({ id: 'ui-settings-auth-status', message: _state.auth.error, kind: 'error' });
      }
      throw e;
    }
  }

  async function logoutCurrentSession() {
    const ok = await confirmAction({
      title: 'Выход из сессии',
      message: 'Завершить текущую сессию?',
      details: [
        'Текущая сессия браузера будет закрыта сразу.',
        'После этого откроется страница входа.',
      ],
      okText: 'Выйти',
      cancelText: 'Остаться',
      danger: true,
      cancelMessage: 'Выход из сессии отменен.',
      cancelKind: 'info',
    });
    if (!ok) {
      setStatus('Выход из сессии отменен.', false);
      return false;
    }

    setBusy(true);
    setStatus('Завершаю сессию...', false);

    try {
      const headers = { Accept: 'application/json' };
      const token = csrfToken();
      if (token) headers['X-CSRF-Token'] = token;

      const res = await fetch('/api/auth/logout', {
        method: 'POST',
        cache: 'no-store',
        headers,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok !== true) {
        throw new Error('Не удалось завершить сессию.');
      }

      window.location.assign(getLogoutRedirectHref());
      return true;
    } catch (e) {
      const msg = (e && e.message) ? String(e.message) : 'Не удалось завершить сессию.';
      setStatus(msg, true);
      toast({ id: 'ui-settings-auth-logout', message: msg, kind: 'error' });
      throw e;
    } finally {
      setBusy(false);
    }
  }

  function createServerSwitch(id, path, label, description, successMessage) {
    return {
      id,
      type: 'switch',
      label,
      description,
      getValue(ctx) {
        return !!getPath(ctx.settings, path);
      },
      isDisabled(ctx) {
        return ctx.loading || ctx.busy || !ctx.serverReady;
      },
      getMeta(ctx) {
        return ctx.serverReady ? '' : (ctx.settingsError || 'Нужен загруженный снимок /api/ui-settings.');
      },
      onChange(checked) {
        return saveServerPatch(buildPatch(path, !!checked), successMessage);
      },
    };
  }

  function createServerNumber(id, path, label, description, min, max, fallback, successMessage) {
    return {
      id,
      type: 'number',
      label,
      description,
      inputMin: min,
      inputMax: max,
      inputStep: 1,
      getValue(ctx) {
        const raw = getPath(ctx.settings, path);
        const safe = clampInt(raw, min, max, fallback);
        return String(safe);
      },
      isDisabled(ctx) {
        return ctx.loading || ctx.busy || !ctx.serverReady;
      },
      getMeta(ctx) {
        return ctx.serverReady ? ('Допустимый диапазон: ' + String(min) + '-' + String(max)) : (ctx.settingsError || 'Нужен загруженный снимок /api/ui-settings.');
      },
      onChange(rawValue) {
        const next = clampInt(rawValue, min, max, fallback);
        return saveServerPatch(buildPatch(path, next), successMessage);
      },
    };
  }

  function createServerSelect(id, path, label, description, options, successMessage) {
    return {
      id,
      type: 'select',
      label,
      description,
      options,
      getValue(ctx) {
        const raw = getPath(ctx.settings, path);
        return raw == null ? '' : String(raw);
      },
      isDisabled(ctx) {
        return ctx.loading || ctx.busy || !ctx.serverReady;
      },
      getMeta(ctx) {
        return ctx.serverReady ? '' : (ctx.settingsError || 'Нужен загруженный снимок /api/ui-settings.');
      },
      onChange(value) {
        return saveServerPatch(buildPatch(path, String(value || '')), successMessage);
      },
    };
  }

  const SECTION_SCHEMA = [
    {
      key: 'editor',
      navLabel: 'Редактор',
      eyebrow: 'Редактор',
      title: 'Редактор и форматирование',
      description: 'Общие настройки редактора хранятся в /api/ui-settings и переиспользуются модулем маршрутизации и помощниками редактора.',
      items: [
        createServerSelect(
          'editor-engine',
          'editor.engine',
          'Предпочтительный движок редактора',
          'Выбирает общий движок для JSON-редакторов.',
          [
            { value: 'codemirror', label: 'CodeMirror' },
            { value: 'monaco', label: 'Monaco' },
          ],
          'Настройка движка редактора сохранена.'
        ),
        createServerSwitch(
          'format-prefer-prettier',
          'format.preferPrettier',
          'Сначала форматировать JSON через Prettier',
          'Команда форматирования сначала попробует встроенный в браузер Prettier, а затем использует резервный сценарий.',
          'Настройка форматирования сохранена.'
        ),
        createServerSwitch(
          'editor-schema-hover',
          'editor.schemaHoverEnabled',
          'Показывать всплывающие подсказки редактора',
          'Отключает hover-подсказки в редакторах CodeMirror и Monaco, включая JSON/Xray и YAML/Mihomo. Подчёркивание ошибок, маркеры и автодополнение остаются включены.',
          'Настройка всплывающих подсказок сохранена.'
        ),
        createServerNumber(
          'editor-codemirror-font-scale',
          'editor.codemirrorFontScale',
          'Масштаб шрифта CodeMirror',
          '100 = текущий размер CodeMirror. Больше значение делает текст крупнее, меньше — компактнее только в редакторах CodeMirror 6.',
          75,
          200,
          100,
          'Масштаб шрифта CodeMirror сохранён.'
        ),
        createServerNumber(
          'editor-monaco-font-scale',
          'editor.monacoFontScale',
          'Масштаб шрифта Monaco',
          '100 = текущий размер Monaco. Больше значение делает текст крупнее, меньше — компактнее только в редакторах Monaco.',
          75,
          200,
          100,
          'Масштаб шрифта Monaco сохранён.'
        ),
        createServerNumber(
          'format-tab-width',
          'format.tabWidth',
          'Ширина таба JSON',
          'Используется форматтерами JSON/YAML как размер отступа. Не меняет ширину таба в браузере и не перестраивает уже открытый редактор сам по себе.',
          1,
          8,
          2,
          'Ширина таба сохранена.'
        ),
        createServerNumber(
          'format-print-width',
          'format.printWidth',
          'Ширина строки JSON',
          'Используется Prettier и другими форматтерами как предпочтительная ширина переноса. Влияет только на форматирование и не меняет визуальную ширину редактора.',
          40,
          200,
          80,
          'Ширина строки сохранена.'
        ),
      ],
    },
    {
      key: 'logs',
      navLabel: 'Логи',
      eyebrow: 'Логи',
      title: 'Рендеринг и транспорт логов',
      description: 'Эти параметры живут в том же снимке ui-settings, который читает панель логов после перезагрузки.',
      items: [
        createServerSwitch(
          'logs-ansi',
          'logs.ansi',
          'Рендерить ANSI-цвета',
          'Преобразует ANSI-последовательности в читаемую цветную разметку в потоке логов.',
          'Настройка ANSI-логов сохранена.'
        ),
        createServerSwitch(
          'logs-ws2',
          'logs.ws2',
          'Использовать WS2-транспорт',
          'Включает более новый websocket-транспорт логов без изменений серверного API.',
          'Настройка WS2 сохранена.'
        ),
        {
          id: 'logs-view-snapshot',
          type: 'status',
          label: 'Снимок состояния логов',
          description: 'Панель логов Xray сохраняет сюда файл, фильтр и состояние live-режима с автопрокруткой.',
          getValue(ctx) {
            return describeLogsView(ctx.settings).value;
          },
          getMeta(ctx) {
            return describeLogsView(ctx.settings).meta;
          },
          getTone() {
            return 'neutral';
          },
        },
      ],
    },
    {
      key: 'routing',
      navLabel: 'Маршрутизация',
      eyebrow: 'Маршрутизация',
      title: 'Настройки маршрутизации',
      description: 'Настройки маршрутизации интерфейса, которые не меняют текущую серверную логику и сценарий редактора.',
      items: [
        createServerSwitch(
          'routing-gui',
          'routing.guiEnabled',
          'Показывать визуальную карточку правил',
          'Оставляет дополнительную панель правил маршрутизации над JSON-редактором.',
          'Видимость визуальной карточки сохранена.'
        ),
        createServerSwitch(
          'routing-autoapply',
          'routing.autoApply',
          'Автоприменение правок маршрутизации',
          'Автоматически синхронизирует изменения из карточек маршрутизации обратно в raw-редактор.',
          'Автоприменение маршрутизации сохранено.'
        ),
      ],
    },
    {
      key: 'updates',
      navLabel: 'Обновления',
      eyebrow: 'Обновления',
      title: 'Бейдж обновлений и информация о сборке',
      description: 'Локальные настройки проверки обновлений и общий снимок версии, который показывается в шапке панели.',
      items: [
        {
          id: 'updates-current-build',
          type: 'status',
          label: 'Текущая сборка',
          description: 'Подтягивается из локальной информации о сборке и синхронизируется с состоянием версии в uiShell.',
          getValue(ctx) {
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            return String(version.currentLabel || '').trim() || 'Сборка неизвестна';
          },
          getMeta(ctx) {
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            const parts = [];
            if (version.currentCommit) parts.push('коммит ' + shortCommit(version.currentCommit));
            if (version.currentBuiltAt) parts.push(formatDateTime(version.currentBuiltAt));
            if (version.channel) parts.push(String(version.channel));
            return parts.join(' · ') || 'Ожидаю локальные метаданные сборки.';
          },
          getTone(ctx) {
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            return version.currentLabel ? 'positive' : 'muted';
          },
        },
        {
          id: 'updates-latest-build',
          type: 'status',
          label: 'Последняя известная доступная сборка',
          description: 'Использует то же состояние обновлений из шапки, чтобы не было рассинхрона между точками входа.',
          getValue(ctx) {
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            const update = (ctx.uiShell && ctx.uiShell.update) || {};
            if (update.hasUpdate) return String(version.latestLabel || update.label || 'Доступно обновление');
            if (version.latestLabel) return String(version.latestLabel);
            return 'Пока не проверялось';
          },
          getMeta(ctx) {
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            const update = (ctx.uiShell && ctx.uiShell.update) || {};
            if (update.hasUpdate) {
              return 'Бейдж в шапке активен' + (version.latestPublishedAt ? (' · ' + formatDateTime(version.latestPublishedAt)) : '');
            }
            if (version.latestLabel) {
              const extra = version.latestPublishedAt ? (' · ' + formatDateTime(version.latestPublishedAt)) : '';
              return 'Сейчас нового бейджа нет' + extra;
            }
            return 'Нажмите «Проверить сейчас», чтобы обновить данные о версии.';
          },
          getTone(ctx) {
            const update = (ctx.uiShell && ctx.uiShell.update) || {};
            const version = (ctx.uiShell && ctx.uiShell.version) || {};
            if (update.hasUpdate) return 'warning';
            if (version.latestLabel) return 'positive';
            return 'muted';
          },
        },
        {
          id: 'updates-enabled',
          type: 'switch',
          label: 'Показывать бейдж обновлений',
          description: 'Хранится в браузере через существующие настройки уведомлений.',
          getValue(ctx) {
            return !!(ctx.updateSettings && ctx.updateSettings.enabled);
          },
          isDisabled(ctx) {
            return ctx.loading || ctx.busy || !getUpdateNotifierApi();
          },
          getMeta() {
            return 'Показывает или скрывает бейдж в шапке, не меняя состояние сервера.';
          },
          onChange(checked) {
            return saveUpdateNotifierSettings({ enabled: !!checked }, 'Настройка бейджа обновлений сохранена.');
          },
        },
        {
          id: 'updates-interval',
          type: 'select',
          label: 'Интервал проверки',
          description: 'Определяет, как часто открытая панель запрашивает GitHub за информацией об обновлениях.',
          options: [
            { value: '1', label: 'Каждый час' },
            { value: '6', label: 'Каждые 6 часов' },
            { value: '24', label: 'Каждые 24 часа' },
          ],
          getValue(ctx) {
            const raw = ctx.updateSettings && ctx.updateSettings.intervalHours;
            return String(raw == null ? 6 : raw);
          },
          isDisabled(ctx) {
            return ctx.loading || ctx.busy || !getUpdateNotifierApi();
          },
          getMeta() {
            return 'Применяется сразу в текущей вкладке и синхронизируется между открытыми вкладками.';
          },
          onChange(value) {
            return saveUpdateNotifierSettings({
              intervalHours: clampInt(value, 1, 24, 6),
            }, 'Интервал проверки обновлений сохранен.');
          },
        },
        {
          id: 'updates-actions',
          type: 'actions',
          label: 'Инструменты обновлений',
          description: 'Быстрые действия для проверки обновлений и сброса бейджа.',
          actions: [
            {
              key: 'check',
              label: 'Проверить сейчас',
              kind: 'secondary',
              onClick() {
                return runUpdateCheckNow();
              },
            },
            {
              key: 'reset',
              label: 'Сбросить бейдж',
              kind: 'secondary',
              onClick() {
                return resetUpdateBadge();
              },
            },
          ],
        },
      ],
    },
    {
      key: 'auth',
      navLabel: 'Сессия',
      eyebrow: 'Сессия',
      title: 'Сессия и выход',
      description: 'Читает текущее состояние авторизации из /api/auth/status и использует существующий серверный сценарий выхода.',
      items: [
        {
          id: 'auth-status',
          type: 'status',
          label: 'Текущая сессия',
          description: 'Панель не хранит флаги авторизации локально: эта строка всегда отражает состояние сервера.',
          getValue(ctx) {
            const auth = ctx.auth || {};
            if (auth.loading) return 'Проверяю сессию...';
            if (auth.error) return 'Статус сессии недоступен';
            if (!auth.configured) return 'Авторизация не настроена';
            if (auth.loggedIn) return auth.user ? ('Вошли как ' + auth.user) : 'Сессия активна';
            return 'Сессия не активна';
          },
          getMeta(ctx) {
            const auth = ctx.auth || {};
            if (auth.loading) return 'Запрашиваю /api/auth/status';
            if (auth.error) return auth.error;
            if (!auth.configured) return 'Пока авторизация не настроена, будет использоваться сценарий первичной настройки.';
            if (auth.loggedIn) return 'Используйте «Выйти», чтобы корректно завершить текущую сессию.';
            return 'Обновите страницу или откройте форму входа для повторной авторизации.';
          },
          getTone(ctx) {
            const auth = ctx.auth || {};
            if (auth.error) return 'danger';
            if (auth.loggedIn) return 'positive';
            if (!auth.configured) return 'warning';
            return 'muted';
          },
        },
        {
          id: 'auth-actions',
          type: 'actions',
          label: 'Действия сессии',
          description: 'Сохраняет совместимость с текущими эндпоинтами авторизации и перенаправлением после выхода.',
          actions: [
            {
              key: 'refresh',
              label: 'Обновить статус',
              kind: 'secondary',
              onClick() {
                return fetchAuthStatus({ silent: false });
              },
            },
            {
              key: 'logout',
              label: 'Выйти',
              kind: 'danger',
              isDisabled(ctx) {
                const auth = ctx.auth || {};
                return ctx.loading || ctx.busy || auth.loading || !auth.loggedIn;
              },
              onClick() {
                return logoutCurrentSession();
              },
            },
          ],
        },
      ],
    },
  ];

  function getRenderContext() {
    refreshLocalSnapshots();
    return {
      loading: _state.loading,
      busy: _state.busy,
      settingsError: _state.settingsError,
      settings: _state.settings || {},
      uiShell: _state.uiShell || readUiShellState(),
      updateSettings: _state.updateSettings || readUpdateNotifierSettings(),
      auth: _state.auth,
      serverReady: isServerSettingsReady(),
    };
  }

  function openSection(sectionKey) {
    const nextKey = String(sectionKey || '').trim();
    const sectionEl = _sectionEls.get(nextKey);
    const container = _dom.sections;
    if (!sectionEl || !container) return;

    _state.activeSection = nextKey;
    syncSectionNavState();

    try {
      container.scrollTo({
        top: Math.max(0, sectionEl.offsetTop - 8),
        behavior: 'smooth',
      });
    } catch (e) {
      container.scrollTop = Math.max(0, sectionEl.offsetTop - 8);
    }
  }

  function syncSectionNavState() {
    _sectionButtons.forEach((button, key) => {
      button.classList.toggle('is-active', key === _state.activeSection);
    });
  }

  function syncActiveSectionFromScroll() {
    const container = _dom.sections;
    if (!container) return;

    let active = SECTION_SCHEMA[0] ? SECTION_SCHEMA[0].key : '';
    const threshold = container.scrollTop + 120;

    SECTION_SCHEMA.forEach((section) => {
      const el = _sectionEls.get(section.key);
      if (el && el.offsetTop <= threshold) active = section.key;
    });

    if (active && active !== _state.activeSection) {
      _state.activeSection = active;
      syncSectionNavState();
    }
  }

  function createItemCopy(item) {
    const copy = document.createElement('div');
    copy.className = 'xk-ui-settings-item-copy';

    const title = document.createElement('strong');
    title.textContent = item.label;
    copy.appendChild(title);

    const description = document.createElement('small');
    description.textContent = item.description || '';
    copy.appendChild(description);

    return copy;
  }

  function createSwitchItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-switch';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const controlWrap = document.createElement('label');
    controlWrap.className = 'dt-switch xk-ui-settings-toggle';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.uiSettingsControl = item.id;

    const slider = document.createElement('span');
    slider.className = 'dt-switch-slider';
    slider.setAttribute('aria-hidden', 'true');

    controlWrap.appendChild(input);
    controlWrap.appendChild(slider);
    root.appendChild(controlWrap);

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';
    root.appendChild(meta);

    input.addEventListener('change', () => {
      Promise.resolve(item.onChange(!!input.checked, getRenderContext(), item))
        .catch(() => {})
        .finally(() => renderState());
    });

    return { root, control: input, meta };
  }

  function createNumberItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-number';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const controlWrap = document.createElement('div');
    controlWrap.className = 'xk-ui-settings-input-wrap';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'xk-ui-settings-input';
    input.dataset.uiSettingsControl = item.id;
    input.min = String(item.inputMin);
    input.max = String(item.inputMax);
    input.step = String(item.inputStep || 1);

    controlWrap.appendChild(input);
    root.appendChild(controlWrap);

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';
    root.appendChild(meta);

    input.addEventListener('change', () => {
      Promise.resolve(item.onChange(input.value, getRenderContext(), item))
        .catch(() => {})
        .finally(() => renderState());
    });

    return { root, control: input, meta };
  }

  function createSelectItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-select';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const controlWrap = document.createElement('div');
    controlWrap.className = 'xk-ui-settings-select-wrap';

    const select = document.createElement('select');
    select.className = 'xk-ui-settings-select';
    select.dataset.uiSettingsControl = item.id;

    (item.options || []).forEach((option) => {
      const el = document.createElement('option');
      el.value = String(option.value);
      el.textContent = option.label;
      select.appendChild(el);
    });

    controlWrap.appendChild(select);
    root.appendChild(controlWrap);

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';
    root.appendChild(meta);

    select.addEventListener('change', () => {
      Promise.resolve(item.onChange(select.value, getRenderContext(), item))
        .catch(() => {})
        .finally(() => renderState());
    });

    return { root, control: select, meta };
  }

  function createStatusItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-status';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const valueBox = document.createElement('div');
    valueBox.className = 'xk-ui-settings-valuebox';

    const value = document.createElement('div');
    value.className = 'xk-ui-settings-value';

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';

    valueBox.appendChild(value);
    valueBox.appendChild(meta);
    root.appendChild(valueBox);

    return { root, value, meta };
  }

  function createActionsItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-actions';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const actions = document.createElement('div');
    actions.className = 'xk-ui-settings-actions';

    const buttons = [];
    (item.actions || []).forEach((action) => {
      let el;
      if (action.kind === 'link') {
        el = document.createElement('a');
        el.href = '#';
      } else {
        el = document.createElement('button');
        el.type = 'button';
      }

      el.className = 'xk-ui-settings-action';
      if (action.kind === 'secondary') el.classList.add('btn-secondary');
      if (action.kind === 'danger') el.classList.add('xk-ui-settings-action-danger');
      if (action.kind === 'link') el.classList.add('xk-ui-settings-action-link');

      el.dataset.actionKey = action.key;
      el.textContent = action.label;

      el.addEventListener('click', (event) => {
        const ctx = getRenderContext();
        if (action.kind === 'link') {
          const href = typeof action.href === 'function' ? action.href(ctx, item, action) : String(action.href || '#');
          el.href = href || '#';
          return;
        }

        event.preventDefault();
        Promise.resolve(action.onClick(ctx, item, action))
          .catch(() => {})
          .finally(() => renderState());
      });

      actions.appendChild(el);
      buttons.push({ config: action, el });
    });

    root.appendChild(actions);

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';
    root.appendChild(meta);

    return { root, meta, actions: buttons };
  }

  function createLinksItem(item) {
    const root = document.createElement('div');
    root.className = 'xk-ui-settings-item xk-ui-settings-item-links';
    root.dataset.itemId = item.id;

    root.appendChild(createItemCopy(item));

    const linksWrap = document.createElement('div');
    linksWrap.className = 'xk-ui-settings-links';

    const links = [];
    (item.links || []).forEach((linkCfg) => {
      const link = document.createElement('a');
      link.className = 'xk-ui-settings-pill';
      link.textContent = linkCfg.label;
      link.dataset.linkKey = linkCfg.key;
      link.href = '#';
      linksWrap.appendChild(link);
      links.push({ config: linkCfg, el: link });
    });

    root.appendChild(linksWrap);

    const meta = document.createElement('div');
    meta.className = 'xk-ui-settings-item-meta';
    root.appendChild(meta);

    return { root, meta, links };
  }

  function createItem(item) {
    switch (item.type) {
      case 'switch':
        return createSwitchItem(item);
      case 'number':
        return createNumberItem(item);
      case 'select':
        return createSelectItem(item);
      case 'actions':
        return createActionsItem(item);
      case 'links':
        return createLinksItem(item);
      case 'status':
      default:
        return createStatusItem(item);
    }
  }

  function ensureSchemaRendered() {
    if (_rendered) return;

    _dom.nav = $('ui-settings-nav');
    _dom.sections = $('ui-settings-sections');
    _dom.status = $('ui-settings-status');

    if (!_dom.nav || !_dom.sections) return;

    _dom.nav.innerHTML = '';
    _dom.sections.innerHTML = '';

    SECTION_SCHEMA.forEach((section) => {
      const navButton = document.createElement('button');
      navButton.type = 'button';
      navButton.className = 'xk-ui-settings-nav-btn';
      navButton.id = 'ui-settings-nav-btn-' + section.key;
      navButton.textContent = section.navLabel;
      navButton.addEventListener('click', () => openSection(section.key));
      _dom.nav.appendChild(navButton);
      _sectionButtons.set(section.key, navButton);

      const sectionEl = document.createElement('section');
      sectionEl.className = 'xk-ui-settings-section';
      sectionEl.id = 'ui-settings-section-' + section.key;
      sectionEl.dataset.sectionKey = section.key;

      const header = document.createElement('div');
      header.className = 'xk-ui-settings-section-head';

      const kicker = document.createElement('span');
      kicker.className = 'xk-ui-settings-section-kicker';
      kicker.textContent = section.eyebrow || section.navLabel;

      const title = document.createElement('h3');
      title.className = 'xk-ui-settings-section-title';
      title.textContent = section.title;

      const description = document.createElement('p');
      description.className = 'xk-ui-settings-section-description';
      description.textContent = section.description || '';

      header.appendChild(kicker);
      header.appendChild(title);
      header.appendChild(description);
      sectionEl.appendChild(header);

      const itemsWrap = document.createElement('div');
      itemsWrap.className = 'xk-ui-settings-items';

      (section.items || []).forEach((item) => {
        const refs = createItem(item);
        itemsWrap.appendChild(refs.root);
        _itemRefs.set(item.id, Object.assign({ item }, refs));
      });

      sectionEl.appendChild(itemsWrap);
      _dom.sections.appendChild(sectionEl);
      _sectionEls.set(section.key, sectionEl);
    });

    _dom.sections.addEventListener('scroll', syncActiveSectionFromScroll);

    _rendered = true;
    syncSectionNavState();
  }

  function renderState() {
    ensureSchemaRendered();
    if (!_rendered) return;

    const ctx = getRenderContext();

    SECTION_SCHEMA.forEach((section) => {
      (section.items || []).forEach((item) => {
        const refs = _itemRefs.get(item.id);
        if (!refs) return;

        refs.root.classList.toggle('is-disabled', !!(item.isDisabled && item.isDisabled(ctx)));

        const metaText = typeof item.getMeta === 'function' ? String(item.getMeta(ctx) || '') : '';
        if (refs.meta) refs.meta.textContent = metaText;

        if (item.type === 'switch' && refs.control) {
          refs.control.checked = !!item.getValue(ctx);
          refs.control.disabled = !!(item.isDisabled && item.isDisabled(ctx));
        } else if (item.type === 'number' && refs.control) {
          refs.control.value = String(item.getValue(ctx) || '');
          refs.control.disabled = !!(item.isDisabled && item.isDisabled(ctx));
        } else if (item.type === 'select' && refs.control) {
          const nextValue = String(item.getValue(ctx) || '');
          refs.control.value = nextValue;
          if (refs.control.value !== nextValue && nextValue) {
            const extra = document.createElement('option');
            extra.value = nextValue;
            extra.textContent = nextValue;
            refs.control.appendChild(extra);
            refs.control.value = nextValue;
          }
          refs.control.disabled = !!(item.isDisabled && item.isDisabled(ctx));
        } else if (item.type === 'status' && refs.value) {
          refs.value.textContent = String(item.getValue(ctx) || '');
          refs.value.dataset.tone = typeof item.getTone === 'function' ? String(item.getTone(ctx) || 'neutral') : 'neutral';
        } else if (item.type === 'actions' && Array.isArray(refs.actions)) {
          refs.actions.forEach(({ config, el }) => {
            const disabled = !!(ctx.loading || ctx.busy || (typeof config.isDisabled === 'function' && config.isDisabled(ctx, item, config)));
            if (el.tagName === 'A') {
              const href = typeof config.href === 'function' ? config.href(ctx, item, config) : String(config.href || '#');
              el.href = href || '#';
              el.classList.toggle('is-disabled', disabled);
              el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
              el.tabIndex = disabled ? -1 : 0;
            } else {
              el.disabled = disabled;
            }
          });
        } else if (item.type === 'links' && Array.isArray(refs.links)) {
          refs.links.forEach(({ config, el }) => {
            const href = typeof config.href === 'function' ? config.href(ctx, item, config) : String(config.href || '#');
            el.href = href || '#';
          });
        }
      });
    });

    syncSectionNavState();
  }

  function ensureSettingsSubscription() {
    if (_settingsUnsubscribe) return _settingsUnsubscribe;

    const api = getSettingsApi();
    if (!api || typeof api.subscribe !== 'function') return null;

    _settingsUnsubscribe = api.subscribe((snapshot) => {
      _state.settings = snapshot && typeof snapshot === 'object' ? snapshot : readSettingsSnapshot();
      if (isServerSettingsReady()) _state.settingsError = '';
      renderState();
    }, { immediate: false });

    return _settingsUnsubscribe;
  }

  function ensureShellSubscription() {
    if (_shellUnsubscribe) return _shellUnsubscribe;

    const api = getUiShellApi();
    if (!api || typeof api.subscribe !== 'function') return null;

    _shellUnsubscribe = api.subscribe((next) => {
      _state.uiShell = next || readUiShellState();
      renderState();
    }, { immediate: false });

    return _shellUnsubscribe;
  }

  async function loadAndRender() {
    ensureSchemaRendered();
    ensureSettingsSubscription();
    ensureShellSubscription();

    _state.loading = true;
    _state.settingsError = '';
    refreshLocalSnapshots();
    renderState();
    setStatus('Загружаю настройки...', false);

    const tasks = [];
    const settingsApi = getSettingsApi();

    if (settingsApi && typeof settingsApi.fetchOnce === 'function') {
      tasks.push(
        settingsApi.fetchOnce()
          .then(() => {
            _state.settingsError = '';
          })
          .catch((e) => {
            _state.settingsError = (e && e.message) ? String(e.message) : 'Не удалось загрузить /api/ui-settings.';
          })
      );
    } else {
      _state.settingsError = 'Модуль настроек интерфейса недоступен.';
    }

    tasks.push(refreshVersionInfo().catch(() => null));
    tasks.push(fetchAuthStatus({ silent: true }).catch(() => null));

    await Promise.allSettled(tasks);

    _state.loading = false;
    refreshLocalSnapshots();
    renderState();

    if (_state.settingsError) {
      setStatus(_state.settingsError, true);
    } else {
      setStatus('Готово.', false);
    }
  }

  function openPanel() {
    const modal = $('ui-settings-modal');
    if (!modal) return false;
    ensureModalBinding(modal);
    ensureSchemaRendered();
    ensureSettingsSubscription();
    ensureShellSubscription();
    showModal(modal);
    void loadAndRender();
    return true;
  }

  function closePanel() {
    const modal = $('ui-settings-modal');
    if (!modal) return false;
    hideModal(modal);
    return true;
  }

  function reloadPanel() {
    return loadAndRender();
  }

  function wire() {
    const openBtn = $('ui-settings-open-btn');
    const modal = $('ui-settings-modal');
    const closeBtn = $('ui-settings-close-btn');
    const okBtn = $('ui-settings-ok-btn');

    if (!modal || !openBtn) return;
    ensureModalBinding(modal);
    ensureSchemaRendered();
    ensureSettingsSubscription();
    ensureShellSubscription();

    if (modal.dataset && modal.dataset.xkSettingsPanelWired === '1') return;

    openBtn.addEventListener('click', (e) => {
      e.preventDefault();
      openPanel();
    });

    const close = () => closePanel();
    if (closeBtn) closeBtn.addEventListener('click', close);
    if (okBtn) okBtn.addEventListener('click', close);

    modal.addEventListener('click', (e) => {
      if (e && e.target === modal) close();
    });

    document.addEventListener('keydown', (e) => {
      if (!e || e.key !== 'Escape') return;
      if (modal.classList.contains('hidden')) return;
      close();
    });

    if (modal.dataset) modal.dataset.xkSettingsPanelWired = '1';
  }

  const SettingsPanel = XK.ui.settingsPanel = XK.ui.settingsPanel || {};
  SettingsPanel.init = function init() {
    wire();
    return SettingsPanel;
  };
  SettingsPanel.open = openPanel;
  SettingsPanel.close = closePanel;
  SettingsPanel.reload = reloadPanel;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();

export function getUiSettingsPanelApi() {
  try {
    return window.XKeen && window.XKeen.ui ? (window.XKeen.ui.settingsPanel || null) : null;
  } catch (error) {
    return null;
  }
}

export function initUiSettingsPanel(...args) {
  const api = getUiSettingsPanelApi();
  if (!api || typeof api.init !== 'function') return null;
  return api.init(...args);
}

export function openUiSettingsPanel(...args) {
  const api = getUiSettingsPanelApi();
  if (!api || typeof api.open !== 'function') return null;
  return api.open(...args);
}

export function closeUiSettingsPanel(...args) {
  const api = getUiSettingsPanelApi();
  if (!api || typeof api.close !== 'function') return null;
  return api.close(...args);
}

export function reloadUiSettingsPanel(...args) {
  const api = getUiSettingsPanelApi();
  if (!api || typeof api.reload !== 'function') return null;
  return api.reload(...args);
}
