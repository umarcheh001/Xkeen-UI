import {
  getXkeenKnownCapabilities,
  loadXkeenCapabilities,
} from '../features/xkeen_runtime.js';

(() => {
  'use strict';

  window.XKeen = window.XKeen || {};
  const XK = window.XKeen;
  XK.ui = XK.ui || {};

  let _settingsUnsubscribe = null;
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
    capabilities: getXkeenKnownCapabilities(),
    capabilitiesError: '',
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

  function readSettingsSnapshot() {
    try {
      const api = getSettingsApi();
      if (api && typeof api.get === 'function') return api.get();
    } catch (e) {}
    return {};
  }

  function refreshLocalSnapshots() {
    _state.settings = readSettingsSnapshot();
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

  function createScrollSwitch(id, path, otherPath, otherLabel, label, description) {
    return {
      id,
      type: 'switch',
      label,
      description,
      getValue(ctx) {
        return getPath(ctx.settings, path) !== false;
      },
      isDisabled(ctx) {
        if (ctx.loading || ctx.busy || !ctx.serverReady) return true;
        const enabled = getPath(ctx.settings, path) !== false;
        const otherEnabled = getPath(ctx.settings, otherPath) !== false;
        return enabled && !otherEnabled;
      },
      getMeta(ctx) {
        if (!ctx.serverReady) return ctx.settingsError || 'Нужен загруженный снимок /api/ui-settings.';
        const enabled = getPath(ctx.settings, path) !== false;
        const otherEnabled = getPath(ctx.settings, otherPath) !== false;
        return enabled && !otherEnabled
          ? 'Сначала включите «' + otherLabel + '»: панель должна сохранить хотя бы одну прокрутку.'
          : '';
      },
      onChange(checked, ctx) {
        const otherEnabled = getPath(ctx.settings, otherPath) !== false;
        if (!checked && !otherEnabled) {
          const msg = 'Нельзя отключить обе прокрутки одновременно.';
          setStatus(msg, true);
          toast({ id: 'ui-settings-scroll-required', message: msg, kind: 'error' });
          return Promise.reject(new Error(msg));
        }
        return saveServerPatch(
          buildPatch(path, !!checked),
          checked ? 'Прокрутка включена.' : 'Прокрутка отключена.'
        );
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
      key: 'scrolling',
      navLabel: 'Прокрутка',
      eyebrow: 'Интерфейс',
      title: 'Прокрутка и шапка',
      description: 'Выберите области прокрутки и поведение шапки.',
      items: [
        createServerSwitch(
          'layout-sticky-header',
          'layout.stickyHeaderEnabled',
          'Закреплять шапку',
          'Оставляет навигацию сверху при прокрутке всей страницы.',
          'Настройка шапки сохранена.'
        ),
        createScrollSwitch(
          'layout-page-scroll',
          'layout.pageScrollEnabled',
          'layout.workspaceScrollEnabled',
          'Прокрутка рабочей области',
          'Прокрутка страницы',
          'Прокручивает содержимое панели как одну страницу.'
        ),
        createScrollSwitch(
          'layout-workspace-scroll',
          'layout.workspaceScrollEnabled',
          'layout.pageScrollEnabled',
          'Прокрутка страницы',
          'Прокрутка рабочей области',
          'Прокручивает содержимое активной вкладки отдельно от всей страницы.'
        ),
      ],
    },
    {
      key: 'editor',
      navLabel: 'Редактор',
      eyebrow: 'Редактор',
      title: 'Редактор и форматирование',
      description: 'Здесь остаются параметры, которых нет рядом с редакторами. Движок выбирается в панели самого редактора.',
      items: [
        createServerSwitch(
          'format-prefer-prettier',
          'format.preferPrettier',
          'Аккуратное форматирование JSON (Prettier)',
          'Кнопка форматирования расставит отступы и переносы по единым правилам. Если Prettier не загрузится, отступы расставит обычное форматирование.',
          'Настройка форматирования сохранена.'
        ),
        createServerSwitch(
          'editor-schema-hover',
          'editor.schemaHoverEnabled',
          'Показывать всплывающие подсказки редактора',
          'Отключает hover-подсказки в редакторах CodeMirror и Monaco, включая JSON/Xray и YAML/Mihomo. Подчёркивание ошибок, маркеры и автодополнение остаются включены.',
          'Настройка всплывающих подсказок сохранена.'
        ),
        createServerSwitch(
          'editor-beginner-mode',
          'editor.beginnerModeEnabled',
          'Режим новичка в подсказках',
          'Добавляет в hover простое объяснение, типичный use case, короткий пример и предупреждение о частой ошибке для полей с расширенными метаданными схемы. Не меняет правила валидации.',
          'Режим новичка сохранён.'
        ),
        createServerSwitch(
          'editor-expert-mode',
          'editor.expertModeEnabled',
          'Эксперт',
          'Полностью отключает Xkeen schema-assist: схемы JSON/YAML, semantic/schema validation, hover, автодополнение, сниппеты и кнопку Quick fix. Оставляет только базовый редактор.',
          'Экспертный режим сохранён.'
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
        Object.assign(
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
          { requiresEditorCapabilities: ['monaco'] }
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
          'Длина строки, после которой форматирование переносит текст. Влияет только на форматирование и не меняет визуальную ширину редактора.',
          40,
          200,
          80,
          'Ширина строки сохранена.'
        ),
      ],
    },
    {
      key: 'resources',
      navLabel: 'Ресурсы',
      eyebrow: 'Система',
      title: 'Память процесса UI',
      description: 'Мягкий бюджет контролирует физическую память Python-процесса (RSS), а не виртуальное адресное пространство VIRT.',
      items: [
        createServerSelect(
          'runtime-memory-budget',
          'runtime.memoryBudget',
          'Бюджет памяти',
          'При приближении к бюджету панель очищает восстанавливаемые кэши, собирает циклический мусор и возвращает свободные арены памяти системе. Это мягкая граница: активный запрос не прерывается.',
          [
            { value: 'auto', label: 'Авто (рекомендуется)' },
            { value: '128', label: '128 МБ' },
            { value: '192', label: '192 МБ' },
            { value: '256', label: '256 МБ' },
            { value: '384', label: '384 МБ' },
            { value: '512', label: '512 МБ' },
            { value: 'off', label: 'Выключено' },
          ],
          'Бюджет памяти применён.'
        ),
        {
          id: 'runtime-memory-budget-note',
          type: 'status',
          label: 'Режим «Авто»',
          description: 'Для роутера с 512 МБ RAM бюджет составит 128 МБ. На устройствах с большим объёмом памяти автоматическое значение ограничено 256 МБ.',
          getValue() {
            return '25% RAM · диапазон 128-256 МБ';
          },
          getMeta() {
            return 'Контроль срабатывает также при критически низком объёме свободной RAM в системе.';
          },
          getTone() {
            return 'neutral';
          },
        },
      ],
    },
    {
      key: 'logs',
      requiresModules: ['engine.xray'],
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
      requiresModules: ['engine.xray'],
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
        createServerSwitch(
          'routing-show-scenario-card',
          'routing.showScenarioCard',
          'Показывать карточку «Сценарий маршрутизации»',
          'Позволяет скрыть боковую карточку выбора сценария маршрутизации, если она не нужна в ежедневной работе.',
          'Видимость карточки сценария сохранена.'
        ),
        createServerSwitch(
          'routing-show-active-outbound',
          'routing.showActiveOutbound',
          'Показывать активный сервер в Прокси',
          'Подсвечивает в карточке Прокси последний выбранный Xray outbound по access/error логам. По умолчанию выключено, потому что требует включённых логов Xray.',
          'Отображение активного сервера сохранено.'
        ),
      ],
    },
    {
      key: 'mihomo',
      requiresModules: ['engine.mihomo'],
      navLabel: 'Mihomo',
      eyebrow: 'Mihomo',
      title: 'Узлы Clash API',
      description: 'Здесь остаются параметры без собственного элемента на карточке Clash API. Сортировка, цель проверки задержки и свёрнутость групп настраиваются прямо в рабочей области и сохраняются автоматически.',
      items: [
        createServerSwitch(
          'mihomo-hide-unavailable',
          'mihomo.hideUnavailable',
          'Скрывать недоступные узлы',
          'Скрывает узел, когда последние N записей истории Mihomo — таймауты. Текущий и зафиксированный узлы всегда остаются видимыми.',
          'Скрытие недоступных узлов сохранено.'
        ),
        createServerNumber(
          'mihomo-consecutive-timeouts',
          'mihomo.consecutiveTimeouts',
          'Таймаутов подряд',
          'Порог срабатывания по последним записям delay_history Mihomo.',
          1,
          10,
          3,
          'Порог таймаутов сохранён.'
        ),
        createServerSelect(
          'mihomo-latency-freshness',
          'mihomo.latencyFreshness',
          'Актуальность задержки',
          'Старое число остаётся видимым приглушённо. Авто использует интервал health-check provider/group и минимум 5 минут.',
          [
            { value: 'auto', label: 'Авто (health-check)' },
            { value: '5', label: '5 минут' },
            { value: '15', label: '15 минут' },
            { value: '30', label: '30 минут' },
          ],
          'Срок актуальности задержки сохранён.'
        ),
        createServerSelect(
          'mihomo-latency-test-mode',
          'mihomo.latencyTestMode',
          'Тест группы',
          'Безопасный режим проверяет конечные узлы по одному. Core batch делегирует группу одному запросу Mihomo — но только там, где ядро тестирует её само (url-test, fallback); группы с ручным выбором в любом режиме проверяются по узлам.',
          [
            { value: 'safe', label: 'Безопасный для роутера' },
            { value: 'core', label: 'Core batch' },
          ],
          'Режим теста группы сохранён.'
        ),
        createServerNumber(
          'mihomo-latency-low',
          'mihomo.latencyLowMs',
          'Быстрая задержка, мс',
          'Верхняя граница зелёного значения.',
          50,
          5000,
          400,
          'Зелёный порог задержки сохранён.'
        ),
        createServerNumber(
          'mihomo-latency-medium',
          'mihomo.latencyMediumMs',
          'Средняя задержка, мс',
          'Верхняя граница жёлтого значения; должна быть выше зелёного порога.',
          100,
          10000,
          800,
          'Жёлтый порог задержки сохранён.'
        ),
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

  function activeModuleIds(capabilities) {
    const ids = capabilities?.moduleRegistry?.effective_module_ids;
    return new Set(Array.isArray(ids) ? ids.map((item) => String(item || '')) : []);
  }

  function editorCapabilities(capabilities) {
    const descriptors = [
      capabilities?.editor,
      window.XKeen?.pageConfig?.frontendModules?.editor,
    ];

    for (const descriptor of descriptors) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      if (Array.isArray(descriptor.capabilities)) {
        return new Set(descriptor.capabilities.map((item) => String(item || '').trim()).filter(Boolean));
      }

      const variant = String(descriptor.variant || '').trim().toLowerCase();
      if (variant === 'full' || variant === 'advanced') return new Set(['codemirror', 'monaco']);
      if (variant === 'light') return new Set(['codemirror']);
    }

    return new Set();
  }

  function sectionIsAvailable(section, ctx) {
    const required = Array.isArray(section?.requiresModules) ? section.requiresModules : [];
    return !required.length || required.some((moduleId) => ctx.activeModuleIds.has(moduleId));
  }

  function itemIsAvailable(item, ctx) {
    const required = Array.isArray(item?.requiresEditorCapabilities)
      ? item.requiresEditorCapabilities
        .map((capability) => String(capability || '').trim())
        .filter(Boolean)
      : [];
    return !required.length || required.every((capability) => ctx.editorCapabilities.has(capability));
  }

  function visibleSections(ctx = getRenderContext()) {
    return SECTION_SCHEMA
      .filter((section) => sectionIsAvailable(section, ctx))
      .map((section) => Object.assign({}, section, {
        items: (section.items || []).filter((item) => itemIsAvailable(item, ctx)),
      }));
  }

  function getRenderContext() {
    refreshLocalSnapshots();
    return {
      loading: _state.loading,
      busy: _state.busy,
      settingsError: _state.settingsError,
      settings: _state.settings || {},
      auth: _state.auth,
      serverReady: isServerSettingsReady(),
      activeModuleIds: activeModuleIds(_state.capabilities),
      editorCapabilities: editorCapabilities(_state.capabilities),
      capabilitiesReady: !!_state.capabilities,
    };
  }

  function openSection(sectionKey) {
    const nextKey = String(sectionKey || '').trim();
    const sectionEl = _sectionEls.get(nextKey);
    const container = _dom.sections;
    if (!sectionEl || !container) return;

    _state.activeSection = nextKey;
    syncSectionNavState();

    let sectionTop = 0;
    try {
      const sectionRect = sectionEl.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      sectionTop = container.scrollTop + sectionRect.top - containerRect.top;
    } catch (e) {
      sectionTop = sectionEl.offsetTop;
    }

    try {
      container.scrollTo({
        top: Math.max(0, sectionTop - 8),
        behavior: 'smooth',
      });
    } catch (e) {
      container.scrollTop = Math.max(0, sectionTop - 8);
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

    const sections = visibleSections();
    let active = sections[0] ? sections[0].key : '';
    const threshold = container.scrollTop + 120;

    sections.forEach((section) => {
      const el = _sectionEls.get(section.key);
      if (!el) return;
      let sectionTop = el.offsetTop;
      try {
        sectionTop = container.scrollTop
          + el.getBoundingClientRect().top
          - container.getBoundingClientRect().top;
      } catch (e) {}
      if (sectionTop <= threshold) active = section.key;
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
    input.setAttribute('aria-label', item.label);

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
    _dom.nav = $('ui-settings-nav');
    _dom.sections = $('ui-settings-sections');
    _dom.status = $('ui-settings-status');

    if (!_dom.nav || !_dom.sections) return;

    const sections = visibleSections();
    const nextSchemaKey = sections
      .map((section) => section.key + ':' + (section.items || []).map((item) => item.id).join('|'))
      .join(',');
    if (_rendered && _dom.sections.dataset.schemaKey === nextSchemaKey) return;

    _sectionButtons.clear();
    _sectionEls.clear();
    _itemRefs.clear();
    _dom.nav.innerHTML = '';
    _dom.sections.innerHTML = '';

    sections.forEach((section) => {
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
    _dom.sections.dataset.schemaKey = nextSchemaKey;
    if (!sections.some((section) => section.key === _state.activeSection)) {
      _state.activeSection = sections[0]?.key || '';
    }

    _rendered = true;
    syncSectionNavState();
  }

  function renderState() {
    ensureSchemaRendered();
    if (!_rendered) return;

    const ctx = getRenderContext();

    visibleSections(ctx).forEach((section) => {
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

  async function loadAndRender() {
    ensureSchemaRendered();
    ensureSettingsSubscription();

    _state.loading = true;
    _state.settingsError = '';
    refreshLocalSnapshots();
    renderState();
    setStatus('Загружаю настройки...', false);

    const tasks = [];
    const settingsApi = getSettingsApi();

    tasks.push(
      loadXkeenCapabilities()
        .then((capabilities) => {
          _state.capabilities = capabilities;
          _state.capabilitiesError = '';
        })
        .catch((e) => {
          _state.capabilities = null;
          _state.capabilitiesError = (e && e.message)
            ? String(e.message)
            : 'Не удалось определить активный профиль.';
        })
    );

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
